# Phase 6 — index-equivalence harness

LLM-free proof that a `conversations.db` built by ONE implementation (TS or Go)
is read identically by the OTHER, producing the SAME search results
(ids / order / scores). The vectors are cosine=1.0 identical (Phase 0), the
schema is byte-identical (db port), and the search SQL matches (search port);
this harness ties those together at the binary/integration level.

## What it does

1. `ts_insert.ts` + `corpus.ts` — open the DB at `CONVERSATION_MEMORY_DB_PATH`,
   insert a fixed 8-record corpus, each with a real TS `embedPassage` vector.
2. `goinsert/` (`main.go` + `corpus.go`) — same corpus, Go `EmbedPassage`
   vectors, into a separate DB. `corpus.go` mirrors `corpus.ts` byte-for-byte.
3. `run_equivalence.sh` — builds both DBs, then runs BOTH `search` binaries
   against BOTH DBs over a query set (single, multi-word, `--after`/`--before`/
   `--source-kind`/`--limit` filters, a no-match query) and asserts all four
   `impl × db` outputs are byte-identical.
4. `ts_search_dump.ts` + `godump/` — emit full-precision `(id, score)` JSON so
   scores can be diffed below the 2-decimal `Score: NN%` CLI rounding. Observed
   cross-impl max score delta ~6.8e-8 with identical ordering.

## Run

```bash
# from repo root
export CGO_LDFLAGS="-L$(pwd)/poc/lib"
go build -o /tmp/memmem-go ./cmd/memmem
GO_BIN=/tmp/memmem-go scripts/phase6/run_equivalence.sh
```

The script sets `MEMMEM_MODEL_PATH` / `MEMMEM_TOKENIZER_PATH` /
`MEMMEM_ORT_LIB_PATH` to the repo-local `.cache` model so nothing downloads.

## MCP one-shot smoke

```bash
go build -o /tmp/memmem-mcp-go ./cmd/memmem-mcp
# pipe initialize + tools/list + tools/call(search) as newline-delimited JSON-RPC
# to /tmp/memmem-mcp-go over stdin; expect search + fetch tools and a result envelope.
```

See `docs/phase6-manual-verification.md` for the deferred external-dependency
checks (extraction-with-LLM, MCP-in-Claude-Code, clean-room deploy).
