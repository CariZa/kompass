package kube

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestImageTag(t *testing.T) {
	cases := map[string]string{
		"602401143452.dkr.ecr.eu-central-1.amazonaws.com/amazon-k8s-cni:v1.19.2-eksbuild.1": "v1.19.2-eksbuild.1",
		"registry.k8s.io/coredns/coredns:v1.11.3":                                           "v1.11.3",
		"localhost:5000/cilium/cilium:v1.16.1@sha256:abcdef0123456789":                      "v1.16.1",
		"localhost:5000/cilium/cilium@sha256:abcdef0123456789aa":                            "digest abcdef012345",
		"docker.io/istio/pilot": "latest",
	}
	for img, want := range cases {
		if got := imageTag(img); got != want {
			t.Errorf("%s: got %q want %q", img, got, want)
		}
	}
}

func TestKnownAddonMatches(t *testing.T) {
	ka := knownAddon{names: []string{"ingress-nginx-controller"}}
	if !ka.matches("ingress-nginx-controller") || !ka.matches("platform-ingress-nginx-controller") {
		t.Fatal("should match exact name and release prefix")
	}
	if ka.matches("ingress-nginx-controller-admission") || ka.matches("myingress-nginx-controller") {
		t.Fatal("should not match other names")
	}
}

func TestNodeGroupOf(t *testing.T) {
	eks := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "ip-10-0-1-1", "labels": map[string]any{
			"eks.amazonaws.com/nodegroup": "general", "node.kubernetes.io/instance-type": "m6i.2xlarge",
			"eks.amazonaws.com/capacityType": "ON_DEMAND", "kubernetes.io/arch": "amd64",
			"eks.amazonaws.com/nodegroup-image": "ami-0abc",
		}},
		"status": map[string]any{"nodeInfo": map[string]any{"osImage": "Amazon Linux 2023.6", "kernelVersion": "6.1.0"}},
	}}
	g := nodeGroupOf(eks, nil)
	if g != (NodeGroup{Provisioner: "EKS nodegroup", Pool: "general", InstanceType: "m6i.2xlarge", Capacity: "on-demand", Arch: "amd64", OSImage: "Amazon Linux 2023.6", Kernels: "6.1.0", ImageID: "ami-0abc"}) {
		t.Errorf("eks: %+v", g)
	}

	karp := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "ip-10-0-2-2", "labels": map[string]any{
			"karpenter.sh/nodepool": "default", "karpenter.sh/capacity-type": "spot", "node.kubernetes.io/instance-type": "c7g.xlarge",
		}},
	}}
	if g := nodeGroupOf(karp, map[string]string{"ip-10-0-2-2": "ami-0def"}); g.ImageID != "ami-0def" || g.Capacity != "spot" || g.Pool != "default" {
		t.Errorf("karpenter: %+v", g)
	}

	gke := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "gke-a", "labels": map[string]any{
			"cloud.google.com/gke-nodepool": "pool-1", "node.kubernetes.io/instance-type": "n2-standard-8",
		}},
	}}
	if g := nodeGroupOf(gke, nil); g.Capacity != "on-demand" || g.Pool != "pool-1" {
		t.Errorf("gke: %+v", g)
	}
	gke.Object["metadata"].(map[string]any)["labels"].(map[string]any)["cloud.google.com/gke-spot"] = "true"
	if g := nodeGroupOf(gke, nil); g.Capacity != "spot" {
		t.Errorf("gke spot: %+v", g)
	}

	cast := &unstructured.Unstructured{Object: map[string]any{
		"metadata": map[string]any{"name": "gke-cast-1", "labels": map[string]any{
			"provisioner.cast.ai/managed-by": "cast.ai", "provisioner.cast.ai/node-configuration-name": "default-config",
			"cloud.google.com/gke-provisioning": "standard",
		}},
	}}
	if g := nodeGroupOf(cast, nil); g.Provisioner != "CAST AI" || g.Pool != "default-config" || g.Capacity != "on-demand" {
		t.Errorf("cast: %+v", g)
	}
}
