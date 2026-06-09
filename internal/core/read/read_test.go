package read

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// intp returns a pointer to an int, for the *int line-range params.
func intp(n int) *int { return &n }

// mustJSON marshals a value to a single JSONL line.
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}

// createMessage mirrors the test helper createMessage() with defaults + overrides.
func createMessage(t *testing.T, overrides map[string]any) string {
	t.Helper()
	m := map[string]any{
		"uuid":        "msg-123",
		"parentUuid":  nil,
		"timestamp":   "2024-01-01T12:00:00.000Z",
		"type":        "user",
		"isSidechain": false,
		"sessionId":   "session-456",
		"gitBranch":   "main",
		"cwd":         "/project",
		"version":     "1.0.0",
		"message": map[string]any{
			"role":    "user",
			"content": "Hello, world!",
		},
	}
	for k, v := range overrides {
		m[k] = v
	}
	return mustJSON(t, m)
}

func mustContain(t *testing.T, s, sub string) {
	t.Helper()
	if !strings.Contains(s, sub) {
		t.Errorf("expected output to contain %q\n--- output ---\n%s", sub, s)
	}
}

func mustNotContain(t *testing.T, s, sub string) {
	t.Helper()
	if strings.Contains(s, sub) {
		t.Errorf("expected output NOT to contain %q\n--- output ---\n%s", sub, s)
	}
}

// ---------- ReadConversation ----------

func TestReadConversation_MissingFile(t *testing.T) {
	if _, ok := ReadConversation("/nonexistent/path.jsonl", nil, nil); ok {
		t.Fatal("expected ok=false for missing file")
	}
	if _, ok := ReadConversation("/nonexistent/file.jsonl", intp(1), intp(2)); ok {
		t.Fatal("expected ok=false for missing file with range")
	}
}

func TestReadConversation_RequiresBoundedRange(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-requires-range.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Do not read all of this"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Use a bounded range"}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, ok := ReadConversation(p, nil, nil); ok {
		t.Error("expected ok=false when no range")
	}
	if _, ok := ReadConversation(p, intp(1), nil); ok {
		t.Error("expected ok=false when only startLine")
	}
	if _, ok := ReadConversation(p, nil, intp(2)); ok {
		t.Error("expected ok=false when only endLine")
	}
}

func TestReadConversation_ReadsWithRange(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-conversation.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Hello from JSONL!"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Hi from JSONL!"}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, ok := ReadConversation(p, intp(1), intp(2))
	if !ok {
		t.Fatal("expected ok=true")
	}
	mustContain(t, out, "# Conversation")
	mustContain(t, out, "Hello from JSONL!")
	mustContain(t, out, "Hi from JSONL!")
	mustContain(t, out, "**Session ID:** session-456")
}

func TestReadConversation_CodexResponseItem(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "codex-conversation.jsonl")
	jsonl := strings.Join([]string{
		mustJSON(t, map[string]any{"type": "session_meta", "payload": map[string]any{"id": "c1", "cwd": "/repo"}}),
		mustJSON(t, map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "Run the focused tests"}}}}),
		mustJSON(t, map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "The focused tests passed"}}}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, ok := ReadConversation(p, intp(1), intp(3))
	if !ok || out == "" {
		t.Fatal("expected non-empty output")
	}
	mustContain(t, out, "Run the focused tests")
	mustContain(t, out, "The focused tests passed")
}

func TestReadConversation_NonClaudeFallback(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "non-claude.jsonl")
	jsonl := mustJSON(t, map[string]any{"type": "event", "message": "plain event content"})
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, ok := ReadConversation(p, intp(1), intp(1))
	if !ok || out == "" {
		t.Fatal("expected non-empty fallback")
	}
	mustContain(t, out, "plain event content")
}

func TestReadConversation_RangeStart(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-pagination.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 1"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 1"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 2"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 2"}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, _ := ReadConversation(p, intp(3), intp(4))
	mustContain(t, out, "Message 2")
	mustNotContain(t, out, "Message 1")
}

