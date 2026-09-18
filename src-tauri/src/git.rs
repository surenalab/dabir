//! Git through libgit2. Status with line counts, commit, init, log, clone,
//! and worktrees for agent runs.

use git2::{
    Cred, DiffOptions, FetchOptions, RemoteCallbacks, Repository, Signature, StatusOptions,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    pub when: i64,
}

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
    repo.signature()
        .or_else(|_| Signature::now("Dabir", "dabir@localhost"))
        .map_err(|e| e.to_string())
}

/// Git's `user.name` for the repository at `root` (its own config, then the global one); None when unset.
pub fn author_name(root: &Path) -> Option<String> {
    let config = Repository::discover(root)
        .ok()
        .and_then(|r| r.config().ok())
        .or_else(|| git2::Config::open_default().ok())?;
    config
        .get_string("user.name")
        .ok()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
}

pub fn status(root: &Path) -> Result<GitStatus, String> {
    let repo = match Repository::discover(root) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitStatus {
                is_repo: false,
                branch: None,
                changes: vec![],
                recent: vec![],
                remote: None,
            })
        }
    };
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()));
    let remote = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().ok().map(|u| u.to_string()));

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut changes: BTreeMap<String, Change> = BTreeMap::new();
    for s in statuses.iter() {
        let path = s.path().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let st = s.status();
        let status = if st.is_conflicted() {
            "conflicted"
        } else if st.is_wt_new() || st.is_index_new() {
            if st.is_wt_new() && !st.is_index_new() {
                "untracked"
            } else {
                "added"
            }
        } else if st.is_wt_deleted() || st.is_index_deleted() {
            "deleted"
        } else if st.is_wt_renamed() || st.is_index_renamed() {
            "renamed"
        } else {
            "modified"
        };
        changes.insert(
            path.clone(),
            Change {
                path,
                status: status.into(),
                add: 0,
                del: 0,
                binary: false,
            },
        );
    }

    // Line counts: HEAD tree → workdir (with index), untracked included.
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut dopts = DiffOptions::new();
    dopts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if let Ok(diff) = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut dopts)) {
        let counts: std::cell::RefCell<BTreeMap<String, (u32, u32, bool)>> =
            std::cell::RefCell::new(BTreeMap::new());
        let _ = diff.foreach(
            &mut |_, _| true,
            Some(&mut |d, _| {
                let p = d
                    .new_file()
                    .path()
                    .or(d.old_file().path())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                counts.borrow_mut().entry(p).or_default().2 = true;
                true
            }),
            None,
            Some(&mut |d, _, l| {
                let p = d
                    .new_file()
                    .path()
                    .or(d.old_file().path())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default();
                let mut c = counts.borrow_mut();
                let e = c.entry(p).or_default();
                match l.origin() {
                    '+' => e.0 += 1,
                    '-' => e.1 += 1,
                    _ => {}
                }
                true
            }),
        );
        for (p, (a, d, b)) in counts.into_inner() {
            if let Some(c) = changes.get_mut(&p) {
                c.add = a;
                c.del = d;
                c.binary = b;
            }
        }
    }

    let mut recent = vec![];
    if let Ok(mut walk) = repo.revwalk() {
        if walk.push_head().is_ok() {
            for oid in walk.take(8).flatten() {
                if let Ok(c) = repo.find_commit(oid) {
                    recent.push(CommitInfo {
                        id: oid.to_string()[..7].to_string(),
                        summary: c.summary().ok().flatten().unwrap_or("").to_string(),
                        author: c.author().name().unwrap_or("").to_string(),
                        when: c.time().seconds(),
                    });
                }
            }
        }
    }
    Ok(GitStatus {
        is_repo: true,
        branch,
        changes: changes.into_values().collect(),
        recent,
        remote,
    })
}

pub fn init(root: &Path) -> Result<(), String> {
    Repository::init(root)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// What `ensure_repo` had to do so that a worktree can be made.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Ensured {
    /// The folder was not a repository: one was created with an empty root commit.
    Initialised,
    /// The repository existed but had no commit yet: an empty root commit was made.
    RootCommit,
    /// Nothing to do.
    Ready,
}

/// The repository an agent run needs, made on the spot: `git init` when the folder has none, and an
/// empty root commit when HEAD is unborn, so `worktree add` has something to branch from. The root
/// commit holds no files: the worktree seeding carries the folder's contents into the run as its own
/// base, so nothing of the user's is committed on their behalf and the sidebar keeps showing every
/// file as uncommitted until they choose to commit.
pub fn ensure_repo(root: &Path) -> Result<Ensured, String> {
    let (repo, created) = match Repository::discover(root) {
        Ok(r) => (r, false),
        Err(_) => (Repository::init(root).map_err(|e| e.to_string())?, true),
    };
    if repo.head().is_ok() {
        return Ok(Ensured::Ready);
    }
    let s = sig(&repo)?;
    let tree_id = repo
        .treebuilder(None)
        .and_then(|b| b.write())
        .map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    repo.commit(
        Some("HEAD"),
        &s,
        &s,
        "Dabir: repository initialised (no files yet)",
        &tree,
        &[],
    )
    .map_err(|e| e.to_string())?;
    Ok(if created {
        Ensured::Initialised
    } else {
        Ensured::RootCommit
    })
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
                if full.exists() {
                    index.add_path(Path::new(&p)).map_err(|e| e.to_string())?;
                } else {
                    let _ = index.remove_path(Path::new(&p));
                }
            }
        }
        _ => {
            let spec = if prefix.is_empty() {
                "*".to_string()
            } else {
                format!("{}*", prefix)
            };
            let mut skip = |path: &Path, _spec: &[u8]| -> i32 {
                let s = path.to_string_lossy();
                if s.contains(".dabir/worktrees")
                    || s.contains(".dabir/build")
                    || s.contains(".dabir/index")
                {
                    1
                } else {
                    0
                }
            };
            index
                .add_all(
                    [spec.as_str()].iter(),
                    git2::IndexAddOption::DEFAULT,
                    Some(&mut skip),
                )
                .map_err(|e| e.to_string())?;
            index
                .update_all([spec.as_str()].iter(), None)
                .map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let s = sig(&repo)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &s, &s, message, &tree, &parents)
        .map_err(|e| e.to_string())?;
    Ok(oid.to_string()[..7].to_string())
}

