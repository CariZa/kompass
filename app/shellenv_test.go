package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestParseShellEnv(t *testing.T) {
	out := "Last login: Thu\nwelcome!\n" + envMark + "/opt/homebrew/bin:/usr/bin\n/Users/x/.kube/a:/Users/x/.kube/b" + envMark + "\nbye"
	path, kc, ok := parseShellEnv(out)
	if !ok || path != "/opt/homebrew/bin:/usr/bin" || kc != "/Users/x/.kube/a:/Users/x/.kube/b" {
		t.Fatalf("got %q %q %v", path, kc, ok)
	}
	if _, _, ok := parseShellEnv("no markers here"); ok {
		t.Fatal("want !ok without markers")
	}
	if _, kc, ok := parseShellEnv(envMark + "/usr/bin\n" + envMark); !ok || kc != "" {
		t.Fatalf("empty KUBECONFIG: %q %v", kc, ok)
	}
}

func TestMergePath(t *testing.T) {
	got := mergePath("/a:/usr/bin:/b", "/usr/bin:/bin:/a")
	if got != "/a:/usr/bin:/b:/bin" {
		t.Fatal(got)
	}
}

// Run on a dev machine to check the real login shell:
//
//	KOMPASS_IT_SHELLENV=gke-gcloud-auth-plugin go test -run ShellEnvIT .
func TestShellEnvIT(t *testing.T) {
	bin := os.Getenv("KOMPASS_IT_SHELLENV")
	if bin == "" {
		t.Skip("KOMPASS_IT_SHELLENV not set")
	}
	t.Setenv("TERM", "")
	t.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin") // what launchd gives a Finder launch
	t.Setenv("KUBECONFIG", "")
	importShellEnv()
	p, err := exec.LookPath(bin)
	if err != nil {
		t.Fatalf("%s still not found after importing the shell env: %v", bin, err)
	}
	t.Logf("found %s; KUBECONFIG=%q", p, os.Getenv("KUBECONFIG"))
}
