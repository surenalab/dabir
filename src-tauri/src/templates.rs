//! Paper templates: the bundled starters and the official kits of journals and conferences.
//!
//! `templates/index.json` is the registry. A template is either bundled (a folder next to the
//! index), a zip fetched from the venue's own server, or a list of files fetched from one base URL.
//! Fetched kits are cached under the app's data folder, keyed by id and version, so a paper can be
//! started offline once the kit has been fetched once. Instantiating copies the kit into the new
//! folder and then applies the small, declared adjustments the registry records for it: dropping
//! documentation, flattening a `bst/` folder, renaming the sample to `main.tex`, and the patches
//! that make a kit compile under the bundled engine, each with a stated reason.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Group {
    pub id: String,
    pub label: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    Bundled,
    Zip { url: String },
    Files { base: String, files: Vec<String> },
}

#[derive(Deserialize, Clone, Debug)]
pub struct Patch {
    pub file: String,
    #[serde(default)]
    pub find: Option<String>,
    #[serde(default)]
    pub replace: Option<String>,
    #[serde(default)]
    pub prepend: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub venue: String,
    pub group: String,
    pub engine: String,
    pub official: bool,
    pub featured: bool,
    #[serde(default)]
    pub version: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub site: Option<String>,
    pub source: Source,
    pub main: String,
    #[serde(default)]
    pub drop: Vec<String>,
    #[serde(default)]
    pub flatten: Vec<String>,
    #[serde(default)]
    pub patches: Vec<Patch>,
}

#[derive(Deserialize, Debug)]
pub struct Index {
    pub groups: Vec<Group>,
    pub templates: Vec<Entry>,
}

/// What the chooser shows.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub label: String,
    pub venue: String,
    pub group: String,
    pub engine: String,
    pub official: bool,
    pub featured: bool,
    pub version: Option<String>,
    pub summary: String,
    pub site: Option<String>,
    /// `main.tex` or `main.typ`: the sample is renamed on copy.
    pub main: String,
    /// Host the kit is fetched from, when it is not bundled.
    pub kit: Option<String>,
    /// The kit has been fetched before and can be used offline.
    pub cached: bool,
    /// Reasons for the adjustments Dabir makes to the kit, in the registry's words.
    pub notes: Vec<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub groups: Vec<Group>,
    pub templates: Vec<Template>,
}

