package kube

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// The shapes below mirror a GKE workload with istio as a
// native sidecar: init containers istio-init, istio-proxy (restartPolicy:
// Always) and configure-sysctl, then the app container.

var always = corev1.ContainerRestartPolicyAlways

func istioSpec() corev1.PodSpec {
	return corev1.PodSpec{
		InitContainers: []corev1.Container{{Name: "istio-init"}, {Name: "istio-proxy", RestartPolicy: &always}, {Name: "configure-sysctl"}},
		Containers:     []corev1.Container{{Name: "app"}},
	}
}

var (
	done      = corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 0, Reason: "Completed"}}
	running   = corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}
	podInit   = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "PodInitializing"}}
	crashLoop = corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}
)

func ptr[T any](v T) *T { return &v }

func cond(t corev1.PodConditionType, ok bool) corev1.PodCondition {
	s := corev1.ConditionFalse
	if ok {
		s = corev1.ConditionTrue
	}
	return corev1.PodCondition{Type: t, Status: s}
}

func rowOf(t *testing.T, pod *corev1.Pod) Row {
	m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(pod)
	if err != nil {
		t.Fatal(err)
	}
	return RowFor("core/Pod", &unstructured.Unstructured{Object: m})
}

func TestPodRowMatchesKubectl(t *testing.T) {
	cases := []struct {
		name                string
		status              corev1.PodStatus
		deleting            bool
		wantStatus, wantRdy string
		wantRestarts        int64
	}{
		{
			name: "running with started sidecar",
			status: corev1.PodStatus{Phase: corev1.PodRunning,
				Conditions: []corev1.PodCondition{cond(corev1.PodInitialized, true), cond(corev1.PodReady, true)},
				InitContainerStatuses: []corev1.ContainerStatus{
					{Name: "istio-init", State: done},
					{Name: "istio-proxy", State: running, Started: ptr(true), Ready: true},
					{Name: "configure-sysctl", State: done},
				},
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", State: running, Ready: true}},
			},
			wantStatus: "Running", wantRdy: "2/2",
		},
		{
			name: "new pod before any init ran",
			status: corev1.PodStatus{Phase: corev1.PodPending,
				InitContainerStatuses: []corev1.ContainerStatus{
					{Name: "istio-init", State: podInit}, {Name: "istio-proxy", State: podInit}, {Name: "configure-sysctl", State: podInit},
				},
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", State: podInit}},
			},
			wantStatus: "Init:0/3", wantRdy: "0/2",
		},
		{
			name: "sidecar running but not started yet",
			status: corev1.PodStatus{Phase: corev1.PodPending,
				InitContainerStatuses: []corev1.ContainerStatus{
					{Name: "istio-init", State: done},
					{Name: "istio-proxy", State: running, Started: ptr(false)},
					{Name: "configure-sysctl", State: podInit},
				},
			},
			wantStatus: "Init:1/3", wantRdy: "0/2",
		},
		{
			name: "init done, main container starting",
			status: corev1.PodStatus{Phase: corev1.PodPending,
				Conditions: []corev1.PodCondition{cond(corev1.PodInitialized, true)},
				InitContainerStatuses: []corev1.ContainerStatus{
					{Name: "istio-init", State: done},
					{Name: "istio-proxy", State: running, Started: ptr(true), Ready: true},
					{Name: "configure-sysctl", State: done},
				},
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", State: podInit}},
			},
			wantStatus: "PodInitializing", wantRdy: "1/2",
		},
		{
			name: "main container crash looping",
			status: corev1.PodStatus{Phase: corev1.PodRunning,
				Conditions: []corev1.PodCondition{cond(corev1.PodInitialized, true), cond(corev1.PodReady, false)},
				InitContainerStatuses: []corev1.ContainerStatus{
					{Name: "istio-init", State: done},
					{Name: "istio-proxy", State: running, Started: ptr(true), Ready: true, RestartCount: 1},
					{Name: "configure-sysctl", State: done},
				},
				ContainerStatuses: []corev1.ContainerStatus{{Name: "app", State: crashLoop, RestartCount: 4}},
			},
			wantStatus: "CrashLoopBackOff", wantRdy: "1/2", wantRestarts: 5,
		},
		{
			name: "init container failed",
			status: corev1.PodStatus{Phase: corev1.PodPending,
				InitContainerStatuses: []corev1.ContainerStatus{
					{Name: "istio-init", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 1, Reason: "Error"}}, RestartCount: 2},
				},
			},
			wantStatus: "Init:Error", wantRdy: "0/2", wantRestarts: 2,
		},
		{
			name:       "terminating",
			status:     corev1.PodStatus{Phase: corev1.PodRunning},
			deleting:   true,
			wantStatus: "Terminating", wantRdy: "0/2",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pod := &corev1.Pod{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Pod"},
				ObjectMeta: metav1.ObjectMeta{Name: "app-0", Namespace: "ns"}, Spec: istioSpec(), Status: c.status}
			if c.deleting {
				now := metav1.Now()
				pod.DeletionTimestamp = &now
			}
			r := rowOf(t, pod)
			if r.Status != c.wantStatus || r.Ready != c.wantRdy || r.Restarts != c.wantRestarts {
				t.Errorf("got %s %s restarts=%d, want %s %s restarts=%d", r.Status, r.Ready, r.Restarts, c.wantStatus, c.wantRdy, c.wantRestarts)
			}
		})
	}
}
