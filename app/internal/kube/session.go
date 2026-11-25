package kube

import (
	"context"
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/kubectl/pkg/describe"
	"sigs.k8s.io/yaml"
)

// HelmKey is the pseudo type for Helm releases, decoded from release secrets.
const HelmKey = "helm.sh/HelmRelease"

type Type struct {
	Key        string   `json:"key"` // "<group or core>/<Kind>"
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Kind       string   `json:"kind"`
	Plural     string   `json:"plural"`
	Namespaced bool     `json:"namespaced"`
	ShortNames []string `json:"shortNames"`
	IsCRD      bool     `json:"isCRD"`
}

func (t Type) GVR() schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: t.Group, Version: t.Version, Resource: t.Plural}
}

func typeKey(group, kind string) string {
	if group == "" {
		group = "core"
	}
	return group + "/" + kind
}

type Session struct {
	Name string
	cfg  *rest.Config
	dyn  dynamic.Interface
	cs   kubernetes.Interface
	disc *discovery.DiscoveryClient
	auth string

	mu    sync.RWMutex
	types map[string]Type
}

func Open(name string) (*Session, error) {
	raw, err := loadRaw()
	if err != nil {
		return nil, err
	}
	cfg, err := restConfigFor(raw, name)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	disc, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Session{Name: name, cfg: cfg, dyn: dyn, cs: cs, disc: disc, auth: authSummary(raw, name), types: map[string]Type{}}, nil
}

// Discover lists what this API server serves. Partial discovery failures
// (an aggregated API that's down) still return everything else.
func (s *Session) Discover(ctx context.Context) ([]Type, error) {
	lists, err := s.disc.ServerPreferredResources()
	if len(lists) == 0 && err != nil {
		return nil, err
	}
	crds := s.crdKinds(ctx)
	types := map[string]Type{}
	for _, l := range lists {
		gv, perr := schema.ParseGroupVersion(l.GroupVersion)
		if perr != nil {
			continue
		}
		for _, r := range l.APIResources {
			if strings.Contains(r.Name, "/") || !hasVerb(r.Verbs, "list") {
				continue
			}
			k := typeKey(gv.Group, r.Kind)
			types[k] = Type{Key: k, Group: gv.Group, Version: gv.Version, Kind: r.Kind, Plural: r.Name,
				Namespaced: r.Namespaced, ShortNames: r.ShortNames, IsCRD: crds[k]}
		}
	}
	s.mu.Lock()
	s.types = types
	s.mu.Unlock()
	out := make([]Type, 0, len(types))
	for _, t := range types {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (s *Session) crdKinds(ctx context.Context) map[string]bool {
	out := map[string]bool{}
	gvr := schema.GroupVersionResource{Group: "apiextensions.k8s.io", Version: "v1", Resource: "customresourcedefinitions"}
	l, err := s.dyn.Resource(gvr).List(ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for _, it := range l.Items {
		g, _, _ := unstructured.NestedString(it.Object, "spec", "group")
		k, _, _ := unstructured.NestedString(it.Object, "spec", "names", "kind")
		out[typeKey(g, k)] = true
	}
	return out
}

func hasVerb(vs []string, v string) bool {
	for _, x := range vs {
		if x == v {
			return true
		}
	}
	return false
}

func (s *Session) typeFor(key string) (Type, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.types[key]
	if !ok {
		return t, fmt.Errorf("%s isn't served by this cluster", key)
	}
	return t, nil
}

func (s *Session) res(t Type, ns string) dynamic.ResourceInterface {
	r := s.dyn.Resource(t.GVR())
	if t.Namespaced && ns != "" {
		return r.Namespace(ns)
	}
	return r
}

// Count asks for one item and reads remainingItemCount, so counting a type
// costs one small request instead of a full list.
func (s *Session) Count(ctx context.Context, key, ns string) (int, error) {
	if key == HelmKey {
		rows, err := s.helmRows(ctx, ns)
		return len(rows), err
	}
	t, err := s.typeFor(key)
	if err != nil {
		return 0, err
	}
	if !t.Namespaced && ns != "" {
		ns = ""
	}
	l, err := s.res(t, ns).List(ctx, metav1.ListOptions{Limit: 1})
	if err != nil {
		return 0, err
	}
	n := len(l.Items)
	if rc := l.GetRemainingItemCount(); rc != nil {
		n += int(*rc)
	} else if l.GetContinue() != "" {
		// The server couldn't estimate; fall back to a full list.
		full, err := s.res(t, ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return 0, err
		}
		n = len(full.Items)
	}
	return n, nil
}

func (s *Session) Namespaces(ctx context.Context) ([]string, error) {
	l, err := s.dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: "namespaces"}).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(l.Items))
	for _, it := range l.Items {
		out = append(out, it.GetName())
	}
	sort.Strings(out)
	return out, nil
}

