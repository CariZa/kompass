package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	"kompass/internal/kube"
	"kompass/internal/pins"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the surface the frontend calls. Everything it holds is in memory and
// goes away with the process.
type App struct {
	ctx context.Context

	mu       sync.Mutex
	sessions map[string]*kube.Session
	lists    map[string]listHandle // by list id
}

type listHandle struct {
	ctx  string
	stop func()
}

func NewApp() *App {
	return &App{sessions: map[string]*kube.Session{}, lists: map[string]listHandle{}}
}

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

func (a *App) shutdown(context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, l := range a.lists {
		l.stop()
		delete(a.lists, id)
	}
}

func (a *App) session(name string) (*kube.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.sessions[name]
	if s == nil {
		return nil, fmt.Errorf("context %s isn't open", name)
	}
	return s, nil
}

func (a *App) timeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(a.ctx, 30*time.Second)
}

func (a *App) Contexts() ([]kube.Context, error) { return kube.LoadContexts() }

// Pinned returns the context names pinned to the rail.
func (a *App) Pinned() ([]string, error) {
	p, err := pins.Path()
	if err != nil {
		return nil, err
	}
	return pins.Load(p)
}

// SetPinned saves the pinned context names, in rail order.
func (a *App) SetPinned(names []string) error {
	p, err := pins.Path()
	if err != nil {
		return err
	}
	return pins.Save(p, names)
}

type Connected struct {
	Types      []kube.Type `json:"types"`
	Namespaces []string    `json:"namespaces"`
	NSError    string      `json:"nsError,omitempty"`
}

// Connect opens a context (or reuses an open one) and runs discovery.
func (a *App) Connect(name string) (*Connected, error) {
	a.mu.Lock()
	s := a.sessions[name]
	a.mu.Unlock()
	if s == nil {
		var err error
		if s, err = kube.Open(name); err != nil {
			return nil, err
		}
	}
	ctx, cancel := a.timeout()
	defer cancel()
	types, err := s.Discover(ctx)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.sessions[name] = s
	a.mu.Unlock()
	out := &Connected{Types: types}
	if out.Namespaces, err = s.Namespaces(ctx); err != nil {
		out.NSError = err.Error()
	}
	return out, nil
}

func (a *App) CloseContext(name string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, l := range a.lists {
		if l.ctx == name {
			l.stop()
			delete(a.lists, id)
		}
	}
	delete(a.sessions, name)
}

type CountEvent struct {
	Ctx   string `json:"ctx"`
	Token string `json:"token"`
	Key   string `json:"key"`
	N     int    `json:"n"`
	Err   string `json:"err,omitempty"`
}

// Counts counts each type in the background and emits a "counts" event per
// type. token lets the UI drop answers for a namespace it has since left.
func (a *App) Counts(name, ns, token string, keys []string) error {
	s, err := a.session(name)
	if err != nil {
		return err
	}
	go func() {
		ctx, cancel := context.WithTimeout(a.ctx, 2*time.Minute)
		defer cancel()
		sem := make(chan struct{}, 8)
		var wg sync.WaitGroup
		for _, k := range keys {
			wg.Add(1)
			sem <- struct{}{}
			go func(k string) {
				defer func() { <-sem; wg.Done() }()
				n, err := s.Count(ctx, k, ns)
				ev := CountEvent{Ctx: name, Token: token, Key: k, N: n}
				if err != nil {
					ev.Err = err.Error()
				}
				runtime.EventsEmit(a.ctx, "counts", ev)
			}(k)
		}
		wg.Wait()
	}()
	return nil
}

type ListEvent struct {
	ID   string     `json:"id"`
	Rows []kube.Row `json:"rows"`
	Err  string     `json:"err,omitempty"`
}

// StartList starts a live list for a list tab; rows arrive as "list" events.
func (a *App) StartList(name, id, key, ns string) error {
	s, err := a.session(name)
	if err != nil {
		return err
	}
	a.StopList(id)
	stop, err := s.StartList(key, ns, func(rows []kube.Row, e string) {
		runtime.EventsEmit(a.ctx, "list", ListEvent{ID: id, Rows: rows, Err: e})
	})
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.lists[id] = listHandle{ctx: name, stop: stop}
	a.mu.Unlock()
	return nil
}

func (a *App) PodContainers(name, ns, pod string) ([]kube.ContainerInfo, error) {
	s, err := a.session(name)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.timeout()
	defer cancel()
	return s.PodContainers(ctx, ns, pod)
}

type LogEvent struct {
	ID    string   `json:"id"`
	Lines []string `json:"lines"`
	Err   string   `json:"err,omitempty"`
	Done  bool     `json:"done"`
}

// StartLogs streams a container's logs as "logs" events until StopList(id).
// Streams share the list registry so closing a context stops both.
func (a *App) StartLogs(name, id, ns, pod, container string, previous bool, tail int64) error {
	s, err := a.session(name)
	if err != nil {
		return err
	}
	a.StopList(id)
	stop := s.StreamLogs(ns, pod, container, previous, tail, func(lines []string, e string, done bool) {
		runtime.EventsEmit(a.ctx, "logs", LogEvent{ID: id, Lines: lines, Err: e, Done: done})
	})
	a.mu.Lock()
	a.lists[id] = listHandle{ctx: name, stop: stop}
	a.mu.Unlock()
	return nil
}

// StopList stops a live list or a log stream.
func (a *App) StopList(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if l, ok := a.lists[id]; ok {
		l.stop()
		delete(a.lists, id)
	}
}

func (a *App) Describe(name, key, ns, res string) (string, error) {
	s, err := a.session(name)
	if err != nil {
		return "", err
	}
	ctx, cancel := a.timeout()
	defer cancel()
	return s.Describe(ctx, key, ns, res)
}

func (a *App) YAML(name, key, ns, res string) (string, error) {
	s, err := a.session(name)
	if err != nil {
		return "", err
	}
	ctx, cancel := a.timeout()
	defer cancel()
	return s.YAML(ctx, key, ns, res)
}

func (a *App) SecretKeys(name, ns, res string) ([]string, error) {
	s, err := a.session(name)
	if err != nil {
		return nil, err
	}
	ctx, cancel := a.timeout()
	defer cancel()
	return s.SecretKeys(ctx, ns, res)
}

func (a *App) RevealSecretKey(name, ns, res, key string) (string, error) {
	s, err := a.session(name)
	if err != nil {
		return "", err
	}
	ctx, cancel := a.timeout()
	defer cancel()
	return s.RevealSecretKey(ctx, ns, res, key)
}

func (a *App) ClusterInfo(name string) (kube.ClusterInfo, error) {
	s, err := a.session(name)
	if err != nil {
		return kube.ClusterInfo{}, err
	}
	return s.Info(), nil
}

// ClusterDetails lists well-known add-ons with their versions and the
// kubelet versions across nodes, for the Cluster tab.
func (a *App) ClusterDetails(name string) (kube.ClusterDetails, error) {
	s, err := a.session(name)
	if err != nil {
		return kube.ClusterDetails{}, err
	}
	ctx, cancel := context.WithTimeout(a.ctx, time.Minute)
	defer cancel()
	return s.Details(ctx), nil
}