func TestReadConversation_RangeEnd(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-pagination.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 1"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 1"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 2"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 2"}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, _ := ReadConversation(p, intp(1), intp(2))
	mustContain(t, out, "Message 1")
	mustContain(t, out, "Response 1")
	mustNotContain(t, out, "Message 2")
}

func TestReadConversation_RangeStartAndEnd(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-pagination.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 1"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 1"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 2"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 2"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 3"}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, _ := ReadConversation(p, intp(3), intp(4))
	mustNotContain(t, out, "Message 1")
	mustContain(t, out, "Message 2")
	mustContain(t, out, "Response 2")
	mustNotContain(t, out, "Message 3")
}

func TestReadConversation_ToolUseAndResult(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-tool.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Read file"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{
			map[string]any{"type": "text", "text": "I will read it"},
			map[string]any{"type": "tool_use", "id": "tool-123", "name": "read_file", "input": map[string]any{"file_path": "/path/to/file.txt"}},
		}}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, _ := ReadConversation(p, intp(1), intp(2))
	mustContain(t, out, "**Tool Use:** `read_file`")
	mustContain(t, out, "**file_path:**")
	mustContain(t, out, "/path/to/file.txt")
}

func TestReadConversation_Sidechain(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "test-sidechain.jsonl")
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "isSidechain": true, "message": map[string]any{"role": "user", "content": "Sidechain user"}}),
		createMessage(t, map[string]any{"type": "assistant", "isSidechain": true, "message": map[string]any{"role": "assistant", "content": "Sidechain agent"}}),
	}, "\n")
	if err := os.WriteFile(p, []byte(jsonl), 0o644); err != nil {
		t.Fatal(err)
	}

	out, _ := ReadConversation(p, intp(1), intp(2))
	mustContain(t, out, "🔀 SIDECHAIN START")
	mustContain(t, out, "🔀 SIDECHAIN END")
}

// ---------- FormatConversationAsMarkdown ----------

func TestFormatConversation_Simple(t *testing.T) {
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Hello"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Hi there!"}}),
	}, "\n")

	out := FormatConversationAsMarkdown(jsonl, nil, nil)
	mustContain(t, out, "# Conversation")
	mustContain(t, out, "## Metadata")
	mustContain(t, out, "**Session ID:** session-456")
	mustContain(t, out, "**Git Branch:** main")
	mustContain(t, out, "**Working Directory:** /project")
	mustContain(t, out, "**Claude Code Version:** 1.0.0")
	mustContain(t, out, "## Messages")
	mustContain(t, out, "### **User**")
	mustContain(t, out, "Hello")
	mustContain(t, out, "### **Agent**")
	mustContain(t, out, "Hi there!")
}

func TestFormatConversation_OmitsUUIDAndTokenUsage(t *testing.T) {
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Hello"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{
			"role": "assistant", "content": "Hi there!",
			"usage": map[string]any{"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 80},
		}}),
	}, "\n")

	out := FormatConversationAsMarkdown(jsonl, nil, nil)
	mustNotContain(t, out, "{#")
	mustNotContain(t, out, "cache read:")
	mustNotContain(t, out, "_in:")
}

func TestFormatConversation_RangeStartOnly(t *testing.T) {
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 1"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 1"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Message 2"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Response 2"}}),
	}, "\n")

	out := FormatConversationAsMarkdown(jsonl, intp(3), nil)
	mustContain(t, out, "Message 2")
	mustNotContain(t, out, "Message 1")
}

func TestFormatConversation_Empty(t *testing.T) {
	if out := FormatConversationAsMarkdown("", nil, nil); out != "" {
		t.Errorf("expected empty string, got %q", out)
	}
}

func TestFormatConversation_FiltersSystem(t *testing.T) {
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "system", "message": map[string]any{"role": "system", "content": "System msg"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Hello"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Hi!"}}),
	}, "\n")

	out := FormatConversationAsMarkdown(jsonl, nil, nil)
	mustNotContain(t, out, "System msg")
	mustContain(t, out, "Hello")
}

