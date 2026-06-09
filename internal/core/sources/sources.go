package sources

// BuiltInSourceAdapters returns the built-in source adapters in stable order:
// claude-projects, claude-transcripts, codex-sessions. Ports
// getBuiltInSourceAdapters in src/core/sources/index.ts.
func BuiltInSourceAdapters() []SourceAdapter {
	return []SourceAdapter{
		NewClaudeProjectsAdapter(),
		NewClaudeTranscriptsAdapter(),
		NewCodexSessionsAdapter(),
	}
}
