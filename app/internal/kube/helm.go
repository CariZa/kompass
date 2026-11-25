package kube

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/yaml"
)

var secretsGVR = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}

const helmSelector = "owner=helm"

// release is the subset of Helm's release record we show. Values and the
// rendered manifest are left out: either can hold secrets.
type release struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Version   int    `json:"version"`
	Info      struct {
		Status        string `json:"status"`
		Description   string `json:"description"`
		FirstDeployed string `json:"first_deployed"`
		LastDeployed  string `json:"last_deployed"`
		Notes         string `json:"notes,omitempty"`
	} `json:"info"`
	Chart struct {
		Metadata struct {
			Name       string `json:"name"`
			Version    string `json:"version"`
			AppVersion string `json:"appVersion"`
			Home       string `json:"home,omitempty"`
		} `json:"metadata"`
	} `json:"chart"`
	Manifest string `json:"manifest"`
}

// decodeRelease unwraps a sh.helm.release.v1 secret: Kubernetes' base64,
// then Helm's own base64, then gzip, then JSON.
func decodeRelease(obj *unstructured.Unstructured) (*release, error) {
	enc, _, _ := unstructured.NestedString(obj.Object, "data", "release")
	k8s, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return nil, err
	}
	helm, err := base64.StdEncoding.DecodeString(string(k8s))
	if err != nil {
		return nil, err
	}
	if len(helm) > 2 && helm[0] == 0x1f && helm[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(helm))
		if err != nil {
			return nil, err
		}
		if helm, err = io.ReadAll(zr); err != nil {
			return nil, err
		}
	}
	var r release
	return &r, json.Unmarshal(helm, &r)
}

// latestReleases keeps the highest revision of each release.
func latestReleases(items []unstructured.Unstructured) map[string]*unstructured.Unstructured {
	best := map[string]*unstructured.Unstructured{}
	ver := map[string]int{}
	for i := range items {
		it := &items[i]
		l := it.GetLabels()
		id := it.GetNamespace() + "/" + l["name"]
		var v int
		fmt.Sscan(l["version"], &v)
		if v >= ver[id] {
			best[id], ver[id] = it, v
		}
	}
	return best
}

func helmRow(obj *unstructured.Unstructured) Row {
	l := obj.GetLabels()
	row := Row{Name: l["name"], Namespace: obj.GetNamespace(), Status: l["status"], Created: obj.GetCreationTimestamp().Unix(),
		Extra: map[string]string{"revision": l["version"]}}
	if r, err := decodeRelease(obj); err == nil {
		row.Extra["chart"] = r.Chart.Metadata.Name + "-" + r.Chart.Metadata.Version
		row.Extra["app"] = r.Chart.Metadata.AppVersion
	}
	return row
}

func helmRowsFrom(items []unstructured.Unstructured) []Row {
	rows := []Row{}
	for _, obj := range latestReleases(items) {
		rows = append(rows, helmRow(obj))
	}
	return rows
}

func (s *Session) helmRows(ctx context.Context, ns string) ([]Row, error) {
	l, err := s.dyn.Resource(secretsGVR).Namespace(ns).List(ctx, metav1.ListOptions{LabelSelector: helmSelector})
	if err != nil {
		return nil, err
	}
	return helmRowsFrom(l.Items), nil
}

func (s *Session) helmRelease(ctx context.Context, ns, name string) (*release, error) {
	l, err := s.dyn.Resource(secretsGVR).Namespace(ns).List(ctx, metav1.ListOptions{LabelSelector: helmSelector + ",name=" + name})
	if err != nil {
		return nil, err
	}
	for _, obj := range latestReleases(l.Items) {
		return decodeRelease(obj)
	}
	return nil, fmt.Errorf("release %s/%s not found", ns, name)
}

var reManifestDoc = regexp.MustCompile(`(?m)^# Source: (.+)$`)

// manifestResources lists kind/name for each document in the rendered
// manifest, without the bodies.
func manifestResources(m string) []string {
	var out []string
	for _, doc := range strings.Split(m, "\n---") {
		var o struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if yaml.Unmarshal([]byte(doc), &o) == nil && o.Kind != "" {
			out = append(out, o.Kind+"/"+o.Metadata.Name)
		}
	}
	sort.Strings(out)
	return out
}

func (s *Session) helmYAML(ctx context.Context, ns, name string) (string, error) {
	r, err := s.helmRelease(ctx, ns, name)
	if err != nil {
		return "", err
	}
	b, err := yaml.Marshal(map[string]any{
		"name": r.Name, "namespace": r.Namespace, "revision": r.Version,
		"info": r.Info, "chart": r.Chart.Metadata,
		"resources": manifestResources(r.Manifest),
		"values":    "# hidden: Helm values can contain secrets",
	})
	return string(b), err
}

func (s *Session) helmDescribe(ctx context.Context, ns, name string) (string, error) {
	r, err := s.helmRelease(ctx, ns, name)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Name:           %s\nNamespace:      %s\nRevision:       %d\nStatus:         %s\n", r.Name, r.Namespace, r.Version, r.Info.Status)
	fmt.Fprintf(&b, "Chart:          %s-%s\nApp Version:    %s\n", r.Chart.Metadata.Name, r.Chart.Metadata.Version, r.Chart.Metadata.AppVersion)
	fmt.Fprintf(&b, "First Deployed: %s\nLast Deployed:  %s\nDescription:    %s\n", r.Info.FirstDeployed, r.Info.LastDeployed, r.Info.Description)
	b.WriteString("Resources:\n")
	for _, x := range manifestResources(r.Manifest) {
		b.WriteString("  " + x + "\n")
	}
	if n := len(reManifestDoc.FindAllString(r.Manifest, -1)); n > 0 {
		fmt.Fprintf(&b, "Templates:      %d\n", n)
	}
	return b.String(), nil
}
