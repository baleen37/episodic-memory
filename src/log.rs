#![allow(dead_code)] // not yet used by main; wired in later tasks

use crate::paths::Paths;
use std::io::Write;

/// Appends `[RFC3339] msg` to the log file. Never panics; errors are ignored.
pub fn log_line(paths: &Paths, msg: &str) {
    let _ = try_log_line(paths, msg);
}

fn try_log_line(paths: &Paths, msg: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(paths.logs())?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.logs().join("episodic-memory.log"))?;
    let ts = chrono::Local::now().to_rfc3339();
    writeln!(f, "[{ts}] {msg}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Paths;

    #[test]
    fn appends_lines_to_log_file() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths::new(tmp.path().join("data"));
        log_line(&paths, "first");
        log_line(&paths, "second");
        let text = std::fs::read_to_string(paths.logs().join("episodic-memory.log")).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with('[') && lines[0].ends_with("] first"));
        assert!(lines[1].ends_with("] second"));
    }

    #[test]
    fn failure_does_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("afile");
        std::fs::write(&file, "").unwrap();
        log_line(&Paths::new(file.join("sub")), "ignored");
    }
}
