// Package pins keeps the one thing Kompass writes to disk: the names of the
// contexts pinned to the rail. No cluster data, tokens or settings go here.
package pins

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

type file struct {
	Pinned []string `json:"pinned"`
}

// Path is ~/Library/Application Support/Kompass/pinned.json on macOS (the
// OS's user config dir elsewhere).
func Path() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "Kompass", "pinned.json"), nil
}

// Load returns the pinned context names; a missing file means none.
func Load(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var f file
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	if f.Pinned == nil {
		f.Pinned = []string{}
	}
	return f.Pinned, nil
}

// Save replaces the pinned list, writing a temp file and renaming it so a
// crash can't leave a half-written file.
func Save(path string, names []string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	seen := map[string]bool{}
	clean := []string{}
	for _, n := range names {
		if n != "" && !seen[n] {
			seen[n] = true
			clean = append(clean, n)
		}
	}
	b, err := json.MarshalIndent(file{Pinned: clean}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pinned-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