fn callbacks<'a>() -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(|url, username, allowed| {
        if allowed.is_ssh_key() {
            if let Ok(c) = Cred::ssh_key_from_agent(username.unwrap_or("git")) {
                return Ok(c);
            }
        }
        if allowed.is_user_pass_plaintext() {
            if let Ok(cfg) = git2::Config::open_default() {
                if let Ok(c) = Cred::credential_helper(&cfg, url, username) {
                    return Ok(c);
                }
            }
        }
        if allowed.is_default() {
            return Cred::default();
        }
        Err(git2::Error::from_str(
            "No credentials available. Set up an SSH key or a git credential helper.",
        ))
    });
    cb
}

pub fn clone(url: &str, dest: &Path) -> Result<String, String> {
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks());
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fo);
    builder
        .clone(url, dest)
        .map_err(|e| format!("Clone failed: {}", e.message()))?;
    Ok(dest.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- worktrees for agent runs

pub fn worktree_dir(root: &Path, run_id: &str) -> PathBuf {
    root.join(".dabir").join("worktrees").join(run_id)
}

/// The paper's folder inside an existing run's worktree, or None when that run is gone.
pub fn worktree_cwd(root: &Path, run_id: &str) -> Option<PathBuf> {
    let dir = worktree_dir(root, run_id);
    if !dir.is_dir() {
        return None;
    }
    let (_, prefix) = repo_prefix(root).ok()?;
    let cwd = dir.join(prefix);
    cwd.is_dir().then_some(cwd)
}

/// A paper may live inside a larger repository (a monorepo, or the bundled sample inside Dabir's own
/// checkout). Everything Git-side works on the repository; everything the user sees is relative to the
/// paper. This returns the repository's working directory and the paper's prefix inside it ("" or "sub/dir/").
pub fn repo_prefix(root: &Path) -> Result<(PathBuf, String), String> {
    let repo = Repository::discover(root).map_err(|_| "This folder is not a Git repository. Initialise one first so agent runs can be isolated.".to_string())?;
    let wd = repo
        .workdir()
        .ok_or("Bare repositories are not supported")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let rootc = root.canonicalize().map_err(|e| e.to_string())?;
    let rel = rootc
        .strip_prefix(&wd)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    Ok((
        wd,
        if rel.is_empty() {
            String::new()
        } else {
            format!("{}/", rel.trim_end_matches('/'))
        },
    ))
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
        let _ = std::fs::create_dir_all(exclude.parent().unwrap());
        let _ = std::fs::write(&exclude, with_excludes(&existing));
    }
    let out = crate::spawn::tool("git")
        .current_dir(root)
        .args(["worktree", "add", "-b", &format!("dabir/{}", run_id)])
        .arg(&dir)
        .arg("HEAD")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    // The agent should see the paper as it is now, not as of the last commit: carry uncommitted edits
    // (and new files) into the worktree as its base commit, so the run's diff is the agent's work alone
    // and applies cleanly onto the same edits in the checkout.
    let (workdir, prefix) = repo_prefix(root)?;
    if let Err(e) = seed_working_copy(&workdir, &dir) {
        let _ = crate::spawn::tool("git")
            .current_dir(root)
            .args(["worktree", "remove", "--force"])
            .arg(&dir)
            .output();
        return Err(e);
    }
    // The agent works in the paper's folder inside the worktree, which is the whole repository.
    let cwd = dir.join(&prefix);
    let _ = std::fs::create_dir_all(cwd.join(".dabir").join("build"));
    Ok(cwd)
}

/// Dabir's own folders, kept out of the index: worktrees, build output, the search index, and the read-only
/// Markdown copies of Word documents an agent run reads (`word::CONTEXT_DIR`). `**/` so the rules also cover a
/// paper in a subfolder of the repository. Rules already there are not written twice.
const EXCLUDES: &[&str] = &[
    "**/.dabir/worktrees/",
    "**/.dabir/build/",
    "**/.dabir/index/",
    "**/.dabir/context/",
];

pub(crate) fn with_excludes(existing: &str) -> String {
    let mut out = existing.to_string();
    for rule in EXCLUDES {
        if !existing.lines().any(|l| l.trim() == *rule) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(rule);
            out.push('\n');
        }
    }
    out
}

/// Repository-relative paths that differ between a working tree and a commit: tracked edits and
/// deletions against `against`, plus untracked files.
fn changed_paths(dir: &Path, against: &str) -> Result<Vec<String>, String> {
    let split = |out: std::process::Output| -> Vec<String> {
        out.stdout
            .split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect()
    };
    let tracked = crate::spawn::tool("git")
        .current_dir(dir)
        .args(["diff", "--name-only", "-z", against])
        .output()
        .map_err(|e| e.to_string())?;
    let untracked = crate::spawn::tool("git")
        .current_dir(dir)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    let mut all = split(tracked);
    all.extend(split(untracked));
    all.sort();
    all.dedup();
    Ok(all)
}

