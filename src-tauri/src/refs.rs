//! References: keeping the paper's `.bib` in step with a reference manager.
//!
//! Three feeds, all landing in the same merge: Zotero on this machine (its local API, or Better
//! BibTeX's pull export when that plugin is installed, which gives stable citation keys), a BibTeX
//! file another manager keeps up to date on disk (Mendeley, Paperpile, JabRef, EndNote, or a Better
//! BibTeX auto-export), and single entries by DOI or arXiv id. The merge is by citation key: new keys
//! are appended, changed entries are replaced in place, and entries only the paper has are kept, so
//! hand-written references survive a sync.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const ZOTERO: &str = "http://127.0.0.1:23119";

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: String,
    pub raw: String,
}

/// Split BibTeX text into entries with a citation key. `@comment`, `@preamble` and `@string` are
/// carried along in the existing file's text but never merged from a feed.
pub fn parse_entries(text: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 1;
        while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
            j += 1;
        }
        let kind = text[i + 1..j].to_ascii_lowercase();
        // Skip to the opening brace or parenthesis.
        while j < bytes.len() && bytes[j] != b'{' && bytes[j] != b'(' {
            j += 1;
        }
        if j >= bytes.len() {
            break;
        }
        let close = if bytes[j] == b'{' { b'}' } else { b')' };
        let open = bytes[j];
        let body_start = j + 1;
        let mut depth = 1i32;
        j += 1;
        while j < bytes.len() && depth > 0 {
            if bytes[j] == open {
                depth += 1;
            } else if bytes[j] == close {
                depth -= 1;
            }
            j += 1;
        }
        let raw = text[start..j].trim().to_string();
        if !matches!(kind.as_str(), "comment" | "preamble" | "string") {
            let key = text[body_start..]
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .trim_end_matches(close as char)
                .trim()
                .to_string();
            if !key.is_empty() && !key.contains(char::is_whitespace) {
                out.push(Entry { key, raw });
            }
        }
        i = j;
    }
    out
}

fn normalised(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    pub text: String,
    pub added: Vec<String>,
    pub updated: Vec<String>,
}

/// Merge `incoming` into `existing` by citation key.
pub fn merge(existing: &str, incoming: &str) -> Merge {
    let mut text = existing.to_string();
    let mut added = Vec::new();
    let mut updated = Vec::new();
    let have = parse_entries(existing);
    for e in parse_entries(incoming) {
        match have.iter().find(|h| h.key == e.key) {
            Some(h) if normalised(&h.raw) == normalised(&e.raw) => {}
            Some(h) => {
                if let Some(pos) = text.find(&h.raw) {
                    text.replace_range(pos..pos + h.raw.len(), &e.raw);
                    updated.push(e.key.clone());
                }
            }
            None => {
                if !text.is_empty() && !text.ends_with("\n\n") {
                    text.push_str(if text.ends_with('\n') { "\n" } else { "\n\n" });
                }
                text.push_str(&e.raw);
                text.push_str("\n\n");
                added.push(e.key.clone());
            }
        }
    }
    Merge {
        text,
        added,
        updated,
    }
}

/// The paper's references file: the conventional names first, then the only `.bib` at the root,
/// else `refs.bib` to be created.
pub fn target_bib(root: &Path) -> PathBuf {
    for n in ["refs.bib", "references.bib", "bibliography.bib"] {
        let p = root.join(n);
        if p.exists() {
            return p;
        }
    }
    let bibs: Vec<PathBuf> = fs::read_dir(root)
        .map(|r| {
            r.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "bib").unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    if bibs.len() == 1 {
        return bibs[0].clone();
    }
    root.join("refs.bib")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub file: String,
    pub added: usize,
    pub updated: usize,
    pub total: usize,
    pub keys: Vec<String>,
}

/// Merge BibTeX text into the paper's references file and report what changed.
pub fn merge_into(root: &Path, incoming: &str) -> Result<SyncReport, String> {
    if parse_entries(incoming).is_empty() {
        return Err("No BibTeX entries were found.".into());
    }
    let target = target_bib(root);
    let existing = fs::read_to_string(&target).unwrap_or_default();
    let m = merge(&existing, incoming);
    if !m.added.is_empty() || !m.updated.is_empty() {
        fs::write(&target, &m.text)
            .map_err(|e| format!("Could not write {}: {}", target.display(), e))?;
    }
    let total = parse_entries(&m.text).len();
    let mut keys = m.added.clone();
    keys.extend(m.updated.iter().cloned());
    Ok(SyncReport {
        file: target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        added: m.added.len(),
        updated: m.updated.len(),
        total,
        keys,
    })
}

fn get(
    url: &str,
    accept: Option<&str>,
    secs: u64,
) -> Result<(u16, String, Option<String>), String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(secs)))
        .http_status_as_error(false)
        .build()
        .new_agent();
    let mut req = agent.get(url);
    if let Some(a) = accept {
        req = req.header("Accept", a);
    }
    let mut resp = req.call().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let total = resp
        .headers()
        .get("Total-Results")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())?;
    Ok((status, body, total))
}

