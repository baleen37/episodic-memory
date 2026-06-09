// Package project resolves a canonical project identity (org/repo + project
// name) from a transcript's working directory by reading the git remote.
//
// Ported from src/core/project.ts. CGO-free; DefaultGitReader shells out to git.
package project

import (
	"os/exec"
	"regexp"
	"strings"
)

// Info is the resolved project identity.
type Info struct {
	Project     string
	ProjectName string
}

// GitReader reads the org/repo from a repo root's git remote.
// ok is false when no org/repo could be determined (TS string|null → "", false).
type GitReader interface {
	ReadRemoteOrgRepo(repoRoot string) (orgRepo string, ok bool)
}

var unknown = Info{Project: "unknown", ProjectName: "unknown"}

var (
	// scp-like: git@github.com:org/repo.git  → ^[^@]+@[^:]+:(.+)$
	scpRe = regexp.MustCompile(`^[^@]+@[^:]+:(.+)$`)
	// proto: https://host/org/repo.git       → ^[a-z]+://[^/]+/(.+)$ (case-insensitive)
	protoRe = regexp.MustCompile(`(?i)^[a-z]+://[^/]+/(.+)$`)
	// trailing slashes
	trailingSlashRe = regexp.MustCompile(`/+$`)
	// trailing .git
	gitSuffixRe = regexp.MustCompile(`\.git$`)
)

// NormalizeRepoRoot strips everything from "/.worktrees/" onward (mapping a
// worktree path to its main repo root), then strips trailing slashes.
func NormalizeRepoRoot(cwd string) string {
	const marker = "/.worktrees/"
	root := cwd
	if i := strings.Index(cwd, marker); i >= 0 {
		root = cwd[:i]
	}
	return trailingSlashRe.ReplaceAllString(root, "")
}

func leaf(repoRoot string) string {
	parts := splitNonEmpty(repoRoot, "/")
	if len(parts) == 0 {
		return "unknown"
	}
	return parts[len(parts)-1]
}

// ParseOrgRepo extracts "org/repo" from a git remote URL. ok is false when the
// URL is malformed or has fewer than two path segments.
func ParseOrgRepo(remoteURL string) (orgRepo string, ok bool) {
	s := strings.TrimSpace(remoteURL)
	if s == "" {
		return "", false
	}
	if m := scpRe.FindStringSubmatch(s); m != nil {
		s = m[1]
	} else if m := protoRe.FindStringSubmatch(s); m != nil {
		s = m[1]
	} else if strings.Contains(s, "://") || strings.Contains(s, "@") {
		return "", false
	} else if !strings.Contains(s, "/") {
		return "", false
	}
	s = gitSuffixRe.ReplaceAllString(s, "")
	s = trailingSlashRe.ReplaceAllString(s, "")
	parts := splitNonEmpty(s, "/")
	if len(parts) < 2 {
		return "", false
	}
	return parts[len(parts)-2] + "/" + parts[len(parts)-1], true
}

// DefaultGitReader shells out to git to read remote.origin.url.
type DefaultGitReader struct{}

// ReadRemoteOrgRepo runs `git -C <repoRoot> config --get remote.origin.url`,
// trims the result, and returns ok=false on empty output or any error.
func (DefaultGitReader) ReadRemoteOrgRepo(repoRoot string) (string, bool) {
	cmd := exec.Command("git", "-C", repoRoot, "config", "--get", "remote.origin.url")
	out, err := cmd.Output() // stderr ignored, non-zero exit → err
	if err != nil {
		return "", false
	}
	url := strings.TrimSpace(string(out))
	if url == "" {
		return "", false
	}
	return ParseOrgRepo(url)
}

// ResolveProject resolves the project identity for cwd. A nil reader uses
// DefaultGitReader. Empty/whitespace cwd or empty normalized root → unknown.
func ResolveProject(cwd string, reader GitReader) Info {
	if cwd == "" {
		return unknown
	}
	repoRoot := NormalizeRepoRoot(cwd)
	if repoRoot == "" {
		return unknown
	}
	if reader == nil {
		reader = DefaultGitReader{}
	}
	if orgRepo, ok := reader.ReadRemoteOrgRepo(repoRoot); ok {
		parts := splitNonEmpty(orgRepo, "/")
		name := orgRepo
		if len(parts) > 0 {
			name = parts[len(parts)-1]
		}
		return Info{Project: orgRepo, ProjectName: name}
	}
	name := leaf(repoRoot)
	return Info{Project: name, ProjectName: name}
}

func splitNonEmpty(s, sep string) []string {
	raw := strings.Split(s, sep)
	out := raw[:0]
	for _, p := range raw {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