/// Before a follow-up request, carry the author's edits made since the run started into the run's
/// worktree, so the agent builds on the paper as it is now. Files the agent itself changed are left
/// alone (Accept resolves those three-way). The carried files are committed on the run branch so the
/// run's diff stays the agent's work alone. Returns the paths carried, relative to the repository.
pub fn sync_working_copy(root: &Path, run_id: &str) -> Result<Vec<String>, String> {
    let wt = worktree_dir(root, run_id);
    let (workdir, _) = repo_prefix(root)?;
    let seed = crate::spawn::tool("git")
        .current_dir(&wt)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    if !seed.status.success() {
        return Err(String::from_utf8_lossy(&seed.stderr).to_string());
    }
    let seed = String::from_utf8_lossy(&seed.stdout).trim().to_string();
    let agent: std::collections::HashSet<String> =
        changed_paths(&wt, "HEAD")?.into_iter().collect();
    let mut carried = Vec::new();
    for rel in changed_paths(&workdir, &seed)? {
        if agent.contains(&rel) || rel.contains(".dabir/") {
            continue;
        }
        let src = workdir.join(&rel);
        let dst = wt.join(&rel);
        if src.is_file() {
            // An untracked file in the checkout shows up on every pass; carry it once.
            if dst.is_file() && std::fs::read(&src).ok() == std::fs::read(&dst).ok() {
                continue;
            }
            if let Some(p) = dst.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&src, &dst).map_err(|e| format!("{}: {}", rel, e))?;
        } else if dst.exists() {
            std::fs::remove_file(&dst).map_err(|e| format!("{}: {}", rel, e))?;
        } else {
            continue;
        }
        carried.push(rel);
    }
    if carried.is_empty() {
        return Ok(carried);
    }
    let out = crate::spawn::tool("git")
        .current_dir(&wt)
        .args(["add", "-A", "--"])
        .args(&carried)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let mut commit = crate::spawn::tool("git");
    commit.current_dir(&wt);
    if !has_identity(&wt) {
        commit.args(["-c", "user.name=Dabir", "-c", "user.email=dabir@localhost"]);
    }
    let out = commit
        .args([
            "commit",
            "-q",
            "--no-verify",
            "--only",
            "-m",
            "Author's edits between requests",
            "--",
        ])
        .args(&carried)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "Could not carry your recent edits into the run: {}{}",
            String::from_utf8_lossy(&out.stderr),
            String::from_utf8_lossy(&out.stdout)
        ));
    }
    Ok(carried)
}