func TestFormatConversation_SidechainMarkers(t *testing.T) {
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Main message"}}),
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": "Main response"}}),
		createMessage(t, map[string]any{"type": "user", "isSidechain": true, "message": map[string]any{"role": "user", "content": "Sidechain user"}}),
		createMessage(t, map[string]any{"type": "assistant", "isSidechain": true, "message": map[string]any{"role": "assistant", "content": "Sidechain agent"}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Back to main"}}),
	}, "\n")

	out := FormatConversationAsMarkdown(jsonl, nil, nil)
	mustContain(t, out, "🔀 SIDECHAIN START")
	mustContain(t, out, "🔀 SIDECHAIN END")
	mustContain(t, out, "Sidechain user")
	mustContain(t, out, "Sidechain agent")
}

// ---------- FilterValidMessages ----------

func parseMsgs(t *testing.T, vals ...any) []message {
	t.Helper()
	var lines []string
	for _, v := range vals {
		lines = append(lines, mustJSON(t, v))
	}
	return ParseJsonlMessages(strings.Join(lines, "\n"), nil, nil)
}

func TestFilterValidMessages_KeepsUserAndAssistant(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "Hello"}},
		map[string]any{"type": "assistant", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "assistant", "content": "Hello"}},
	)
	if got := FilterValidMessages(msgs); len(got) != 2 {
		t.Errorf("expected 2, got %d", len(got))
	}
}

func TestFilterValidMessages_FiltersSystem(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "system", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "system", "content": "Hello"}},
		map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "Hello"}},
	)
	got := FilterValidMessages(msgs)
	if len(got) != 1 || got[0].typ() != "user" {
		t.Errorf("expected 1 user msg, got %d", len(got))
	}
}

func TestFilterValidMessages_FiltersNoTimestamp(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "user", "timestamp": "", "message": map[string]any{"role": "user", "content": "Hello"}},
		map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "Hello"}},
	)
	if got := FilterValidMessages(msgs); len(got) != 1 {
		t.Errorf("expected 1, got %d", len(got))
	}
}

func TestFilterValidMessages_KeepsAssistantWithUsageOnly(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "assistant", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{
			"role": "assistant", "content": "", "usage": map[string]any{"input_tokens": 10, "output_tokens": 5}}},
	)
	if got := FilterValidMessages(msgs); len(got) != 1 {
		t.Errorf("expected 1, got %d", len(got))
	}
}

func TestFilterValidMessages_FiltersEmptyContentArray(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": []any{}}},
	)
	if got := FilterValidMessages(msgs); len(got) != 0 {
		t.Errorf("expected 0, got %d", len(got))
	}
}

// ---------- FormatTokenUsage ----------

func TestFormatTokenUsage_Basic(t *testing.T) {
	out := FormatTokenUsage(TokenUsage{InputTokens: 100, OutputTokens: 50})
	mustContain(t, out, "in: 100")
	mustContain(t, out, "out: 50")
}

func TestFormatTokenUsage_CacheRead(t *testing.T) {
	out := FormatTokenUsage(TokenUsage{InputTokens: 100, OutputTokens: 50, CacheReadInputTokens: 80})
	mustContain(t, out, "cache read: 80")
}

func TestFormatTokenUsage_CacheCreate(t *testing.T) {
	out := FormatTokenUsage(TokenUsage{InputTokens: 100, OutputTokens: 50, CacheCreationInputTokens: 20})
	mustContain(t, out, "cache create: 20")
}

func TestFormatTokenUsage_AllWithCommaGrouping(t *testing.T) {
	out := FormatTokenUsage(TokenUsage{InputTokens: 1000, OutputTokens: 500, CacheReadInputTokens: 800, CacheCreationInputTokens: 200})
	mustContain(t, out, "in: 1,000")
	mustContain(t, out, "cache read: 800")
	mustContain(t, out, "cache create: 200")
	mustContain(t, out, "out: 500")
}

