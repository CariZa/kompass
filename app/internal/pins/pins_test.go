package pins

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Kompass", "pinned.json")
	got, err := Load(path)
	if err != nil || len(got) != 0 {
		t.Fatalf("missing file: %v %v", got, err)
	}
	if err := Save(path, []string{"b", "a", "b", ""}); err != nil {
		t.Fatal(err)
	}
	if got, _ = Load(path); !reflect.DeepEqual(got, []string{"b", "a"}) {
		t.Fatalf("got %v", got)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("perm: %v %v", st.Mode(), err)
	}
	if err := Save(path, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ = Load(path); len(got) != 0 {
		t.Fatalf("cleared: %v", got)
	}
}
