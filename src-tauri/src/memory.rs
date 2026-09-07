//! Repo-resident agent memory: `.dabir/PROJECT.md`, one-fact files under
//! `.dabir/memory/`, and the provenance graph that ties figures and tables to
//! the commands that made them.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fact { pub name: String, pub description: String, pub body: String, pub path: String }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Artefact {
    pub artefact: String,
    pub command: String,
    #[serde(default)] pub inputs: Vec<String>,
    #[serde(default)] pub produced_at: Option<String>,
    #[serde(default)] pub commit: Option<String>,
    #[serde(default)] pub data_hash: Option<String>,
    #[serde(default, skip_deserializing)] pub stale: bool,
    #[serde(default, skip_deserializing)] pub missing: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub brief: Option<String>,
    pub brief_path: String,
    pub facts: Vec<Fact>,
    pub provenance: Vec<Artefact>,
    pub pointers: Vec<String>, // AGENTS.md, CLAUDE.md … that exist
}

#[derive(Deserialize, Default)]
struct ProvFile { #[serde(default)] artefacts: std::collections::BTreeMap<String, Artefact> }

fn mtime(p: &Path) -> Option<SystemTime> { fs::metadata(p).ok().and_then(|m| m.modified().ok()) }

fn frontmatter(text: &str) -> (String, String, String) {
    let mut name = String::new();
    let mut desc = String::new();
    let body;
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            for l in rest[..end].lines() {
                if let Some(v) = l.strip_prefix("name:") { name = v.trim().into(); }
                if let Some(v) = l.strip_prefix("description:") { desc = v.trim().into(); }
            }
            body = rest[end + 4..].trim().to_string();
            return (name, desc, body);
        }
    }
    (name, desc, text.trim().to_string())
}

pub fn read(root: &Path) -> Result<Memory, String> {
    let dabir = root.join(".dabir");
    let brief_path = dabir.join("PROJECT.md");
    let brief = fs::read_to_string(&brief_path).ok();

    let mut facts = vec![];
    if let Ok(rd) = fs::read_dir(dabir.join("memory")) {
        let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|e| e == "md").unwrap_or(false)).collect();
        paths.sort();
        for p in paths {
            if let Ok(t) = fs::read_to_string(&p) {
                let (mut name, desc, body) = frontmatter(&t);
                if name.is_empty() { name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(); }
                facts.push(Fact { name, description: desc, body, path: p.to_string_lossy().to_string() });
            }
        }
    }

    // Provenance: provenance.json first, then dabir.toml [provenance] for commands not listed.
    let mut provenance: Vec<Artefact> = vec![];
    if let Ok(t) = fs::read_to_string(dabir.join("provenance.json")) {
        if let Ok(pf) = serde_json::from_str::<ProvFile>(&t) {
            for (k, mut a) in pf.artefacts { a.artefact = k; provenance.push(a); }
        }
    }
    if let Ok(t) = fs::read_to_string(root.join("dabir.toml")) {
        if let Ok(v) = t.parse::<toml::Table>() {
            if let Some(p) = v.get("provenance").and_then(|p| p.as_table()) {
                for (k, cmd) in p {
                    if !provenance.iter().any(|a| &a.artefact == k) {
                        provenance.push(Artefact { artefact: k.clone(), command: cmd.as_str().unwrap_or("").into(), ..Default::default() });
                    }
                }
            }
        }
    }
    for a in provenance.iter_mut() {
        let out = root.join(&a.artefact);
        a.missing = !out.exists();
        let out_t = mtime(&out);
        a.stale = a.missing || a.inputs.iter().any(|i| match (mtime(&root.join(i)), out_t) { (Some(it), Some(ot)) => it > ot, (Some(_), None) => true, _ => false });
    }

    let pointers = ["AGENTS.md", "CLAUDE.md", ".cursor/rules/dabir.mdc"].iter().filter(|p| root.join(p).exists()).map(|s| s.to_string()).collect();
    Ok(Memory { brief, brief_path: brief_path.to_string_lossy().to_string(), facts, provenance, pointers })
}

fn head_short(root: &Path) -> Option<String> {
    let o = Command::new("git").current_dir(root).args(["rev-parse", "--short", "HEAD"]).output().ok()?;
    if o.status.success() { Some(String::from_utf8_lossy(&o.stdout).trim().to_string()) } else { None }
}

