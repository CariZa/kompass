package main

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const envMark = "__KOMPASS_ENV__"

// importShellEnv copies PATH and KUBECONFIG from the user's login shell.
// Apps started from Finder or the Dock get launchd's minimal environment, so
// exec auth plugins put on PATH by shell rc files (gke-gcloud-auth-plugin,
// aws) can't be found. It only reads the shell's output; nothing is written.
func importShellEnv() {
	if runtime.GOOS == "windows" || os.Getenv("TERM") != "" {
		return // launched from a terminal: the environment is already the shell's
	}
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// -i as well as -l: tools like the gcloud SDK add themselves in .zshrc.
	// Interactive shells can exit non-zero or print noise, so only the text
	// between the markers counts.
	out, _ := exec.CommandContext(ctx, sh, "-ilc", `printf '`+envMark+`%s\n%s`+envMark+`' "$PATH" "$KUBECONFIG"`).Output()
	path, kubeconfig, ok := parseShellEnv(string(out))
	if !ok {
		return
	}
	os.Setenv("PATH", mergePath(path, os.Getenv("PATH")))
	if os.Getenv("KUBECONFIG") == "" && kubeconfig != "" {
		os.Setenv("KUBECONFIG", kubeconfig)
	}
}

func parseShellEnv(out string) (path, kubeconfig string, ok bool) {
	i := strings.Index(out, envMark)
	j := strings.LastIndex(out, envMark)
	if i < 0 || j <= i {
		return "", "", false
	}
	body := out[i+len(envMark) : j]
	path, kubeconfig, _ = strings.Cut(body, "\n")
	return path, kubeconfig, path != ""
}

// mergePath puts the shell's entries first and keeps any others, without
// duplicates.
func mergePath(shell, current string) string {
	seen := map[string]bool{}
	var out []string
	for _, p := range append(strings.Split(shell, ":"), strings.Split(current, ":")...) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return strings.Join(out, ":")
}
