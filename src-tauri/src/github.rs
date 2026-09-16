//! GitHub collaborators for a paper: list, invite, remove. Auth is the user's `gh` login
//! (the same CLI that opens pull requests). Dabir never stores a token.

use serde::Serialize;
use std::path::Path;

use crate::git;
use crate::spawn;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub login: String,
    pub role: String,
    pub pending: bool,
    /// GitHub invitation id, when `pending`.
    pub invitation_id: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct People {
    /// `owner/repo` when origin (or another remote) is GitHub.
    pub repo: Option<String>,
    pub gh: bool,
    pub signed_in: bool,
    pub me: Option<String>,
    /// `admin`, `write`, or `read` on this repository, when known.
    pub permission: Option<String>,
    pub collaborators: Vec<Person>,
    pub error: Option<String>,
}

/// `owner/repo` from a Git remote URL, or None when it is not GitHub.
pub fn parse_repo(url: &str) -> Option<(String, String)> {
    let s = url.trim();
    let s = s.strip_suffix(".git").unwrap_or(s);
    const PREFIXES: &[&str] = &[
        "git@github.com:",
        "ssh://git@github.com/",
        "https://github.com/",
        "http://github.com/",
        "git://github.com/",
    ];
    let rest = PREFIXES.iter().find_map(|p| s.strip_prefix(p))?;
    let rest = rest.trim_start_matches('/');
    let (owner, repo) = rest.split_once('/')?;
    let repo = repo.split('/').next().unwrap_or(repo);
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn gh(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = spawn::tool("gh");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let o = cmd.args(args).output().map_err(|_| {
        "Install the GitHub CLI (gh) to manage collaborators from Dabir.".to_string()
    })?;
    let out = format!(
        "{}{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    );
    if o.status.success() {
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        Err(clean_gh_err(&out))
    }
}

fn clean_gh_err(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return "GitHub refused the request.".into();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    t.lines().last().unwrap_or(t).to_string()
}

fn gh_ok() -> bool {
    spawn::tool("gh")
        .args(["--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn signed_in() -> bool {
    spawn::tool("gh")
        .args(["auth", "status"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn role_of(v: &serde_json::Value) -> String {
    if let Some(r) = v.get("role_name").and_then(|x| x.as_str()) {
        return match r {
            "write" => "write".into(),
            "read" => "read".into(),
            other => other.to_string(),
        };
    }
    let p = v.get("permissions");
    if p.and_then(|x| x.get("admin")).and_then(|x| x.as_bool()) == Some(true) {
        return "admin".into();
    }
    if p.and_then(|x| x.get("maintain")).and_then(|x| x.as_bool()) == Some(true) {
        return "maintain".into();
    }
    if p.and_then(|x| x.get("push")).and_then(|x| x.as_bool()) == Some(true) {
        return "write".into();
    }
    "read".into()
}

pub fn people(root: &Path) -> People {
    let origin = git::remote_url(root, "origin");
    let repo = origin.as_deref().and_then(parse_repo);
    let repo_s = repo.as_ref().map(|(o, r)| format!("{o}/{r}"));
    let gh_bin = gh_ok();
    if repo.is_none() {
        return People {
            repo: None,
            gh: gh_bin,
            signed_in: false,
            me: None,
            permission: None,
            collaborators: vec![],
            error: None,
        };
    }
    if !gh_bin {
        return People {
            repo: repo_s,
            gh: false,
            signed_in: false,
            me: None,
            permission: None,
            collaborators: vec![],
            error: Some("Install the GitHub CLI (gh) to see and invite collaborators.".into()),
        };
    }
    if !signed_in() {
        return People {
            repo: repo_s,
            gh: true,
            signed_in: false,
            me: None,
            permission: None,
            collaborators: vec![],
            error: Some(
                "Sign in with gh (the GitHub CLI) to manage this paper's collaborators.".into(),
            ),
        };
    }
    let (owner, name) = repo.unwrap();
    let slug = format!("{owner}/{name}");
    let me = gh(&["api", "user", "--jq", ".login"], Some(root)).ok();
    let collab_path = format!("repos/{slug}/collaborators?affiliation=all&per_page=100");
    let inv_path = format!("repos/{slug}/invitations?per_page=100");
    let mut error = None;
    let mut collaborators = Vec::new();
    match gh(&["api", &collab_path], Some(root)) {
        Ok(body) => {
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                for u in arr {
                    let login = u
                        .get("login")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if login.is_empty() {
                        continue;
                    }
                    collaborators.push(Person {
                        login,
                        role: role_of(&u),
                        pending: false,
                        invitation_id: None,
                    });
                }
            }
        }
        Err(e) => error = Some(e),
    }
    match gh(&["api", &inv_path], Some(root)) {
        Ok(body) => {
            if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(&body) {
                for u in arr {
                    let login = u
                        .pointer("/invitee/login")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    if login.is_empty() {
                        continue;
                    }
                    collaborators.push(Person {
                        login,
                        role: u
                            .get("permissions")
                            .and_then(|x| x.as_str())
                            .unwrap_or("write")
                            .to_string(),
                        pending: true,
                        invitation_id: u.get("id").and_then(|x| x.as_u64()),
                    });
                }
            }
        }
        Err(_) => {
            // Listing invitations needs admin; a writer still sees collaborators.
        }
    }
    let permission = gh(&["api", &format!("repos/{slug}")], Some(root))
        .ok()
        .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
        .and_then(|v| v.get("permissions").cloned())
        .map(|p| {
            if p.get("admin").and_then(|x| x.as_bool()) == Some(true) {
                "admin".into()
            } else if p.get("push").and_then(|x| x.as_bool()) == Some(true) {
                "write".into()
            } else {
                "read".into()
            }
        });
    People {
        repo: Some(slug),
        gh: true,
        signed_in: true,
        me,
        permission,
        collaborators,
        error,
    }
}

pub fn invite(root: &Path, login: &str, permission: &str) -> Result<(), String> {
    let login = login.trim().trim_start_matches('@');
    if !valid_login(login) {
        return Err("That is not a GitHub username.".into());
    }
    let perm = match permission {
        "admin" | "maintain" | "push" | "write" | "triage" | "pull" | "read" => {
            if permission == "write" {
                "push"
            } else if permission == "read" {
                "pull"
            } else {
                permission
            }
        }
        _ => "push",
    };
    let (owner, repo) = repo_of(root)?;
    let path = format!("repos/{owner}/{repo}/collaborators/{login}?permission={perm}");
    gh(&["api", "-X", "PUT", &path], Some(root)).map(|_| ())
}

pub fn remove(root: &Path, login: &str, invitation_id: Option<u64>) -> Result<(), String> {
    let (owner, repo) = repo_of(root)?;
    if let Some(id) = invitation_id {
        let path = format!("repos/{owner}/{repo}/invitations/{id}");
        return gh(&["api", "-X", "DELETE", &path], Some(root)).map(|_| ());
    }
    let login = login.trim().trim_start_matches('@');
    if !valid_login(login) {
        return Err("That is not a GitHub username.".into());
    }
    let path = format!("repos/{owner}/{repo}/collaborators/{login}");
    gh(&["api", "-X", "DELETE", &path], Some(root)).map(|_| ())
}

fn repo_of(root: &Path) -> Result<(String, String), String> {
    git::remote_url(root, "origin")
        .as_deref()
        .and_then(parse_repo)
        .ok_or_else(|| "This paper's origin remote is not a GitHub URL.".to_string())
}

pub fn valid_login(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 39 {
        return false;
    }
    if !b[0].is_ascii_alphanumeric() {
        return false;
    }
    b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
        && !s.contains("--")
        && !s.ends_with('-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_https_and_git() {
        assert_eq!(
            parse_repo("git@github.com:surenalab/dabir.git"),
            Some(("surenalab".into(), "dabir".into()))
        );
        assert_eq!(
            parse_repo("https://github.com/surenalab/dabir"),
            Some(("surenalab".into(), "dabir".into()))
        );
        assert_eq!(
            parse_repo("https://github.com/surenalab/dabir.git"),
            Some(("surenalab".into(), "dabir".into()))
        );
        assert_eq!(
            parse_repo("ssh://git@github.com/ada/paper.git"),
            Some(("ada".into(), "paper".into()))
        );
        assert_eq!(parse_repo("https://gitlab.com/ada/paper.git"), None);
        assert_eq!(parse_repo("git@overleaf.com:xyz"), None);
    }

    #[test]
    fn github_usernames() {
        assert!(valid_login("octocat"));
        assert!(valid_login("Ada-Lovelace"));
        assert!(!valid_login(""));
        assert!(!valid_login("-ada"));
        assert!(!valid_login("ada-"));
        assert!(!valid_login("ada--b"));
        assert!(!valid_login("not a name"));
    }
}
