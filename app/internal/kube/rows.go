package kube

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// Row is one line of a list tab. Created is unix seconds; the UI renders age.
type Row struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"`
	Status    string            `json:"status"`
	Ready     string            `json:"ready,omitempty"`
	Restarts  int64             `json:"restarts"`
	Node      string            `json:"node,omitempty"`
	Created   int64             `json:"created"`
	Extra     map[string]string `json:"extra,omitempty"`
}

func str(o map[string]any, path ...string) string {
	s, _, _ := unstructured.NestedString(o, path...)
	return s
}

func num(o map[string]any, path ...string) int64 {
	v, ok, _ := unstructured.NestedFieldNoCopy(o, path...)
	if !ok {
		return 0
	}
	switch n := v.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return 0
}

func slice(o map[string]any, path ...string) []any {
	s, _, _ := unstructured.NestedSlice(o, path...)
	return s
}

func RowFor(key string, obj *unstructured.Unstructured) Row {
	o := obj.Object
	r := Row{Name: obj.GetName(), Namespace: obj.GetNamespace(), Created: obj.GetCreationTimestamp().Unix()}
	switch key {
	case "core/Pod":
		podRow(obj, &r)
	case "core/Node":
		r.Status = condStatus(o, "Ready", "Ready", "NotReady")
		if b, _, _ := unstructured.NestedBool(o, "spec", "unschedulable"); b {
			r.Status += ",SchedulingDisabled"
		}
		r.Extra = map[string]string{"version": str(o, "status", "nodeInfo", "kubeletVersion")}
	case "apps/Deployment", "apps/StatefulSet", "apps/ReplicaSet", "core/ReplicationController":
		r.Status = fmt.Sprintf("%d/%d", num(o, "status", "readyReplicas"), num(o, "spec", "replicas"))
	case "apps/DaemonSet":
		r.Status = fmt.Sprintf("%d/%d", num(o, "status", "numberReady"), num(o, "status", "desiredNumberScheduled"))
	case "batch/Job":
		r.Status = "Running"
		for _, c := range slice(o, "status", "conditions") {
			cm, _ := c.(map[string]any)
			if (cm["type"] == "Complete" || cm["type"] == "Failed") && cm["status"] == "True" {
				r.Status = cm["type"].(string)
			}
		}
	case "batch/CronJob":
		r.Status = "Active"
		if b, _, _ := unstructured.NestedBool(o, "spec", "suspend"); b {
			r.Status = "Suspended"
		}
	case "core/Service":
		r.Status = str(o, "spec", "type")
	case "core/Secret":
		r.Status = str(o, "type")
	case "core/Event", "events.k8s.io/Event":
		r.Status = str(o, "type")
		obj := str(o, "involvedObject", "kind") + "/" + str(o, "involvedObject", "name")
		if obj == "/" {
			obj = str(o, "regarding", "kind") + "/" + str(o, "regarding", "name")
		}
		msg := str(o, "message")
		if msg == "" {
			msg = str(o, "note")
		}
		r.Extra = map[string]string{"reason": str(o, "reason"), "object": obj, "message": msg,
			"count": fmt.Sprint(num(o, "count"))}
	default:
		r.Status = genericStatus(o)
	}
	return r
}

// podRow ports kubectl's STATUS, READY and RESTARTS columns (printPod in
// k8s.io/kubernetes/pkg/printers/internalversion). Native sidecars, init
// containers with restartPolicy: Always, keep running for the pod's life:
// once started they don't hold the pod in Init, and they count towards READY.
func podRow(obj *unstructured.Unstructured, r *Row) {
	var pod corev1.Pod
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &pod); err != nil {
		r.Status = genericStatus(obj.Object)
		return
	}
	r.Node = pod.Spec.NodeName
	reason := string(pod.Status.Phase)
	if pod.Status.Reason != "" {
		reason = pod.Status.Reason
	}

	sidecars := map[string]bool{}
	total, ready := len(pod.Spec.Containers), 0
	for _, c := range pod.Spec.InitContainers {
		if c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways {
			sidecars[c.Name] = true
			total++
		}
	}

	var restarts, sidecarRestarts int64
	initializing := false
	for i, c := range pod.Status.InitContainerStatuses {
		restarts += int64(c.RestartCount)
		started := c.Started != nil && *c.Started
		if sidecars[c.Name] {
			sidecarRestarts += int64(c.RestartCount)
			if started && c.Ready {
				ready++
			}
		}
		switch {
		case c.State.Terminated != nil && c.State.Terminated.ExitCode == 0:
			continue
		case sidecars[c.Name] && started:
			continue
		case c.State.Terminated != nil:
			reason = "Init:" + exitReason(c.State.Terminated)
		case c.State.Waiting != nil && c.State.Waiting.Reason != "" && c.State.Waiting.Reason != "PodInitializing":
			reason = "Init:" + c.State.Waiting.Reason
		default:
			reason = fmt.Sprintf("Init:%d/%d", i, len(pod.Spec.InitContainers))
		}
		initializing = true
		break
	}

	if !initializing || podCondition(&pod, corev1.PodInitialized) {
		restarts = sidecarRestarts
		hasRunning := false
		for i := len(pod.Status.ContainerStatuses) - 1; i >= 0; i-- {
			c := pod.Status.ContainerStatuses[i]
			restarts += int64(c.RestartCount)
			switch {
			case c.State.Waiting != nil && c.State.Waiting.Reason != "":
				reason = c.State.Waiting.Reason
			case c.State.Terminated != nil:
				reason = exitReason(c.State.Terminated)
			case c.Ready && c.State.Running != nil:
				hasRunning = true
				ready++
			}
		}
		// A completed container next to a running one isn't a completed pod.
		if reason == "Completed" && hasRunning {
			if podCondition(&pod, corev1.PodReady) {
				reason = "Running"
			} else {
				reason = "NotReady"
			}
		}
	}

	if pod.DeletionTimestamp != nil {
		reason = "Terminating"
		if pod.Status.Reason == "NodeLost" {
			reason = "Unknown"
		}
	}
	r.Status, r.Ready, r.Restarts = reason, fmt.Sprintf("%d/%d", ready, total), restarts
}

func exitReason(t *corev1.ContainerStateTerminated) string {
	switch {
	case t.Reason != "":
		return t.Reason
	case t.Signal != 0:
		return fmt.Sprintf("Signal:%d", t.Signal)
	}
	return fmt.Sprintf("ExitCode:%d", t.ExitCode)
}

func podCondition(pod *corev1.Pod, typ corev1.PodConditionType) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == typ {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func condStatus(o map[string]any, typ, yes, no string) string {
	for _, c := range slice(o, "status", "conditions") {
		cm, _ := c.(map[string]any)
		if cm["type"] == typ {
			if cm["status"] == "True" {
				return yes
			}
			if r, _ := cm["reason"].(string); r != "" && no == "" {
				return r
			}
			if no == "" {
				return "Not" + typ
			}
			return no
		}
	}
	return ""
}

// genericStatus is a best effort for kinds without a known shape: phase,
// then the common Ready / Available / Synced conditions, then Argo's sync.
func genericStatus(o map[string]any) string {
	if p := str(o, "status", "phase"); p != "" {
		return p
	}
	for _, c := range []string{"Ready", "Available", "Established", "Healthy"} {
		if s := condStatus(o, c, c, ""); s != "" {
			return s
		}
	}
	if s := condStatus(o, "Synced", "Synced", ""); s != "" {
		return s
	}
	if s := str(o, "status", "sync", "status"); s != "" {
		return s
	}
	if s := str(o, "status", "health", "status"); s != "" {
		return s
	}
	return ""
}