func TestFormatLocaleNumber(t *testing.T) {
	cases := map[int64]string{
		0:        "0",
		5:        "5",
		100:      "100",
		1000:     "1,000",
		1234:     "1,234",
		12345:    "12,345",
		123456:   "123,456",
		1234567:  "1,234,567",
		-1234567: "-1,234,567",
	}
	for in, want := range cases {
		if got := formatLocaleNumber(in); got != want {
			t.Errorf("formatLocaleNumber(%d) = %q, want %q", in, got, want)
		}
	}
}

// ---------- Sidechain / RoleLabel ----------

func TestSidechainMarkers(t *testing.T) {
	if !strings.Contains(FormatSidechainStart(), "SIDECHAIN START") || !strings.Contains(FormatSidechainStart(), "---") {
		t.Error("bad start marker")
	}
	if !strings.Contains(FormatSidechainEnd(), "SIDECHAIN END") || !strings.Contains(FormatSidechainEnd(), "---") {
		t.Error("bad end marker")
	}
}

func TestGetRoleLabel(t *testing.T) {
	cases := []struct {
		typ        string
		isSidechan bool
		want       string
	}{
		{"user", false, "User"},
		{"assistant", false, "Agent"},
		{"user", true, "Agent"},
		{"assistant", true, "Subagent"},
	}
	for _, c := range cases {
		if got := GetRoleLabel(c.typ, c.isSidechan); got != c.want {
			t.Errorf("GetRoleLabel(%q,%v) = %q, want %q", c.typ, c.isSidechan, got, c.want)
		}
	}
}

// ---------- FormatToolInput ----------

func parseInput(t *testing.T, v any) jsonValue {
	t.Helper()
	jv, err := parseJSONValue([]byte(mustJSON(t, v)))
	if err != nil {
		t.Fatal(err)
	}
	return jv
}

func TestFormatToolInput_SimpleString(t *testing.T) {
	out := FormatToolInput(parseInput(t, map[string]any{"file_path": "/path/to/file.txt"}))
	mustContain(t, out, "**file_path:** /path/to/file.txt")
}

func TestFormatToolInput_MultilineString(t *testing.T) {
	out := FormatToolInput(parseInput(t, map[string]any{"code": "line 1\nline 2\nline 3"}))
	mustContain(t, out, "**code:**")
	mustContain(t, out, "```")
	mustContain(t, out, "line 1")
}

func TestFormatToolInput_ObjectAsJSON(t *testing.T) {
	out := FormatToolInput(parseInput(t, map[string]any{"options": map[string]any{"verbose": true, "count": 5}}))
	mustContain(t, out, "**options:**")
	mustContain(t, out, "```json")
	mustContain(t, out, "\"verbose\"")
}

func TestFormatToolInput_Empty(t *testing.T) {
	if out := FormatToolInput(parseInput(t, map[string]any{})); out != "\n" {
		t.Errorf("expected %q, got %q", "\n", out)
	}
}

// ---------- FormatToolResultContent ----------

func TestFormatToolResultContent_ShortInline(t *testing.T) {
	if out := FormatToolResultContent(jsonString("Short result")); out != "Short result\n\n" {
		t.Errorf("got %q", out)
	}
}

func TestFormatToolResultContent_LongFenced(t *testing.T) {
	long := strings.Repeat("A", 150)
	out := FormatToolResultContent(jsonString(long))
	mustContain(t, out, "```")
	mustContain(t, out, long)
}

func TestFormatToolResultContent_MultilineFenced(t *testing.T) {
	out := FormatToolResultContent(jsonString("Line 1\nLine 2\nLine 3"))
	mustContain(t, out, "```")
	mustContain(t, out, "Line 1")
	mustContain(t, out, "Line 2")
}

func TestFormatToolResultContent_ArrayJSON(t *testing.T) {
	content := parseInput(t, []any{map[string]any{"foo": "bar"}, map[string]any{"baz": "qux"}})
	out := FormatToolResultContent(content)
	mustContain(t, out, "```json")
	mustContain(t, out, "\"foo\"")
}

// ---------- FindToolResult ----------