// YAML returns the object as YAML with managedFields stripped and secret
// values masked.
func (s *Session) YAML(ctx context.Context, key, ns, name string) (string, error) {
	if key == HelmKey {
		return s.helmYAML(ctx, ns, name)
	}
	t, err := s.typeFor(key)
	if err != nil {
		return "", err
	}
	obj, err := s.res(t, ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	obj.SetManagedFields(nil)
	if key == "core/Secret" {
		maskSecret(obj)
	}
	b, err := yaml.Marshal(obj.Object)
	return string(b), err
}

const masked = "••••••••"

func maskSecret(obj *unstructured.Unstructured) {
	for _, f := range []string{"data", "stringData"} {
		if m, ok := obj.Object[f].(map[string]any); ok {
			for k := range m {
				m[k] = masked
			}
		}
	}
	// last-applied-configuration carries the plaintext secret too.
	if a := obj.GetAnnotations(); a != nil {
		if _, ok := a["kubectl.kubernetes.io/last-applied-configuration"]; ok {
			a["kubectl.kubernetes.io/last-applied-configuration"] = masked
			obj.SetAnnotations(a)
		}
	}
}

// SecretKeys lists a secret's keys without their values.
func (s *Session) SecretKeys(ctx context.Context, ns, name string) ([]string, error) {
	obj, err := s.res(Type{Version: "v1", Plural: "secrets", Namespaced: true}, ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	m, _, _ := unstructured.NestedMap(obj.Object, "data")
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys, nil
}

// RevealSecretKey fetches one decoded value on demand. It's never cached.
func (s *Session) RevealSecretKey(ctx context.Context, ns, name, key string) (string, error) {
	obj, err := s.res(Type{Version: "v1", Plural: "secrets", Namespaced: true}, ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	v, ok, _ := unstructured.NestedString(obj.Object, "data", key)
	if !ok {
		return "", fmt.Errorf("no key %q", key)
	}
	b, err := base64.StdEncoding.DecodeString(v)
	return string(b), err
}

// Describe renders kubectl describe output with kubectl's own describers.
func (s *Session) Describe(ctx context.Context, key, ns, name string) (string, error) {
	if key == HelmKey {
		return s.helmDescribe(ctx, ns, name)
	}
	t, err := s.typeFor(key)
	if err != nil {
		return "", err
	}
	if !t.Namespaced {
		ns = ""
	}
	d, ok := describe.DescriberFor(schema.GroupKind{Group: t.Group, Kind: t.Kind}, s.cfg)
	if !ok {
		scope := meta.RESTScopeRoot
		if t.Namespaced {
			scope = meta.RESTScopeNamespace
		}
		d, ok = describe.GenericDescriberFor(&meta.RESTMapping{
			Resource:         t.GVR(),
			GroupVersionKind: schema.GroupVersionKind{Group: t.Group, Version: t.Version, Kind: t.Kind},
			Scope:            scope,
		}, s.cfg)
		if !ok {
			return "", fmt.Errorf("no describer for %s", key)
		}
	}
	return d.Describe(ns, name, describe.DescriberSettings{ShowEvents: true, ChunkSize: 500})
}

type ClusterInfo struct {
	Server     string `json:"server"`
	Version    string `json:"version"`
	Platform   string `json:"platform"`
	Auth       string `json:"auth"`
	TypeCount  int    `json:"typeCount"`
	CRDCount   int    `json:"crdCount"`
	GroupCount int    `json:"groupCount"`
}

func (s *Session) Info() ClusterInfo {
	ci := ClusterInfo{Server: s.cfg.Host, Auth: s.auth}
	if v, err := s.disc.ServerVersion(); err == nil {
		ci.Version, ci.Platform = v.GitVersion, v.Platform
	}
	s.mu.RLock()
	groups := map[string]bool{}
	for _, t := range s.types {
		ci.TypeCount++
		groups[t.Group] = true
		if t.IsCRD {
			ci.CRDCount++
		}
	}
	s.mu.RUnlock()
	ci.GroupCount = len(groups)
	return ci
}
