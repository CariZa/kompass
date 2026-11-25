package kube

import (
	"fmt"
	"net/http"
	"strings"

	"k8s.io/client-go/rest"
)

// ErrWriteBlocked is returned for any request that isn't a plain read.
type ErrWriteBlocked struct {
	Method string
	Path   string
	Reason string
}

func (e *ErrWriteBlocked) Error() string {
	return fmt.Sprintf("kompass is read-only: blocked %s %s (%s)", e.Method, e.Path, e.Reason)
}

// Subresources that stream into or out of a container, or proxy to it. They
// can be reached with GET plus an upgrade, so the method check alone isn't enough.
var blockedSubresources = map[string]bool{
	"exec":        true,
	"attach":      true,
	"portforward": true,
	"proxy":       true,
}

// CheckReadOnly allows only GET/HEAD requests that don't upgrade the
// connection and don't target an interactive subresource. get, list and
// watch are all plain GETs, so they pass.
func CheckReadOnly(r *http.Request) error {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return &ErrWriteBlocked{r.Method, r.URL.Path, "only get, list and watch are allowed"}
	}
	if r.Header.Get("Upgrade") != "" || strings.EqualFold(r.Header.Get("Connection"), "upgrade") {
		return &ErrWriteBlocked{r.Method, r.URL.Path, "connection upgrades are not allowed"}
	}
	for _, seg := range strings.Split(r.URL.Path, "/") {
		if blockedSubresources[seg] {
			return &ErrWriteBlocked{r.Method, r.URL.Path, seg + " is not allowed"}
		}
	}
	return nil
}

type readOnlyTransport struct{ next http.RoundTripper }

func (t readOnlyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if err := CheckReadOnly(r); err != nil {
		return nil, err
	}
	return t.next.RoundTrip(r)
}

// Guard wraps cfg so every client built from it can only read. client-go
// applies WrapTransport outermost, after auth, so nothing gets past it.
func Guard(cfg *rest.Config) {
	cfg.Wrap(func(rt http.RoundTripper) http.RoundTripper { return readOnlyTransport{rt} })
}