func TestFindToolResult_Found(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "assistant", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "tool-123", "name": "read", "input": map[string]any{}}}}},
		map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{
			"role": "user", "content": []any{
				map[string]any{"type": "text", "text": "Some text"},
				map[string]any{"type": "tool_result", "tool_use_id": "tool-123", "content": "File contents"},
			}}},
	)
	result, ok := FindToolResult(msgs, 0, "tool-123")
	if !ok {
		t.Fatal("expected to find result")
	}
	c, _ := result.get("content")
	if s, _ := asString(c); s != "File contents" {
		t.Errorf("got %q", s)
	}
}

func TestFindToolResult_NotFound(t *testing.T) {
	msgs := parseMsgs(t,
		map[string]any{"type": "assistant", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "tool-123", "name": "read", "input": map[string]any{}}}}},
	)
	if _, ok := FindToolResult(msgs, 0, "tool-123"); ok {
		t.Error("expected not found")
	}
}

func TestFindToolResult_Only6Ahead(t *testing.T) {
	vals := []any{
		map[string]any{"type": "assistant", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "tool-123", "name": "read", "input": map[string]any{}}}}},
	}
	for i := 0; i < 6; i++ {
		vals = append(vals, map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "filler"}})
	}
	vals = append(vals, map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{
		"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "tool-123", "content": "Too far"}}}})

	msgs := parseMsgs(t, vals...)
	if _, ok := FindToolResult(msgs, 0, "tool-123"); ok {
		t.Error("expected not found (beyond 6 ahead)")
	}
}

// ---------- FormatUserMessage ----------

func userMsg(t *testing.T, v any) message {
	t.Helper()
	jv, err := parseJSONValue([]byte(mustJSON(t, v)))
	if err != nil {
		t.Fatal(err)
	}
	m, _ := messageFromValue(jv)
	return m
}

func TestFormatUserMessage_StringContent(t *testing.T) {
	m := userMsg(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "Hello world"}})
	if out := FormatUserMessage(m); out != "Hello world\n\n" {
		t.Errorf("got %q", out)
	}
}

func TestFormatUserMessage_TextBlocks(t *testing.T) {
	m := userMsg(t, map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "text", "text": "First part"},
		map[string]any{"type": "text", "text": "Second part"},
	}}})
	out := FormatUserMessage(m)
	mustContain(t, out, "First part")
	mustContain(t, out, "Second part")
}

func TestFormatUserMessage_ToolUseResultString(t *testing.T) {
	m := userMsg(t, map[string]any{"type": "user", "toolUseResult": "Tool result here", "message": map[string]any{"role": "user", "content": ""}})
	out := FormatUserMessage(m)
	mustContain(t, out, "**Tool Result:**")
	mustContain(t, out, "Tool result here")
}

func TestFormatUserMessage_ToolUseResultArray(t *testing.T) {
	m := userMsg(t, map[string]any{"type": "user", "toolUseResult": []any{
		map[string]any{"type": "text", "text": "Result 1"},
		map[string]any{"type": "text", "text": "Result 2"},
	}, "message": map[string]any{"role": "user", "content": ""}})
	out := FormatUserMessage(m)
	mustContain(t, out, "Result 1")
	mustContain(t, out, "Result 2")
}

// ---------- ParseJsonlMessages ----------

