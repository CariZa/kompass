package kube

import (
	"bufio"
	"context"
	"errors"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ContainerInfo struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"` // "", "init" or "sidecar"
	Default bool   `json:"default"`
}

// PodContainers lists a pod's containers, main ones first. The default is
// the one kubectl logs picks: the default-container annotation, else the
// first main container.
func (s *Session) PodContainers(ctx context.Context, ns, name string) ([]ContainerInfo, error) {
	pod, err := s.cs.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	def := pod.Annotations["kubectl.kubernetes.io/default-container"]
	var out []ContainerInfo
	for _, c := range pod.Spec.Containers {
		out = append(out, ContainerInfo{Name: c.Name})
	}
	for _, c := range pod.Spec.InitContainers {
		kind := "init"
		if c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways {
			kind = "sidecar"
		}
		out = append(out, ContainerInfo{Name: c.Name, Kind: kind})
	}
	for i := range out {
		if out[i].Name == def {
			out[i].Default = true
			return out, nil
		}
	}
	if len(out) > 0 {
		out[0].Default = true
	}
	return out, nil
}

// LogEmit receives log lines in batches. done is set once, when the stream
// ends; err says why if it wasn't a normal end.
type LogEmit func(lines []string, err string, done bool)

const logBatch = 5000

// StreamLogs reads a container's logs (a GET on pods/log) until stop is
// called. With previous it reads the last terminated instance and doesn't
// follow. Lines go straight to emit; nothing is kept here.
func (s *Session) StreamLogs(ns, pod, container string, previous bool, tail int64, emit LogEmit) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	opts := &corev1.PodLogOptions{Container: container, Previous: previous, Follow: !previous}
	if tail > 0 {
		opts.TailLines = &tail
	}
	go func() {
		rc, err := s.cs.CoreV1().Pods(ns).GetLogs(pod, opts).Stream(ctx)
		if err != nil {
			if ctx.Err() == nil {
				emit(nil, err.Error(), true)
			}
			return
		}
		defer rc.Close()

		lines := make(chan string, 1024)
		var scanErr error
		go func() {
			sc := bufio.NewScanner(rc)
			sc.Buffer(make([]byte, 64*1024), 1024*1024)
			for sc.Scan() {
				lines <- sc.Text()
			}
			scanErr = sc.Err() // read after close(lines), so no race
			close(lines)
		}()

		tick := time.NewTicker(200 * time.Millisecond)
		defer tick.Stop()
		var batch []string
		flush := func() {
			if len(batch) > 0 {
				emit(batch, "", false)
				batch = nil
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case l, ok := <-lines:
				if !ok {
					flush()
					if ctx.Err() != nil {
						return
					}
					msg := ""
					if scanErr != nil && !errors.Is(scanErr, context.Canceled) {
						msg = scanErr.Error()
					}
					emit(nil, msg, true)
					return
				}
				if batch = append(batch, l); len(batch) >= logBatch {
					flush()
				}
			case <-tick.C:
				flush()
			}
		}
	}()
	return cancel
}
