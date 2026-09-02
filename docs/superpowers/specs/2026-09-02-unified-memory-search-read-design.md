# Unified compact search/read design

## Goal

Make the episodic-memory and private-journal-mcp retrieval surfaces follow the
same Aside-like flow:

```text
search(query, limit?) -> compact result cards -> read(ids) -> selected detail
```

The default search limit is 10. `threshold`, `explain`, and the journal
equivalent `minScore` are not public controls.

## Scope

- Keep episodic multi-query search as strict AND search.
- Add bounded multi-record reads to both MCP servers.
- Use `search` and `read` as the retrieval tool names in both servers.
- Keep `write_journal` and `list_journal`; they are separate journal lifecycle
  capabilities and are not part of this retrieval rename.
- Keep Markdown and the episodic SQLite memory records as the canonical data.
- Do not add automatic promotion, taxonomy, or a new transcript archive API.

## Public contracts

### Search

`episodic-memory` accepts a string or an array of 2-5 strings. Arrays retain
strict AND semantics. The only ranking control is the optional `limit`, which
defaults to 10 and is capped at the existing maximum.

`private-journal-mcp` keeps the useful scope filters `section` and `project`.
It removes `minScore`; the search service keeps one fixed internal ranking
policy.

Both tools return only `{ results }`. A result card contains a compact public
ID, short text/title data, date, and a rounded score. Query/options metadata,
absolute paths, UUIDs, and score explanations are omitted.

### Read

Both tools accept `{ ids: string[] }`, with 1-10 IDs, and return records in
the requested order:

```json
{
  "results": [],
  "missing": []
}
```

Missing records do not discard successful records. Invalid IDs are rejected by
the boundary. `episodic-memory` reads the stored memory records themselves;
there is no transcript provenance contract in the current flat mem0 model.
`private-journal-mcp` reads the selected Markdown files after resolving the
compact ID inside the journal data directory.

## ID strategy

Public IDs are aliases. Canonical IDs and paths remain internal.

- Episodic memory uses a reversible `e_` alias. UUIDs are encoded from their
  16-byte binary representation, reducing a 36-character UUID to 24
  characters including the prefix. Non-UUID test/legacy IDs use a reversible
  UTF-8 fallback. Full canonical IDs remain accepted for direct reads.
- Journal entries use a deterministic `j_` alias derived from the generated
  date/time filename, encoded in base36. Legacy non-standard paths use a
  reversible path fallback. The alias is stable across SQLite index rebuilds
  and machine-local data path changes.

No public response exposes the absolute journal path. Internal path validation
remains unchanged.

## Aside alignment and boundary

Aside publicly describes post-task extraction/dreaming into episodic and
subject-oriented Markdown memory, followed by relevant context restoration.
This change adopts the useful retrieval boundary only: compact discovery and
explicit detail expansion. It does not claim to reproduce Aside's private
search algorithm or internal ID format.

## Verification

- Schema tests reject `threshold`, `explain`, and `minScore`.
- Search tests verify default limit 10, compact cards, and strict multi-query
  intersection.
- Read tests verify one and many IDs, requested ordering, missing IDs, and
  path/ID security.
- Tool-list tests expose `search` and `read` in both servers.
- Build, focused tests, full tests where the existing suite is runnable, and a
  real stdio `tools/list`/`tools/call` smoke test are required.
