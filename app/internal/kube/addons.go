package kube

import (
	"context"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

type Addon struct {
	Category  string `json:"category"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	Namespace string `json:"namespace"`
	Workload  string `json:"workload"` // "DaemonSet/aws-node"
	Image     string `json:"image"`
}

type KubeletVersion struct {
	Version string `json:"version"`
	Nodes   int    `json:"nodes"`
}

// NodeGroup is a set of nodes that share a pool, machine type and image.
type NodeGroup struct {
	Provisioner  string `json:"provisioner"` // EKS nodegroup, Karpenter, GKE, CAST AI, AKS
	Pool         string `json:"pool"`
	InstanceType string `json:"instanceType"`
	Capacity     string `json:"capacity"` // on-demand, spot, preemptible
	Arch         string `json:"arch"`
	OSImage      string `json:"osImage"`
	Kernels      string `json:"kernels"` // distinct kernel versions, comma-separated
	ImageID      string `json:"imageId"` // AMI etc., when the node or its NodeClaim says
	Nodes        int    `json:"nodes"`
}

type ClusterDetails struct {
	Addons     []Addon          `json:"addons"`
	Kubelets   []KubeletVersion `json:"kubelets"`
	NodeGroups []NodeGroup      `json:"nodeGroups"`
	Errors     []string         `json:"errors,omitempty"`
}

// knownAddon matches a DaemonSet or Deployment by name. Only well-known
// names are listed, so nothing is guessed from arbitrary workloads.
type knownAddon struct {
	category, name, kind string
	names                []string // workload name, or "<release>-<name>"
	container            string   // container to read the version from; "" = first
}

var knownAddons = []knownAddon{
	{"CNI", "AWS VPC CNI", "DaemonSet", []string{"aws-node"}, "aws-node"},
	{"CNI", "Cilium", "DaemonSet", []string{"cilium"}, "cilium-agent"},
	{"CNI", "GKE Dataplane V2 (Cilium)", "DaemonSet", []string{"anetd"}, ""},
	{"CNI", "GKE netd", "DaemonSet", []string{"netd"}, ""},
	{"CNI", "Calico", "DaemonSet", []string{"calico-node"}, "calico-node"},
	{"CNI", "Flannel", "DaemonSet", []string{"kube-flannel-ds", "kube-flannel"}, ""},
	{"CNI", "Antrea", "DaemonSet", []string{"antrea-agent"}, "antrea-agent"},
	{"CNI", "Weave Net", "DaemonSet", []string{"weave-net"}, "weave"},
	{"CNI", "Azure CNS", "DaemonSet", []string{"azure-cns"}, ""},
	{"CNI", "kindnet", "DaemonSet", []string{"kindnet"}, ""},
	{"Proxy", "kube-proxy", "DaemonSet", []string{"kube-proxy"}, ""},
	{"DNS", "CoreDNS", "Deployment", []string{"coredns"}, "coredns"},
	{"DNS", "kube-dns", "Deployment", []string{"kube-dns"}, "kubedns"},
	{"DNS", "external-dns", "Deployment", []string{"external-dns"}, ""},
	{"Storage", "EBS CSI driver", "Deployment", []string{"ebs-csi-controller"}, "ebs-plugin"},
	{"Storage", "EFS CSI driver", "Deployment", []string{"efs-csi-controller"}, "efs-plugin"},
	{"Storage", "GCE PD CSI driver", "DaemonSet", []string{"pdcsi-node"}, "gce-pd-driver"},
	{"Metrics", "metrics-server", "Deployment", []string{"metrics-server"}, ""},
	{"Autoscaling", "Karpenter", "Deployment", []string{"karpenter"}, "controller"},
	{"Autoscaling", "Cluster Autoscaler", "Deployment", []string{"cluster-autoscaler"}, ""},
	{"Mesh", "Istio (istiod)", "Deployment", []string{"istiod"}, "discovery"},
	{"Ingress", "ingress-nginx", "Deployment", []string{"ingress-nginx-controller"}, "controller"},
	{"Ingress", "AWS Load Balancer Controller", "Deployment", []string{"aws-load-balancer-controller"}, ""},
	{"Certificates", "cert-manager", "Deployment", []string{"cert-manager"}, ""},
	{"GitOps", "Argo CD", "Deployment", []string{"argocd-server"}, ""},
	{"Infra", "Crossplane", "Deployment", []string{"crossplane"}, ""},
	{"Observability", "Dash0 operator", "Deployment", []string{"dash0-operator-controller"}, ""},
}

func (k knownAddon) matches(name string) bool {
	for _, n := range k.names {
		if name == n || strings.HasSuffix(name, "-"+n) {
			return true
		}
	}
	return false
}

// imageTag returns the tag of an image reference, ignoring any digest.
func imageTag(img string) string {
	img, digest, _ := strings.Cut(img, "@")
	if i := strings.LastIndex(img, ":"); i > strings.LastIndex(img, "/") {
		return img[i+1:]
	}
	if digest != "" {
		return "digest " + strings.TrimPrefix(digest, "sha256:")[:min(12, len(strings.TrimPrefix(digest, "sha256:")))]
	}
	return "latest"
}

func addonFrom(k knownAddon, obj *unstructured.Unstructured) Addon {
	a := Addon{Category: k.category, Name: k.name, Namespace: obj.GetNamespace(), Workload: k.kind + "/" + obj.GetName()}
	cs, _, _ := unstructured.NestedSlice(obj.Object, "spec", "template", "spec", "containers")
	for i, c := range cs {
		cm, _ := c.(map[string]any)
		if (k.container == "" && i == 0) || cm["name"] == k.container {
			a.Image, _ = cm["image"].(string)
			break
		}
	}
	if a.Image == "" && len(cs) > 0 {
		a.Image, _ = cs[0].(map[string]any)["image"].(string)
	}
	a.Version = imageTag(a.Image)
	return a
}

// Details finds well-known add-ons and their versions from the image tags of
// their DaemonSets and Deployments, plus the kubelet versions across nodes.
func (s *Session) Details(ctx context.Context) ClusterDetails {
	d := ClusterDetails{Addons: []Addon{}, Kubelets: []KubeletVersion{}, NodeGroups: []NodeGroup{}}
	for _, kind := range []string{"DaemonSet", "Deployment"} {
		gvr := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: strings.ToLower(kind) + "s"}
		opts := metav1.ListOptions{Limit: 500}
		for {
			l, err := s.dyn.Resource(gvr).List(ctx, opts)
			if err != nil {
				d.Errors = append(d.Errors, kind+"s: "+err.Error())
				break
			}
			for i := range l.Items {
				for _, k := range knownAddons {
					if k.kind == kind && k.matches(l.Items[i].GetName()) {
						d.Addons = append(d.Addons, addonFrom(k, &l.Items[i]))
						break
					}
				}
			}
			if opts.Continue = l.GetContinue(); opts.Continue == "" {
				break
			}
		}
	}
	order := map[string]int{}
	for i, k := range knownAddons {
		if _, ok := order[k.category]; !ok {
			order[k.category] = i
		}
	}
	sort.SliceStable(d.Addons, func(i, j int) bool {
		a, b := d.Addons[i], d.Addons[j]
		if order[a.Category] != order[b.Category] {
			return order[a.Category] < order[b.Category]
		}
		return a.Name+a.Namespace < b.Name+b.Namespace
	})

	nodes, err := s.dyn.Resource(schema.GroupVersionResource{Version: "v1", Resource: "nodes"}).List(ctx, metav1.ListOptions{})
	if err != nil {
		d.Errors = append(d.Errors, "nodes: "+err.Error())
		return d
	}
	byVer := map[string]int{}
	images := s.karpenterImages(ctx)
	groups := map[NodeGroup]*NodeGroup{} // keyed without kernel and count
	kernels := map[NodeGroup]map[string]bool{}
	for i := range nodes.Items {
		n := &nodes.Items[i]
		v, _, _ := unstructured.NestedString(n.Object, "status", "nodeInfo", "kubeletVersion")
		byVer[v]++
		g := nodeGroupOf(n, images)
		k := g
		k.Kernels = ""
		if groups[k] == nil {
			ng := k
			groups[k], kernels[k] = &ng, map[string]bool{}
		}
		groups[k].Nodes++
		kernels[k][g.Kernels] = true
	}
	for k, g := range groups {
		var ks []string
		for kv := range kernels[k] {
			if kv != "" {
				ks = append(ks, kv)
			}
		}
		sort.Strings(ks)
		g.Kernels = strings.Join(ks, ", ")
		d.NodeGroups = append(d.NodeGroups, *g)
	}
	sort.Slice(d.NodeGroups, func(i, j int) bool {
		a, b := d.NodeGroups[i], d.NodeGroups[j]
		if a.Nodes != b.Nodes {
			return a.Nodes > b.Nodes
		}
		return a.Pool+a.InstanceType < b.Pool+b.InstanceType
	})
	for v, n := range byVer {
		d.Kubelets = append(d.Kubelets, KubeletVersion{v, n})
	}
	sort.Slice(d.Kubelets, func(i, j int) bool { return d.Kubelets[i].Nodes > d.Kubelets[j].Nodes })
	return d
}

func firstLabel(l map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := l[k]; v != "" {
			return v
		}
	}
	return ""
}

// nodeGroupOf reads the well-known labels EKS, Karpenter, GKE and AKS put on
// nodes. imageIDs maps node name to the image a Karpenter NodeClaim launched.
func nodeGroupOf(n *unstructured.Unstructured, imageIDs map[string]string) NodeGroup {
	l := n.GetLabels()
	g := NodeGroup{
		Pool:         firstLabel(l, "eks.amazonaws.com/nodegroup", "karpenter.sh/nodepool", "provisioner.cast.ai/node-configuration-name", "cloud.google.com/gke-nodepool", "kubernetes.azure.com/agentpool", "agentpool"),
		InstanceType: firstLabel(l, "node.kubernetes.io/instance-type", "beta.kubernetes.io/instance-type"),
		Arch:         firstLabel(l, "kubernetes.io/arch", "beta.kubernetes.io/arch"),
		ImageID:      firstLabel(l, "eks.amazonaws.com/nodegroup-image"),
	}
	g.OSImage, _, _ = unstructured.NestedString(n.Object, "status", "nodeInfo", "osImage")
	g.Kernels, _, _ = unstructured.NestedString(n.Object, "status", "nodeInfo", "kernelVersion")
	switch {
	case l["provisioner.cast.ai/managed-by"] != "":
		g.Provisioner = "CAST AI"
	case l["karpenter.sh/nodepool"] != "":
		g.Provisioner = "Karpenter"
	case l["eks.amazonaws.com/nodegroup"] != "":
		g.Provisioner = "EKS nodegroup"
	case l["cloud.google.com/gke-nodepool"] != "":
		g.Provisioner = "GKE node pool"
	case l["kubernetes.azure.com/agentpool"] != "" || l["agentpool"] != "":
		g.Provisioner = "AKS agent pool"
	}
	if g.ImageID == "" {
		g.ImageID = imageIDs[n.GetName()]
	}
	c := strings.ToLower(firstLabel(l, "karpenter.sh/capacity-type", "eks.amazonaws.com/capacityType", "kubernetes.azure.com/scalesetpriority", "cloud.google.com/gke-provisioning"))
	switch {
	case c == "spot" || l["cloud.google.com/gke-spot"] == "true" || l["scheduling.cast.ai/spot"] == "true":
		g.Capacity = "spot"
	case c == "preemptible" || l["cloud.google.com/gke-preemptible"] == "true":
		g.Capacity = "preemptible"
	case c == "on_demand" || c == "on-demand" || c == "regular" || c == "standard":
		g.Capacity = "on-demand"
	case l["cloud.google.com/gke-nodepool"] != "":
		g.Capacity = "on-demand" // older GKE only labels spot and preemptible nodes
	}
	return g
}

// karpenterImages maps node name to status.imageID from Karpenter NodeClaims,
// if the cluster runs Karpenter.
func (s *Session) karpenterImages(ctx context.Context) map[string]string {
	out := map[string]string{}
	t, err := s.typeFor("karpenter.sh/NodeClaim")
	if err != nil {
		return out
	}
	l, err := s.dyn.Resource(t.GVR()).List(ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for _, it := range l.Items {
		node, _, _ := unstructured.NestedString(it.Object, "status", "nodeName")
		img, _, _ := unstructured.NestedString(it.Object, "status", "imageID")
		if node != "" && img != "" {
			out[node] = img
		}
	}
	return out
}
