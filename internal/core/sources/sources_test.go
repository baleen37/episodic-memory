package sources

import (
	"reflect"
	"testing"
)

func TestBuiltInSourceAdapters_StableKinds(t *testing.T) {
	adapters := BuiltInSourceAdapters()
	kinds := make([]string, len(adapters))
	for i, a := range adapters {
		kinds[i] = a.Kind()
	}
	want := []string{"claude-projects", "claude-transcripts", "codex-sessions"}
	if !reflect.DeepEqual(kinds, want) {
		t.Fatalf("kinds mismatch: got %v want %v", kinds, want)
	}
}

func TestAdapters_DetectJsonl(t *testing.T) {
	for _, a := range BuiltInSourceAdapters() {
		if !a.Detect("/some/path/file.jsonl") {
			t.Errorf("%s: expected .jsonl detected", a.Kind())
		}
		if a.Detect("/some/path/file.json") {
			t.Errorf("%s: did not expect .json detected", a.Kind())
		}
	}
}