fn has_identity(dir: &Path) -> bool {
    crate::spawn::tool("git")
        .current_dir(dir)
        .args(["config", "user.email"])
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Copy the checkout's uncommitted state (tracked edits and untracked files) into a fresh worktree
/// and commit it there. No-op when the checkout is clean.
fn seed_working_copy(workdir: &Path, wt: &Path) -> Result<(), String> {
    let patch = crate::spawn::tool("git")
        .current_dir(workdir)
        .args(["diff", "HEAD", "--binary"])
        .output()
        .map_err(|e| e.to_string())?;
    let untracked = crate::spawn::tool("git")
        .current_dir(workdir)
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .output()
        .map_err(|e| e.to_string())?;
    let untracked: Vec<String> = untracked
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();
    let dirty = patch.stdout.iter().any(|b| !b.is_ascii_whitespace());
    if !dirty && untracked.is_empty() {
        return Ok(());
    }
    if dirty {
        let mut child = crate::spawn::tool("git")
            .current_dir(wt)
            .args(["apply", "--index", "--whitespace=nowarn", "-"])
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&patch.stdout)
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "Could not carry your uncommitted edits into the run: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    for rel in &untracked {
        let src = workdir.join(rel);
        let dst = wt.join(rel);
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&src, &dst).map_err(|e| format!("{}: {}", rel, e))?;
        let _ = crate::spawn::tool("git")
            .current_dir(wt)
            .args(["add", "--"])
            .arg(rel)
            .output();
    }
    // The owner's identity when configured; a local fallback only so the seed commit can exist at all.
    let mut commit = crate::spawn::tool("git");
    commit.current_dir(wt);
    if !has_identity(wt) {
        commit.args(["-c", "user.name=Dabir", "-c", "user.email=dabir@localhost"]);
    }
    let out = commit
        .args([
            "commit",
            "-q",
            "--no-verify",
            "-m",
            "Working copy at run start",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "Could not record your uncommitted edits for the run: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub patch: String,
    pub changes: Vec<Change>,
}

/// Everything the agent changed in its worktree, as a patch against the branch point.
pub fn worktree_diff(root: &Path, run_id: &str) -> Result<WorktreeDiff, String> {
    let dir = worktree_dir(root, run_id);
    let out = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["add", "-A"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    let patch = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["diff", "--cached", "--binary", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    let stat = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["diff", "--cached", "--numstat", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    let (_, prefix) = repo_prefix(root)?;
    let mut changes = vec![];
    for line in String::from_utf8_lossy(&stat.stdout).lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let binary = parts[0] == "-";
        // Paths are shown relative to the paper; anything the agent touched outside it keeps its repository path.
        let path = parts[2]
            .strip_prefix(prefix.as_str())
            .map(|p| p.to_string())
            .unwrap_or_else(|| format!("../{}", parts[2]));
        changes.push(Change {
            path,
            status: "modified".into(),
            add: parts[0].parse().unwrap_or(0),
            del: parts[1].parse().unwrap_or(0),
            binary,
        });
    }
    // The patch text is what the review renders, so its headers must speak paper-relative too.
    let mut text = String::from_utf8_lossy(&patch.stdout).to_string();
    if !prefix.is_empty() {
        for (from, to) in [
            (format!(" a/{}", prefix), " a/".to_string()),
            (format!(" b/{}", prefix), " b/".to_string()),
        ] {
            text = text.replace(&from, &to);
        }
    }
    Ok(WorktreeDiff {
        patch: text,
        changes,
    })
}

#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub path: String,
    pub hunks: Option<Vec<usize>>,
}

/// Keep only the selected files and hunks of a unified diff. Binary files are all or nothing.
/// Keep only the picked files and hunks of a patch. Byte-exact: a diff of a PDF or other file Git treats as text may hold bytes that are not
/// UTF-8, and a lossy round trip would change the context lines so `git apply` rejects the hunk.
pub fn filter_patch_bytes(patch: &[u8], picks: &[Pick]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut file_block: Vec<&[u8]> = vec![];
    let flush = |block: &Vec<&[u8]>, out: &mut Vec<u8>| {
        if block.is_empty() {
            return;
        }
        let header = String::from_utf8_lossy(block[0]).into_owned();
        let Some(name) = header
            .strip_prefix("diff --git a/")
            .and_then(|r| r.split(" b/").next())
        else {
            return;
        };
        let Some(pick) = picks.iter().find(|p| p.path == name) else {
            return;
        };
        let first_hunk = block.iter().position(|l| l.starts_with(b"@@"));
        let emit = |lines: &[&[u8]], out: &mut Vec<u8>| {
            for l in lines {
                out.extend_from_slice(l);
                out.push(b'\n');
            }
        };
        match (&pick.hunks, first_hunk) {
            (Some(wanted), Some(h0)) => {
                let mut kept: Vec<&[u8]> = block[..h0].to_vec();
                let mut idx = 0usize;
                let mut i = h0;
                let mut any = false;
                while i < block.len() {
                    let mut j = i + 1;
                    while j < block.len() && !block[j].starts_with(b"@@") {
                        j += 1;
                    }
                    if wanted.contains(&idx) {
                        kept.extend_from_slice(&block[i..j]);
                        any = true;
                    }
                    idx += 1;
                    i = j;
                }
                if any {
                    emit(&kept, out);
                }
            }
            _ => emit(block, out),
        }
    };
    let body = patch.strip_suffix(b"\n").unwrap_or(patch);
    for line in body.split(|b| *b == b'\n') {
        if line.starts_with(b"diff --git ") {
            flush(&file_block, &mut out);
            file_block = vec![line];
        } else if !file_block.is_empty() {
            file_block.push(line);
        }
    }
    flush(&file_block, &mut out);
    out
}

/// Apply the worktree's changes to the user's checkout without committing, then drop the worktree.
/// Returns the repository-relative paths that were applied. Pair with `checkpoint` for a record.
pub fn worktree_apply(
    root: &Path,
    run_id: &str,
    picks: Option<Vec<Pick>>,
) -> Result<Vec<String>, String> {
    let selected = apply_selection(root, run_id, picks)?;
    worktree_remove(root, run_id)?;
    Ok(selected)
}

fn apply_selection(
    root: &Path,
    run_id: &str,
    picks: Option<Vec<Pick>>,
) -> Result<Vec<String>, String> {
    let dir = worktree_dir(root, run_id);
    let (workdir, prefix) = repo_prefix(root)?;
    // Picks arrive relative to the paper; the patch speaks in repository paths.
    let picks = picks.map(|ps| {
        ps.into_iter()
            .map(|p| Pick {
                path: if let Some(r) = p.path.strip_prefix("../") {
                    r.to_string()
                } else {
                    format!("{}{}", prefix, p.path)
                },
                hunks: p.hunks,
            })
            .collect::<Vec<_>>()
    });
    let full = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["diff", "--cached", "--binary", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    // Keep the patch as bytes: a regenerated figure that Git still treats as text must round-trip exactly.
    let full = full.stdout;
    // Agents do not edit Word documents. The run's preamble says so, and the Word view is the only thing that
    // writes a .docx, atomically and after checking it is still a package. A run that touched one anyway must not
    // reach the author's file through `git apply`, which writes it in place: those paths are left out here, and the
    // rest of the run still lands. The worktree keeps the change, so nothing the agent did is lost.
    let changed = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["diff", "--cached", "--name-only", "HEAD"])
        .output()
        .map_err(|e| e.to_string())?;
    let word: Vec<String> = String::from_utf8_lossy(&changed.stdout)
        .lines()
        .filter(|l| crate::word::is_docx(Path::new(l)))
        .map(|l| l.to_string())
        .collect();
    let picks = if word.is_empty() {
        picks
    } else {
        let keep: Vec<Pick> = match picks {
            Some(ps) => ps.into_iter().filter(|p| !word.contains(&p.path)).collect(),
            None => String::from_utf8_lossy(&changed.stdout)
                .lines()
                .filter(|l| !l.is_empty() && !word.contains(&l.to_string()))
                .map(|l| Pick {
                    path: l.to_string(),
                    hunks: None,
                })
                .collect(),
        };
        Some(keep)
    };
    let (patch, selected): (Vec<u8>, Vec<String>) = match &picks {
        // Nothing left to apply: the run touched Word documents and nothing else.
        Some(ps) if ps.is_empty() => (Vec::new(), Vec::new()),
        Some(ps) => (
            filter_patch_bytes(&full, ps),
            ps.iter().map(|p| p.path.clone()).collect(),
        ),
        _ => {
            let stat = crate::spawn::tool("git")
                .current_dir(&dir)
                .args(["diff", "--cached", "--name-only", "HEAD"])
                .output()
                .map_err(|e| e.to_string())?;
            (
                full.clone(),
                String::from_utf8_lossy(&stat.stdout)
                    .lines()
                    .map(|l| l.to_string())
                    .filter(|l| !l.is_empty())
                    .collect(),
            )
        }
    };
    if patch.iter().any(|b| !b.is_ascii_whitespace()) {
        // Apply from the repository root: git apply run in a subdirectory silently drops paths outside it.
        // The working tree is the target, never the index: the user may have unstaged edits, and the run
        // started from exactly those, so a plain apply is the common case. A three-way merge is the
        // fallback for files edited since the run started; it needs the file to match the index.
        let run = |args: &[&str]| -> Result<std::process::Output, String> {
            let mut child = crate::spawn::tool("git")
                .current_dir(&workdir)
                .args(args)
                .stdin(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&patch)
                .map_err(|e| e.to_string())?;
            child.wait_with_output().map_err(|e| e.to_string())
        };
        let plain = run(&["apply", "--whitespace=nowarn", "-"])?;
        if !plain.status.success() {
            let merged = run(&["apply", "--3way", "--whitespace=nowarn", "-"])?;
            if !merged.status.success() {
                return Err(format!(
                    "Could not apply the agent's changes; the file changed since the run started. Save your edits and try again, or reject the run.\n{}",
                    String::from_utf8_lossy(&plain.stderr).trim()
                ));
            }
        }
    }
    let mut selected = selected;
    if root.join(".dabir/memory/runs.md").exists() && !selected.is_empty() {
        selected.push(format!("{}.dabir/memory/runs.md", prefix));
    }
    Ok(selected)
}

/// Apply the worktree's changes to the user's checkout and commit them there.
/// With `picks`, only those files and hunks are applied and committed; the rest is discarded with the worktree.
pub fn worktree_accept(
    root: &Path,
    run_id: &str,
    message: &str,
    picks: Option<Vec<Pick>>,
) -> Result<String, String> {
    let selected = apply_selection(root, run_id, picks)?;
    let id = commit(
        root,
        message,
        if selected.is_empty() {
            None
        } else {
            Some(selected)
        },
    )?;
    worktree_remove(root, run_id)?;
    Ok(id)
}

// ---------------------------------------------------------------- checkpoints
//
// Word-style version history without asking for commits: a snapshot of the paper's working tree is
// written as a commit on `refs/dabir/checkpoints`, chained to the previous snapshot, leaving the user's
// branch, index and history untouched. Nothing is created when nothing changed.

const CHECKPOINT_REF: &str = "refs/dabir/checkpoints";
/// Trailer that marks a snapshot commit. The first snapshot has the branch commit it grew from as its
/// parent, so every step (including the first) has a "before" to diff against; the walk stops at the
/// first commit without the trailer.
const CHECKPOINT_MARK: &str = "\n\nDabir-Snapshot: 1";

fn snapshot_message(c: &git2::Commit) -> Option<String> {
    let m = c.message().ok()?;
    m.strip_suffix(CHECKPOINT_MARK.trim_start_matches('\n'))
        .map(|s| s.trim().to_string())
        .or_else(|| {
            m.split("\n\nDabir-Snapshot:")
                .next()
                .filter(|_| m.contains("Dabir-Snapshot:"))
                .map(|s| s.trim().to_string())
        })
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub id: String,
    pub message: String,
    pub at: i64,
    /// What this step changed against the step before it, paths relative to the paper.
    pub files: Vec<Change>,
}

/// Snapshots by the author within this window are folded into one entry, so a typing session is one step.
pub const COALESCE_SECS: i64 = 180;

fn checkpoint_tree(repo: &Repository, prefix: &str) -> Result<git2::Oid, String> {
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let spec = if prefix.is_empty() {
        "*".to_string()
    } else {
        format!("{}*", prefix)
    };
    let mut skip = |path: &Path, _spec: &[u8]| -> i32 {
        let s = path.to_string_lossy();
        if s.contains(".dabir/worktrees")
            || s.contains(".dabir/build")
            || s.contains(".dabir/index")
            || s.contains(".dabir/context")
        {
            1
        } else {
            0
        }
    };
    index
        .add_all(
            [spec.as_str()].iter(),
            git2::IndexAddOption::DEFAULT,
            Some(&mut skip),
        )
        .map_err(|e| e.to_string())?;
    index
        .update_all([spec.as_str()].iter(), None)
        .map_err(|e| e.to_string())?;
    let tree = index.write_tree_to(repo).map_err(|e| e.to_string())?;
    // Forget the in-memory staging so the user's own index file is left exactly as it was.
    index.read(true).map_err(|e| e.to_string())?;
    Ok(tree)
}

/// Snapshot the working tree. Returns the short id, or None when nothing changed since the last snapshot.
pub fn checkpoint(root: &Path, message: &str) -> Result<Option<String>, String> {
    checkpoint_with(root, message, false)
}

/// Like `checkpoint`, but when `coalesce` is set and the newest snapshot carries the same message and is
/// younger than `COALESCE_SECS`, that snapshot is replaced rather than chained: one entry per session of
/// edits, not one per autosave.
pub fn checkpoint_with(
    root: &Path,
    message: &str,
    coalesce: bool,
) -> Result<Option<String>, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let (_, prefix) = repo_prefix(root)?;
    let tree_id = checkpoint_tree(&repo, &prefix)?;
    let tip = repo
        .find_reference(CHECKPOINT_REF)
        .ok()
        .and_then(|r| r.peel_to_commit().ok());
    if let Some(p) = &tip {
        if p.tree_id() == tree_id {
            return Ok(None);
        }
    } else if let Some(head) = repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        if head.tree_id() == tree_id {
            return Ok(None);
        }
    }
    let now = git2::Time::new(chrono_now(), 0).seconds();
    let fold = coalesce
        && tip.as_ref().is_some_and(|t| {
            snapshot_message(t).as_deref() == Some(message)
                && now - t.time().seconds() < COALESCE_SECS
        });
    // Folding replaces the tip with a snapshot that has the tip's own parents. The first snapshot
    // grows from the branch commit, so it too has a "before".
    let parent = if fold {
        tip.as_ref().and_then(|t| t.parent(0).ok())
    } else if tip.is_some() {
        tip
    } else {
        repo.head().ok().and_then(|h| h.peel_to_commit().ok())
    };
    if fold {
        if let Some(p) = &parent {
            if p.tree_id() == tree_id {
                // Edits undone by hand: the folded step would be empty, so drop it.
                repo.reference(CHECKPOINT_REF, p.id(), true, "fold")
                    .map_err(|e| e.to_string())?;
                return Ok(None);
            }
        }
    }
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let s = sig(&repo)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo
        .commit(
            None,
            &s,
            &s,
            &format!("{}{}", message, CHECKPOINT_MARK),
            &tree,
            &parents,
        )
        .map_err(|e| e.to_string())?;
    repo.reference(CHECKPOINT_REF, oid, true, message)
        .map_err(|e| e.to_string())?;
    Ok(Some(oid.to_string()[..7].to_string()))
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Per-file line counts between two trees, restricted to the paper and named relative to it.
fn tree_changes(
    repo: &Repository,
    from: Option<&git2::Tree>,
    to: &git2::Tree,
    prefix: &str,
) -> Vec<Change> {
    let mut opts = git2::DiffOptions::new();
    if !prefix.is_empty() {
        opts.pathspec(prefix.trim_end_matches('/'));
    }
    let Ok(diff) = repo.diff_tree_to_tree(from, Some(to), Some(&mut opts)) else {
        return vec![];
    };
    let rel = |p: Option<&Path>| -> String {
        let s = p
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        s.strip_prefix(prefix).unwrap_or(&s).to_string()
    };
    // Two passes over one shared map: file records first, then line counts.
    let out = std::cell::RefCell::new(Vec::<Change>::new());
    let _ = diff.foreach(
        &mut |d, _| {
            let path = rel(d.new_file().path().or(d.old_file().path()));
            if path.starts_with(".dabir/") {
                return true;
            }
            out.borrow_mut().push(Change {
                path,
                status: match d.status() {
                    git2::Delta::Added => "added",
                    git2::Delta::Deleted => "deleted",
                    git2::Delta::Renamed => "renamed",
                    _ => "modified",
                }
                .into(),
                add: 0,
                del: 0,
                binary: d.new_file().is_binary() || d.old_file().is_binary(),
            });
            true
        },
        None,
        None,
        Some(&mut |d, _, l| {
            let path = rel(d.new_file().path().or(d.old_file().path()));
            if let Some(c) = out.borrow_mut().iter_mut().find(|c| c.path == path) {
                match l.origin() {
                    '+' => c.add += 1,
                    '-' => c.del += 1,
                    _ => {}
                }
            }
            true
        }),
    );
    out.into_inner()
}

/// The most recent snapshots, newest first.
pub fn checkpoints(root: &Path, limit: usize) -> Result<Vec<Checkpoint>, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let Some(head) = repo
        .find_reference(CHECKPOINT_REF)
        .ok()
        .and_then(|r| r.peel_to_commit().ok())
    else {
        return Ok(vec![]);
    };
    let (_, prefix) = repo_prefix(root)?;
    let mut out = vec![];
    // Chains from before the trailer existed are walked to their root, as before.
    let legacy = snapshot_message(&head).is_none();
    let mut cur = Some(head);
    while let Some(c) = cur {
        if out.len() >= limit {
            break;
        }
        let message = match snapshot_message(&c) {
            Some(m) => m,
            None if legacy => c.message().unwrap_or("").trim().to_string(),
            None => break,
        };
        let parent = c.parent(0).ok();
        let parent_tree = parent.as_ref().and_then(|p| p.tree().ok());
        let files = match c.tree() {
            Ok(t) => tree_changes(&repo, parent_tree.as_ref(), &t, &prefix),
            Err(_) => vec![],
        };
        out.push(Checkpoint {
            id: c.id().to_string()[..7].to_string(),
            message,
            at: c.time().seconds(),
            files,
        });
        cur = parent;
    }
    Ok(out)
}

