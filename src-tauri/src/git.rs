//! Git through libgit2. Status with line counts, commit, init, log, clone,
//! and worktrees for agent runs.

use git2::{Cred, DiffOptions, FetchOptions, RemoteCallbacks, Repository, Signature, StatusOptions};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    pub status: String, // modified | added | deleted | renamed | untracked | conflicted
    pub add: u32,
    pub del: u32,
    pub binary: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo { pub id: String, pub summary: String, pub author: String, pub when: i64 }

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub changes: Vec<Change>,
    pub recent: Vec<CommitInfo>,
    pub remote: Option<String>,
}

fn sig(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature().or_else(|_| Signature::now("Dabir", "dabir@localhost")).map_err(|e| e.to_string())
}

pub fn status(root: &Path) -> Result<GitStatus, String> {
    let repo = match Repository::discover(root) {
        Ok(r) => r,
        Err(_) => return Ok(GitStatus { is_repo: false, branch: None, changes: vec![], recent: vec![], remote: None }),
    };
    let branch = repo.head().ok().and_then(|h| h.shorthand().map(|s| s.to_string()));
    let remote = repo.find_remote("origin").ok().and_then(|r| r.url().map(|u| u.to_string()));

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut changes: BTreeMap<String, Change> = BTreeMap::new();
    for s in statuses.iter() {
        let path = s.path().unwrap_or("").to_string();
        if path.is_empty() { continue; }
        let st = s.status();
        let status = if st.is_conflicted() { "conflicted" }
            else if st.is_wt_new() || st.is_index_new() { if st.is_wt_new() && !st.is_index_new() { "untracked" } else { "added" } }
            else if st.is_wt_deleted() || st.is_index_deleted() { "deleted" }
            else if st.is_wt_renamed() || st.is_index_renamed() { "renamed" }
            else { "modified" };
        changes.insert(path.clone(), Change { path, status: status.into(), add: 0, del: 0, binary: false });
    }

    // Line counts: HEAD tree → workdir (with index), untracked included.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut dopts = DiffOptions::new();
    dopts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    if let Ok(diff) = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut dopts)) {
        let counts: std::cell::RefCell<BTreeMap<String, (u32, u32, bool)>> = std::cell::RefCell::new(BTreeMap::new());
        let _ = diff.foreach(
            &mut |_, _| true,
            Some(&mut |d, _| {
                let p = d.new_file().path().or(d.old_file().path()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                counts.borrow_mut().entry(p).or_default().2 = true;
                true
            }),
            None,
            Some(&mut |d, _, l| {
                let p = d.new_file().path().or(d.old_file().path()).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
                let mut c = counts.borrow_mut();
                let e = c.entry(p).or_default();
                match l.origin() { '+' => e.0 += 1, '-' => e.1 += 1, _ => {} }
                true
            }),
        );
        for (p, (a, d, b)) in counts.into_inner() {
            if let Some(c) = changes.get_mut(&p) { c.add = a; c.del = d; c.binary = b; }
        }
    }

    let mut recent = vec![];
    if let Ok(mut walk) = repo.revwalk() {
        if walk.push_head().is_ok() {
            for oid in walk.take(8).flatten() {
                if let Ok(c) = repo.find_commit(oid) {
                    recent.push(CommitInfo {
                        id: oid.to_string()[..7].to_string(),
                        summary: c.summary().unwrap_or("").to_string(),
                        author: c.author().name().unwrap_or("").to_string(),
                        when: c.time().seconds(),
                    });
                }
            }
        }
    }
    Ok(GitStatus { is_repo: true, branch, changes: changes.into_values().collect(), recent, remote })
}

pub fn init(root: &Path) -> Result<(), String> {
    Repository::init(root).map(|_| ()).map_err(|e| e.to_string())
}

