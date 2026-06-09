package read

import "strings"

// FormatTokenUsage mirrors formatTokenUsage. Token counts are integers; missing
// values default to 0. Numbers are comma-grouped (toLocaleString, en-US).
func FormatTokenUsage(usage TokenUsage) string {
	var b strings.Builder
	b.WriteString("_in: " + formatLocaleNumber(usage.InputTokens))
	if usage.CacheReadInputTokens != 0 {
		b.WriteString(" | cache read: " + formatLocaleNumber(usage.CacheReadInputTokens))
	}
	if usage.CacheCreationInputTokens != 0 {
		b.WriteString(" | cache create: " + formatLocaleNumber(usage.CacheCreationInputTokens))
	}
	b.WriteString(" | out: " + formatLocaleNumber(usage.OutputTokens) + "_\n\n")
	return b.String()
}

// TokenUsage mirrors the usage object fields formatTokenUsage reads.
type TokenUsage struct {
	InputTokens              int64
	OutputTokens             int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
}

// FormatToolInput mirrors formatToolInput. Iterates input keys in order:
//   - string containing '\n' -> fenced plain block
//   - plain string           -> inline
//   - other                  -> fenced ```json block (JSON.stringify, 2-space)
//
// When input is a non-nil object a trailing "\n" is appended (even when empty).
func FormatToolInput(input jsonValue) string {
	obj, ok := asObject(input)
	if !ok {
		// In read.ts, `input && typeof input === 'object'` is false for
		// non-objects, so nothing (not even the trailing newline) is emitted.
		return ""
	}

	var b strings.Builder
	for _, key := range obj.keys {
		value := obj.values[key]
		if s, ok := asString(value); ok {
			if strings.Contains(s, "\n") {
				b.WriteString("- **" + key + ":**\n```\n" + s + "\n```\n")
			} else {
				b.WriteString("- **" + key + ":** " + s + "\n")
			}
		} else {
			b.WriteString("- **" + key + ":**\n```json\n" + stringifyJSON(value) + "\n```\n")
		}
	}
	b.WriteString("\n")
	return b.String()
}

// FormatToolResultContent mirrors formatToolResultContent.
//   - string with '\n' OR length > 100 (UTF-16 code units) -> fenced ``` block
//   - short string                                          -> inline
//   - array                                                 -> fenced ```json
//   - anything else                                         -> ""
func FormatToolResultContent(content jsonValue) string {
	if s, ok := asString(content); ok {
		if strings.Contains(s, "\n") || utf16Len(s) > 100 {
			return "```\n" + s + "\n```\n\n"
		}
		return s + "\n\n"
	}
	if arr, ok := asArray(content); ok {
		return "```json\n" + stringifyJSON(arr) + "\n```\n\n"
	}
	return ""
}

// truthy mirrors JS truthiness for the jsonValue kinds that appear as a
// tool_use `input`: null/false/empty-string/0 are falsy.
func truthy(v jsonValue) bool {
	switch t := v.(type) {
	case nil, jsonNull:
		return false
	case jsonBool:
		return bool(t)
	case jsonString:
		return string(t) != ""
	case jsonNumber:
		return string(t) != "0" && string(t) != "0.0" && string(t) != ""
	default:
		return true
	}
}

// utf16Len returns the number of UTF-16 code units in s, matching JS
// String.prototype.length used by read.ts for the >100 threshold.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// FindToolResult searches up to 6 messages ahead of toolUseIndex for a user
// message containing a tool_result block whose tool_use_id matches. Mirrors
// findToolResult. Returns the matching block (a jsonObject) and true.
func FindToolResult(messages []message, toolUseIndex int, toolUseID string) (*jsonObject, bool) {
	limit := toolUseIndex + 6
	if limit > len(messages) {
		limit = len(messages)
	}
	for j := toolUseIndex + 1; j < limit; j++ {
		laterMsg := messages[j]
		if laterMsg.typ() != "user" {
			continue
		}
		content, ok := laterMsg.content()
		if !ok {
			continue
		}
		arr, ok := asArray(content)
		if !ok {
			continue
		}
		for _, block := range arr {
			obj, ok := asObject(block)
			if !ok {
				continue
			}
			if t, ok := obj.get("type"); !ok {
				continue
			} else if s, ok := asString(t); !ok || s != "tool_result" {
				continue
			}
			id, ok := obj.get("tool_use_id")
			if !ok {
				continue
			}
			if s, ok := asString(id); ok && s == toolUseID {
				return obj, true
			}
		}
	}
	return nil, false
}

