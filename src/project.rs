use std::path::Path;
use std::process::Command;

/// Spec §5 project: the main repo directory name via `git rev-parse --git-common-dir`
/// (so worktrees map to their main repo), else the cwd basename, else `unknown`.
pub fn resolve_project(cwd: Option<&str>) -> String {
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
    if !cwd.is_dir() {
        return None;
    }
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let common = String::from_utf8(out.stdout).ok()?;
    let common = cwd.join(common.trim()).canonicalize().ok()?;
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
    fn none_is_unknown() {
        assert_eq!(resolve_project(None), "unknown");
    }
}
