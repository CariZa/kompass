package kube

import (
	"sort"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

// Emit receives the full row set for a list whenever it changes, at most a
// few times a second.
type Emit func(rows []Row, err string)

// StartList runs an informer for one list tab until StopList. ns "" means all
// namespaces. Objects live only in the informer's in-memory store.
func (s *Session) StartList(key, ns string, emit Emit) (func(), error) {
	t := Type{Version: "v1", Plural: "secrets", Namespaced: true}
	tweak := func(*metav1.ListOptions) {}
	if key == HelmKey {
		tweak = func(o *metav1.ListOptions) { o.LabelSelector = helmSelector }
	} else {
		var err error
		if t, err = s.typeFor(key); err != nil {
			return nil, err
		}
	}
	if !t.Namespaced {
		ns = ""
	}
	inf := dynamicinformer.NewFilteredDynamicInformer(s.dyn, t.GVR(), ns, 0, cache.Indexers{}, tweak).Informer()
	// Drop managedFields to keep memory down; we never show them.
	inf.SetTransform(func(o any) (any, error) {
		if u, ok := o.(*unstructured.Unstructured); ok {
			u.SetManagedFields(nil)
		}
		return o, nil
	})

	var mu sync.Mutex
	dirty, lastErr := true, ""
	mark := func() { mu.Lock(); dirty = true; mu.Unlock() }
	inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { mark() },
		UpdateFunc: func(any, any) { mark() },
		DeleteFunc: func(any) { mark() },
	})
	inf.SetWatchErrorHandler(func(_ *cache.Reflector, err error) {
		mu.Lock()
		lastErr, dirty = err.Error(), true
		mu.Unlock()
	})

	stop := make(chan struct{})
	go inf.Run(stop)
	go func() {
		tick := time.NewTicker(250 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				mu.Lock()
				d, e := dirty, lastErr
				dirty = false
				if inf.HasSynced() {
					lastErr = ""
				}
				mu.Unlock()
				if !d || (!inf.HasSynced() && e == "") {
					continue
				}
				emit(rowsOf(key, inf.GetStore().List()), e)
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(stop) }) }, nil
}

func rowsOf(key string, objs []any) []Row {
	rows := make([]Row, 0, len(objs))
	if key == HelmKey {
		items := make([]unstructured.Unstructured, 0, len(objs))
		for _, o := range objs {
			items = append(items, *o.(*unstructured.Unstructured))
		}
		rows = helmRowsFrom(items)
	} else {
		for _, o := range objs {
			rows = append(rows, RowFor(key, o.(*unstructured.Unstructured)))
		}
	}
	if key == "core/Event" || key == "events.k8s.io/Event" {
		sort.Slice(rows, func(i, j int) bool { return rows[i].Created > rows[j].Created })
	} else {
		sort.Slice(rows, func(i, j int) bool {
			if rows[i].Namespace != rows[j].Namespace {
				return rows[i].Namespace < rows[j].Namespace
			}
			return rows[i].Name < rows[j].Name
		})
	}
	return rows
}