/// The unified diff of one step against the step before it, paths relative to the paper.
pub fn checkpoint_patch(root: &Path, id: &str) -> Result<String, String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let (_, prefix) = repo_prefix(root)?;
    let obj = repo
        .revparse_single(id)
        .map_err(|_| format!("No snapshot {}", id))?;
    let commit = obj.peel_to_commit().map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = git2::DiffOptions::new();
    if !prefix.is_empty() {
        opts.pathspec(prefix.trim_end_matches('/'));
    }
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let mut text = String::new();
    // A Word document is a zip, so Git sees only "binary"; its step reads as a diff of its text instead.
    let mut words: Vec<(PathBuf, git2::Oid, git2::Oid)> = vec![];
    diff.print(git2::DiffFormat::Patch, |d, _, l| {
        let path = d.new_file().path().or(d.old_file().path());
        if let Some(p) = path.filter(|p| crate::word::is_docx(p)) {
            if !words.iter().any(|(q, _, _)| q == p) {
                words.push((p.to_path_buf(), d.old_file().id(), d.new_file().id()));
            }
            return true;
        }
        let body = String::from_utf8_lossy(l.content());
        match l.origin() {
            '+' | '-' | ' ' => text.push(l.origin()),
            _ => {}
        }
        text.push_str(&body);
        true
    })
    .map_err(|e| e.to_string())?;
    for (path, old, new) in words {
        text.push_str(&word_patch(&repo, &path, old, new));
    }
    if !prefix.is_empty() {
        text = text
            .replace(&format!(" a/{}", prefix), " a/")
            .replace(&format!(" b/{}", prefix), " b/");
    }
    Ok(text)
}

