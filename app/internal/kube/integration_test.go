//go:build integration

// Runs against a real cluster. Point KUBECONFIG at a throwaway cluster and set
// KOMPASS_IT_CONTEXT (see README.md). Expected fixtures:
//
//	kubectl create ns tenant-a
//	kubectl -n tenant-a create secret generic api-keys --from-literal=admin=s3cr3t-value --from-literal=reader=r34d
//	kubectl -n tenant-a run crashy --image=busybox:1.36 -- sh -c 'exit 1'
//	a namespaced widgets.example.com CRD (kind Widget) with a "demo" resource whose status.phase is Degraded
//	helm install demo <any chart rendering ConfigMap demo-cm> -n tenant-a
package kube

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestIntegration(t *testing.T) {
	name := os.Getenv("KOMPASS_IT_CONTEXT")
	if name == "" {
		t.Skip("KOMPASS_IT_CONTEXT not set")
	}
	ctx := context.Background()
	s, err := Open(name)
	if err != nil {
		t.Fatal(err)
	}
	types, err := s.Discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]Type{}
	for _, ty := range types {
		keys[ty.Key] = ty
	}
	if !keys["example.com/Widget"].IsCRD || keys["core/Pod"].IsCRD {
		t.Fatalf("CRD detection wrong: %+v / %+v", keys["example.com/Widget"], keys["core/Pod"])
	}
	t.Logf("discovered %d types", len(types))

	if n, err := s.Count(ctx, "core/Pod", "tenant-a"); err != nil || n < 3 {
		t.Fatalf("count pods: %d %v", n, err)
	}
	if n, err := s.Count(ctx, HelmKey, ""); err != nil || n != 1 {
		t.Fatalf("count helm: %d %v", n, err)
	}

	got := make(chan []Row, 4)
	stop, err := s.StartList("core/Pod", "tenant-a", func(rows []Row, e string) { got <- rows })
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	select {
	case rows := <-got:
		for _, r := range rows {
			t.Logf("pod %-24s %-18s %s restarts=%d node=%s", r.Name, r.Status, r.Ready, r.Restarts, r.Node)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("no rows from list")
	}

	d, err := s.Describe(ctx, "core/Pod", "tenant-a", "crashy")
	if err != nil || !strings.Contains(d, "Events:") {
		t.Fatalf("describe pod: %v\n%s", err, d)
	}
	if d, err = s.Describe(ctx, "example.com/Widget", "tenant-a", "demo"); err != nil || !strings.Contains(d, "Degraded") {
		t.Fatalf("describe CR: %v\n%s", err, d)
	}
	y, err := s.YAML(ctx, "core/Secret", "tenant-a", "api-keys")
	if err != nil || strings.Contains(y, "czNjcjN0") || strings.Contains(y, "s3cr3t") || strings.Contains(y, "managedFields") {
		t.Fatalf("secret yaml not masked: %v\n%s", err, y)
	}
	if v, err := s.RevealSecretKey(ctx, "tenant-a", "api-keys", "admin"); err != nil || v != "s3cr3t-value" {
		t.Fatalf("reveal: %q %v", v, err)
	}
	if d, err = s.Describe(ctx, HelmKey, "tenant-a", "demo"); err != nil || !strings.Contains(d, "ConfigMap/demo-cm") {
		t.Fatalf("helm describe: %v\n%s", err, d)
	}
	t.Log(s.Info())
}

// TestPodColumnsMatchKubectl compares Kompass's pod Status / Ready / Restarts
// with `kubectl get pods -A` on any cluster. Both only read.
func TestPodColumnsMatchKubectl(t *testing.T) {
	name := os.Getenv("KOMPASS_IT_CONTEXT")
	if name == "" {
		t.Skip("KOMPASS_IT_CONTEXT not set")
	}
	out, err := exec.Command("kubectl", "--context", name, "get", "pods", "-A", "--no-headers").Output()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Open(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Discover(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := make(chan []Row, 1)
	stop, err := s.StartList("core/Pod", "", func(rows []Row, e string) {
		select {
		case got <- rows:
		default:
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	ours := map[string]Row{}
	select {
	case rows := <-got:
		for _, r := range rows {
			ours[r.Namespace+"/"+r.Name] = r
		}
	case <-time.After(60 * time.Second):
		t.Fatal("no rows")
	}
	compared, diffs := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line) // NAMESPACE NAME READY STATUS RESTARTS [(Xm ago)] AGE
		if len(f) < 6 {
			continue
		}
		r, ok := ours[f[0]+"/"+f[1]]
		if !ok {
			continue // created or deleted between the two lists
		}
		compared++
		if want := f[2] + " " + f[3] + " " + f[4]; want != fmt.Sprintf("%s %s %d", r.Ready, r.Status, r.Restarts) {
			diffs++
			t.Logf("%s/%s: kubectl %q, kompass %s %s %d", f[0], f[1], want, r.Ready, r.Status, r.Restarts)
		}
	}
	t.Logf("compared %d pods, %d differ", compared, diffs)
	// Pods change between the two lists, so allow a little churn.
	if compared == 0 || diffs > compared/100+2 {
		t.Fatalf("%d of %d pods differ from kubectl", diffs, compared)
	}
}

// TestDetails prints the add-ons and kubelet versions found on any cluster.
func TestDetails(t *testing.T) {
	name := os.Getenv("KOMPASS_IT_CONTEXT")
	if name == "" {
		t.Skip("KOMPASS_IT_CONTEXT not set")
	}
	s, err := Open(name)
	if err != nil {
		t.Fatal(err)
	}
	d := s.Details(context.Background())
	for _, a := range d.Addons {
		t.Logf("%-12s %-28s %-24s %s/%s", a.Category, a.Name, a.Version, a.Namespace, a.Workload)
	}
	for _, g := range d.NodeGroups {
		t.Logf("%3d  %-14s %-14s %-18s %-10s %-6s %-36s %-14s %s", g.Nodes, g.Provisioner, g.Pool, g.InstanceType, g.Capacity, g.Arch, g.OSImage, g.ImageID, g.Kernels)
	}
	t.Logf("kubelets: %+v errors: %v", d.Kubelets, d.Errors)
	if len(d.Errors) > 0 || len(d.Kubelets) == 0 {
		t.Fatal("details incomplete")
	}
}

// TestProviderCounts shows how the real kubeconfig's contexts split by cloud.
func TestProviderCounts(t *testing.T) {
	if os.Getenv("KOMPASS_IT_PROVIDERS") == "" {
		t.Skip("KOMPASS_IT_PROVIDERS not set")
	}
	cs, err := LoadContexts()
	if err != nil {
		t.Fatal(err)
	}
	n := map[string]int{}
	for _, c := range cs {
		n[c.Provider]++
	}
	t.Logf("%v", n)
}
