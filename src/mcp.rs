use crate::db;
use crate::embed::Embedder;
use crate::host::session_of;
use crate::paths::Paths;
use crate::read::read_archive;
use crate::search::{Hit, SearchParams, search};
use anyhow::Result;
use chrono::{DateTime, Local, NaiveDate, TimeZone};
use serde_json::{Map, Value, json};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 50;
const KEYWORD_ONLY: &str = "(vector search unavailable: model loading — keyword results only)";
const KEYWORD_ONLY_FAILED: &str =
    "(vector search unavailable: model unavailable — keyword results only)";
const SEMANTIC_ONLY: &str = "(no keyword match — semantic matches only)";

pub struct Ctx {
    pub paths: Paths,
    pub embedder: Arc<RwLock<Option<Arc<dyn Embedder>>>>,
    /// Model load ended in an error (the daemon will not retry).
    pub load_failed: AtomicBool,
}

/// Newline-delimited JSON-RPC 2.0 over `r`/`w` until EOF on `r`. `host_pid` is the Claude Code
/// or Codex process behind the connection; search leaves out the session it is running.
pub fn serve(r: impl BufRead, mut w: impl Write, ctx: &Ctx, host_pid: Option<u32>) -> Result<()> {
    for line in r.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => handle(&msg, ctx, host_pid),
            Err(_) => Some(error(&Value::Null, -32700, "Parse error")),
        };
        if let Some(resp) = resp {
            serde_json::to_writer(&mut w, &resp)?;
            w.write_all(b"\n")?;
            w.flush()?;
        }
    }
    Ok(())
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// Messages without an `id` are notifications and get no response.
fn handle(msg: &Value, ctx: &Ctx, host_pid: Option<u32>) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => json!({
            "protocolVersion": params.get("protocolVersion").cloned()
                .unwrap_or_else(|| json!("2025-06-18")),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "episodic-memory", "version": VERSION},
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": tools()}),
        "tools/call" => {
            let empty = Map::new();
            let args = params
                .get("arguments")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let out = match params.get("name").and_then(Value::as_str) {
                Some("search") => search_tool(args, ctx, host_pid),
                Some("read") => read_tool(args, ctx),
                other => Err(format!("unknown tool: {}", other.unwrap_or(""))),
            };
            match out {
                Ok(text) => json!({"content": [{"type": "text", "text": text}]}),
                Err(text) => {
                    json!({"content": [{"type": "text", "text": text}], "isError": true})
                }
            }
        }
        _ => return Some(error(&id, -32601, "Method not found")),
    };
    Some(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn tools() -> Value {
    let annotations = |title: &str| {
        json!({
            "title": title, "readOnlyHint": true, "destructiveHint": false,
            "idempotentHint": true, "openWorldHint": false,
        })
    };
    let date_schema = |description: &str| json!({"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": description});
    json!([
        {
            "name": "search",
            "description": "Gives you memory across sessions. You don't automatically remember past Claude Code and Codex conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Single string for hybrid semantic and keyword search, or array of 2-5 concepts for precise AND matching (conversations containing every concept). Subagent (sidechain) conversations are included, de-ranked on ties with main-thread matches (an exact keyword hit can still rank first). Returns ranked results with project, date, snippets, and archive paths with line ranges to pass to read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"oneOf": [
                        {"type": "string", "minLength": 1},
                        {"type": "array", "items": {"type": "string", "minLength": 1},
                         "minItems": 2, "maxItems": 5},
                    ]},
                    "limit": {"type": "number", "minimum": 1, "maximum": MAX_LIMIT,
                              "default": DEFAULT_LIMIT},
                    "after": date_schema("Only conversations on or after this local date (YYYY-MM-DD)"),
                    "before": date_schema("Only conversations on or before this local date (YYYY-MM-DD)"),
                    "project": {"type": "string", "minLength": 1,
                                "description": "Filter by project name (exact match)"},
                },
                "required": ["query"],
                "additionalProperties": false,
            },
            "annotations": annotations("Search Episodic Memory"),
        },
        {
            "name": "read",
            "description": "Read full conversations to extract detailed context after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Pass the archive path from a search result; use startLine/endLine pagination (1-indexed, e.g. the line range from search) to avoid context bloat. Long output ends with the startLine to continue from.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "minLength": 1},
                    "startLine": {"type": "number", "minimum": 1},
                    "endLine": {"type": "number", "minimum": 1},
                },
                "required": ["path"],
                "additionalProperties": false,
            },
            "annotations": annotations("Read Full Conversation"),
        },
    ])
}