/// The text diff of one Word document between two blobs (a zero id is "no file"), as a unified patch whose
/// headers name the document. When a side cannot be read as a document the step says so instead.
fn word_patch(repo: &Repository, path: &Path, old: git2::Oid, new: git2::Oid) -> String {
    let text_of = |id: git2::Oid| -> Result<String, String> {
        if id.is_zero() {
            return Ok(String::new());
        }
        let blob = repo.find_blob(id).map_err(|e| e.to_string())?;
        crate::word::to_markdown(blob.content(), crate::word::Options { comments: true })
    };
    let name = path.to_string_lossy().replace('\\', "/");
    let (before, after) = match (text_of(old), text_of(new)) {
        (Ok(b), Ok(a)) => (b, a),
        _ => {
            return format!(
                "diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n@@ -1 +1 @@\n-(a Word document that could not be read as text)\n+(the Word document changed; open it to see how)\n"
            )
        }
    };
    // The text is the same, but Git listed the file, so something else in the package changed: a picture, a
    // style, the page setup. Say so rather than leaving the step's detail blank, as for a side that would not read.
    if before == after {
        return format!(
            "diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n@@ -1 +1 @@\n-(the text of the document is unchanged)\n+(a picture, a style or the page setup changed; open it to see)\n"
        );
    }
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(2);
    let Ok(mut patch) = git2::Patch::from_buffers(
        before.as_bytes(),
        Some(path),
        after.as_bytes(),
        Some(path),
        Some(&mut opts),
    ) else {
        return String::new();
    };
    patch
        .to_buf()
        .ok()
        .and_then(|b| b.as_str().map(|s| s.to_string()).ok())
        .unwrap_or_default()
}

