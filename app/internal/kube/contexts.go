package kube

import (
	"regexp"
	"sort"
	"strings"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

type Context struct {
	Name     string `json:"name"`
	Short    string `json:"short"`
	Where    string `json:"where"`
	Env      string `json:"env"`
	Provider string `json:"provider"` // aws, gcp, azure, kind, or ""

	Cluster   string `json:"cluster"`
	User      string `json:"user"`
	Namespace string `json:"namespace"`
	Server    string `json:"server"`
}

// loadRaw reads ~/.kube/config plus $KUBECONFIG the way kubectl does. It only
// reads; nothing here holds a handle that can write the file back.
func loadRaw() (*clientcmdapi.Config, error) {
	return clientcmd.NewDefaultClientConfigLoadingRules().Load()
}

func LoadContexts() ([]Context, error) {
	raw, err := loadRaw()
	if err != nil {
		return nil, err
	}
	out := make([]Context, 0, len(raw.Contexts))
	for name, c := range raw.Contexts {
		short, where, env := ParseName(name)
		cx := Context{Name: name, Short: short, Where: where, Env: env, Cluster: c.Cluster, User: c.AuthInfo, Namespace: c.Namespace}
		if cl := raw.Clusters[c.Cluster]; cl != nil {
			cx.Server = cl.Server
		}
		cx.Provider = ProviderOf(name, cx.Server)
		out = append(out, cx)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

var (
	reEKS      = regexp.MustCompile(`^arn:aws:eks:([^:]+):(\d+):cluster/(.+)$`)
	reGKE      = regexp.MustCompile(`^gke_([^_]+)_([^_]+)_(.+)$`)
	reKind     = regexp.MustCompile(`^kind-(.+)$`)
	reEksctl   = regexp.MustCompile(`^([^@]+)@([^.]+)\.([^.]+)\.eksctl\.io$`)
	reTeleport = regexp.MustCompile(`^teleport\.[^-]+-(.+)$`)
	reDev      = regexp.MustCompile(`dev|sandbox|experiment`)
	reLocal    = regexp.MustCompile(`kind|local|docker-desktop|minikube`)
)

// ParseName derives the short name, where it runs and the environment from a
// context name. Mirrors parseCtx in the mockups.
func ParseName(n string) (short, where, env string) {
	short, where = n, "kubeconfig"
	if m := reEKS.FindStringSubmatch(n); m != nil {
		short, where = m[3], "EKS · "+m[1]+" · "+m[2]
	} else if m := reGKE.FindStringSubmatch(n); m != nil {
		short, where = m[3], "GKE · "+m[2]+" · "+m[1]
	} else if m := reKind.FindStringSubmatch(n); m != nil {
		short, where = m[1], "kind"
	} else if m := reEksctl.FindStringSubmatch(n); m != nil {
		short, where = m[2], "eksctl · "+m[3]+" · user "+m[1]
	} else if m := reTeleport.FindStringSubmatch(n); m != nil {
		short, where = m[1], "Teleport"
	}
	switch {
	case strings.Contains(n, "prod"):
		env = "prod"
	case strings.Contains(n, "stag"):
		env = "staging"
	case reDev.MatchString(n):
		env = "dev"
	case reLocal.MatchString(n):
		env = "local"
	default:
		env = "other"
	}
	return
}

// restConfigFor builds a guarded client config for one context. Passing a nil
// ConfigAccess means client-go has no persister, so legacy auth providers
// can't write refreshed tokens back into the kubeconfig.
func restConfigFor(raw *clientcmdapi.Config, name string) (*rest.Config, error) {
	cfg, err := clientcmd.NewNonInteractiveClientConfig(*raw, name, &clientcmd.ConfigOverrides{}, nil).ClientConfig()
	if err != nil {
		return nil, err
	}
	cfg.QPS, cfg.Burst = 50, 100
	cfg.UserAgent = "kompass (read-only)"
	Guard(cfg)
	return cfg, nil
}

// AuthSummary describes how a context authenticates, for the Cluster card.
func authSummary(raw *clientcmdapi.Config, name string) string {
	c := raw.Contexts[name]
	if c == nil {
		return ""
	}
	u := raw.AuthInfos[c.AuthInfo]
	switch {
	case u == nil:
		return "none"
	case u.Exec != nil:
		return "exec: " + strings.TrimSpace(u.Exec.Command+" "+strings.Join(u.Exec.Args, " "))
	case u.AuthProvider != nil:
		return "auth provider: " + u.AuthProvider.Name
	case u.Token != "" || u.TokenFile != "":
		return "bearer token"
	case len(u.ClientCertificateData) > 0 || u.ClientCertificate != "":
		return "client certificate"
	case u.Username != "":
		return "basic auth"
	}
	return "none"
}

// ProviderOf guesses the cloud from the context name and API server URL.
// Teleport and other proxied contexts give no hint, so they stay "".
func ProviderOf(name, server string) string {
	switch {
	case reEKS.MatchString(name) || reEksctl.MatchString(name) || strings.Contains(server, ".eks.amazonaws.com"):
		return "aws"
	case reGKE.MatchString(name) || strings.Contains(server, "container.googleapis.com"):
		return "gcp"
	case strings.Contains(server, ".azmk8s.io") || strings.Contains(server, ".azure.com"):
		return "azure"
	case reKind.MatchString(name):
		return "kind"
	}
	return ""
}