pub fn load_index(dir: &Path) -> Result<Index, String> {
    let text = fs::read_to_string(dir.join("index.json"))
        .map_err(|e| format!("Templates index is missing: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("Templates index is malformed: {}", e))
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    Some(rest.split('/').next()?.to_string())
}

fn main_name(entry: &Entry) -> String {
    match Path::new(&entry.main).extension().and_then(|e| e.to_str()) {
        Some("typ") => "main.typ".into(),
        _ => "main.tex".into(),
    }
}

fn cache_key(entry: &Entry) -> String {
    match &entry.version {
        Some(v) => format!("{}-{}", entry.id, v),
        None => entry.id.clone(),
    }
}

pub fn list(dir: &Path, cache: &Path) -> Result<Listing, String> {
    let index = load_index(dir)?;
    let templates = index
        .templates
        .into_iter()
        .filter(|e| !matches!(e.source, Source::Bundled) || dir.join(&e.id).is_dir())
        .map(|e| {
            let (kit, cached) = match &e.source {
                Source::Bundled => (None, true),
                Source::Zip { url } => (host_of(url), cache.join(cache_key(&e)).is_dir()),
                Source::Files { base, .. } => (host_of(base), cache.join(cache_key(&e)).is_dir()),
            };
            Template {
                id: e.id.clone(),
                label: e.label.clone(),
                venue: e.venue.clone(),
                group: e.group.clone(),
                engine: e.engine.clone(),
                official: e.official,
                featured: e.featured,
                version: e.version.clone(),
                summary: e.summary.clone(),
                site: e.site.clone(),
                main: main_name(&e),
                kit,
                cached,
                notes: e.patches.iter().filter_map(|p| p.why.clone()).collect(),
            }
        })
        .collect();
    Ok(Listing {
        groups: index.groups,
        templates,
    })
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let mut resp = ureq::get(url)
        .config()
        .timeout_global(Some(std::time::Duration::from_secs(90)))
        .http_status_as_error(true)
        .build()
        .call()
        .map_err(|e| format!("Could not fetch {}: {}", url, e))?;
    resp.body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| format!("Could not read {}: {}", url, e))
}

fn unzip_into(bytes: &[u8], target: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("The kit is not a zip file: {}", e))?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        // Finder's resource forks and the like never belong in a paper.
        if rel
            .components()
            .any(|c| matches!(c.as_os_str().to_str(), Some("__MACOSX") | Some(".DS_Store")))
        {
            continue;
        }
        let out = target.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// A kit zipped with a single top-level folder is lifted out of it.
fn strip_single_folder(dir: &Path) -> Result<(), String> {
    let entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .collect();
    if entries.len() != 1 || !entries[0].is_dir() {
        return Ok(());
    }
    let inner = entries[0].clone();
    let staging = dir.join(".dabir-lift");
    fs::rename(&inner, &staging).map_err(|e| e.to_string())?;
    for e in fs::read_dir(&staging).map_err(|e| e.to_string())?.flatten() {
        fs::rename(e.path(), dir.join(e.file_name())).map_err(|e| e.to_string())?;
    }
    fs::remove_dir_all(&staging).map_err(|e| e.to_string())
}

/// The raw kit, fetched once into the cache. Bundled templates come straight from their folder.
pub fn prepare(
    dir: &Path,
    cache: &Path,
    entry: &Entry,
    progress: &dyn Fn(&str),
) -> Result<PathBuf, String> {
    match &entry.source {
        Source::Bundled => {
            let p = dir.join(&entry.id);
            if p.is_dir() {
                Ok(p)
            } else {
                Err(format!("Template {} is missing from this build", entry.id))
            }
        }
        Source::Zip { url } => {
            let target = cache.join(cache_key(entry));
            if target.is_dir() {
                return Ok(target);
            }
            progress(&format!(
                "Fetching the official kit from {}…",
                host_of(url).unwrap_or_default()
            ));
            let bytes = fetch(url)?;
            let tmp = cache.join(format!(".{}.part", cache_key(entry)));
            let _ = fs::remove_dir_all(&tmp);
            fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
            progress("Unpacking the kit…");
            unzip_into(&bytes, &tmp)?;
            strip_single_folder(&tmp)?;
            fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            Ok(target)
        }
        Source::Files { base, files } => {
            let target = cache.join(cache_key(entry));
            if target.is_dir() {
                return Ok(target);
            }
            progress(&format!(
                "Fetching the official files from {}…",
                host_of(base).unwrap_or_default()
            ));
            let tmp = cache.join(format!(".{}.part", cache_key(entry)));
            let _ = fs::remove_dir_all(&tmp);
            fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
            for f in files {
                let bytes = fetch(&format!("{}{}", base, f))?;
                fs::write(tmp.join(f), bytes).map_err(|e| e.to_string())?;
            }
            fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            Ok(target)
        }
    }
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for e in fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let dest = to.join(e.file_name());
        if p.is_dir() {
            copy_tree(&p, &dest)?;
        } else {
            fs::copy(&p, &dest).map_err(|err| format!("{}: {}", p.display(), err))?;
        }
    }
    Ok(())
}

/// `*.pdf` matches by extension, anything else by exact file or folder name, at any depth.
fn matches_drop(rel_name: &str, pattern: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(ext) => Path::new(rel_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case(ext))
            .unwrap_or(false),
        None => rel_name == pattern,
    }
}

fn drop_matching(dir: &Path, patterns: &[String]) -> Result<(), String> {
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if patterns.iter().any(|pat| matches_drop(&name, pat)) {
            if p.is_dir() {
                fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(&p).map_err(|e| e.to_string())?;
            }
        } else if p.is_dir() {
            drop_matching(&p, patterns)?;
        }
    }
    Ok(())
}