/// Take one step out of the working tree: the step's diff is applied in reverse, leaving later edits in
/// place. The current state is snapshotted first. Fails, touching nothing, when later edits overlap it.
pub fn checkpoint_undo(root: &Path, id: &str) -> Result<(), String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let (workdir, prefix) = repo_prefix(root)?;
    let obj = repo
        .revparse_single(id)
        .map_err(|_| format!("No snapshot {}", id))?;
    let commit = obj.peel_to_commit().map_err(|e| e.to_string())?;
    let parent = commit
        .parent(0)
        .map(|p| p.id().to_string())
        .unwrap_or_else(|_| {
            repo.head()
                .and_then(|h| h.peel_to_commit())
                .map(|c| c.id().to_string())
                .unwrap_or_default()
        });
    let mut args = vec![
        "diff".to_string(),
        "--binary".into(),
        commit.id().to_string(),
        parent.clone(),
    ];
    if !prefix.is_empty() {
        args.push("--".into());
        args.push(prefix.trim_end_matches('/').to_string());
    }
    let reverse = crate::spawn::tool("git")
        .current_dir(&workdir)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;
    if !reverse.status.success() {
        return Err(String::from_utf8_lossy(&reverse.stderr).to_string());
    }
    let check = apply_bytes(&workdir, &reverse.stdout, true)?;
    if !check.status.success() {
        return Err("Later edits overlap this change, so it cannot be taken out on its own. Restore the version before it instead.".into());
    }
    let label = snapshot_message(&commit)
        .unwrap_or_else(|| commit.message().unwrap_or("").trim().to_string());
    checkpoint(root, &format!("Before undoing: {}", label))?;
    let out = apply_bytes(&workdir, &reverse.stdout, false)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    checkpoint(root, &format!("Undid: {}", label))?;
    Ok(())
}

