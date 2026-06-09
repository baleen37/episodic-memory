package sources

import (
	"os"
	"path/filepath"
	"strings"
)

// codexMeta carries session/turn-level metadata snapshotted onto each span.
// Mirrors CodexMeta in src/core/sources/codex.ts.
type codexMeta struct {
	sessionID *string
	cwd       *string
	gitBranch *string
	model     *string
}

// pendingCodexSpan accumulates a user message and the assistant messages that
// follow it. Mirrors PendingCodexSpan in src/core/sources/codex.ts.
type pendingCodexSpan struct {
	sessionID      *string
	cwd            *string
	gitBranch      *string
	model          *string
	lineStart      int64
	lineEnd        int64
	observedAt     *int64
	userText       string
	assistantTexts []string
}

// codexMetadataJSON is the constant metadata JSON attached to every codex span,
// matching JSON.stringify({ source: 'codex' }).
const codexMetadataJSON = `{"source":"codex"}`

// ParseCodexJsonl parses Codex session rollout JSONL into transcript spans.
// Ports parseCodexJsonl in src/core/sources/codex.ts.
func ParseCodexJsonl(content string, ctx ParseContext) []TranscriptSpan {
	spans := []TranscriptSpan{}
	meta := codexMeta{}
	var current *pendingCodexSpan

	flushCurrent := func() {
		if current == nil {
			return
		}
		text := formatSpanText(current.userText, strings.Join(current.assistantTexts, "\n"))
		if strings.TrimSpace(text) != "" {
			provider := "codex"
			metadata := codexMetadataJSON
			spans = append(spans, TranscriptSpan{
				ArchivePath:  ctx.ArchivePath,
				LineStart:    current.lineStart,
				LineEnd:      current.lineEnd,
				SourceKind:   ctx.SourceKind,
				SessionID:    current.sessionID,
				Project:      nil,
				Cwd:          meta.cwd,
				GitBranch:    meta.gitBranch,
				Model:        current.model,
				Provider:     &provider,
				MetadataJSON: &metadata,
				ObservedAt:   current.observedAt,
				Text:         text,
			})
		}
		current = nil
	}

	eachJsonLine(content, func(item jsonObject, lineNumber int64) {
		itemType, _ := item["type"].(string)

		if itemType == "session_meta" {
			payload := asObject(item["payload"])
			if payload != nil {
				meta.sessionID = asString(payload["id"])
				meta.cwd = asString(payload["cwd"])
				meta.gitBranch = asString(objectField(asObject(payload["git"]), "branch"))
				meta.model = asString(payload["model"])
			}
			return
		}

		if itemType == "turn_context" {
			payload := asObject(item["payload"])
			if payload != nil {
				if v := asString(payload["cwd"]); v != nil {
					meta.cwd = v
				}
				if v := asString(payload["model"]); v != nil {
					meta.model = v
				}
			}
			return
		}

		if itemType != "response_item" {
			return
		}

		payload := asObject(item["payload"])
		if payload == nil {
			return
		}

		if payloadType, _ := payload["type"].(string); payloadType == "message" {
			role := asString(payload["role"])
			if role != nil && *role == "user" {
				flushCurrent()
				current = &pendingCodexSpan{
					lineStart:      lineNumber,
					lineEnd:        lineNumber,
					sessionID:      meta.sessionID,
					cwd:            meta.cwd,
					gitBranch:      meta.gitBranch,
					model:          meta.model,
					observedAt:     parseTimestamp(item["timestamp"]),
					userText:       strings.TrimSpace(extractCodexText(payload["content"])),
					assistantTexts: []string{},
				}
				return
			}

			if role != nil && *role == "assistant" && current != nil {
				current.lineEnd = lineNumber
				coalesceInt64(&current.observedAt, parseTimestamp(item["timestamp"]))
				text := strings.TrimSpace(extractCodexText(payload["content"]))
				if text != "" {
					current.assistantTexts = append(current.assistantTexts, text)
				}
			}
			return
		}

		if current == nil {
			return
		}
		current.lineEnd = lineNumber
		coalesceInt64(&current.observedAt, parseTimestamp(item["timestamp"]))
	})

	flushCurrent()
	return spans
}

// NewCodexSessionsAdapter returns the codex-sessions adapter. Ports
// createCodexSessionsAdapter.
func NewCodexSessionsAdapter() SourceAdapter {
	return codexAdapter{}
}

type codexAdapter struct{}

func (codexAdapter) Kind() string { return "codex-sessions" }

func (codexAdapter) Roots() []string {
	base := os.Getenv("CODEX_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return []string{}
		}
		base = filepath.Join(home, ".codex")
	}
	root := filepath.Join(base, "sessions")
	if _, err := os.Stat(root); err != nil {
		return []string{}
	}
	return []string{root}
}

func (codexAdapter) Detect(filePath string) bool {
	return strings.HasSuffix(filePath, ".jsonl")
}

func (codexAdapter) Parse(content string, ctx ParseContext) []TranscriptSpan {
	return ParseCodexJsonl(content, ctx)
}

// extractCodexText mirrors extractText in codex.ts: a string passes through; an
// array maps the text string field of object blocks, dropping empties, joined
// with "\n"; anything else is empty. (Note: unlike Claude's variant, it does
// not fall back to a `content` field.)
func extractCodexText(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	arr, ok := value.([]any)
	if !ok {
		return ""
	}
	parts := []string{}
	for _, block := range arr {
		object := asObject(block)
		if object == nil {
			continue
		}
		if text, ok := object["text"].(string); ok && text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

func objectField(object jsonObject, key string) any {
	if object == nil {
		return nil
	}
	return object[key]
}