// FormatUserMessage mirrors formatUserMessage.
func FormatUserMessage(msg message) string {
	var b strings.Builder

	if tur, ok := msg.toolUseResult(); ok {
		b.WriteString("**Tool Result:**\n\n")
		if s, ok := asString(tur); ok {
			b.WriteString(s + "\n\n")
		} else if arr, ok := asArray(tur); ok {
			for _, result := range arr {
				b.WriteString(resultText(result) + "\n\n")
			}
		}
		return b.String()
	}

	content, ok := msg.content()
	if !ok {
		return b.String()
	}
	if s, ok := asString(content); ok {
		b.WriteString(s + "\n\n")
	} else if arr, ok := asArray(content); ok {
		for _, block := range arr {
			obj, ok := asObject(block)
			if !ok {
				continue
			}
			if t, ok := obj.get("type"); !ok {
				continue
			} else if s, ok := asString(t); !ok || s != "text" {
				continue
			}
			if txt, ok := obj.get("text"); ok {
				if s, ok := asString(txt); ok && s != "" {
					b.WriteString(s + "\n\n")
				}
			}
		}
	}

	return b.String()
}

// resultText mirrors `(result as any).text || String(result)` for entries in a
// toolUseResult array. read.ts entries are {type,text}; if text is missing or
// empty, JS falls back to String(result) ("[object Object]" for objects).
func resultText(result jsonValue) string {
	if obj, ok := asObject(result); ok {
		if v, ok := obj.get("text"); ok {
			if s, ok := asString(v); ok && s != "" {
				return s
			}
		}
		return "[object Object]"
	}
	if s, ok := asString(result); ok {
		return s
	}
	return ""
}

// formatAssistantMessage mirrors formatAssistantMessage, including tool_use
// rendering and tool-result lookahead.
func formatAssistantMessage(messages []message, index int, msg message) string {
	var b strings.Builder

	content, ok := msg.content()
	if !ok {
		return b.String()
	}

	if s, ok := asString(content); ok {
		b.WriteString(s + "\n\n")
		return b.String()
	}

	arr, ok := asArray(content)
	if !ok {
		return b.String()
	}

	for _, block := range arr {
		obj, ok := asObject(block)
		if !ok {
			continue
		}
		blockType := ""
		if t, ok := obj.get("type"); ok {
			blockType, _ = asString(t)
		}

		switch blockType {
		case "text":
			if txt, ok := obj.get("text"); ok {
				if s, ok := asString(txt); ok && s != "" {
					b.WriteString(s + "\n\n")
				}
			}
		case "tool_use":
			name := ""
			if v, ok := obj.get("name"); ok {
				name, _ = asString(v)
			}
			b.WriteString("**Tool Use:** `" + name + "`\n\n")

			// Mirror `block.input || {}`: a falsy input (missing, null,
			// false, "", 0) falls back to an empty object.
			var input jsonValue = newJSONObject()
			if v, ok := obj.get("input"); ok && truthy(v) {
				input = v
			}
			b.WriteString(FormatToolInput(input))

			if idv, ok := obj.get("id"); ok {
				if toolUseID, ok := asString(idv); ok && toolUseID != "" {
					if result, found := FindToolResult(messages, index, toolUseID); found {
						b.WriteString("**Result:**\n")
						resultContent, _ := result.get("content")
						b.WriteString(FormatToolResultContent(resultContent))
					}
				}
			}
		}
	}

	return b.String()
}
