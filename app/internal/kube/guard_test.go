package kube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	autoscalingv1 "k8s.io/api/autoscaling/v1"
	policyv1 "k8s.io/api/policy/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// fakeAPI counts every request that reaches the "API server" and answers
// reads with an empty list.
func fakeAPI(t *testing.T) (*httptest.Server, *atomic.Int32, *atomic.Int32) {
	var reads, writes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			reads.Add(1)
		} else {
			writes.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"kind":"List","apiVersion":"v1","metadata":{},"items":[]}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &reads, &writes
}

// The session config is the only way Kompass builds clients, so test that one.
func guardedClients(t *testing.T, server string) (dynamic.Interface, kubernetes.Interface) {
	raw := clientcmdapi.NewConfig()
	raw.Clusters["c"] = &clientcmdapi.Cluster{Server: server}
	raw.AuthInfos["u"] = &clientcmdapi.AuthInfo{Token: "t"}
	raw.Contexts["ctx"] = &clientcmdapi.Context{Cluster: "c", AuthInfo: "u"}
	cfg, err := restConfigFor(raw, "ctx")
	if err != nil {
		t.Fatal(err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return dyn, cs
}

func TestNoWriteVerbReachesServer(t *testing.T) {
	srv, reads, writes := fakeAPI(t)
	dyn, cs := guardedClients(t, srv.URL)
	ctx := context.Background()
	pods := dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).Namespace("default")
	obj := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": "p"}}}

	attempts := map[string]func() error{
		"create": func() error { _, err := pods.Create(ctx, obj, metav1.CreateOptions{}); return err },
		"update": func() error { _, err := pods.Update(ctx, obj, metav1.UpdateOptions{}); return err },
		"patch": func() error {
			_, err := pods.Patch(ctx, "p", types.MergePatchType, []byte(`{}`), metav1.PatchOptions{})
			return err
		},
		"apply":            func() error { _, err := pods.Apply(ctx, "p", obj, metav1.ApplyOptions{FieldManager: "x"}); return err },
		"delete":           func() error { return pods.Delete(ctx, "p", metav1.DeleteOptions{}) },
		"deletecollection": func() error { return pods.DeleteCollection(ctx, metav1.DeleteOptions{}, metav1.ListOptions{}) },
		"scale": func() error {
			_, err := cs.AppsV1().Deployments("default").UpdateScale(ctx, "d", &autoscalingv1.Scale{ObjectMeta: metav1.ObjectMeta{Name: "d"}}, metav1.UpdateOptions{})
			return err
		},
		"evict": func() error {
			return cs.CoreV1().Pods("default").EvictV1(ctx, &policyv1.Eviction{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default"}})
		},
		"exec": func() error {
			return cs.CoreV1().RESTClient().Get().Namespace("default").Resource("pods").Name("p").SubResource("exec").Do(ctx).Error()
		},
		"portforward": func() error {
			return cs.CoreV1().RESTClient().Get().Namespace("default").Resource("pods").Name("p").SubResource("portforward").Do(ctx).Error()
		},
		"proxy": func() error {
			return cs.CoreV1().RESTClient().Get().Namespace("default").Resource("services").Name("s").SubResource("proxy").Do(ctx).Error()
		},
	}
	for name, do := range attempts {
		err := do()
		var blocked *ErrWriteBlocked
		if !errors.As(err, &blocked) {
			t.Errorf("%s: want ErrWriteBlocked, got %v", name, err)
		}
	}
	if n := writes.Load() + reads.Load(); n != 0 {
		t.Fatalf("%d blocked requests reached the server", n)
	}

	if _, err := pods.List(ctx, metav1.ListOptions{}); err != nil {
		t.Fatalf("list should pass: %v", err)
	}
	if reads.Load() != 1 {
		t.Fatalf("list didn't reach the server")
	}
}

func TestCheckReadOnlyRejectsUpgrade(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/v1/namespaces/x/pods/p/log", nil)
	if err := CheckReadOnly(r); err != nil {
		t.Fatalf("logs are a read: %v", err)
	}
	r.Header.Set("Upgrade", "websocket")
	if err := CheckReadOnly(r); err == nil {
		t.Fatal("upgrade should be blocked")
	}
}

func TestParseName(t *testing.T) {
	cases := []struct{ in, short, env string }{
		{"arn:aws:eks:eu-central-1:111122223333:cluster/prod-data-plane-eu", "prod-data-plane-eu", "prod"},
		{"gke_my-proj_europe-west3_staging-apps", "staging-apps", "staging"},
		{"kind-local", "local", "local"},
		{"alice@dev-a.eu-west-1.eksctl.io", "dev-a", "dev"},
		{"teleport.example.com-ops-cluster", "ops-cluster", "other"},
	}
	for _, c := range cases {
		short, _, env := ParseName(c.in)
		if short != c.short || env != c.env {
			t.Errorf("%s: got %q/%q want %q/%q", c.in, short, env, c.short, c.env)
		}
	}
}

func TestProviderOf(t *testing.T) {
	cases := []struct{ name, server, want string }{
		{"arn:aws:eks:eu-central-1:1:cluster/x", "https://ABC.gr7.eu-central-1.eks.amazonaws.com", "aws"},
		{"prod-eu", "https://ABC.gr7.eu-central-1.eks.amazonaws.com", "aws"},
		{"gke_p_europe-west3_c", "https://35.1.2.3", "gcp"},
		{"aks-prod", "https://aks-prod-dns-1234.hcp.westeurope.azmk8s.io:443", "azure"},
		{"kind-local", "https://127.0.0.1:6443", "kind"},
		{"teleport.example.com-ops-cluster", "https://teleport.example.com:3026", ""},
	}
	for _, c := range cases {
		if got := ProviderOf(c.name, c.server); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
