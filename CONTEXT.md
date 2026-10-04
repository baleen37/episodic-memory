# episodic-memory

Persistent memory of past Claude Code and Codex conversations, searchable by keyword and meaning.

## Language

### Sources and archive

**Provider**:
A coding agent whose transcripts are indexed (Claude Code, Codex). Each provider has its own transcript format and its own adapter that interprets it.

**Source transcript**:
A provider's own JSONL file for one conversation. It can grow, and it can be rewritten.
_Avoid_: session file, log

**Archive**:
The append-only copy of a source transcript kept by episodic-memory. The archive, not the source transcript, is what gets indexed and read.
_Avoid_: backup, mirror

**Generation**:
One archive file of a source transcript. A new generation starts when the source transcript is rewritten; older generations are kept but no longer indexed.

### Indexing

**Exchange**:
One user message together with the answers and tool calls that follow it, up to the next user message. The unit of search.
_Avoid_: turn, message, chunk

**Exchange start message**:
A line that opens a new exchange. Which lines qualify differs per provider and per file meta.

**File meta**:
Facts about one archive that apply to every line: session, working directory, whether it is a subagent, and the user signal. It is learned from the archive's lines as they arrive.
_Avoid_: header, session info

**User signal**:
The rule a Codex archive uses to recognise exchange start messages, chosen by which event kinds the archive contains.

**Reparse point**:
Where the next sync resumes parsing an archive: the start of its last exchange, which may still be in progress.
_Avoid_: checkpoint, cursor

### Search

**Concept**:
One element of an array query. A conversation matches only if every concept matches somewhere in it.
_Avoid_: term, keyword
