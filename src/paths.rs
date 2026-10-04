use fs2::FileExt;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Opens (creating if needed) `path` and takes a non-blocking exclusive lock on it.
/// `None` when another process holds it; the lock lives as long as the returned file.
pub fn try_lock(path: &Path) -> io::Result<Option<File>> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    Ok(f.try_lock_exclusive().is_ok().then_some(f))
}

#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
}

/// Treats unset and empty env values alike.
fn non_empty(v: Option<OsString>) -> Option<PathBuf> {
    v.filter(|s| !s.is_empty()).map(PathBuf::from)
}

fn home_dir() -> PathBuf {
    non_empty(std::env::var_os("HOME")).unwrap_or_else(|| PathBuf::from("."))
}

impl Paths {
    #[cfg(test)]
    pub fn new(data: PathBuf) -> Paths {
        Paths { data }
    }

    pub fn from_env() -> Paths {
        Paths::from_env_values(std::env::var_os("EPISODIC_MEMORY_DIR"), &home_dir())
    }

    pub fn from_env_values(dir: Option<OsString>, home: &Path) -> Paths {
        let data = non_empty(dir).unwrap_or_else(|| home.join(".config").join("episodic-memory"));
        Paths { data }
    }

    pub fn archive_root(&self) -> PathBuf {
        self.data.join("conversation-archive")
    }

    pub fn db(&self) -> PathBuf {
        self.data.join("episodic.db")
    }

    pub fn models(&self) -> PathBuf {
        self.data.join("models")
    }

    pub fn logs(&self) -> PathBuf {
        self.data.join("logs")
    }

    pub fn daemon_socket(&self) -> PathBuf {
        self.data.join(format!("daemon-{VERSION}.sock"))
    }

    pub fn daemon_lock(&self) -> PathBuf {
        self.data.join(format!("daemon-{VERSION}.lock"))
    }

    pub fn sync_lock(&self) -> PathBuf {
        self.data.join("sync.lock")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    ClaudeCodeProjects,
    ClaudeCodeTranscripts,
    CodexSessions,
}

impl SourceKind {
    pub const ALL: [SourceKind; 3] = [
        SourceKind::ClaudeCodeProjects,
        SourceKind::ClaudeCodeTranscripts,
        SourceKind::CodexSessions,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            SourceKind::ClaudeCodeProjects => "claude-code-projects",
            SourceKind::ClaudeCodeTranscripts => "claude-code-transcripts",
            SourceKind::CodexSessions => "codex-sessions",
        }
    }

    pub fn parse(s: &str) -> Option<SourceKind> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    pub fn harness(&self) -> &'static str {
        match self {
            SourceKind::ClaudeCodeProjects | SourceKind::ClaudeCodeTranscripts => "claude",
            SourceKind::CodexSessions => "codex",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SourceRoot {
    pub kind: SourceKind,
    pub root: PathBuf,
}

/// All three roots resolved from the environment, whether or not they exist.
pub fn candidate_roots_from_env() -> Vec<SourceRoot> {
    candidate_roots(
        std::env::var_os("CLAUDE_CONFIG_DIR"),
        std::env::var_os("CODEX_HOME"),
        &home_dir(),
    )
}

fn candidate_roots(
    claude_config_dir: Option<OsString>,
    codex_home: Option<OsString>,
    home: &Path,
) -> Vec<SourceRoot> {
    let claude = non_empty(claude_config_dir).unwrap_or_else(|| home.join(".claude"));
    let codex = non_empty(codex_home).unwrap_or_else(|| home.join(".codex"));
    vec![
        SourceRoot {
            kind: SourceKind::ClaudeCodeProjects,
            root: claude.join("projects"),
        },
        SourceRoot {
            kind: SourceKind::ClaudeCodeTranscripts,
            root: claude.join("transcripts"),
        },
        SourceRoot {
            kind: SourceKind::CodexSessions,
            root: codex.join("sessions"),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn data_dir_override() {
        let p = Paths::from_env_values(os("/tmp/x"), Path::new("/home/u"));
        assert_eq!(p.db(), PathBuf::from("/tmp/x/episodic.db"));
        assert_eq!(
            p.archive_root(),
            PathBuf::from("/tmp/x/conversation-archive")
        );
        assert_eq!(p.models(), PathBuf::from("/tmp/x/models"));
        assert_eq!(p.logs(), PathBuf::from("/tmp/x/logs"));
    }

    #[test]
    fn data_dir_default_and_empty_override() {
        let expected = PathBuf::from("/home/u/.config/episodic-memory");
        assert_eq!(
            Paths::from_env_values(None, Path::new("/home/u")).data,
            expected
        );
        assert_eq!(
            Paths::from_env_values(os(""), Path::new("/home/u")).data,
            expected
        );
    }

    #[test]
    fn socket_and_lock_naming() {
        let p = Paths::new(PathBuf::from("/tmp/x"));
        let ver = VERSION;
        assert!(
            p.daemon_socket()
                .to_string_lossy()
                .ends_with(&format!("daemon-{ver}.sock"))
        );
        assert!(
            p.daemon_lock()
                .to_string_lossy()
                .ends_with(&format!("daemon-{ver}.lock"))
        );
        assert_eq!(p.sync_lock(), PathBuf::from("/tmp/x/sync.lock"));
        assert!(!p.sync_lock().to_string_lossy().contains(ver));
    }

    #[test]
    fn source_kind_strings() {
        assert_eq!(
            SourceKind::ClaudeCodeProjects.as_str(),
            "claude-code-projects"
        );
        assert_eq!(
            SourceKind::ClaudeCodeTranscripts.as_str(),
            "claude-code-transcripts"
        );
        assert_eq!(SourceKind::CodexSessions.as_str(), "codex-sessions");
        assert_eq!(SourceKind::ClaudeCodeProjects.harness(), "claude");
        assert_eq!(SourceKind::ClaudeCodeTranscripts.harness(), "claude");
        assert_eq!(SourceKind::CodexSessions.harness(), "codex");
        assert_eq!(SourceKind::ALL.len(), 3);
        for k in SourceKind::ALL {
            assert_eq!(SourceKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(SourceKind::parse("nope"), None);
    }

    #[test]
    fn candidate_roots_defaults() {
        let r = candidate_roots(None, None, Path::new("/home/u"));
        let roots: Vec<_> = r.iter().map(|s| s.root.clone()).collect();
        assert_eq!(
            roots,
            vec![
                PathBuf::from("/home/u/.claude/projects"),
                PathBuf::from("/home/u/.claude/transcripts"),
                PathBuf::from("/home/u/.codex/sessions"),
            ]
        );
    }

    #[test]
    fn candidate_roots_overrides() {
        let r = candidate_roots(os("/c"), os("/x"), Path::new("/home/u"));
        assert_eq!(r[0].root, PathBuf::from("/c/projects"));
        assert_eq!(r[1].root, PathBuf::from("/c/transcripts"));
        assert_eq!(r[2].root, PathBuf::from("/x/sessions"));
        assert_eq!(r[0].kind, SourceKind::ClaudeCodeProjects);
    }
}
