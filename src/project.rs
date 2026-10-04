use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// Project names by working directory, so a sync starts at most one git process per cwd.
#[derive(Default)]
pub struct ProjectCache(HashMap<String, String>);

impl ProjectCache {
    /// `resolve_project`, computed once per distinct `cwd`.
    pub fn resolve(&mut self, cwd: Option<&str>) -> String {
        let Some(cwd) = cwd else {
            return "unknown".into();
        };
        self.0
            .entry(cwd.to_owned())
            .or_insert_with(|| resolve_project(Some(cwd)))
            .clone()
    }
}

/// Spec §5 project: the main repo directory name via `git rev-parse --git-common-dir`
/// (so worktrees map to their main repo), else the cwd basename, else `unknown`.
/// A cwd that no longer exists (a removed worktree) is resolved from its nearest existing
/// ancestor, which still finds the repo for worktrees kept inside it (`<repo>/.worktrees/x`).
fn resolve_project(cwd: Option<&str>) -> String {
    let Some(cwd) = cwd else {
        return "unknown".into();
    };
    if let Some(name) = git_repo_name(Path::new(cwd)) {
        return name;
    }
    Path::new(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown".into())
}

fn git_repo_name(cwd: &Path) -> Option<String> {
    let dir = cwd.ancestors().find(|p| p.is_dir())?;
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let common = String::from_utf8(out.stdout).ok()?;
    let common = dir.join(common.trim()).canonicalize().ok()?;
    Some(common.parent()?.file_name()?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn worktree_maps_to_main_repo_name() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("mainrepo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = t.path().join("feature-wt");
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert_eq!(resolve_project(Some(wt.to_str().unwrap())), "mainrepo");
        assert_eq!(resolve_project(Some(repo.to_str().unwrap())), "mainrepo");
        let sub = repo.join("a/b");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(resolve_project(Some(sub.to_str().unwrap())), "mainrepo");
    }

    #[test]
    fn removed_worktree_inside_repo_maps_to_repo() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("mainrepo");
        std::fs::create_dir_all(repo.join(".worktrees")).unwrap();
        git(&repo, &["init", "-q"]);
        let gone = repo.join(".worktrees/00001-gone/sub");
        assert_eq!(resolve_project(Some(gone.to_str().unwrap())), "mainrepo");
        let outside = t.path().join("elsewhere/feature");
        assert_eq!(resolve_project(Some(outside.to_str().unwrap())), "feature");
    }

    #[test]
    fn non_repo_dir_uses_basename() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("plain");
        std::fs::create_dir(&d).unwrap();
        assert_eq!(resolve_project(Some(d.to_str().unwrap())), "plain");
    }

    #[test]
    fn missing_path_uses_basename() {
        assert_eq!(resolve_project(Some("/x/y/proj")), "proj");
    }

    #[test]
    fn cache_runs_git_once_per_cwd() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("mainrepo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        git(&repo, &["init", "-q"]);
        let sub = sub.to_str().unwrap();
        let mut cache = ProjectCache::default();
        assert_eq!(cache.resolve(Some(sub)), "mainrepo");
        // Without the repo, git would now say "sub"; a cached cwd never asks git again.
        std::fs::remove_dir_all(repo.join(".git")).unwrap();
        assert_eq!(cache.resolve(Some(sub)), "mainrepo");
        assert_eq!(ProjectCache::default().resolve(Some(sub)), "sub");
        assert_eq!(cache.resolve(None), "unknown");
    }

    #[test]
    fn none_is_unknown() {
        assert_eq!(resolve_project(None), "unknown");
    }
}