/// `paths` are repository-relative (the form `git diff --name-only` prints). Without paths, everything
/// under the paper is staged, so a paper inside a larger repository commits only its own files.
pub fn commit(root: &Path, message: &str, paths: Option<Vec<String>>) -> Result<String, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let (workdir, prefix) = repo_prefix(root)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    match paths {
        Some(ps) if !ps.is_empty() => {
            for p in ps {
                let full = workdir.join(&p);
                if full.exists() { index.add_path(Path::new(&p)).map_err(|e| e.to_string())?; }
                else { let _ = index.remove_path(Path::new(&p)); }
            }
        }
        _ => {
            let spec = if prefix.is_empty() { "*".to_string() } else { format!("{}*", prefix) };
            let mut skip = |path: &Path, _spec: &[u8]| -> i32 { let s = path.to_string_lossy(); if s.contains(".dabir/worktrees") || s.contains(".dabir/build") || s.contains(".dabir/index") { 1 } else { 0 } };
            index.add_all([spec.as_str()].iter(), git2::IndexAddOption::DEFAULT, Some(&mut skip)).map_err(|e| e.to_string())?;
            index.update_all([spec.as_str()].iter(), None).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let s = sig(&repo)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &s, &s, message, &tree, &parents).map_err(|e| e.to_string())?;
    Ok(oid.to_string()[..7].to_string())
}

fn callbacks<'a>() -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(|url, username, allowed| {
        if allowed.is_ssh_key() {
            if let Ok(c) = Cred::ssh_key_from_agent(username.unwrap_or("git")) { return Ok(c); }
        }
        if allowed.is_user_pass_plaintext() {
            if let Ok(cfg) = git2::Config::open_default() {
                if let Ok(c) = Cred::credential_helper(&cfg, url, username) { return Ok(c); }
            }
        }
        if allowed.is_default() { return Cred::default(); }
        Err(git2::Error::from_str("No credentials available. Set up an SSH key or a git credential helper."))
    });
    cb
}

pub fn clone(url: &str, dest: &Path) -> Result<String, String> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks());
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    builder.clone(url, dest).map_err(|e| format!("Clone failed: {}", e.message()))?;
    Ok(dest.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- worktrees for agent runs

pub fn worktree_dir(root: &Path, run_id: &str) -> PathBuf { root.join(".dabir").join("worktrees").join(run_id) }

/// A paper may live inside a larger repository (a monorepo, or the bundled sample inside Dabir's own
/// checkout). Everything Git-side works on the repository; everything the user sees is relative to the
/// paper. This returns the repository's working directory and the paper's prefix inside it ("" or "sub/dir/").
pub fn repo_prefix(root: &Path) -> Result<(PathBuf, String), String> {
    let repo = Repository::discover(root).map_err(|_| "This folder is not a Git repository. Initialise one first so agent runs can be isolated.".to_string())?;
    let wd = repo.workdir().ok_or("Bare repositories are not supported")?.canonicalize().map_err(|e| e.to_string())?;
    let rootc = root.canonicalize().map_err(|e| e.to_string())?;
    let rel = rootc.strip_prefix(&wd).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    Ok((wd, if rel.is_empty() { String::new() } else { format!("{}/", rel.trim_end_matches('/')) }))
}

/// Create a worktree on a fresh branch so the agent never touches the user's checkout.
pub fn worktree_add(root: &Path, run_id: &str) -> Result<PathBuf, String> {
    let dir = worktree_dir(root, run_id);
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;
    let repo = Repository::discover(root).map_err(|_| "This folder is not a Git repository. Initialise one first so agent runs can be isolated.".to_string())?;
    if repo.head().is_err() {
        return Err("The repository has no commits yet. Make a first commit so a worktree can branch from it.".into());
    }
    // Keep Dabir's own state out of the index without touching the user's .gitignore.
    if let Ok(git_dir) = repo.path().canonicalize() {
        let exclude = git_dir.join("info").join("exclude");
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        // `**/` so the rule also covers a paper that lives in a subfolder of the repository.
        if !existing.contains("**/.dabir/worktrees/") {
            let _ = std::fs::create_dir_all(exclude.parent().unwrap());
            let _ = std::fs::write(&exclude, format!("{}{}**/.dabir/worktrees/\n**/.dabir/build/\n**/.dabir/index/\n", existing, if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" }));
        }
    }
    let out = Command::new("git").current_dir(root)
        .args(["worktree", "add", "-b", &format!("dabir/{}", run_id)]).arg(&dir).arg("HEAD")
        .output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).to_string()); }
    // The agent works in the paper's folder inside the worktree, which is the whole repository.
    let (_, prefix) = repo_prefix(root)?;
    let cwd = dir.join(&prefix);
    let _ = std::fs::create_dir_all(cwd.join(".dabir"));
    Ok(cwd)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff { pub patch: String, pub changes: Vec<Change> }

/// Everything the agent changed in its worktree, as a patch against the branch point.
pub fn worktree_diff(root: &Path, run_id: &str) -> Result<WorktreeDiff, String> {
    let dir = worktree_dir(root, run_id);
    let out = Command::new("git").current_dir(&dir).args(["add", "-A"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).to_string()); }
    let patch = Command::new("git").current_dir(&dir).args(["diff", "--cached", "--binary", "HEAD"]).output().map_err(|e| e.to_string())?;
    let stat = Command::new("git").current_dir(&dir).args(["diff", "--cached", "--numstat", "HEAD"]).output().map_err(|e| e.to_string())?;
    let (_, prefix) = repo_prefix(root)?;
    let mut changes = vec![];
    for line in String::from_utf8_lossy(&stat.stdout).lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 { continue; }
        let binary = parts[0] == "-";
        // Paths are shown relative to the paper; anything the agent touched outside it keeps its repository path.
        let path = parts[2].strip_prefix(prefix.as_str()).map(|p| p.to_string()).unwrap_or_else(|| format!("../{}", parts[2]));
        changes.push(Change { path, status: "modified".into(), add: parts[0].parse().unwrap_or(0), del: parts[1].parse().unwrap_or(0), binary });
    }
    Ok(WorktreeDiff { patch: String::from_utf8_lossy(&patch.stdout).to_string(), changes })
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pick { pub path: String, pub hunks: Option<Vec<usize>> }