func TestParseJsonlMessages_Valid(t *testing.T) {
	jsonl := strings.Join([]string{
		mustJSON(t, map[string]any{"uuid": "1", "type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "Hello"}}),
		mustJSON(t, map[string]any{"uuid": "2", "type": "assistant", "timestamp": "2024-01-01T00:00:01Z", "message": map[string]any{"role": "assistant", "content": "Hi"}}),
	}, "\n")
	got := ParseJsonlMessages(jsonl, nil, nil)
	if len(got) != 2 || got[0].uuid() != "1" || got[1].uuid() != "2" {
		t.Errorf("unexpected parse: %d", len(got))
	}
}

func TestParseJsonlMessages_FiltersEmptyLines(t *testing.T) {
	jsonl := strings.Join([]string{
		mustJSON(t, map[string]any{"uuid": "1", "type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "Hello"}}),
		"",
		"   ",
		mustJSON(t, map[string]any{"uuid": "2", "type": "assistant", "timestamp": "2024-01-01T00:00:01Z", "message": map[string]any{"role": "assistant", "content": "Hi"}}),
	}, "\n")
	if got := ParseJsonlMessages(jsonl, nil, nil); len(got) != 2 {
		t.Errorf("expected 2, got %d", len(got))
	}
}

func TestParseJsonlMessages_Range(t *testing.T) {
	jsonl := strings.Join([]string{
		mustJSON(t, map[string]any{"uuid": "1", "type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "A"}}),
		mustJSON(t, map[string]any{"uuid": "2", "type": "assistant", "timestamp": "2024-01-01T00:00:01Z", "message": map[string]any{"role": "assistant", "content": "B"}}),
		mustJSON(t, map[string]any{"uuid": "3", "type": "user", "timestamp": "2024-01-01T00:00:02Z", "message": map[string]any{"role": "user", "content": "C"}}),
	}, "\n")
	got := ParseJsonlMessages(jsonl, intp(2), intp(3))
	if len(got) != 2 || got[0].uuid() != "2" || got[1].uuid() != "3" {
		t.Errorf("unexpected range parse: %d", len(got))
	}
}

func TestParseJsonlMessages_SkipsInvalid(t *testing.T) {
	jsonl := strings.Join([]string{
		mustJSON(t, map[string]any{"uuid": "1", "type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "A"}}),
		"{not valid json",
		mustJSON(t, map[string]any{"uuid": "2", "type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "B"}}),
	}, "\n")
	if got := ParseJsonlMessages(jsonl, nil, nil); len(got) != 2 {
		t.Errorf("expected 2 (skipping invalid), got %d", len(got))
	}
}

// ---------- FormatMetadata ----------

func TestFormatMetadata_AllFields(t *testing.T) {
	m := userMsg(t, map[string]any{
		"type": "user", "timestamp": "2024-01-01T00:00:00Z",
		"sessionId": "session-123", "gitBranch": "feature-branch",
		"cwd": "/home/user/project", "version": "2.0.0",
		"message": map[string]any{"role": "user", "content": "Hello"},
	})
	out := FormatMetadata(m)
	mustContain(t, out, "## Metadata")
	mustContain(t, out, "**Session ID:** session-123")
	mustContain(t, out, "**Git Branch:** feature-branch")
	mustContain(t, out, "**Working Directory:** /home/user/project")
	mustContain(t, out, "**Claude Code Version:** 2.0.0")
}

func TestFormatMetadata_OmitsMissing(t *testing.T) {
	m := userMsg(t, map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "sessionId": "session-123", "message": map[string]any{"role": "user", "content": "Hello"}})
	out := FormatMetadata(m)
	mustContain(t, out, "**Session ID:** session-123")
	mustNotContain(t, out, "**Git Branch:**")
	mustNotContain(t, out, "**Working Directory:**")
	mustNotContain(t, out, "**Claude Code Version:**")
}

func TestFormatMetadata_HeaderOnly(t *testing.T) {
	m := userMsg(t, map[string]any{"type": "user", "timestamp": "2024-01-01T00:00:00Z", "message": map[string]any{"role": "user", "content": "Hello"}})
	if out := FormatMetadata(m); out != "## Metadata\n\n---\n\n" {
		t.Errorf("got %q", out)
	}
}

// ---------- Extra: skip user-message-of-only-tool-results ----------

func TestFormatConversation_SkipsToolResultOnlyUserMessage(t *testing.T) {
	jsonl := strings.Join([]string{
		createMessage(t, map[string]any{"type": "assistant", "message": map[string]any{
			"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "t1", "name": "read", "input": map[string]any{"x": "y"}}}}}),
		createMessage(t, map[string]any{"type": "user", "message": map[string]any{
			"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": "the result"}}}}),
	}, "\n")

	out := FormatConversationAsMarkdown(jsonl, nil, nil)
	// The user message is all tool_results -> its own block is skipped (no User header for it),
	// but the result is rendered inline under the assistant tool_use via lookahead.
	mustContain(t, out, "**Tool Use:** `read`")
	mustContain(t, out, "**Result:**")
	mustContain(t, out, "the result")
}

// ---------- Codex fallback details ----------

func TestCodexFallback_RawAndJSON(t *testing.T) {
	// A line that is invalid JSON should pass through raw; a valid non-codex
	// JSON record should be fenced as json.
	jsonl := strings.Join([]string{
		"raw text line",
		mustJSON(t, map[string]any{"type": "event", "detail": "x"}),
	}, "\n")
	out := FormatConversationAsMarkdown(jsonl, intp(1), intp(2))
	mustContain(t, out, "# Conversation\n\n## Messages\n\n")
	mustContain(t, out, "raw text line")
	mustContain(t, out, "```json")
	mustContain(t, out, "\"detail\"")
}

// ---------- Regression: JSON HTML chars must NOT be escaped ----------

// JS JSON.stringify does not escape <, >, &. The Go port must match byte-for-byte,
// including for nested values inside tool-input objects and array tool-results.
func TestStringifyJSON_DoesNotEscapeHTMLChars(t *testing.T) {
	// Nested object inside a tool_use input.
	objInput := parseInput(t, map[string]any{
		"options": map[string]any{"cmd": "grep -E 'a&b' > out.txt && echo <done>"},
	})
	objOut := FormatToolInput(objInput)
	mustContain(t, objOut, "\"cmd\": \"grep -E 'a&b' > out.txt && echo <done>\"")
	// The \uXXXX escapes for <, >, & must NOT appear.
	mustNotContain(t, objOut, "\\u003c") // <
	mustNotContain(t, objOut, "\\u003e") // >
	mustNotContain(t, objOut, "\\u0026") // &

	// Array tool-result containing the same chars.
	arrContent := parseInput(t, []any{
		map[string]any{"cmd": "if [ $a -lt 5 ] && [ $b -gt 3 ]; then echo <ok>; fi"},
	})
	arrOut := FormatToolResultContent(arrContent)
	mustContain(t, arrOut, "\"cmd\": \"if [ $a -lt 5 ] && [ $b -gt 3 ]; then echo <ok>; fi\"")
	mustNotContain(t, arrOut, "\\u003c")
	mustNotContain(t, arrOut, "\\u003e")
	mustNotContain(t, arrOut, "\\u0026")
}

// ---------- Regression: timestamp is deterministic (UTC), pinned exactly ----------

func TestFormatTimestamp_DeterministicUTC(t *testing.T) {
	cases := map[string]string{
		"2024-01-01T12:00:00.000Z":  "1/1/2024, 12:00:00 PM", // noon UTC
		"2024-01-01T00:00:00Z":      "1/1/2024, 12:00:00 AM", // midnight UTC, h12 0->12
		"2024-03-05T14:30:45+02:00": "3/5/2024, 12:30:45 PM", // offset normalized to UTC
		"2024-09-07T09:05:03Z":      "9/7/2024, 9:05:03 AM",  // single-digit month/day, AM
	}
	for in, want := range cases {
		if got := formatTimestamp(in); got != want {
			t.Errorf("formatTimestamp(%q) = %q, want %q", in, got, want)
		}
	}
}

// The rendered message header must embed the pinned UTC timestamp string.
func TestFormatConversation_TimestampInHeaderIsUTC(t *testing.T) {
	jsonl := createMessage(t, map[string]any{
		"type":      "user",
		"timestamp": "2024-01-01T12:00:00.000Z",
		"message":   map[string]any{"role": "user", "content": "hi"},
	})
	out := FormatConversationAsMarkdown(jsonl, nil, nil)
	mustContain(t, out, "### **User** (1/1/2024, 12:00:00 PM)")
}

func TestCodexFallback_CodexIndexAnchor(t *testing.T) {
	jsonl := mustJSON(t, map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "content": "hello codex"}})
	out := FormatConversationAsMarkdown(jsonl, intp(1), intp(1))
	mustContain(t, out, "### **Agent** {#codex-1}")
	mustContain(t, out, "hello codex")
}