fn positive_int(args: &Map<String, Value>, key: &str) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(n) if n >= 1.0 && n.fract() == 0.0 => Ok(Some(n.min(usize::MAX as f64) as usize)),
            _ => Err(format!("{key} must be a positive integer")),
        },
    }
}

fn date(args: &Map<String, Value>, key: &str) -> Result<Option<NaiveDate>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.len() == 10 => NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .map(Some)
            .map_err(|_| format!("{key} must be a date in YYYY-MM-DD format")),
        Some(_) => Err(format!("{key} must be a date in YYYY-MM-DD format")),
    }
}

fn search_params(args: &Map<String, Value>) -> Result<SearchParams, String> {
    let non_empty = |v: &Value| {
        v.as_str()
            .filter(|s| !s.trim().is_empty())
            .map(String::from)
    };
    let queries = match args.get("query") {
        Some(v @ Value::String(_)) => vec![non_empty(v).ok_or("query must not be empty")?],
        Some(Value::Array(items)) if (2..=5).contains(&items.len()) => items
            .iter()
            .map(|v| non_empty(v).ok_or("query items must be non-empty strings"))
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("query must be a string or an array of 2-5 strings".into()),
        None => return Err("query is required".into()),
    };
    let project = match args.get("project") {
        None | Some(Value::Null) => None,
        Some(v) => Some(non_empty(v).ok_or("project must be a non-empty string")?),
    };
    Ok(SearchParams {
        queries,
        limit: positive_int(args, "limit")?
            .unwrap_or(DEFAULT_LIMIT)
            .min(MAX_LIMIT),
        after: date(args, "after")?,
        before: date(args, "before")?,
        project,
        exclude_session: None,
    })
}

