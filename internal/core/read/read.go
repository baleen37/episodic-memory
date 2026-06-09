// Package read renders archived transcript content for a given archive path
// and optional line range. Ports src/core/read.ts.
//
// The module is pure Go and CGO-free: it builds markdown strings by hand
// (strings.Builder) plus JSON parsing. No markdown library (e.g. gomarkdown) is
// required, because read.ts also builds markdown by string concatenation rather
// than parsing it.
package read

import (
	"os"
	"strings"
)

// Line-range parameters are *int: nil means "not provided" (JS undefined),
// distinguishing it from an explicit value.

// ReadConversation reads a conversation from a JSONL file and renders it as
// markdown. Mirrors readConversation(path, startLine, endLine):
//   - file missing -> (\"\", false)
//   - startLine OR endLine nil (undefined) -> (\"\", false) (a bounded range is
//     deliberately required)
//   - otherwise -> (markdown, true)
func ReadConversation(path string, startLine, endLine *int) (string, bool) {
	if _, err := os.Stat(path); err != nil {
		return "", false
	}
	if startLine == nil || endLine == nil {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return FormatConversationAsMarkdown(string(data), startLine, endLine), true
}

// selectJsonlLines mirrors selectJsonlLines: trim the whole string, split on
// '\n', drop blank lines, then slice by the 1-indexed inclusive range.
func selectJsonlLines(jsonl string, startLine, endLine *int) []string {
	trimmed := strings.TrimSpace(jsonl)
	var lines []string
	if trimmed != "" {
		for _, l := range strings.Split(trimmed, "\n") {
			if strings.TrimSpace(l) != "" {
				lines = append(lines, l)
			}
		}
	}

	if startLine == nil && endLine == nil {
		return lines
	}

	start := 0
	if startLine != nil {
		start = *startLine - 1
	}
	end := len(lines)
	if endLine != nil {
		end = *endLine
	}
	return sliceLines(lines, start, end)
}

// sliceLines replicates JS Array.prototype.slice(start, end) clamping behavior.
func sliceLines(lines []string, start, end int) []string {
	n := len(lines)
	if start < 0 {
		start += n
		if start < 0 {
			start = 0
		}
	}
	if start > n {
		start = n
	}
	if end < 0 {
		end += n
		if end < 0 {
			end = 0
		}
	}
	if end > n {
		end = n
	}
	if end < start {
		end = start
	}
	return lines[start:end]
}

// ParseJsonlMessages parses selected JSONL lines into messages, skipping lines
// that fail to parse. Mirrors parseJsonlMessages.
func ParseJsonlMessages(jsonl string, startLine, endLine *int) []message {
	lines := selectJsonlLines(jsonl, startLine, endLine)
	var out []message
	for _, line := range lines {
		v, err := parseJSONValue([]byte(line))
		if err != nil {
			continue
		}
		m, ok := messageFromValue(v)
		if !ok {
			continue
		}
		out = append(out, m)
	}
	return out
}

// FilterValidMessages keeps only valid user/assistant messages. Mirrors
// filterValidMessages:
//   - type must be user|assistant
//   - timestamp required
//   - message.content required UNLESS (assistant with usage)
//   - empty content array follows the same assistant-usage exception
func FilterValidMessages(messages []message) []message {
	var out []message
	for _, msg := range messages {
		t := msg.typ()
		if t != "user" && t != "assistant" {
			continue
		}
		if msg.timestamp() == "" {
			continue
		}

		content, hasContent := msg.content()
		if !hasContent {
			if t == "assistant" && msg.hasUsage() {
				out = append(out, msg)
			}
			continue
		}
		if arr, ok := asArray(content); ok && len(arr) == 0 {
			if t == "assistant" && msg.hasUsage() {
				out = append(out, msg)
			}
			continue
		}
		out = append(out, msg)
	}
	return out
}

// FormatMetadata renders the metadata section from the first message. Mirrors
// formatMetadata.
func FormatMetadata(first message) string {
	var b strings.Builder
	b.WriteString("## Metadata\n\n")
	if v, ok := first.metadataField("sessionId"); ok {
		b.WriteString("**Session ID:** " + v + "\n\n")
	}
	if v, ok := first.metadataField("gitBranch"); ok {
		b.WriteString("**Git Branch:** " + v + "\n\n")
	}
	if v, ok := first.metadataField("cwd"); ok {
		b.WriteString("**Working Directory:** " + v + "\n\n")
	}
	if v, ok := first.metadataField("version"); ok {
		b.WriteString("**Claude Code Version:** " + v + "\n\n")
	}
	b.WriteString("---\n\n")
	return b.String()
}

// FormatSidechainStart mirrors formatSidechainStart.
func FormatSidechainStart() string {
	return "\n---\n**🔀 SIDECHAIN START**\n---\n\n"
}

// FormatSidechainEnd mirrors formatSidechainEnd.
func FormatSidechainEnd() string {
	return "\n---\n**🔀 SIDECHAIN END**\n---\n\n"
}

// GetRoleLabel mirrors getRoleLabel.
func GetRoleLabel(typ string, isSidechain bool) string {
	if isSidechain {
		if typ == "user" {
			return "Agent"
		}
		return "Subagent"
	}
	if typ == "user" {
		return "User"
	}
	return "Agent"
}

// FormatConversationAsMarkdown parses + filters JSONL and renders markdown.
// Mirrors formatConversationAsMarkdown. Falls back to the Codex/other renderer
// when there are no valid Claude messages.
func FormatConversationAsMarkdown(jsonl string, startLine, endLine *int) string {
	allMessages := ParseJsonlMessages(jsonl, startLine, endLine)
	messages := FilterValidMessages(allMessages)

	if len(messages) == 0 {
		return formatNonClaudeJsonlFallback(selectJsonlLines(jsonl, startLine, endLine))
	}

	var b strings.Builder
	b.WriteString("# Conversation\n\n")
	b.WriteString(FormatMetadata(messages[0]))
	b.WriteString("## Messages\n\n")

	inSidechain := false

	for i, msg := range messages {
		timestamp := formatTimestamp(msg.timestamp())

		// Skip user messages that are entirely tool_result blocks.
		if msg.typ() == "user" {
			if content, ok := msg.content(); ok {
				if arr, ok := asArray(content); ok && allToolResults(arr) {
					continue
				}
			}
		}

		// Sidechain grouping.
		if msg.isSidechain() && !inSidechain {
			b.WriteString(FormatSidechainStart())
			inSidechain = true
		} else if !msg.isSidechain() && inSidechain {
			b.WriteString(FormatSidechainEnd())
			inSidechain = false
		}

		roleLabel := GetRoleLabel(msg.typ(), msg.isSidechain())
		b.WriteString("### **" + roleLabel + "** (" + timestamp + ")\n\n")

		switch msg.typ() {
		case "user":
			b.WriteString(FormatUserMessage(msg))
		case "assistant":
			b.WriteString(formatAssistantMessage(messages, i, msg))
		}
	}

	if inSidechain {
		b.WriteString(FormatSidechainEnd())
	}

	return b.String()
}

// allToolResults reports whether every block in the array is a tool_result.
// Mirrors `content.every(block => block.type === 'tool_result')`. JS `every`
// returns true for an empty array, but empty content arrays are filtered out
// upstream so this path only sees non-empty arrays here.
func allToolResults(arr jsonArray) bool {
	for _, block := range arr {
		obj, ok := asObject(block)
		if !ok {
			return false
		}
		t, ok := obj.get("type")
		if !ok {
			return false
		}
		if s, ok := asString(t); !ok || s != "tool_result" {
			return false
		}
	}
	return true
}