/// Draft the brief from the paper itself: title, sections, figure files, and any
/// provenance commands already in dabir.toml. Deterministic, no model involved.
pub fn setup(root: &Path, main_tex: Option<&Path>) -> Result<Vec<String>, String> {
    let dabir = root.join(".dabir");
    fs::create_dir_all(dabir.join("memory")).map_err(|e| e.to_string())?;
    let mut written = vec![];

    let brief = dabir.join("PROJECT.md");
    if !brief.exists() {
        let src = main_tex.and_then(|m| fs::read_to_string(m).ok()).unwrap_or_default();
        let cap = |cmd: &str| -> Option<String> {
            let i = src.find(&format!("\\{}{{", cmd))?;
            let rest = &src[i + cmd.len() + 2..];
            let j = rest.find('}')?;
            Some(rest[..j].trim().to_string())
        };
        let title = cap("title").unwrap_or_else(|| "Untitled paper".into());
        let class = cap("documentclass").unwrap_or_else(|| "unknown".into());
        let sections: Vec<String> = src.lines().filter_map(|l| l.trim().strip_prefix("\\section{").map(|s| s.trim_end_matches('}').to_string())).collect();
        let figures: Vec<String> = src.match_indices("\\includegraphics").filter_map(|(i, _)| { let r = &src[i..]; let a = r.find('{')? + 1; let b = r[a..].find('}')? + a; Some(r[a..b].to_string()) }).collect();
        let mut prov_rows = String::new();
        if let Ok(t) = fs::read_to_string(root.join("dabir.toml")) {
            if let Ok(v) = t.parse::<toml::Table>() {
                if let Some(p) = v.get("provenance").and_then(|p| p.as_table()) {
                    for (k, cmd) in p { prov_rows.push_str(&format!("| {} | `{}` |  |\n", k, cmd.as_str().unwrap_or(""))); }
                }
            }
        }
        for f in &figures { if !prov_rows.contains(f) { prov_rows.push_str(&format!("| {} | (unknown, fill in) |  |\n", f)); } }
        let text = format!(
"# Project brief

Maintained by agents, reviewed by humans. Every vendor's instruction file points here. Drafted by Dabir from the manuscript on {date}; edit freely.

## Claim
{title}

(One paragraph: what the paper claims and what the key number is.)

## Venue
Document class `{class}`. (Venue, page limit, colour rules.)

## Notation
(Macros and symbols that must not be redefined.)

## Structure
{sections}

## Generated artefacts
| Artefact | Made by | Notes |
|---|---|---|
{prov}
Agents must not hand-edit generated artefacts or numbers copied from them. Rerun the command instead.

## How to run
(Environment and the exact commands.)
",
            date = chrono_date(),
            title = title,
            class = class,
            sections = if sections.is_empty() { "(no sections found)".into() } else { sections.iter().map(|s| format!("- {}", s)).collect::<Vec<_>>().join("\n") },
            prov = prov_rows,
        );
        fs::write(&brief, text).map_err(|e| e.to_string())?;
        written.push(".dabir/PROJECT.md".into());
    }

    let prov = dabir.join("provenance.json");
    if !prov.exists() {
        fs::write(&prov, "{\n  \"version\": 1,\n  \"artefacts\": {}\n}\n").map_err(|e| e.to_string())?;
        written.push(".dabir/provenance.json".into());
    }

    let pointer = "See .dabir/PROJECT.md for the project brief, notation, generated artefacts and how to run the experiments. Read it before changing anything. Record durable decisions as one-fact files in .dabir/memory/ with a name and description in the frontmatter.\n";
    for p in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(p);
        if !path.exists() { fs::write(&path, pointer).map_err(|e| e.to_string())?; written.push(p.into()); }
    }
    let cursor = root.join(".cursor").join("rules");
    if !cursor.join("dabir.mdc").exists() {
        fs::create_dir_all(&cursor).map_err(|e| e.to_string())?;
        fs::write(cursor.join("dabir.mdc"), format!("---\ndescription: Dabir project brief\nalwaysApply: true\n---\n{}", pointer)).map_err(|e| e.to_string())?;
        written.push(".cursor/rules/dabir.mdc".into());
    }
    let gi = root.join(".gitignore");
    let existing = fs::read_to_string(&gi).unwrap_or_default();
    if !existing.contains(".dabir/build") {
        fs::write(&gi, format!("{}{}.dabir/build/\n.dabir/index/\n.dabir/worktrees/\n", existing, if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" })).map_err(|e| e.to_string())?;
        written.push(".gitignore".into());
    }
    Ok(written)
}

fn chrono_date() -> String {
    let secs = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Civil date from epoch days (Howard Hinnant's algorithm), no chrono dependency.
    let days = (secs / 86400) as i64;
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput { pub ok: bool, pub output: String, pub millis: u128 }

/// Rerun the command that produces an artefact, in the project root, and record it.
pub fn rerun(root: &Path, artefact: &str) -> Result<RunOutput, String> {
    let mem = read(root)?;
    let a = mem.provenance.into_iter().find(|a| a.artefact == artefact).ok_or("No command recorded for that artefact")?;
    if a.command.trim().is_empty() { return Err("No command recorded for that artefact".into()); }
    let started = std::time::Instant::now();
    let out = Command::new("sh").arg("-lc").arg(&a.command).current_dir(root).output().map_err(|e| e.to_string())?;
    let millis = started.elapsed().as_millis();
    let ok = out.status.success();
    if ok {
        let path = root.join(".dabir").join("provenance.json");
        let mut v: serde_json::Value = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({"version": 1, "artefacts": {}}));
        let entry = v["artefacts"][artefact].as_object().cloned().unwrap_or_default();
        let mut entry = serde_json::Value::Object(entry);
        entry["command"] = serde_json::Value::String(a.command.clone());
        entry["producedAt"] = serde_json::Value::String(chrono_date());
        if let Some(h) = head_short(root) { entry["commit"] = serde_json::Value::String(h); }
        if entry.get("inputs").is_none() { entry["inputs"] = serde_json::json!(a.inputs); }
        v["artefacts"][artefact] = entry;
        let _ = fs::create_dir_all(path.parent().unwrap());
        let _ = fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    Ok(RunOutput { ok, output: format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)), millis })
}