const NOT_RUNNING: &str = "Zotero is not reachable. Start Zotero 7 and turn on Settings → Advanced → Allow other applications on this computer to communicate with Zotero.";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub key: String,
    pub name: String,
    pub parent: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroStatus {
    pub reachable: bool,
    pub better_bibtex: bool,
    pub collections: Vec<Collection>,
}

#[derive(Deserialize)]
struct ApiCollection {
    key: String,
    data: ApiCollectionData,
}
#[derive(Deserialize)]
struct ApiCollectionData {
    name: String,
    #[serde(default, rename = "parentCollection")]
    parent_collection: serde_json::Value,
}

/// Is Zotero up, is Better BibTeX there, and which collections exist.
pub fn zotero_status(base: &str) -> ZoteroStatus {
    let mut collections = Vec::new();
    let mut start = 0;
    let mut reachable = false;
    loop {
        let url = format!("{}/api/users/0/collections?limit=100&start={}", base, start);
        let Ok((status, body, _)) = get(&url, None, 4) else {
            break;
        };
        if status != 200 {
            break;
        }
        reachable = true;
        let page: Vec<ApiCollection> = serde_json::from_str(&body).unwrap_or_default();
        let n = page.len();
        for c in page {
            collections.push(Collection {
                key: c.key,
                name: c.data.name,
                parent: c.data.parent_collection.as_str().map(|s| s.to_string()),
            });
        }
        if n < 100 {
            break;
        }
        start += 100;
    }
    // Nest names so "Thesis / Chapter 2" reads as a path.
    let by_key: std::collections::HashMap<String, (String, Option<String>)> = collections
        .iter()
        .map(|c| (c.key.clone(), (c.name.clone(), c.parent.clone())))
        .collect();
    for c in collections.iter_mut() {
        let mut path = vec![c.name.clone()];
        let mut p = c.parent.clone();
        let mut guard = 0;
        while let Some(k) = p {
            guard += 1;
            if guard > 8 {
                break;
            }
            match by_key.get(&k) {
                Some((name, parent)) => {
                    path.push(name.clone());
                    p = parent.clone();
                }
                None => break,
            }
        }
        path.reverse();
        c.name = path.join(" / ");
    }
    collections.sort_by_key(|a| a.name.to_lowercase());
    let better_bibtex = reachable
        && get(&format!("{}/better-bibtex/cayw?probe=true", base), None, 4)
            .map(|(s, b, _)| s == 200 && b.trim() == "ready")
            .unwrap_or(false);
    ZoteroStatus {
        reachable,
        better_bibtex,
        collections,
    }
}

/// BibTeX for the whole library or one collection, through Better BibTeX when present.
pub fn zotero_fetch(
    base: &str,
    collection: Option<&str>,
    better_bibtex: bool,
) -> Result<String, String> {
    if better_bibtex {
        // The user library is id 1; older installs answered on 0.
        for lib in ["1", "0"] {
            let url = match collection {
                Some(k) => format!(
                    "{}/better-bibtex/export/collection?/{}/{}.bibtex",
                    base, lib, k
                ),
                None => format!(
                    "{}/better-bibtex/export/library?/{}/library.bibtex",
                    base, lib
                ),
            };
            if let Ok((200, body, _)) = get(&url, None, 120) {
                if body.contains('@') || body.trim().is_empty() {
                    return Ok(body);
                }
            }
        }
    }
    let mut out = String::new();
    let mut start = 0;
    loop {
        let path = match collection {
            Some(k) => format!("/api/users/0/collections/{}/items", k),
            None => "/api/users/0/items".to_string(),
        };
        let url = format!(
            "{}{}?format=bibtex&limit=100&start={}&itemType=-attachment%20%7C%7C%20note",
            base, path, start
        );
        let (status, body, total) = get(&url, None, 60).map_err(|_| NOT_RUNNING.to_string())?;
        if status != 200 {
            return Err(format!("Zotero answered {} for {}.", status, path));
        }
        let n = parse_entries(&body).len();
        out.push_str(&body);
        out.push('\n');
        start += 100;
        let more = match total.and_then(|t| t.parse::<usize>().ok()) {
            Some(t) => start < t,
            None => n == 100,
        };
        if !more || n == 0 {
            break;
        }
    }
    Ok(out)
}