/// Bytes that are not UTF-8 are read as Latin-1 (the SIAM sample is), so the editor shows them.
fn transcode_text(dir: &Path) -> Result<(), String> {
    for e in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.is_dir() {
            transcode_text(&p)?;
            continue;
        }
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
        if !matches!(
            ext,
            "tex" | "bib" | "sty" | "cls" | "bst" | "typ" | "md" | "txt"
        ) {
            continue;
        }
        let bytes = fs::read(&p).map_err(|e| e.to_string())?;
        if std::str::from_utf8(&bytes).is_ok() {
            continue;
        }
        let text: String = bytes.iter().map(|&b| b as char).collect();
        fs::write(&p, text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn apply_patch(dest: &Path, patch: &Patch) -> Result<(), String> {
    let path = dest.join(&patch.file);
    let mut text =
        fs::read_to_string(&path).map_err(|e| format!("Cannot patch {}: {}", patch.file, e))?;
    if let Some(pre) = &patch.prepend {
        text = format!("{}{}", pre, text);
    }
    if let (Some(find), Some(replace)) = (&patch.find, &patch.replace) {
        if !text.contains(find.as_str()) {
            return Err(format!(
                "The kit has changed: {} no longer contains {}",
                patch.file, find
            ));
        }
        text = text.replacen(find.as_str(), replace, 1);
    }
    fs::write(&path, text).map_err(|e| e.to_string())
}

/// Copy the prepared kit into `dest` and apply the registry's adjustments.
pub fn instantiate(
    dir: &Path,
    cache: &Path,
    id: &str,
    dest: &Path,
    progress: &dyn Fn(&str),
) -> Result<(), String> {
    let index = load_index(dir)?;
    let entry = index
        .templates
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("Unknown template {}", id))?;
    let kit = prepare(dir, cache, entry, progress)?;
    progress("Laying out the paper…");
    copy_tree(&kit, dest)?;
    let mut drops = entry.drop.clone();
    drops.push("__MACOSX".into());
    drops.push(".DS_Store".into());
    drop_matching(dest, &drops)?;
    for folder in &entry.flatten {
        let f = dest.join(folder);
        if f.is_dir() {
            for e in fs::read_dir(&f).map_err(|e| e.to_string())?.flatten() {
                if e.path().is_file() {
                    fs::rename(e.path(), dest.join(e.file_name())).map_err(|e| e.to_string())?;
                }
            }
            let _ = fs::remove_dir_all(&f);
        }
    }
    let main = main_name(entry);
    if entry.main != main {
        let from = dest.join(&entry.main);
        if from.is_file() {
            fs::rename(&from, dest.join(&main)).map_err(|e| e.to_string())?;
        } else {
            return Err(format!(
                "The kit has changed: {} is not in it any more",
                entry.main
            ));
        }
    }
    transcode_text(dest)?;
    for patch in &entry.patches {
        apply_patch(dest, patch)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../templates")
    }

    #[test]
    fn index_is_well_formed_and_bundled_templates_exist() {
        let dir = registry();
        let index = load_index(&dir).unwrap();
        assert!(index.templates.len() >= 20);
        let groups: Vec<&str> = index.groups.iter().map(|g| g.id.as_str()).collect();
        let mut ids = std::collections::HashSet::new();
        for e in &index.templates {
            assert!(ids.insert(e.id.clone()), "duplicate id {}", e.id);
            assert!(
                groups.contains(&e.group.as_str()),
                "{} has an unknown group",
                e.id
            );
            assert!(
                matches!(e.engine.as_str(), "latex" | "typst"),
                "{} engine",
                e.id
            );
            if matches!(e.source, Source::Bundled) {
                assert!(
                    dir.join(&e.id).join(&e.main).is_file(),
                    "bundled template {} lacks {}",
                    e.id,
                    e.main
                );
            } else {
                assert!(
                    e.version.is_some(),
                    "fetched template {} needs a version",
                    e.id
                );
            }
            for p in &e.patches {
                assert!(p.why.is_some(), "patch on {} needs a reason", e.id);
                assert!(p.prepend.is_some() || (p.find.is_some() && p.replace.is_some()));
            }
        }
        let listing = list(&dir, &std::env::temp_dir().join("dabir-no-cache")).unwrap();
        assert!(listing.templates.iter().any(|t| t.id == "neurips"
            && !t.cached
            && t.kit.as_deref() == Some("media.neurips.cc")));
        assert!(listing
            .templates
            .iter()
            .any(|t| t.id == "article" && t.cached && t.kit.is_none()));
    }

    #[test]
    fn instantiating_a_bundled_template_copies_and_renames() {
        let dest = std::env::temp_dir().join(format!("dabir-tpl-{}", uuid::Uuid::new_v4()));
        let cache = std::env::temp_dir().join("dabir-tpl-cache-unused");
        instantiate(&registry(), &cache, "typst-ieee", &dest, &|_| {}).unwrap();
        assert!(dest.join("main.typ").is_file());
        assert!(dest.join("refs.bib").is_file());
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn adjustments_apply_to_a_fake_kit() {
        // A registry of one zip-less entry exercised through the cache path: the kit is placed in the
        // cache by hand, as a fetch would leave it.
        let base = std::env::temp_dir().join(format!("dabir-tplreg-{}", uuid::Uuid::new_v4()));
        let dir = base.join("templates");
        let cache = base.join("cache");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("index.json"),
            r##"{"groups":[{"id":"g","label":"G"}],"templates":[{"id":"k","label":"K","venue":"V","group":"g","engine":"latex","official":true,"featured":false,"version":"1","summary":"s","source":{"kind":"zip","url":"https://example.org/k.zip"},"main":"sample.tex","drop":["*.pdf","docs"],"flatten":["bst"],"patches":[{"file":"main.tex","find":"\\usepackage{bad}","replace":"% bad","why":"bad fails"},{"file":"main.tex","prepend":"% top\n","why":"prelude"}]}]}"##,
        )
        .unwrap();
        let kit = cache.join("k-1");
        fs::create_dir_all(kit.join("bst")).unwrap();
        fs::create_dir_all(kit.join("docs")).unwrap();
        fs::write(
            kit.join("sample.tex"),
            b"\\documentclass{x}\n\\usepackage{bad}\n\xe9\n",
        )
        .unwrap();
        fs::write(kit.join("bst").join("s.bst"), "bst").unwrap();
        fs::write(kit.join("manual.pdf"), "pdf").unwrap();
        fs::write(kit.join("docs").join("readme.txt"), "doc").unwrap();
        let dest = base.join("paper");
        instantiate(&dir, &cache, "k", &dest, &|_| {}).unwrap();
        let main = fs::read_to_string(dest.join("main.tex")).unwrap();
        assert!(
            main.starts_with("% top\n\\documentclass{x}\n% bad\n"),
            "{}",
            main
        );
        assert!(main.contains('é'), "latin-1 byte transcoded");
        assert!(dest.join("s.bst").is_file() && !dest.join("bst").exists());
        assert!(!dest.join("manual.pdf").exists() && !dest.join("docs").exists());
        assert!(!dest.join("sample.tex").exists());
        let listing = list(&dir, &cache).unwrap();
        assert!(listing.templates[0].cached);
        assert_eq!(listing.templates[0].notes, vec!["bad fails", "prelude"]);
        let _ = fs::remove_dir_all(&base);
    }

    /// Fetches every official kit and applies its adjustments. Network; run by hand:
    /// `cargo test -- --ignored kits_fetch`.
    #[test]
    #[ignore]
    fn kits_fetch_and_adjust() {
        let dir = registry();
        let base = std::env::temp_dir().join(format!("dabir-kits-{}", uuid::Uuid::new_v4()));
        let cache = base.join("cache");
        fs::create_dir_all(&cache).unwrap();
        for e in load_index(&dir).unwrap().templates {
            if matches!(e.source, Source::Bundled) {
                continue;
            }
            let dest = base.join(&e.id);
            instantiate(&dir, &cache, &e.id, &dest, &|m| {
                eprintln!("{}: {}", e.id, m)
            })
            .unwrap_or_else(|err| panic!("{}: {}", e.id, err));
            assert!(dest.join(main_name(&e)).is_file(), "{} has no main", e.id);
        }
        eprintln!("kits in {}", base.display());
    }
}
