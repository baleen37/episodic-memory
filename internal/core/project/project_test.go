package project

import (
	"reflect"
	"testing"
)

// fakeGitReader injects a fixed result and records the roots it was queried with.
type fakeGitReader struct {
	orgRepo string
	ok      bool
	seen    []string
}

func (f *fakeGitReader) ReadRemoteOrgRepo(root string) (string, bool) {
	f.seen = append(f.seen, root)
	return f.orgRepo, f.ok
}

// noGit always reports "no remote".
var noGit = &fakeGitReader{}

func TestNormalizeRepoRoot(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"worktree stripped", "/home/u/proj/.worktrees/feat-x", "/home/u/proj"},
		{"plain path unchanged", "/Users/jito.hello/dev/search", "/Users/jito.hello/dev/search"},
		{"trailing slash stripped", "/Users/jito.hello/dev/search/", "/Users/jito.hello/dev/search"},
		{"multiple trailing slashes stripped", "/a/b///", "/a/b"},
		{"worktree then trailing slash", "/home/u/proj/.worktrees/x/", "/home/u/proj"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NormalizeRepoRoot(c.in); got != c.want {
				t.Fatalf("NormalizeRepoRoot(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestParseOrgRepo(t *testing.T) {
	cases := []struct {
		name   string
		in     string
		want   string
		wantOk bool
	}{
		{"https url", "https://github.com/croquis/memmem.git", "croquis/memmem", true},
		{"https without .git", "https://github.com/croquis/memmem", "croquis/memmem", true},
		{"ssh scp-like", "git@github.com:croquis/memmem.git", "croquis/memmem", true},
		{"ssh with protocol", "ssh://git@github.com/croquis/memmem.git", "croquis/memmem", true},
		{"trailing slash tolerated", "https://github.com/croquis/memmem/", "croquis/memmem", true},
		{"unparseable returns null", "not-a-url", "", false},
		{"empty string", "", "", false},
		{"has :// but malformed", "https://github.com", "", false},
		{"has @ but malformed", "git@github.com", "", false},
		{"single segment scp-like", "git@github.com:repo.git", "", false},
		{"uppercase scheme", "HTTPS://github.com/croquis/memmem.git", "croquis/memmem", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ParseOrgRepo(c.in)
			if got != c.want || ok != c.wantOk {
				t.Fatalf("ParseOrgRepo(%q) = (%q, %v), want (%q, %v)", c.in, got, ok, c.want, c.wantOk)
			}
		})
	}
}

func TestResolveProjectFallbackNoGit(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want Info
	}{
		{
			"strips worktree suffix and uses leaf",
			"/Users/jito.hello/dev/wooto/ssulmeta/.worktrees/00058-proud-harbor-bachman",
			Info{Project: "ssulmeta", ProjectName: "ssulmeta"},
		},
		{"plain repo path uses leaf", "/Users/jito.hello/dev/search", Info{Project: "search", ProjectName: "search"}},
		{"non-standard path uses leaf", "/private/tmp", Info{Project: "tmp", ProjectName: "tmp"}},
		{"empty cwd yields unknown", "", Info{Project: "unknown", ProjectName: "unknown"}},
		{"trailing slash tolerated", "/Users/jito.hello/dev/search/", Info{Project: "search", ProjectName: "search"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ResolveProject(c.in, noGit); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("ResolveProject(%q) = %+v, want %+v", c.in, got, c.want)
			}
		})
	}
}

func TestResolveProjectGitRemoteWins(t *testing.T) {
	t.Run("uses org/repo from gitReader, name is repo basename", func(t *testing.T) {
		reader := &fakeGitReader{orgRepo: "croquis/memmem", ok: true}
		got := ResolveProject("/Users/jito.hello/dev/wooto/memmem", reader)
		want := Info{Project: "croquis/memmem", ProjectName: "memmem"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("worktree cwd still resolves via repoRoot git", func(t *testing.T) {
		reader := &fakeGitReader{orgRepo: "croquis/memmem", ok: true}
		got := ResolveProject("/Users/jito.hello/dev/wooto/memmem/.worktrees/00008-x", reader)
		want := Info{Project: "croquis/memmem", ProjectName: "memmem"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
		if !reflect.DeepEqual(reader.seen, []string{"/Users/jito.hello/dev/wooto/memmem"}) {
			t.Fatalf("git read with %v, want normalized repoRoot", reader.seen)
		}
	})
}

func TestResolveProjectNilReaderUsesDefault(t *testing.T) {
	// Non-existent path → DefaultGitReader returns no remote → leaf fallback.
	got := ResolveProject("/no/such/path/xyz", nil)
	want := Info{Project: "xyz", ProjectName: "xyz"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestDefaultGitReaderNeverThrows(t *testing.T) {
	t.Run("returns false for a non-existent path", func(t *testing.T) {
		if _, ok := (DefaultGitReader{}).ReadRemoteOrgRepo("/no/such/path/xyz"); ok {
			t.Fatal("expected ok=false for non-existent path")
		}
	})
}