/// One entry by DOI or arXiv id, from the publisher's registry or arXiv itself.
pub fn fetch_reference(id: &str) -> Result<String, String> {
    let s = id.trim();
    let s = s
        .strip_prefix("https://doi.org/")
        .or_else(|| s.strip_prefix("http://doi.org/"))
        .or_else(|| s.strip_prefix("https://dx.doi.org/"))
        .or_else(|| s.strip_prefix("doi:"))
        .unwrap_or(s);
    let arxiv = s
        .strip_prefix("arXiv:")
        .or_else(|| s.strip_prefix("arxiv:"))
        .or_else(|| s.strip_prefix("https://arxiv.org/abs/"))
        .or_else(|| s.strip_prefix("http://arxiv.org/abs/"))
        .or_else(|| {
            // Bare new-style id: 2301.00001 or 2301.00001v2
            let (a, b) = s.split_once('.')?;
            (a.len() == 4
                && a.chars().all(|c| c.is_ascii_digit())
                && b.len() >= 4
                && b.chars().take(4).all(|c| c.is_ascii_digit()))
            .then_some(s)
        });
    if let Some(aid) = arxiv {
        let url = format!("https://arxiv.org/bibtex/{}", aid.trim_end_matches('/'));
        let (status, body, _) =
            get(&url, None, 20).map_err(|e| format!("arXiv is not reachable: {}", e))?;
        if status != 200 || !body.contains('@') {
            return Err(format!("arXiv has no entry for {}.", aid));
        }
        return Ok(body);
    }
    if !s.starts_with("10.") || !s.contains('/') {
        return Err("Enter a DOI (10.xxxx/…) or an arXiv id (2301.00001).".into());
    }
    let url = format!("https://doi.org/{}", s);
    let (status, body, _) = get(&url, Some("application/x-bibtex; charset=utf-8"), 20)
        .map_err(|e| format!("doi.org is not reachable: {}", e))?;
    if status == 404 {
        return Err(format!("No record for DOI {}.", s));
    }
    if status != 200 || !body.contains('@') {
        return Err(format!(
            "The DOI registry answered {} without a BibTeX record.",
            status
        ));
    }
    Ok(body)
}

/// The linked file's modification time in milliseconds since the epoch, when it exists.
pub fn mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSync {
    pub mtime: u64,
    pub report: Option<SyncReport>,
}