/// Keep only the selected files and hunks of a unified diff. Binary files are all or nothing.
pub fn filter_patch(patch: &str, picks: &[Pick]) -> String {
    let mut out = String::new();
    let mut file_block: Vec<&str> = vec![];
    let flush = |block: &Vec<&str>, out: &mut String| {
        if block.is_empty() { return; }
        let header = block[0];
        let Some(name) = header.strip_prefix("diff --git a/").and_then(|r| r.split(" b/").next()) else { return };
        let Some(pick) = picks.iter().find(|p| p.path == name) else { return };
        let first_hunk = block.iter().position(|l| l.starts_with("@@"));
        match (&pick.hunks, first_hunk) {
            (Some(wanted), Some(h0)) => {
                let mut kept: Vec<&str> = block[..h0].to_vec();
                let mut idx = 0usize;
                let mut i = h0;
                let mut any = false;
                while i < block.len() {
                    let mut j = i + 1;
                    while j < block.len() && !block[j].starts_with("@@") { j += 1; }
                    if wanted.contains(&idx) { kept.extend_from_slice(&block[i..j]); any = true; }
                    idx += 1;
                    i = j;
                }
                if any { for l in kept { out.push_str(l); out.push('\n'); } }
            }
            _ => { for l in block { out.push_str(l); out.push('\n'); } }
        }
    };
    for line in patch.lines() {
        if line.starts_with("diff --git ") { flush(&file_block, &mut out); file_block = vec![line]; }
        else if !file_block.is_empty() { file_block.push(line); }
    }
    flush(&file_block, &mut out);
    out
}

/// Apply the worktree's changes to the user's checkout and commit them there.
/// With `paths`, only those files are applied and committed; the rest is discarded with the worktree.
pub fn worktree_accept(root: &Path, run_id: &str, message: &str, picks: Option<Vec<Pick>>) -> Result<String, String> {
    let dir = worktree_dir(root, run_id);
    let (workdir, prefix) = repo_prefix(root)?;
    // Picks arrive relative to the paper; the patch speaks in repository paths.
    let picks = picks.map(|ps| ps.into_iter().map(|p| Pick { path: if let Some(r) = p.path.strip_prefix("../") { r.to_string() } else { format!("{}{}", prefix, p.path) }, hunks: p.hunks }).collect::<Vec<_>>());
    let full = Command::new("git").current_dir(&dir).args(["diff", "--cached", "--binary", "HEAD"]).output().map_err(|e| e.to_string())?;
    let full = String::from_utf8_lossy(&full.stdout).to_string();
    let (patch, selected): (String, Vec<String>) = match &picks {
        Some(ps) if !ps.is_empty() => (filter_patch(&full, ps), ps.iter().map(|p| p.path.clone()).collect()),
        _ => {
            let stat = Command::new("git").current_dir(&dir).args(["diff", "--cached", "--name-only", "HEAD"]).output().map_err(|e| e.to_string())?;
            (full.clone(), String::from_utf8_lossy(&stat.stdout).lines().map(|l| l.to_string()).filter(|l| !l.is_empty()).collect())
        }
    };
    if !patch.trim().is_empty() {
        // Apply from the repository root: git apply run in a subdirectory silently drops paths outside it.
        let mut child = Command::new("git").current_dir(&workdir).args(["apply", "--3way", "--index", "-"]).stdin(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        use std::io::Write;
        child.stdin.take().unwrap().write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(format!("Could not apply the agent's changes: {}", String::from_utf8_lossy(&out.stderr))); }
    }
    let mut selected = selected;
    if root.join(".dabir/memory/runs.md").exists() && !selected.is_empty() { selected.push(format!("{}.dabir/memory/runs.md", prefix)); }
    let id = commit(root, message, if selected.is_empty() { None } else { Some(selected) })?;
    worktree_remove(root, run_id)?;
    Ok(id)
}

