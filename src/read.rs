use crate::archive::generation_stem;
use crate::db::open_readonly;
use crate::parse::{read_file_lines_from, render_line, truncate_bytes};
use crate::paths::{Paths, SourceKind};
use anyhow::{Result, anyhow, bail};
use std::fmt::Write as _;
use std::path::{Component, Path};

const OUTPUT_MAX: usize = 61440;
/// Room kept for the trailing `_(continue with startLine=<n>)_` line.
const MARKER_RESERVE: usize = 64;

fn kind_of(first: &str) -> Result<SourceKind> {
    SourceKind::ALL
        .into_iter()
        .find(|k| k.as_str() == first)
        .ok_or_else(|| anyhow!("unknown archive source: {first}"))
}

/// `<stem>.gen-N.jsonl` -> `<stem>.jsonl`; other names are unchanged.
fn generation_base(p: &Path) -> std::path::PathBuf {
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned());
    match name.as_deref().and_then(generation_stem) {
        Some(stem) => p.with_file_name(format!("{stem}.jsonl")),
        None => p.to_path_buf(),
    }
}

/// True when the index marks this archive file (any generation of its source) DO NOT INDEX.
/// `Ok(false)` only when no DB exists yet; every other failure is an error (fail closed).
fn is_skipped(paths: &Paths, full: &Path) -> Result<bool> {
    let db = paths.db();
    if !db.exists() {
        return Ok(false);
    }
    let c = open_readonly(&db, false)
        .map_err(|e| anyhow!("cannot check DO NOT INDEX status: {e:#}"))?;
    let check = || -> rusqlite::Result<Vec<String>> {
        let mut stmt = c.prepare("SELECT archive_path FROM files WHERE skipped = 1")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect()
    };
    let archive_paths = check().map_err(|e| anyhow!("cannot check DO NOT INDEX status: {e}"))?;
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let target = generation_base(full);
    Ok(archive_paths
        .iter()
        .any(|a| generation_base(&canon(Path::new(a))) == target))
}

