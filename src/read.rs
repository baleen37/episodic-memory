#![allow(dead_code)] // not yet used by main; wired in later tasks

use crate::parse::{read_file_lines, render_line};
use crate::paths::{Paths, SourceKind};
use anyhow::{anyhow, bail, Result};
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

fn cut(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
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

    let (start, end) = (
        start.unwrap_or(1).max(1) as i64,
        end.map_or(i64::MAX, |e| e as i64),
    );
    let budget = OUTPUT_MAX - MARKER_RESERVE;
    let mut out = String::new();
    let mut lines = read_file_lines(&full)?;
    while let Some(line) = lines.next() {
        let (n, v) = line?;
        if n < start {
            continue;
        }
        if n > end {
            break;
        }
        let Some(v) = v else { continue };
        let items = render_line(kind, &v);
        if items.is_empty() {
            continue;
        }
        let block: String = items.iter().map(|i| format!("L{n} {i}\n\n")).collect();
        if out.len() + block.len() <= budget {
            out.push_str(&block);
            continue;
        }
        if out.is_empty() {
            // Progress is always at least one line: emit it cut to fit.
            out.push_str(cut(&block, budget - 16));
            out.push_str("…[truncated]\n\n");
            if lines.next().is_some_and(|l| l.is_ok_and(|(m, _)| m <= end)) {
                out.push_str(&format!("_(continue with startLine={})_", n + 1));
            }
        } else {
            out.push_str(&format!("_(continue with startLine={n})_"));
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

    fn assistant_tool(name: &str, input: serde_json::Value) -> String {
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
                assistant_tool("Bash", json!({"command":"ls"})),
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