fn search_tool(
    args: &Map<String, Value>,
    ctx: &Ctx,
    host_pid: Option<u32>,
) -> Result<String, String> {
    let mut params = search_params(args)?;
    let conn = db::open(&ctx.paths.db()).map_err(|e| format!("search failed: {e:#}"))?;
    params.exclude_session = host_pid.and_then(|pid| session_of(&conn, pid));
    let embedder = crate::locks::read(&ctx.embedder).clone();
    let out = match search(&conn, embedder.as_deref(), &params) {
        Err(_) if embedder.is_some() => search(&conn, None, &params),
        r => r,
    }
    .map_err(|e| format!("search failed: {e:#}"))?;

    let mut text = String::new();
    if !out.vector_used {
        text.push_str(if ctx.load_failed.load(Ordering::SeqCst) {
            KEYWORD_ONLY_FAILED
        } else {
            KEYWORD_ONLY
        });
        text.push('\n');
    } else if !out.hits.is_empty() && !out.keyword_match {
        text.push_str(SEMANTIC_ONLY);
        text.push('\n');
    }
    if out.hits.is_empty() {
        text.push_str("No results.");
    } else {
        let cards: Vec<String> = out
            .hits
            .iter()
            .enumerate()
            .map(|(i, h)| card(i + 1, h))
            .collect();
        text.push_str(&cards.join("\n\n"));
    }
    Ok(text)
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn card(n: usize, h: &Hit) -> String {
    card_in(n, h, &Local)
}

/// Result card with the date shown in `tz`.
fn card_in<Tz: TimeZone>(n: usize, h: &Hit, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let day = DateTime::from_timestamp_millis(h.ts)
        .map(|d| d.with_timezone(tz).format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    format!(
        "{n}. [{}, {day}, score {:.2}]\n   User: {}\n   Assistant: {}\n   {}:{}-{}",
        h.project,
        h.score,
        one_line(&h.user_snippet),
        one_line(&h.assistant_snippet),
        h.archive_path,
        h.line_start,
        h.line_end
    )
}

fn read_tool(args: &Map<String, Value>, ctx: &Ctx) -> Result<String, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("path is required")?;
    let start = positive_int(args, "startLine")?;
    let end = positive_int(args, "endLine")?;
    read_archive(&ctx.paths, path, start, end).map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::FakeEmbedder;
    use crate::paths::{SourceKind, SourceRoot};
    use crate::sync::run_sync_with_roots;
    use serde_json::{Value, json};

    fn indexed_ctx() -> (tempfile::TempDir, Ctx) {
        let t = tempfile::tempdir().unwrap();
        let projects = t.path().join("claude/projects/demo");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/claude/main.jsonl"
            ),
            projects.join("main.jsonl"),
        )
        .unwrap();
        let paths = Paths::new(t.path().join("data"));
        let roots = vec![SourceRoot {
            kind: SourceKind::ClaudeCodeProjects,
            root: t.path().join("claude/projects"),
        }];
        run_sync_with_roots(&paths, Some(&FakeEmbedder), &roots).unwrap();
        let embedder: Arc<dyn Embedder> = Arc::new(FakeEmbedder);
        let ctx = Ctx {
            paths,
            embedder: Arc::new(RwLock::new(Some(embedder))),
            load_failed: AtomicBool::new(false),
        };
        (t, ctx)
    }

    /// Feeds each request as one line and returns the parsed response lines.
    fn exchange(ctx: &Ctx, reqs: &[Value]) -> Vec<Value> {
        let input: String = reqs.iter().map(|r| r.to_string() + "\n").collect();
        let mut out = Vec::new();
        serve(input.as_bytes(), &mut out, ctx, None).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn call(id: i64, name: &str, args: &Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":args}})
    }

    #[test]
    fn card_date_uses_given_timezone() {
        use chrono::{FixedOffset, Utc};
        let h = Hit {
            exchange_id: 1,
            project: "demo".into(),
            // 2026-01-02T20:00:00Z
            ts: 1_767_384_000_000,
            score: 1.0,
            user_snippet: "u".into(),
            assistant_snippet: "a".into(),
            archive_path: "/p".into(),
            line_start: 1,
            line_end: 2,
        };
        assert!(card_in(1, &h, &Utc).starts_with("1. [demo, 2026-01-02,"));
        let kst = FixedOffset::east_opt(9 * 3600).unwrap();
        assert!(card_in(1, &h, &kst).starts_with("1. [demo, 2026-01-03,"));
    }

    fn text(resp: &Value) -> &str {
        resp["result"]["content"][0]["text"].as_str().unwrap()
    }

    #[test]
    fn initialize_list_and_search() {
        let (_t, ctx) = indexed_ctx();
        let resps = exchange(
            &ctx,
            &[
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}),
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
                call(3, "search", &json!({"query":"list files"})),
            ],
        );
        assert_eq!(resps.len(), 3, "notification must not get a response");
        assert_eq!(resps[0]["id"], 1);
        assert_eq!(resps[0]["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(resps[0]["result"]["serverInfo"]["name"], "episodic-memory");
        assert_eq!(
            resps[0]["result"]["serverInfo"]["version"],
            env!("CARGO_PKG_VERSION")
        );
        assert!(resps[0]["result"]["capabilities"]["tools"].is_object());

        let names: Vec<&str> = resps[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["search", "read"]);

        assert_eq!(resps[2]["id"], 3);
        assert_ne!(resps[2]["result"]["isError"], true);
        let body = text(&resps[2]);
        // Fixture ts is 2026-01-02T03:04:05Z; the card shows the machine-local date.
        let local_day = DateTime::from_timestamp_millis(1_767_323_045_000)
            .unwrap()
            .with_timezone(&Local)
            .format("%Y-%m-%d")
            .to_string();
        let archive = ctx.paths.archive_root();
        assert!(
            body.contains(&*archive.to_string_lossy()),
            "no archive path in: {body}"
        );
        assert!(
            body.starts_with(&format!("1. [demo, {local_day}, score 1.00]")),
            "{body}"
        );
        assert!(
            body.contains("\n   User: Q1 how do I list files?"),
            "{body}"
        );
        assert!(!body.contains("vector search unavailable"), "{body}");
    }

    #[test]
    fn keyword_only_notice_without_embedder() {
        let (_t, ctx) = indexed_ctx();
        *ctx.embedder.write().unwrap() = None;
        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"list files"}))])[0];
        let body = text(r);
        assert!(
            body.starts_with("(vector search unavailable: model loading — keyword results only)\n"),
            "{body}"
        );
        assert!(body.contains("main.jsonl:"), "{body}");
    }

    #[test]
    fn keyword_only_notice_after_failed_load() {
        let (_t, ctx) = indexed_ctx();
        *ctx.embedder.write().unwrap() = None;
        ctx.load_failed.store(true, Ordering::SeqCst);
        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"list files"}))])[0];
        let body = text(r);
        assert!(
            body.starts_with(
                "(vector search unavailable: model unavailable — keyword results only)\n"
            ),
            "{body}"
        );
    }

    struct Broken;
    impl Embedder for Broken {
        fn embed_passages(&self, _: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            anyhow::bail!("broken")
        }
        fn embed_query(&self, _: &str) -> anyhow::Result<Vec<f32>> {
            anyhow::bail!("broken")
        }
    }

    #[test]
    fn embedder_error_falls_back_to_keywords() {
        let (_t, ctx) = indexed_ctx();
        *ctx.embedder.write().unwrap() = Some(Arc::new(Broken));
        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"list files"}))])[0];
        assert_ne!(r["result"]["isError"], true, "{r}");
        assert!(text(r).starts_with(KEYWORD_ONLY), "{}", text(r));
        assert!(text(r).contains("main.jsonl:"));
    }

    #[test]
    fn no_results_and_array_query() {
        let (_t, ctx) = indexed_ctx();
        let r = call(2, "search", &json!({"query":["list","files"], "limit": 99}));
        let r = &exchange(&ctx, &[r])[0];
        assert!(text(r).starts_with("1. ["), "{}", text(r));
        // No keyword match and no vector neighbour above the floor: nothing at all.
        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"zzqqxx"}))])[0];
        assert_eq!(text(r), "No results.");
        *ctx.embedder.write().unwrap() = None;
        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"zzqqxx"}))])[0];
        assert_eq!(text(r), format!("{KEYWORD_ONLY}\nNo results."));
    }

    /// Every passage and query embeds to the same vector (cosine 1).
    struct Same;
    impl Embedder for Same {
        fn embed_passages(&self, t: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
            Ok(t.iter().map(|_| self.embed_query("").unwrap()).collect())
        }
        fn embed_query(&self, _: &str) -> anyhow::Result<Vec<f32>> {
            let mut v = vec![0.0; crate::embed::DIMS];
            v[0] = 1.0;
            Ok(v)
        }
    }

    #[test]
    fn semantic_only_notice_when_no_hit_matches_keywords() {
        let (_t, ctx) = indexed_ctx();
        let mut conn = db::open(&ctx.paths.db()).unwrap();
        conn.execute_batch("DELETE FROM vec_exchanges; UPDATE exchanges SET embedded = 0;")
            .unwrap();
        crate::embed::embed_pending(&mut conn, &Same).unwrap();
        *ctx.embedder.write().unwrap() = Some(Arc::new(Same));

        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"zzqqxx"}))])[0];
        let body = text(r);
        assert!(
            body.starts_with(&format!("{SEMANTIC_ONLY}\n1. [")),
            "{body}"
        );

        let r = &exchange(&ctx, &[call(1, "search", &json!({"query":"list files"}))])[0];
        let body = text(r);
        assert!(body.starts_with("1. ["), "{body}");
        assert!(!body.contains(SEMANTIC_ONLY), "{body}");
    }

    #[test]
    fn invalid_inputs_are_tool_errors() {
        let (_t, ctx) = indexed_ctx();
        let bad = [
            json!({"query":"x","limit":"x"}),
            json!({"query":"x","limit":0}),
            json!({}),
            json!({"query":["only one"]}),
            json!({"query":["a","b","c","d","e","f"]}),
            json!({"query":""}),
            json!({"query":"x","after":"2026/01/01"}),
            json!({"query":"x","project":5}),
        ];
        let reqs: Vec<Value> = bad
            .iter()
            .enumerate()
            .map(|(i, a)| call(i as i64, "search", a))
            .collect();
        for (r, a) in exchange(&ctx, &reqs).iter().zip(&bad) {
            assert_eq!(r["result"]["isError"], true, "{a} -> {r}");
            assert!(!text(r).is_empty());
        }
    }

    #[test]
    fn read_tool() {
        let (_t, ctx) = indexed_ctx();
        let path = std::fs::read_dir(ctx.paths.archive_root().join("claude-code-projects/demo"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let r = exchange(
            &ctx,
            &[
                call(
                    1,
                    "read",
                    &json!({"path": path, "startLine": 1, "endLine": 2}),
                ),
                call(2, "read", &json!({"path": "/etc/passwd"})),
                call(3, "read", &json!({"path": path, "startLine": 0})),
                call(4, "read", &json!({})),
            ],
        );
        assert_ne!(r[0]["result"]["isError"], true, "{}", r[0]);
        assert!(text(&r[0]).contains("Q1 how do I list files?"));
        for e in &r[1..] {
            assert_eq!(e["result"]["isError"], true, "{e}");
        }
    }

    #[test]
    fn read_tool_refuses_do_not_index() {
        let (t, ctx) = indexed_ctx();
        let src = t.path().join("claude/projects/demo/secret.jsonl");
        std::fs::write(
            &src,
            json!({"type":"user","sessionId":"s9","message":{"role":"user","content":
                "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>"}})
            .to_string()
                + "\n",
        )
        .unwrap();
        let roots = vec![SourceRoot {
            kind: SourceKind::ClaudeCodeProjects,
            root: t.path().join("claude/projects"),
        }];
        run_sync_with_roots(&ctx.paths, Some(&FakeEmbedder), &roots).unwrap();
        let path = ctx
            .paths
            .archive_root()
            .join("claude-code-projects/demo/secret.jsonl");
        let r = exchange(&ctx, &[call(1, "read", &json!({"path": path}))]);
        assert_eq!(r[0]["result"]["isError"], true, "{}", r[0]);
        assert_eq!(text(&r[0]), "conversation is marked DO NOT INDEX");
    }

    #[test]
    fn protocol_errors() {
        let (_t, ctx) = indexed_ctx();
        let input = "not json\n{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"nope\"}\n{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"ping\"}\n";
        let mut out = Vec::new();
        serve(input.as_bytes(), &mut out, &ctx, None).unwrap();
        let r: Vec<Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(r[0]["error"]["code"], -32700);
        assert!(r[0]["id"].is_null());
        assert_eq!(r[1]["id"], 7);
        assert_eq!(r[1]["error"]["code"], -32601);
        assert_eq!(r[2]["id"], 8);
        assert_eq!(r[2]["result"], json!({}));
    }
}