/// Renders an archive file as markdown, `L<line> `-prefixed per item, from `start` to `end`
/// (1-based, inclusive). Stops before the output would pass 60 KB and says where to continue.
pub fn read_archive(
    paths: &Paths,
    path: &str,
    start: Option<usize>,
    end: Option<usize>,
) -> Result<String> {
    let root = paths
        .archive_root()
        .canonicalize()
        .map_err(|_| anyhow!("file not found: {path}"))?;
    let given = Path::new(path);
    let full = if given.is_absolute() {
        given.to_path_buf()
    } else {
        root.join(given)
    };
    let full = full
        .canonicalize()
        .map_err(|_| anyhow!("file not found: {path}"))?;
    let rel = full
        .strip_prefix(&root)
        .map_err(|_| anyhow!("path outside archive"))?;
    let Some(Component::Normal(first)) = rel.components().next() else {
        bail!("path outside archive");
    };
    let kind = kind_of(&first.to_string_lossy())?;
    if !full.is_file() {
        bail!("file not found: {path}");
    }
    if is_skipped(paths, &full)? {
        bail!("conversation is marked DO NOT INDEX");
    }

    let (start, end) = (
        start.unwrap_or(1).max(1) as i64,
        end.map_or(i64::MAX, |e| e as i64),
    );
    let budget = OUTPUT_MAX - MARKER_RESERVE;
    let mut out = String::new();
    let mut lines = read_file_lines_from(&full, start)?;
    while let Some(line) = lines.next() {
        let (n, v) = line?;
        if n > end {
            break;
        }
        let Some(v) = v else { continue };
        let items = render_line(kind, &v);
        if items.is_empty() {
            continue;
        }
        let mut block = String::new();
        for i in &items {
            let _ = write!(block, "L{n} {i}\n\n");
        }
        if out.len() + block.len() <= budget {
            out.push_str(&block);
            continue;
        }
        if out.is_empty() {
            // Progress is always at least one line: emit it cut to fit.
            out.push_str(&truncate_bytes(&block, budget - 16));
            out.push_str("\n\n");
            if lines.next().is_some_and(|l| l.is_ok_and(|(m, _)| m <= end)) {
                let _ = write!(out, "_(continue with startLine={})_", n + 1);
            }
        } else {
            let _ = write!(out, "_(continue with startLine={n})_");
        }
        return Ok(out);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Env {
        _t: tempfile::TempDir,
        paths: Paths,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        fs::create_dir_all(paths.archive_root()).unwrap();
        Env { _t: t, paths }
    }

    impl Env {
        fn put(&self, rel: &str, lines: &[String]) -> String {
            let p = self.paths.archive_root().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, lines.join("\n") + "\n").unwrap();
            p.to_string_lossy().into_owned()
        }
    }

    fn user(t: &str) -> String {
        json!({"type":"user","message":{"role":"user","content":t}}).to_string()
    }

    fn assistant_tool(name: &str, input: &serde_json::Value) -> String {
        json!({"type":"assistant","message":{"content":[
            {"type":"text","text":"on it"},
            {"type":"tool_use","name":name,"input":input}]}})
        .to_string()
    }

    fn tool_result(out: &str) -> String {
        json!({"type":"user","message":{"content":[
            {"type":"tool_result","tool_use_id":"t1","content":out}]}})
        .to_string()
    }

    fn continue_line(out: &str) -> Option<usize> {
        let tail = out.rsplit("_(continue with startLine=").next()?;
        out.contains("_(continue with startLine=")
            .then(|| tail.trim_end_matches(")_").parse().unwrap())
    }

    #[test]
    fn renders_user_assistant_tool_and_result() {
        let e = env();
        let p = e.put(
            "claude-code-projects/p/s.jsonl",
            &[
                user("hello there"),
                assistant_tool("Bash", &json!({"command":"ls"})),
                tool_result("file-a\nfile-b"),
                json!({"type":"summary"}).to_string(),
            ],
        );
        let out = read_archive(&e.paths, &p, None, None).unwrap();
        assert!(out.contains("L1 **User:** hello there"), "{out}");
        assert!(out.contains("L2 **Assistant:** on it"), "{out}");
        assert!(
            out.contains("L2 **Tool Bash:** {\"command\":\"ls\"}"),
            "{out}"
        );
        assert!(out.contains("L3 **Result:** file-a\nfile-b"), "{out}");
        assert!(!out.contains("L4"), "{out}");
        assert!(!out.contains("continue"));
    }

    #[test]
    fn renders_codex_items() {
        let e = env();
        let item = |p: serde_json::Value| json!({"type":"response_item","payload":p}).to_string();
        let p = e.put(
            "codex-sessions/2026/s.jsonl",
            &[
                item(json!({"type":"message","role":"user","content":[{"type":"input_text","text":"do it"}]})),
                item(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]})),
                item(json!({"type":"function_call","name":"shell","arguments":"{\"cmd\":\"pwd\"}"})),
                item(json!({"type":"function_call_output","output":"/tmp"})),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"dup"}}).to_string(),
            ],
        );
        let out = read_archive(&e.paths, &p, None, None).unwrap();
        assert!(out.contains("L1 **User:** do it"), "{out}");
        assert!(out.contains("L2 **Assistant:** done"), "{out}");
        assert!(
            out.contains("L3 **Tool shell:** {\"cmd\":\"pwd\"}"),
            "{out}"
        );
        assert!(out.contains("L4 **Result:** /tmp"), "{out}");
        assert!(!out.contains("dup"));
    }

    #[test]
    fn line_range_and_relative_path() {
        let e = env();
        e.put(
            "claude-code-projects/p/s.jsonl",
            &[user("one"), user("two"), user("three"), user("four")],
        );
        let out =
            read_archive(&e.paths, "claude-code-projects/p/s.jsonl", Some(2), Some(3)).unwrap();
        assert!(!out.contains("one") && !out.contains("four"), "{out}");
        assert!(out.contains("L2 **User:** two") && out.contains("L3 **User:** three"));
        let out = read_archive(&e.paths, "claude-code-projects/p/s.jsonl", Some(4), None).unwrap();
        assert_eq!(out.trim(), "L4 **User:** four");
    }

    #[test]
    fn bad_json_lines_are_skipped() {
        let e = env();
        let p = e.put(
            "claude-code-projects/p/s.jsonl",
            &[user("one"), "{not json".into(), user("three")],
        );
        let out = read_archive(&e.paths, &p, None, None).unwrap();
        assert!(out.contains("L1 ") && out.contains("L3 ") && !out.contains("L2 "));
    }

    #[test]
    fn tool_result_truncated_to_4096_bytes() {
        let e = env();
        let p = e.put(
            "claude-code-projects/p/s.jsonl",
            &[tool_result(&"가".repeat(40_000))],
        );
        let out = read_archive(&e.paths, &p, None, None).unwrap();
        assert!(out.contains("…[truncated]"));
        let body = out
            .strip_prefix("L1 **Result:** ")
            .unwrap()
            .trim_end()
            .strip_suffix("…[truncated]")
            .unwrap();
        assert!(body.len() <= 4096 && body.len() > 4090, "{}", body.len());
    }

    #[test]
    fn long_file_pages_under_60kb_and_progresses() {
        let e = env();
        let lines: Vec<String> = (0..1000)
            .map(|i| user(&format!("{i} {}", "x".repeat(300))))
            .collect();
        let p = e.put("claude-code-projects/p/s.jsonl", &lines);
        let mut start = 1;
        let mut seen = 0;
        loop {
            let out = read_archive(&e.paths, &p, Some(start), None).unwrap();
            assert!(out.len() <= 61440, "{}", out.len());
            seen += out.matches("**User:**").count();
            match continue_line(&out) {
                Some(n) => {
                    assert!(n > start);
                    start = n;
                }
                None => break,
            }
        }
        assert_eq!(seen, 1000);
    }

    #[test]
    fn oversized_single_line_still_progresses() {
        let e = env();
        // Many tool calls on one line exceed the cap even after per-item truncation.
        let blocks: Vec<_> = (0..30)
            .map(|_| json!({"type":"tool_use","name":"T","input":{"x":"y".repeat(5000)}}))
            .collect();
        let big = json!({"type":"assistant","message":{"content":blocks}}).to_string();
        let p = e.put("claude-code-projects/p/s.jsonl", &[big, user("after")]);
        let out = read_archive(&e.paths, &p, None, None).unwrap();
        assert!(out.len() <= 61440);
        assert!(out.starts_with("L1 **Tool T:**"));
        assert_eq!(continue_line(&out), Some(2));
        let out = read_archive(&e.paths, &p, Some(2), None).unwrap();
        assert_eq!(out.trim(), "L2 **User:** after");
    }

    #[test]
    fn rejects_paths_outside_archive_and_missing_files() {
        let e = env();
        e.put("claude-code-projects/p/s.jsonl", &[user("x")]);
        let outside = e.paths.data.join("secret.txt");
        fs::write(&outside, "nope").unwrap();
        let err = read_archive(&e.paths, outside.to_str().unwrap(), None, None).unwrap_err();
        assert_eq!(err.to_string(), "path outside archive");
        let err = read_archive(&e.paths, "../secret.txt", None, None).unwrap_err();
        assert_eq!(err.to_string(), "path outside archive");
        let err =
            read_archive(&e.paths, "../../../../../../../../etc/passwd", None, None).unwrap_err();
        assert_eq!(err.to_string(), "path outside archive");
        let err =
            read_archive(&e.paths, "claude-code-projects/p/none.jsonl", None, None).unwrap_err();
        assert!(err.to_string().starts_with("file not found: "), "{err}");
        // A symlink pointing out of the archive is outside too.
        std::os::unix::fs::symlink(
            &outside,
            e.paths.archive_root().join("claude-code-projects/l"),
        )
        .unwrap();
        let err = read_archive(&e.paths, "claude-code-projects/l", None, None).unwrap_err();
        assert_eq!(err.to_string(), "path outside archive");
    }

    fn synced_with_marker() -> (tempfile::TempDir, Paths) {
        use crate::paths::SourceRoot;
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("src/projects");
        fs::create_dir_all(root.join("p")).unwrap();
        let ok = [user("normal talk")];
        let bad = [user(
            "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>",
        )];
        fs::write(root.join("p/ok.jsonl"), ok.join("\n") + "\n").unwrap();
        fs::write(root.join("p/bad.jsonl"), bad.join("\n") + "\n").unwrap();
        let paths = Paths::new(t.path().join("data"));
        let roots = vec![SourceRoot {
            kind: SourceKind::ClaudeCodeProjects,
            root,
        }];
        crate::sync::run_sync_with_roots(&paths, None, &roots).unwrap();
        (t, paths)
    }

    #[test]
    fn do_not_index_conversation_is_refused() {
        let (_t, paths) = synced_with_marker();
        let dir = paths.archive_root().join("claude-code-projects/p");
        let bad = dir.join("bad.jsonl");
        assert!(bad.exists(), "archive mirrors skipped files");
        for p in [bad.to_str().unwrap(), "claude-code-projects/p/bad.jsonl"] {
            let err = read_archive(&paths, p, None, None).unwrap_err();
            assert_eq!(err.to_string(), "conversation is marked DO NOT INDEX");
        }
        // Older generation of a skipped source is refused too.
        let old = dir.join("bad.gen-0.jsonl");
        fs::copy(&bad, &old).unwrap();
        let err = read_archive(&paths, old.to_str().unwrap(), None, None).unwrap_err();
        assert_eq!(err.to_string(), "conversation is marked DO NOT INDEX");
        // Lookalike names are different conversations and stay readable.
        for name in ["bad2.jsonl", "bad.gen-x.jsonl"] {
            fs::write(dir.join(name), user("lookalike") + "\n").unwrap();
            let out = read_archive(&paths, dir.join(name).to_str().unwrap(), None, None).unwrap();
            assert!(out.contains("lookalike"), "{name}: {out}");
        }
        let out = read_archive(&paths, dir.join("ok.jsonl").to_str().unwrap(), None, None).unwrap();
        assert!(out.contains("normal talk"), "{out}");
    }

    #[test]
    fn unqueryable_db_fails_closed_and_missing_db_allows() {
        let e = env();
        let p = e.put("claude-code-projects/p/s.jsonl", &[user("visible")]);
        // No DB file yet: nothing can be marked, read works.
        let out = read_archive(&e.paths, &p, None, None).unwrap();
        assert!(out.contains("visible"));
        // A DB that exists but cannot be queried: refuse rather than expose content.
        fs::write(
            e.paths.db(),
            "this is not a sqlite database, just garbage bytes",
        )
        .unwrap();
        let err = read_archive(&e.paths, &p, None, None).unwrap_err();
        assert!(
            err.to_string()
                .starts_with("cannot check DO NOT INDEX status"),
            "{err}"
        );
    }

    #[test]
    fn generation_base_strips_only_numeric_gen_suffix() {
        let g = |s: &str| generation_base(Path::new(s));
        assert_eq!(g("/a/x.gen-12.jsonl"), Path::new("/a/x.jsonl"));
        assert_eq!(g("/a/x.gen-.jsonl"), Path::new("/a/x.gen-.jsonl"));
        assert_eq!(g("/a/x.gen-1a.jsonl"), Path::new("/a/x.gen-1a.jsonl"));
        assert_eq!(g("/a/x.jsonl"), Path::new("/a/x.jsonl"));
    }

    #[test]
    fn unknown_source_directory_is_an_error() {
        let e = env();
        let p = e.put("mystery/s.jsonl", &[user("x")]);
        let err = read_archive(&e.paths, &p, None, None).unwrap_err();
        assert!(
            err.to_string().starts_with("unknown archive source"),
            "{err}"
        );
    }
}