pub fn worktree_remove(root: &Path, run_id: &str) -> Result<(), String> {
    let dir = worktree_dir(root, run_id);
    let _ = Command::new("git").current_dir(root).args(["worktree", "remove", "--force"]).arg(&dir).output();
    let _ = Command::new("git").current_dir(root).args(["branch", "-D", &format!("dabir/{}", run_id)]).output();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Commit on the worktree branch, push it, and open a pull request in the browser with gh.
pub fn worktree_pull_request(root: &Path, run_id: &str, message: &str) -> Result<String, String> {
    let dir = worktree_dir(root, run_id);
    let branch = format!("dabir/{}", run_id);
    let c = Command::new("git").current_dir(&dir).args(["commit", "-m", message]).output().map_err(|e| e.to_string())?;
    if !c.status.success() && !String::from_utf8_lossy(&c.stdout).contains("nothing to commit") {
        return Err(String::from_utf8_lossy(&c.stderr).to_string());
    }
    let p = Command::new("git").current_dir(&dir).args(["push", "-u", "origin", &branch]).output().map_err(|e| e.to_string())?;
    if !p.status.success() { return Err(format!("Push failed: {}", String::from_utf8_lossy(&p.stderr))); }
    let gh = Command::new("gh").current_dir(&dir).args(["pr", "create", "--web", "--head", &branch, "--title", message, "--body", "Opened from Dabir."]).output();
    match gh {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        Ok(o) => Err(format!("Pushed {}, but gh could not open a pull request: {}", branch, String::from_utf8_lossy(&o.stderr))),
        Err(_) => Ok(format!("Pushed {}. Install the GitHub CLI (gh) to open pull requests from Dabir.", branch)),
    }
}

// ---------------------------------------------------------------- remotes (Overleaf Git bridge and friends)

fn git_out(root: &Path, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git").current_dir(root).args(args).output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    if o.status.success() { Ok(text.trim().to_string()) } else { Err(text.trim().to_string()) }
}

pub fn remote_url(root: &Path, name: &str) -> Option<String> {
    git_out(root, &["remote", "get-url", name]).ok().filter(|s| !s.is_empty())
}

pub fn remote_add(root: &Path, name: &str, url: &str) -> Result<(), String> {
    if remote_url(root, name).is_some() { git_out(root, &["remote", "set-url", name, url])?; } else { git_out(root, &["remote", "add", name, url])?; }
    Ok(())
}

/// Pull with rebase so local commits stay on top of coauthors' Overleaf edits.
pub fn pull(root: &Path, remote: &str) -> Result<String, String> {
    let branch = git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "master".into());
    let remote_branch = if git_out(root, &["ls-remote", "--heads", remote, "master"]).map(|s| !s.is_empty()).unwrap_or(false) { "master".to_string() } else { branch.clone() };
    let out = git_out(root, &["pull", "--rebase", "--autostash", remote, &remote_branch])?;
    Ok(if out.is_empty() { "Already up to date.".into() } else { out.lines().last().unwrap_or("Pulled.").to_string() })
}

pub fn push(root: &Path, remote: &str) -> Result<String, String> {
    let branch = git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "master".into());
    // Overleaf's bridge only accepts its master branch.
    let target = if remote_url(root, remote).map(|u| u.contains("overleaf.com")).unwrap_or(false) { format!("{}:master", branch) } else { branch.clone() };
    let out = git_out(root, &["push", remote, &target])?;
    Ok(out.lines().last().map(|l| l.to_string()).unwrap_or_else(|| format!("Pushed {}.", branch)))
}
