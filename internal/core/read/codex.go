package read

import (
	"strconv"
	"strings"
)

// formatNonClaudeJsonlFallback mirrors formatNonClaudeJsonlFallback: render each
// selected line as a Codex message, a fenced ```json block, or the raw line.
func formatNonClaudeJsonlFallback(lines []string) string {
	var rendered []string
	for index, line := range lines {
		v, err := parseJSONValue([]byte(line))
		if err != nil {
			rendered = append(rendered, line)
			continue
		}
		if codexMsg, ok := formatCodexResponseItem(v, index); ok {
			rendered = append(rendered, codexMsg)
			continue
		}
		rendered = append(rendered, "```json\n"+stringifyJSON(v)+"\n```")
	}

	if len(rendered) == 0 {
		return ""
	}
	return "# Conversation\n\n## Messages\n\n" + strings.Join(rendered, "\n\n") + "\n"
}

// formatCodexResponseItem mirrors formatCodexResponseItem. Returns (msg, true)
// only when the record is a codex response_item message with extractable text.
func formatCodexResponseItem(record jsonValue, index int) (string, bool) {
	obj, ok := asObject(record)
	if !ok {
		return "", false
	}
	t, ok := obj.get("type")
	if !ok {
		return "", false
	}
	if s, ok := asString(t); !ok || s != "response_item" {
		return "", false
	}

	payloadVal, ok := obj.get("payload")
	if !ok {
		return "", false
	}
	payload, ok := asObject(payloadVal)
	if !ok {
		return "", false
	}
	pt, ok := payload.get("type")
	if !ok {
		return "", false
	}
	if s, ok := asString(pt); !ok || s != "message" {
		return "", false
	}

	role := "User"
	if rv, ok := payload.get("role"); ok {
		if s, ok := asString(rv); ok && s == "assistant" {
			role = "Agent"
		}
	}

	contentVal, _ := payload.get("content")
	text := extractCodexMessageText(contentVal)
	if text == "" {
		return "", false
	}

	return "### **" + role + "** {#codex-" + strconv.Itoa(index+1) + "}\n\n" + text + "\n", true
}

// extractCodexMessageText mirrors extractCodexMessageText: string content as-is,
// or join text fields of array blocks (filtering empties) with "\n\n".
func extractCodexMessageText(content jsonValue) string {
	if s, ok := asString(content); ok {
		return s
	}
	arr, ok := asArray(content)
	if !ok {
		return ""
	}
	var parts []string
	for _, block := range arr {
		if s, ok := asString(block); ok {
			if s != "" {
				parts = append(parts, s)
			}
			continue
		}
		if obj, ok := asObject(block); ok {
			if v, ok := obj.get("text"); ok {
				if s, ok := asString(v); ok && s != "" {
					parts = append(parts, s)
				}
			}
		}
	}
	return strings.Join(parts, "\n\n")
}
