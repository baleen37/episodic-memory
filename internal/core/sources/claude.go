package sources

import (
	"os"
	"path/filepath"
	"strings"
)

// pendingClaudeSpan accumulates a user turn plus the assistant texts that
// follow it before the next user turn flushes it. Mirrors PendingClaudeSpan in
// src/core/sources/claude.ts.
type pendingClaudeSpan struct {
	archivePath    string
	lineStart      int64
	lineEnd        int64
	sourceKind     string
	sessionID      *string
	project        *string
	cwd            *string
	gitBranch      *string
	model          *string
	provider       *string
	metadataJSON   *string
	observedAt     *int64
	userText       string
	assistantTexts []string
}

// ParseClaudeJsonl parses Claude Code transcript JSONL into transcript spans.
// Ports parseClaudeJsonl in src/core/sources/claude.ts.
func ParseClaudeJsonl(content string, ctx ParseContext) []TranscriptSpan {
	spans := []TranscriptSpan{}
	var current *pendingClaudeSpan

	flushCurrent := func() {
		if current == nil {
			return
		}
		text := formatSpanText(current.userText, strings.Join(current.assistantTexts, "\n"))
		if strings.TrimSpace(text) != "" {
			spans = append(spans, TranscriptSpan{
				ArchivePath:  current.archivePath,
				LineStart:    current.lineStart,
				LineEnd:      current.lineEnd,
				SourceKind:   current.sourceKind,
				SessionID:    current.sessionID,
				Project:      current.project,
				Cwd:          current.cwd,
				GitBranch:    current.gitBranch,
				Model:        current.model,
				Provider:     current.provider,
				MetadataJSON: current.metadataJSON,
				ObservedAt:   current.observedAt,
				Text:         text,
			})
		}
		current = nil
	}

	eachJsonLine(content, func(item jsonObject, lineNumber int64) {
		message := asObject(item["message"])
		role := asString(messageField(message, "role"))
		if role == nil {
			role = asString(item["type"])
		}
		var messageContent any
		if message != nil {
			if c, ok := message["content"]; ok {
				messageContent = c
			}
		}

		if role != nil && *role == "user" {
			if isToolResultContent(messageContent) {
				if current != nil {
					current.lineEnd = lineNumber
				}
				return
			}

			flushCurrent()
			userText := strings.TrimSpace(extractClaudeText(messageContent))
			current = &pendingClaudeSpan{
				archivePath:    ctx.ArchivePath,
				lineStart:      lineNumber,
				lineEnd:        lineNumber,
				sourceKind:     ctx.SourceKind,
				sessionID:      asString(item["sessionId"]),
				project:        nil,
				cwd:            asString(item["cwd"]),
				gitBranch:      asString(item["gitBranch"]),
				model:          asString(item["model"]),
				provider:       asString(item["provider"]),
				metadataJSON:   nil,
				observedAt:     parseTimestamp(item["timestamp"]),
				userText:       userText,
				assistantTexts: []string{},
			}
			return
		}

		if current == nil {
			return
		}

		current.lineEnd = lineNumber
		coalesceString(&current.sessionID, asString(item["sessionId"]))
		coalesceString(&current.cwd, asString(item["cwd"]))
		coalesceString(&current.gitBranch, asString(item["gitBranch"]))
		coalesceString(&current.model, asString(item["model"]))
		coalesceString(&current.provider, asString(item["provider"]))
		coalesceInt64(&current.observedAt, parseTimestamp(item["timestamp"]))

		if role != nil && *role == "assistant" {
			coalesceString(&current.model, asString(messageField(message, "model")))
			text := strings.TrimSpace(extractClaudeText(messageContent))
			if text != "" {
				current.assistantTexts = append(current.assistantTexts, text)
			}
		}
	})

	flushCurrent()
	return spans
}

// NewClaudeProjectsAdapter returns the claude-projects adapter. Ports
// createClaudeProjectsAdapter.
func NewClaudeProjectsAdapter() SourceAdapter {
	return newClaudeAdapter("claude-projects", "projects")
}

// NewClaudeTranscriptsAdapter returns the claude-transcripts adapter. Ports
// createClaudeTranscriptsAdapter.
func NewClaudeTranscriptsAdapter() SourceAdapter {
	return newClaudeAdapter("claude-transcripts", "transcripts")
}

type claudeAdapter struct {
	kind    string
	dirname string
}

func newClaudeAdapter(kind, dirname string) SourceAdapter {
	return claudeAdapter{kind: kind, dirname: dirname}
}

func (a claudeAdapter) Kind() string { return a.kind }

func (a claudeAdapter) Roots() []string {
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return []string{}
		}
		base = filepath.Join(home, ".claude")
	}
	root := filepath.Join(base, a.dirname)
	if _, err := os.Stat(root); err != nil {
		return []string{}
	}
	return []string{root}
}

func (a claudeAdapter) Detect(filePath string) bool {
	return strings.HasSuffix(filePath, ".jsonl")
}

func (a claudeAdapter) Parse(content string, ctx ParseContext) []TranscriptSpan {
	return ParseClaudeJsonl(content, ctx)
}

func formatSpanText(userText, assistantText string) string {
	parts := []string{}
	if strings.TrimSpace(userText) != "" {
		parts = append(parts, "User: "+strings.TrimSpace(userText))
	}
	if strings.TrimSpace(assistantText) != "" {
		parts = append(parts, "Assistant: "+strings.TrimSpace(assistantText))
	}
	return strings.Join(parts, "\n")
}

// extractClaudeText mirrors extractText in claude.ts: a string passes through;
// an array maps text/content string fields of object blocks, dropping empties,
// joined with "\n"; anything else is empty.
func extractClaudeText(value any) string {
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
		if text, ok := object["text"].(string); ok {
			if text != "" {
				parts = append(parts, text)
			}
			continue
		}
		if content, ok := object["content"].(string); ok {
			if content != "" {
				parts = append(parts, content)
			}
		}
	}
	return strings.Join(parts, "\n")
}

func isToolResultContent(value any) bool {
	arr, ok := value.([]any)
	if !ok {
		return false
	}
	for _, block := range arr {
		if object := asObject(block); object != nil {
			if t, ok := object["type"].(string); ok && t == "tool_result" {
				return true
			}
		}
	}
	return false
}

// messageField returns message[key] or nil when message is nil. Helper to keep
// the nil-object access pattern (TS message?.role) faithful.
func messageField(message jsonObject, key string) any {
	if message == nil {
		return nil
	}
	return message[key]
}

func coalesceString(dst **string, v *string) {
	if *dst == nil {
		*dst = v
	}
}

func coalesceInt64(dst **int64, v *int64) {
	if *dst == nil {
		*dst = v
	}
}