/// Merge a linked `.bib` when it has changed since `since` (ms). The linked file is never written.
pub fn linked_sync(root: &Path, path: &Path, since: u64) -> Result<LinkedSync, String> {
    let mtime =
        mtime_ms(path).ok_or_else(|| format!("{} is not there any more.", path.display()))?;
    if mtime <= since {
        return Ok(LinkedSync {
            mtime,
            report: None,
        });
    }
    if path.canonicalize().ok() == target_bib(root).canonicalize().ok() {
        return Err(
            "That is the paper's own references file; link the file your reference manager writes."
                .into(),
        );
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let report = merge_into(root, &text)?;
    Ok(LinkedSync {
        mtime,
        report: Some(report),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parses_braced_and_parenthesised_entries_and_skips_comments() {
        let text = "@comment{ignored}\n@article{smith2020,\n  title = {A {nested} title},\n  year = 2020\n}\n@Book(doe2019, title=\"B\")\n@string{x = \"y\"}\n";
        let e = parse_entries(text);
        assert_eq!(
            e.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(),
            vec!["smith2020", "doe2019"]
        );
        assert!(e[0].raw.ends_with("}"));
    }

    #[test]
    fn merge_appends_new_replaces_changed_and_keeps_local() {
        let existing = "@article{a,\n  title = {A}\n}\n\n@misc{local,\n  title = {Mine}\n}\n";
        let incoming = "@article{a,\n  title = {A, revised}\n}\n@article{b,\n  title = {B}\n}\n";
        let m = merge(existing, incoming);
        assert_eq!(m.updated, vec!["a"]);
        assert_eq!(m.added, vec!["b"]);
        assert!(
            m.text.contains("A, revised")
                && m.text.contains("Mine")
                && m.text.contains("@article{b")
        );
        // Unchanged content is a no-op.
        let again = merge(&m.text, incoming);
        assert!(again.added.is_empty() && again.updated.is_empty());
    }

    #[test]
    fn merge_into_picks_the_papers_bib_and_reports() {
        let dir = std::env::temp_dir().join(format!("dabir-refs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("paper.bib"), "@article{a, title={A}}\n").unwrap();
        let r = merge_into(&dir, "@article{b, title={B}}").unwrap();
        assert_eq!(
            (r.file.as_str(), r.added, r.updated, r.total),
            ("paper.bib", 1, 0, 2)
        );
        assert!(merge_into(&dir, "nothing here").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn linked_file_merges_only_when_changed() {
        let base = std::env::temp_dir().join(format!("dabir-link-{}", uuid::Uuid::new_v4()));
        let dir = base.join("paper");
        fs::create_dir_all(&dir).unwrap();
        let linked = base.join("mendeley.bib");
        fs::write(&linked, "@article{m1, title={M}}\n").unwrap();
        let first = linked_sync(&dir, &linked, 0).unwrap();
        assert_eq!(first.report.as_ref().unwrap().added, 1);
        assert!(dir.join("refs.bib").is_file());
        let second = linked_sync(&dir, &linked, first.mtime).unwrap();
        assert!(second.report.is_none());
        assert!(linked_sync(&dir, &dir.join("refs.bib"), 0).is_err());
        let _ = fs::remove_dir_all(&base);
    }

    /// A stand-in for Zotero's local API on a free port, answering canned pages.
    fn fake_zotero(bbt: bool) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut s = stream.unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split(' ')
                    .nth(1)
                    .unwrap_or("")
                    .to_string();
                let (status, body, extra) = if path.starts_with("/api/users/0/collections?") {
                    (200, r#"[{"key":"C1","data":{"name":"Thesis","parentCollection":false}},{"key":"C2","data":{"name":"Chapter 2","parentCollection":"C1"}}]"#.to_string(), "")
                } else if path.starts_with("/better-bibtex/cayw") {
                    if bbt {
                        (200, "ready".to_string(), "")
                    } else {
                        (404, String::new(), "")
                    }
                } else if path.starts_with("/better-bibtex/export/collection?/1/C2.bibtex") {
                    (
                        200,
                        "@article{bbtKey2024,\n  title = {From BBT}\n}\n".to_string(),
                        "",
                    )
                } else if path.starts_with("/api/users/0/collections/C2/items?") {
                    let start: usize = path
                        .split("start=")
                        .nth(1)
                        .and_then(|s| s.split('&').next())
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(0);
                    let body = if start == 0 {
                        (0..100)
                            .map(|i| format!("@article{{z{},\n  title = {{Z {}}}\n}}\n", i, i))
                            .collect::<String>()
                    } else {
                        "@article{z100,\n  title = {Z 100}\n}\n".to_string()
                    };
                    (200, body, "Total-Results: 101\r\n")
                } else {
                    (404, String::new(), "")
                };
                let _ = write!(
                    s,
                    "HTTP/1.1 {} OK\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    extra,
                    body
                );
            }
        });
        format!("http://127.0.0.1:{}", port)
    }

    #[test]
    fn zotero_status_nests_collections_and_detects_better_bibtex() {
        let base = fake_zotero(true);
        let s = zotero_status(&base);
        assert!(s.reachable && s.better_bibtex);
        assert_eq!(
            s.collections
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Thesis", "Thesis / Chapter 2"]
        );
        let text = zotero_fetch(&base, Some("C2"), true).unwrap();
        assert!(text.contains("bbtKey2024"));
    }

    #[test]
    fn zotero_fetch_pages_through_the_local_api() {
        let base = fake_zotero(false);
        let s = zotero_status(&base);
        assert!(s.reachable && !s.better_bibtex);
        let text = zotero_fetch(&base, Some("C2"), false).unwrap();
        assert_eq!(parse_entries(&text).len(), 101);
    }

    #[test]
    fn zotero_down_is_reported_plainly() {
        assert!(!zotero_status("http://127.0.0.1:1").reachable);
        assert!(zotero_fetch("http://127.0.0.1:1", None, false)
            .unwrap_err()
            .contains("not reachable"));
    }

    #[test]
    fn reference_ids_are_recognised() {
        assert!(fetch_reference("not an id")
            .unwrap_err()
            .contains("Enter a DOI"));
    }

    /// Network; run by hand: `cargo test -- --ignored doi_and_arxiv`.
    #[test]
    #[ignore]
    fn doi_and_arxiv_lookups_return_bibtex() {
        let doi = fetch_reference("https://doi.org/10.1038/nature14539").unwrap();
        assert!(parse_entries(&doi).len() == 1, "{}", doi);
        let arxiv = fetch_reference("arXiv:1706.03762").unwrap();
        assert!(
            parse_entries(&arxiv).len() == 1 && arxiv.contains("Attention"),
            "{}",
            arxiv
        );
        let bare = fetch_reference("1706.03762v7").unwrap();
        assert_eq!(parse_entries(&bare).len(), 1);
    }
}