fn apply_bytes(workdir: &Path, patch: &[u8], check: bool) -> Result<std::process::Output, String> {
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if check {
        args.push("--check");
    }
    args.push("-");
    let mut child = crate::spawn::tool("git")
        .current_dir(workdir)
        .args(&args)
        .stdin(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(patch)
        .map_err(|e| e.to_string())?;
    child.wait_with_output().map_err(|e| e.to_string())
}

/// Put one file back as it is in HEAD (or delete it when untracked). Snapshotted first, so reversible.
/// The file as HEAD has it (`path` relative to `root`), or None when it is new or the folder is not a
/// repository: what the editor's change gutter compares the buffer against.
pub fn head_text(root: &Path, path: &str) -> Result<Option<String>, String> {
    let Ok(repo) = Repository::discover(root) else {
        return Ok(None);
    };
    let (_, prefix) = repo_prefix(root)?;
    let repo_path = format!("{}{}", prefix, path);
    let Some(tree) = repo.head().ok().and_then(|h| h.peel_to_tree().ok()) else {
        return Ok(None);
    };
    let Ok(entry) = tree.get_path(Path::new(&repo_path)) else {
        return Ok(None);
    };
    let obj = entry.to_object(&repo).map_err(|e| e.to_string())?;
    let Some(blob) = obj.as_blob() else {
        return Ok(None);
    };
    if blob.is_binary() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
}

pub fn discard(root: &Path, path: &str) -> Result<(), String> {
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let (workdir, prefix) = repo_prefix(root)?;
    let repo_path = format!("{}{}", prefix, path);
    checkpoint(root, &format!("Before discarding changes to {}", path))?;
    let in_head = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .map(|t| t.get_path(Path::new(&repo_path)).is_ok())
        .unwrap_or(false);
    if in_head {
        let out = crate::spawn::tool("git")
            .current_dir(&workdir)
            .args(["checkout", "HEAD", "--"])
            .arg(&repo_path)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).to_string());
        }
    } else {
        std::fs::remove_file(workdir.join(&repo_path)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Put the paper's files back as they were in a snapshot. The current state is snapshotted first, so
/// restoring is itself reversible. The user's branch and index are not moved.
pub fn checkpoint_restore(root: &Path, id: &str) -> Result<(), String> {
    checkpoint(root, &format!("Before restoring {}", id))?;
    let repo = Repository::discover(root).map_err(|e| e.to_string())?;
    let (_, prefix) = repo_prefix(root)?;
    let obj = repo
        .revparse_single(id)
        .map_err(|_| format!("No snapshot {}", id))?;
    let tree = obj.peel_to_tree().map_err(|e| e.to_string())?;
    let mut cb = git2::build::CheckoutBuilder::new();
    cb.force().update_index(false).remove_untracked(false);
    if !prefix.is_empty() {
        cb.path(format!("{}*", prefix));
    }
    repo.checkout_tree(tree.as_object(), Some(&mut cb))
        .map_err(|e| e.to_string())?;
    // The restored state becomes the newest step, so later steps diff against it.
    checkpoint(root, &format!("Restored {}", id))?;
    Ok(())
}

pub fn worktree_remove(root: &Path, run_id: &str) -> Result<(), String> {
    let dir = worktree_dir(root, run_id);
    let _ = crate::spawn::tool("git")
        .current_dir(root)
        .args(["worktree", "remove", "--force"])
        .arg(&dir)
        .output();
    let _ = crate::spawn::tool("git")
        .current_dir(root)
        .args(["branch", "-D", &format!("dabir/{}", run_id)])
        .output();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Commit on the worktree branch, push it, and open a pull request in the browser with gh.
pub fn worktree_pull_request(root: &Path, run_id: &str, message: &str) -> Result<String, String> {
    let dir = worktree_dir(root, run_id);
    let branch = format!("dabir/{}", run_id);
    let c = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["commit", "-m", message])
        .output()
        .map_err(|e| e.to_string())?;
    if !c.status.success() && !String::from_utf8_lossy(&c.stdout).contains("nothing to commit") {
        return Err(String::from_utf8_lossy(&c.stderr).to_string());
    }
    let p = crate::spawn::tool("git")
        .current_dir(&dir)
        .args(["push", "-u", "origin", &branch])
        .output()
        .map_err(|e| e.to_string())?;
    if !p.status.success() {
        return Err(format!(
            "Push failed: {}",
            String::from_utf8_lossy(&p.stderr)
        ));
    }
    let gh = crate::spawn::tool("gh")
        .current_dir(&dir)
        .args([
            "pr",
            "create",
            "--web",
            "--head",
            &branch,
            "--title",
            message,
            "--body",
            "Opened from Dabir.",
        ])
        .output();
    match gh {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        Ok(o) => Err(format!(
            "Pushed {}, but gh could not open a pull request: {}",
            branch,
            String::from_utf8_lossy(&o.stderr)
        )),
        Err(_) => Ok(format!(
            "Pushed {}. Install the GitHub CLI (gh) to open pull requests from Dabir.",
            branch
        )),
    }
}

// ---------------------------------------------------------------- remotes (Overleaf Git bridge and friends)

fn git_out(root: &Path, args: &[&str]) -> Result<String, String> {
    let o = crate::spawn::tool("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    if o.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

pub fn remote_url(root: &Path, name: &str) -> Option<String> {
    git_out(root, &["remote", "get-url", name])
        .ok()
        .filter(|s| !s.is_empty())
}

pub fn remote_add(root: &Path, name: &str, url: &str) -> Result<(), String> {
    if remote_url(root, name).is_some() {
        git_out(root, &["remote", "set-url", name, url])?;
    } else {
        git_out(root, &["remote", "add", name, url])?;
    }
    Ok(())
}

/// Pull with rebase so local commits stay on top of coauthors' Overleaf edits.
pub fn pull(root: &Path, remote: &str) -> Result<String, String> {
    let branch =
        git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "master".into());
    let remote_branch = if git_out(root, &["ls-remote", "--heads", remote, "master"])
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        "master".to_string()
    } else {
        branch.clone()
    };
    let out = git_out(
        root,
        &["pull", "--rebase", "--autostash", remote, &remote_branch],
    )?;
    Ok(if out.is_empty() {
        "Already up to date.".into()
    } else {
        out.lines().last().unwrap_or("Pulled.").to_string()
    })
}

pub fn push(root: &Path, remote: &str) -> Result<String, String> {
    let branch =
        git_out(root, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "master".into());
    // Overleaf's bridge only accepts its master branch.
    let target = if remote_url(root, remote)
        .map(|u| u.contains("overleaf.com"))
        .unwrap_or(false)
    {
        format!("{}:master", branch)
    } else {
        branch.clone()
    };
    let out = git_out(root, &["push", remote, &target])?;
    Ok(out
        .lines()
        .last()
        .map(|l| l.to_string())
        .unwrap_or_else(|| format!("Pushed {}.", branch)))
}
