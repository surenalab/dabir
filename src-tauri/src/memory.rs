//! Repo-resident agent context. Three small things, all plain files committed with the paper:
//!
//! * `.dabir/PROJECT.md`  identity: what the paper is, its claims, conventions, repo map, how to run.
//! * `.dabir/skills/*/SKILL.md`  playbooks for the recurring jobs (rerun an experiment, update a
//!   figure and the text that cites it, answer a reviewer, …). Exposed to every vendor through
//!   `.agents/skills` and `.claude/skills` symlinks so each CLI discovers them natively.
//! * `.dabir/memory/*.md`  one fact per file, plus `runs.md`, an append-only log of accepted runs.
//!
//! Plus `context_pack`, a small lexical retriever that puts the likely relevant passages for a
//! request at the top of the agent's prompt, so it starts in the right place without a search.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub name: String,
    pub description: String,
    pub body: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Artefact {
    pub artefact: String,
    pub command: String,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub produced_at: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub data_hash: Option<String>,
    #[serde(default, skip_deserializing)]
    pub stale: bool,
    #[serde(default, skip_deserializing)]
    pub missing: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub brief: Option<String>,
    pub brief_path: String,
    pub identity: Option<String>, // first paragraph under "## Identity"
    pub env_prefix: Option<String>, // e.g. "conda run -n deepinv"
    pub facts: Vec<Fact>,
    pub skills: Vec<Skill>,
    pub runs: Vec<String>, // last accepted runs, newest first
    pub provenance: Vec<Artefact>,
    pub pointers: Vec<String>,
}

#[derive(Deserialize, Default)]
struct ProvFile {
    #[serde(default)]
    artefacts: std::collections::BTreeMap<String, Artefact>,
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).ok().and_then(|m| m.modified().ok())
}

fn frontmatter(text: &str) -> (String, String, String) {
    let mut name = String::new();
    let mut desc = String::new();
    if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---") {
            for l in rest[..end].lines() {
                if let Some(v) = l.strip_prefix("name:") {
                    name = v.trim().into();
                }
                if let Some(v) = l.strip_prefix("description:") {
                    desc = v.trim().trim_matches('"').into();
                }
            }
            return (name, desc, rest[end + 4..].trim().to_string());
        }
    }
    (name, desc, text.trim().to_string())
}

fn toml_table(root: &Path) -> Option<toml::Table> {
    fs::read_to_string(root.join("dabir.toml"))
        .ok()?
        .parse::<toml::Table>()
        .ok()
}

pub fn env_prefix(root: &Path) -> Option<String> {
    toml_table(root)?
        .get("env")?
        .get("prefix")?
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn section(brief: &str, heading: &str) -> Option<String> {
    let start = brief.find(&format!("## {}", heading))?;
    let body = &brief[start..];
    let body = &body[body.find('\n')? + 1..];
    let end = body.find("\n## ").unwrap_or(body.len());
    let text = body[..end].trim();
    if text.is_empty() || text.starts_with('(') {
        None
    } else {
        Some(text.to_string())
    }
}

pub fn read(root: &Path) -> Result<Memory, String> {
    let dabir = root.join(".dabir");
    let brief_path = dabir.join("PROJECT.md");
    let brief = fs::read_to_string(&brief_path).ok();
    let identity = brief
        .as_deref()
        .and_then(|b| section(b, "Identity"))
        .map(|s| s.lines().next().unwrap_or("").to_string());

    let mut facts = vec![];
    if let Ok(rd) = fs::read_dir(dabir.join("memory")) {
        let mut paths: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.extension().map(|e| e == "md").unwrap_or(false)
                    && p.file_name().map(|n| n != "runs.md").unwrap_or(true)
            })
            .collect();
        paths.sort();
        for p in paths {
            if let Ok(t) = fs::read_to_string(&p) {
                let (mut name, desc, body) = frontmatter(&t);
                if name.is_empty() {
                    name = p
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                }
                facts.push(Fact {
                    name,
                    description: desc,
                    body,
                    path: p.to_string_lossy().to_string(),
                });
            }
        }
    }

    let mut skills = vec![];
    if let Ok(rd) = fs::read_dir(dabir.join("skills")) {
        let mut dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("SKILL.md").exists())
            .collect();
        dirs.sort();
        for d in dirs {
            let t = fs::read_to_string(d.join("SKILL.md")).unwrap_or_default();
            let (mut name, desc, _) = frontmatter(&t);
            if name.is_empty() {
                name = d
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
            }
            skills.push(Skill {
                name,
                description: desc,
                path: d.join("SKILL.md").to_string_lossy().to_string(),
            });
        }
    }

    let runs: Vec<String> = fs::read_to_string(dabir.join("memory").join("runs.md"))
        .ok()
        .map(|t| {
            t.lines()
                .filter(|l| l.starts_with("- "))
                .rev()
                .take(8)
                .map(|l| l[2..].to_string())
                .collect()
        })
        .unwrap_or_default();

    let mut provenance: Vec<Artefact> = vec![];
    if let Ok(t) = fs::read_to_string(dabir.join("provenance.json")) {
        if let Ok(pf) = serde_json::from_str::<ProvFile>(&t) {
            for (k, mut a) in pf.artefacts {
                a.artefact = k;
                provenance.push(a);
            }
        }
    }
    if let Some(p) =
        toml_table(root).and_then(|v| v.get("provenance").and_then(|p| p.as_table()).cloned())
    {
        for (k, cmd) in p {
            if !provenance.iter().any(|a| a.artefact == k) {
                provenance.push(Artefact {
                    artefact: k.clone(),
                    command: cmd.as_str().unwrap_or("").into(),
                    ..Default::default()
                });
            }
        }
    }
    for a in provenance.iter_mut() {
        let out = root.join(&a.artefact);
        a.missing = !out.exists();
        let out_t = mtime(&out);
        a.stale = a.missing
            || a.inputs
                .iter()
                .any(|i| match (mtime(&root.join(i)), out_t) {
                    (Some(it), Some(ot)) => it > ot,
                    (Some(_), None) => true,
                    _ => false,
                });
    }

    let pointers = ["AGENTS.md", "CLAUDE.md", ".cursor/rules/dabir.mdc"]
        .iter()
        .filter(|p| root.join(p).exists())
        .map(|s| s.to_string())
        .collect();
    Ok(Memory {
        brief,
        brief_path: brief_path.to_string_lossy().to_string(),
        identity,
        env_prefix: env_prefix(root),
        facts,
        skills,
        runs,
        provenance,
        pointers,
    })
}

fn head_short(root: &Path) -> Option<String> {
    let o = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if o.status.success() {
        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        None
    }
}

// ---------------------------------------------------------------- environment detection

struct Detected {
    prefix: Option<String>,
    how: Vec<String>,
    notes: Vec<String>,
}

/// Work out how this project's code is run, from the files that are already there.
fn detect_env(root: &Path) -> Detected {
    let mut how = vec![];
    let mut notes = vec![];
    let mut prefix = None;
    if let Ok(t) = fs::read_to_string(root.join("environment.yml"))
        .or_else(|_| fs::read_to_string(root.join("environment.yaml")))
    {
        if let Some(name) = t
            .lines()
            .find_map(|l| l.strip_prefix("name:"))
            .map(|s| s.trim().to_string())
        {
            prefix = Some(format!("conda run -n {}", name));
            how.push(format!(
                "conda env create -f environment.yml   # once; the env is `{}`",
                name
            ));
        }
    }
    if root.join("pyproject.toml").exists() {
        if prefix.is_none() {
            prefix = Some("uv run".into());
        }
        how.push("uv sync   # once; then prefix commands with `uv run`".into());
    } else if root.join("requirements.txt").exists() && prefix.is_none() {
        prefix = Some(".venv/bin/python -m".into());
        how.push(
            "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once".into(),
        );
        notes.push("Commands below assume `.venv/bin/python`.".into());
    }
    if root.join("Project.toml").exists() {
        how.push("julia --project=. -e 'using Pkg; Pkg.instantiate()'   # once".into());
    }
    if root.join("renv.lock").exists() {
        how.push("Rscript -e 'renv::restore()'   # once".into());
    }
    if let Ok(mk) = fs::read_to_string(root.join("Makefile")) {
        let targets: Vec<String> = mk
            .lines()
            .filter_map(|l| {
                let t = l.split(':').next()?;
                if !l.starts_with(['\t', ' ', '#', '.'])
                    && l.contains(':')
                    && !t.contains('=')
                    && !t.contains(' ')
                {
                    Some(t.to_string())
                } else {
                    None
                }
            })
            .take(8)
            .collect();
        if !targets.is_empty() {
            how.push(format!("make {}   # Makefile targets", targets.join(" | ")));
        }
    }
    Detected { prefix, how, notes }
}

/// One line per code file: path and its first docstring or comment line.
/// Every file of the paper (not Dabir's own state, not caches), relative, with sizes: what an agent
/// needs to act without listing directories first. Capped so a stray data folder cannot flood the prompt.
pub fn file_map(root: &Path, cap: usize) -> Vec<String> {
    let mut out = vec![];
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>, depth: usize, cap: usize) {
        if depth > 4 || out.len() >= cap {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if out.len() >= cap {
                return;
            }
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.starts_with('.')
                || [
                    "node_modules",
                    "target",
                    "__pycache__",
                    "venv",
                    ".venv",
                    "build",
                    "dist",
                ]
                .contains(&name.as_str())
            {
                continue;
            }
            if p.is_dir() {
                walk(&p, root, out, depth + 1, cap);
                continue;
            }
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let human = if size < 1024 {
                format!("{size} B")
            } else if size < 1024 * 1024 {
                format!("{} KB", size / 1024)
            } else {
                format!("{:.1} MB", size as f64 / 1048576.0)
            };
            out.push(format!("{rel} ({human})"));
        }
    }
    walk(root, root, &mut out, 0, cap);
    out
}

fn repo_map(root: &Path) -> Vec<String> {
    let mut out = vec![];
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>, depth: usize) {
        if depth > 4 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.starts_with('.')
                || [
                    "node_modules",
                    "target",
                    "__pycache__",
                    "venv",
                    ".venv",
                    "build",
                    "dist",
                ]
                .contains(&name.as_str())
            {
                continue;
            }
            if p.is_dir() {
                walk(&p, root, out, depth + 1);
                continue;
            }
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !["py", "jl", "r", "R", "m", "sh", "ipynb", "rs", "js", "ts"].contains(&ext) {
                continue;
            }
            let text = fs::read_to_string(&p).unwrap_or_default();
            let summary = text
                .lines()
                .map(|l| l.trim())
                .find(|l| {
                    !l.is_empty()
                        && !l.starts_with("#!")
                        && !l.starts_with("import ")
                        && !l.starts_with("from ")
                        && !l.starts_with("use ")
                })
                .map(|l| {
                    l.trim_matches(|c| c == '"' || c == '#' || c == '/' || c == '\'' || c == ' ')
                        .to_string()
                })
                .unwrap_or_default();
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .to_string();
            out.push(if summary.is_empty() {
                format!("- `{}`", rel)
            } else {
                format!(
                    "- `{}`: {}",
                    rel,
                    summary.chars().take(100).collect::<String>()
                )
            });
            if out.len() >= 40 {
                return;
            }
        }
    }
    walk(root, root, &mut out, 0);
    out
}

// ---------------------------------------------------------------- setup

const SKILLS: &[(&str, &str, &str)] = &[
    ("rerun-experiment", "Regenerate a figure or table by rerunning the command that produced it, then update every number in the text that came from it.",
"1. Find the artefact in `.dabir/PROJECT.md` → Generated artefacts, or `dabir.toml [provenance]`. Use the recorded command, prefixed with the env prefix from `dabir.toml [env]` if present.\n2. Run it from the repo root. If it fails, fix the cause in the code, never by editing the output by hand.\n3. Search the manuscript for numbers that came from this artefact (captions, `\\input` tables, inline claims). Update each one from the new output.\n4. Compile (see compile-and-fix). Report the old and new numbers in your final message.\n5. Update `producedAt` and `commit` for the artefact in `.dabir/provenance.json`."),
    ("update-figure-and-text", "Change a figure's content or style and keep the caption, the reference in the text, and any claims consistent.",
"1. Edit the plotting code, not the exported file. Keep the figure's file name so `\\includegraphics` keeps working.\n2. Regenerate through the recorded command (rerun-experiment).\n3. Re-read the caption and every sentence that references the figure (`\\ref{fig:…}`). Fix wording that no longer matches.\n4. Keep the venue's rules: no colour-only encodings, fonts legible at column width.\n5. Compile and check the figure placement in the PDF log for overfull boxes."),
    ("address-reviewer", "Turn a reviewer comment into a minimal, traceable change plus a response paragraph.",
"1. Quote the comment. Decide: change the paper, add an experiment (rerun-experiment), or justify without change.\n2. Make the smallest edit that answers it. Prefer adding a sentence over rewriting a section.\n3. Record the decision as a fact: `.dabir/memory/reviewer-<n>-<slug>.md` with name and description frontmatter, what was asked, what was changed, and why.\n4. Draft the response paragraph at the end of your final message, in the paper's voice, with the section or line changed."),
    ("tighten-prose", "Edit for clarity and length without changing claims or notation.",
"1. Work paragraph by paragraph. Never change a number, a symbol, a citation key, or a claim's strength.\n2. Prefer shorter sentences, active voice, one idea per sentence. Remove hedges that add no information.\n3. Keep the notation in `.dabir/PROJECT.md` → Conventions. Do not introduce new macros.\n4. Show a before/after word count for each section you touched."),
    ("check-references", "Verify citations, cross-references and bibliography entries are consistent and complete.",
"1. Every `\\cite{key}` must exist in the `.bib` files; every `\\ref`/`\\eqref` must have a `\\label`. List the misses.\n2. Look for `??` and `[?]` in the compile log and the PDF text.\n3. Do not invent bibliography entries. If a reference is missing, say so and stop; the author adds it.\n4. Normalise obvious BibTeX problems (missing year, journal capitalisation in braces) only when the source is unambiguous."),
    ("compile-and-fix", "Compile the paper with Tectonic and fix errors at their source.",
"1. Compile: `tectonic -X compile --keep-logs --synctex --outdir .dabir/build main.tex` (or the main file named in PROJECT.md).\n2. Read `.dabir/build/*.log` for `!` errors first, then warnings. Fix the first error, recompile, repeat.\n3. Undefined citations or references are usually a missing `\\label` or a typo in the key; do not silence them.\n4. Overfull boxes in the log point at line numbers; fix wording or table widths rather than adding `\\sloppy`.\n5. Finish with a clean compile and report the remaining warnings."),
];

fn link_skills(root: &Path) -> Result<Vec<String>, String> {
    let mut written = vec![];
    for host in [".agents/skills", ".claude/skills"] {
        let dir = root.join(host);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (name, _, _) in SKILLS {
            let link = dir.join(format!("dabir-{}", name));
            if link.exists() || fs::symlink_metadata(&link).is_ok() {
                continue;
            }
            let target = PathBuf::from("../..")
                .join(".dabir")
                .join("skills")
                .join(name);
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())?;
            #[cfg(not(unix))]
            {
                let _ = target;
                fs::write(
                    link.with_extension("md"),
                    format!("See .dabir/skills/{}/SKILL.md\n", name),
                )
                .map_err(|e| e.to_string())?;
            }
            written.push(format!("{}/dabir-{}", host, name));
        }
    }
    Ok(written)
}

/// Draft the identity brief, the run manifest and the starter skills from the repository itself.
/// Deterministic, no model involved, and it never overwrites a file that already exists.
pub fn setup(root: &Path, main_tex: Option<&Path>) -> Result<Vec<String>, String> {
    let dabir = root.join(".dabir");
    fs::create_dir_all(dabir.join("memory")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dabir.join("skills")).map_err(|e| e.to_string())?;
    let mut written = vec![];
    let det = detect_env(root);

    // dabir.toml: add [env] when missing so provenance commands and agents share one interpreter.
    let toml_path = root.join("dabir.toml");
    let existing_toml = fs::read_to_string(&toml_path).unwrap_or_default();
    if !existing_toml.contains("[env]") {
        let prefix = det.prefix.clone().unwrap_or_default();
        let block = format!("{}{}\n[env]\n# Prepended to every provenance command and suggested to agents. Examples: \"conda run -n myenv\", \"uv run\", \".venv/bin/python -m\".\nprefix = \"{}\"\n", existing_toml, if existing_toml.is_empty() || existing_toml.ends_with('\n') { "" } else { "\n" }, prefix);
        let header = if existing_toml.is_empty() {
            format!(
                "[paper]\nmain = \"{}\"\nengine = \"tectonic\"\n",
                main_tex
                    .and_then(|m| m.file_name())
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or("main.tex".into())
            )
        } else {
            String::new()
        };
        fs::write(&toml_path, format!("{}{}", header, block)).map_err(|e| e.to_string())?;
        written.push("dabir.toml".into());
    }
    let prefix = env_prefix(root);

    let brief = dabir.join("PROJECT.md");
    if !brief.exists() {
        let src = main_tex
            .and_then(|m| fs::read_to_string(m).ok())
            .unwrap_or_default();
        let cap = |cmd: &str| -> Option<String> {
            let i = src.find(&format!("\\{}", cmd))?;
            let mut rest = &src[i + cmd.len() + 1..];
            if rest.starts_with('[') {
                rest = &rest[rest.find(']')? + 1..];
            }
            let rest = rest.strip_prefix('{')?;
            let j = rest.find('}')?;
            Some(rest[..j].trim().to_string())
        };
        let title = cap("title").unwrap_or_else(|| "Untitled paper".into());
        let class = cap("documentclass").unwrap_or_else(|| "unknown".into());
        let abstract_ = src
            .find("\\begin{abstract}")
            .and_then(|i| {
                let r = &src[i + 16..];
                r.find("\\end{abstract}")
                    .map(|j| r[..j].trim().replace('\n', " "))
            })
            .unwrap_or_default();
        let sections: Vec<String> = src
            .lines()
            .filter_map(|l| {
                l.trim()
                    .strip_prefix("\\section{")
                    .map(|s| s.trim_end_matches('}').to_string())
            })
            .collect();
        let macros: Vec<String> = src
            .lines()
            .filter(|l| l.trim_start().starts_with("\\newcommand"))
            .map(|l| format!("- `{}`", l.trim()))
            .take(12)
            .collect();
        let figures: Vec<String> = src
            .match_indices("\\includegraphics")
            .filter_map(|(i, _)| {
                let r = &src[i..];
                let a = r.find('{')? + 1;
                let b = r[a..].find('}')? + a;
                Some(r[a..b].to_string())
            })
            .collect();
        let mut prov_rows = String::new();
        if let Some(p) =
            toml_table(root).and_then(|v| v.get("provenance").and_then(|p| p.as_table()).cloned())
        {
            for (k, cmd) in p {
                prov_rows.push_str(&format!("| {} | `{}` |\n", k, cmd.as_str().unwrap_or("")));
            }
        }
        for f in &figures {
            if !prov_rows.contains(f.as_str()) {
                prov_rows.push_str(&format!(
                    "| {} | (unknown; add to `dabir.toml [provenance]`) |\n",
                    f
                ));
            }
        }
        let main_name = main_tex
            .and_then(|m| m.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or("main.tex".into());
        let how = if det.how.is_empty() {
            "(No environment file found. Add one, or set `prefix` in `dabir.toml [env]`.)"
                .to_string()
        } else {
            det.how
                .iter()
                .map(|h| format!("    {}", h))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let text = format!(
"# {title}

Read this first. It is the paper's identity, its conventions and how its code runs. Keep it short; agents and humans both maintain it.

## Identity
{abstract_short}

Document class `{class}`. Main file `{main}`. Structure: {sections}.

## Claims and key numbers
(One line per claim with the number that supports it and the artefact it comes from.)

## Conventions
Notation and macros that must not be redefined:
{macros}

## Repo map
{repo_map}

## How to run
{how}
{prefix_line}

## Generated artefacts
| Artefact | Made by |
|---|---|
{prov}
Never hand-edit these or numbers copied from them. Rerun the command (skill: rerun-experiment).

## Working rules
- Smallest change that does the job. One concern per run.
- Compile before you finish (skill: compile-and-fix).
- Record durable decisions as one fact per file in `.dabir/memory/`, with `name` and `description` frontmatter.
- Skills for the recurring jobs are in `.dabir/skills/`.
",
            title = title,
            abstract_short = if abstract_.is_empty() { "(One paragraph: what the paper claims and why it matters.)".to_string() } else { abstract_.chars().take(600).collect::<String>() },
            class = class,
            main = main_name,
            sections = if sections.is_empty() { "(no sections found)".into() } else { sections.join(" · ") },
            macros = if macros.is_empty() { "- (none found in the preamble)".to_string() } else { macros.join("\n") },
            repo_map = { let m = repo_map(root); if m.is_empty() { "- (no code files found)".to_string() } else { m.join("\n") } },
            how = how,
            prefix_line = match &prefix { Some(p) => format!("Environment prefix for every command: `{}` (from `dabir.toml [env]`). Example: `{} python code/script.py`.", p, p), None => "No environment prefix set in `dabir.toml [env]`; commands run as written, for example `python code/script.py`.".to_string() },
            prov = prov_rows,
        );
        fs::write(&brief, text).map_err(|e| e.to_string())?;
        written.push(".dabir/PROJECT.md".into());
    }

    for (name, desc, body) in SKILLS {
        let dir = dabir.join("skills").join(name);
        let file = dir.join("SKILL.md");
        if file.exists() {
            continue;
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(
            &file,
            format!(
                "---\nname: dabir-{}\ndescription: \"{}\"\n---\n\n# {}\n\n{}\n",
                name,
                desc,
                name.replace('-', " "),
                body
            ),
        )
        .map_err(|e| e.to_string())?;
        written.push(format!(".dabir/skills/{}/SKILL.md", name));
    }
    written.extend(link_skills(root)?);

    let prov = dabir.join("provenance.json");
    if !prov.exists() {
        fs::write(&prov, "{\n  \"version\": 1,\n  \"artefacts\": {}\n}\n")
            .map_err(|e| e.to_string())?;
        written.push(".dabir/provenance.json".into());
    }
    let runs = dabir.join("memory").join("runs.md");
    if !runs.exists() {
        fs::write(&runs, "# Accepted agent runs\n\nAppended by Dabir when a run is accepted. Newest at the bottom.\n\n").map_err(|e| e.to_string())?;
        written.push(".dabir/memory/runs.md".into());
    }

    let pointer = "Read .dabir/PROJECT.md first: it is this paper's identity, conventions, repo map and how to run its code. Skills for the recurring jobs live in .dabir/skills/ (also linked under .agents/skills and .claude/skills). Never hand-edit generated artefacts; rerun their recorded command. Record durable decisions as one-fact files in .dabir/memory/ with name and description frontmatter.\n";
    for p in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(p);
        if !path.exists() {
            fs::write(&path, pointer).map_err(|e| e.to_string())?;
            written.push(p.into());
        }
    }
    let cursor = root.join(".cursor").join("rules");
    if !cursor.join("dabir.mdc").exists() {
        fs::create_dir_all(&cursor).map_err(|e| e.to_string())?;
        fs::write(
            cursor.join("dabir.mdc"),
            format!(
                "---\ndescription: Dabir project brief\nalwaysApply: true\n---\n{}",
                pointer
            ),
        )
        .map_err(|e| e.to_string())?;
        written.push(".cursor/rules/dabir.mdc".into());
    }
    let gi = root.join(".gitignore");
    let existing = fs::read_to_string(&gi).unwrap_or_default();
    if !existing.contains(".dabir/build") {
        fs::write(
            &gi,
            format!(
                "{}{}.dabir/build/\n.dabir/index/\n.dabir/worktrees/\n",
                existing,
                if existing.is_empty() || existing.ends_with('\n') {
                    ""
                } else {
                    "\n"
                }
            ),
        )
        .map_err(|e| e.to_string())?;
        written.push(".gitignore".into());
    }
    let _ = det.notes;
    Ok(written)
}

pub fn chrono_date() -> String {
    let secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
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

/// Append one line to the run log. Called when a run is accepted.
pub fn log_run(root: &Path, provider: &str, prompt: &str, files: &[String]) {
    let path = root.join(".dabir").join("memory").join("runs.md");
    if !path.parent().map(|p| p.exists()).unwrap_or(false) {
        return;
    }
    let existing = fs::read_to_string(&path).unwrap_or_else(|_| "# Accepted agent runs\n\n".into());
    let summary: String = prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(100)
        .collect();
    let line = format!(
        "- {} · {} · {} · {}\n",
        chrono_date(),
        provider,
        summary,
        files.join(", ")
    );
    let _ = fs::write(&path, format!("{}{}", existing, line));
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub ok: bool,
    pub output: String,
    pub millis: u128,
}

/// Rerun the command that produces an artefact, in the project root with the env prefix, and record it.
pub fn rerun(root: &Path, artefact: &str) -> Result<RunOutput, String> {
    let mem = read(root)?;
    let a = mem
        .provenance
        .into_iter()
        .find(|a| a.artefact == artefact)
        .ok_or("No command recorded for that artefact")?;
    if a.command.trim().is_empty() {
        return Err("No command recorded for that artefact".into());
    }
    let cmd = match env_prefix(root) {
        Some(p) if !a.command.starts_with(&p) => format!("{} {}", p, a.command),
        _ => a.command.clone(),
    };
    let started = std::time::Instant::now();
    let out = Command::new("sh")
        .arg("-lc")
        .arg(&cmd)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    let millis = started.elapsed().as_millis();
    let ok = out.status.success();
    if ok {
        let path = root.join(".dabir").join("provenance.json");
        let mut v: serde_json::Value = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| serde_json::json!({"version": 1, "artefacts": {}}));
        let mut entry = serde_json::Value::Object(
            v["artefacts"][artefact]
                .as_object()
                .cloned()
                .unwrap_or_default(),
        );
        entry["command"] = serde_json::Value::String(a.command.clone());
        entry["producedAt"] = serde_json::Value::String(chrono_date());
        if let Some(h) = head_short(root) {
            entry["commit"] = serde_json::Value::String(h);
        }
        if entry.get("inputs").is_none() {
            entry["inputs"] = serde_json::json!(a.inputs);
        }
        v["artefacts"][artefact] = entry;
        let _ = fs::create_dir_all(path.parent().unwrap());
        let _ = fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    Ok(RunOutput {
        ok,
        output: format!(
            "$ {}\n{}{}",
            cmd,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
        millis,
    })
}

// ---------------------------------------------------------------- context pack (lexical retrieval)

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 2)
        .map(|t| t.to_string())
        .collect()
}

struct Chunk {
    path: String,
    start: usize,
    end: usize,
    text: String,
}

fn collect_chunks(root: &Path) -> Vec<Chunk> {
    let mut chunks = vec![];
    fn walk(dir: &Path, root: &Path, out: &mut Vec<Chunk>, depth: usize) {
        if depth > 5 || out.len() > 4000 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.')
                || [
                    "node_modules",
                    "target",
                    "__pycache__",
                    "venv",
                    ".venv",
                    "build",
                    "dist",
                ]
                .contains(&name.as_str())
            {
                continue;
            }
            if p.is_dir() {
                walk(&p, root, out, depth + 1);
                continue;
            }
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
            if ![
                "tex", "bib", "py", "md", "toml", "jl", "r", "R", "sty", "txt", "yml", "yaml",
                "json",
            ]
            .contains(&ext)
            {
                continue;
            }
            if fs::metadata(&p).map(|m| m.len() > 400_000).unwrap_or(true) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&p) else {
                continue;
            };
            let lines: Vec<&str> = text.lines().collect();
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .to_string();
            let mut i = 0;
            while i < lines.len() {
                let end = (i + 30).min(lines.len());
                out.push(Chunk {
                    path: rel.clone(),
                    start: i + 1,
                    end,
                    text: lines[i..end].join("\n"),
                });
                if end == lines.len() {
                    break;
                }
                i += 20;
            }
        }
    }
    // Also include the brief and memory facts: they are the highest-value context.
    walk(root, root, &mut chunks, 0);
    for extra in [".dabir/PROJECT.md"] {
        if let Ok(text) = fs::read_to_string(root.join(extra)) {
            chunks.push(Chunk {
                path: extra.into(),
                start: 1,
                end: text.lines().count(),
                text,
            });
        }
    }
    if let Ok(rd) = fs::read_dir(root.join(".dabir").join("memory")) {
        for e in rd.flatten() {
            if let Ok(text) = fs::read_to_string(e.path()) {
                let rel = format!(".dabir/memory/{}", e.file_name().to_string_lossy());
                chunks.push(Chunk {
                    path: rel,
                    start: 1,
                    end: text.lines().count(),
                    text,
                });
            }
        }
    }
    chunks
}

/// The likely relevant passages for a request, as a compact block for the top of the prompt.
pub fn context_pack(root: &Path, query: &str, max_chars: usize) -> String {
    let q = tokens(query);
    if q.is_empty() {
        return String::new();
    }
    let chunks = collect_chunks(root);
    if chunks.is_empty() {
        return String::new();
    }
    let n = chunks.len() as f64;
    let mut df: HashMap<&str, usize> = HashMap::new();
    let toks: Vec<Vec<String>> = chunks.iter().map(|c| tokens(&c.text)).collect();
    for t in &toks {
        let mut seen = std::collections::HashSet::new();
        for w in t {
            if seen.insert(w.as_str()) {
                *df.entry(w.as_str()).or_default() += 1;
            }
        }
    }
    let avg = toks.iter().map(|t| t.len()).sum::<usize>() as f64 / n;
    let mut scored: Vec<(f64, usize)> = toks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let len = t.len() as f64;
            let mut tf: HashMap<&str, f64> = HashMap::new();
            for w in t {
                *tf.entry(w.as_str()).or_default() += 1.0;
            }
            let s: f64 = q
                .iter()
                .map(|w| {
                    let f = *tf.get(w.as_str()).unwrap_or(&0.0);
                    if f == 0.0 {
                        return 0.0;
                    }
                    let d = *df.get(w.as_str()).unwrap_or(&1) as f64;
                    let idf = ((n - d + 0.5) / (d + 0.5) + 1.0).ln();
                    idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len / avg.max(1.0)))
                })
                .sum();
            (s, i)
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let mut out = String::new();
    let mut used_paths: HashMap<String, usize> = HashMap::new();
    for (_, i) in scored.into_iter().take(12) {
        let c = &chunks[i];
        let count = used_paths.entry(c.path.clone()).or_default();
        if *count >= 2 {
            continue;
        }
        *count += 1;
        let snippet: String = c.text.lines().take(14).collect::<Vec<_>>().join("\n");
        let block = format!(
            "{}:{}-{}\n{}\n\n",
            c.path,
            c.start,
            c.end,
            snippet.chars().take(700).collect::<String>()
        );
        if out.len() + block.len() > max_chars {
            break;
        }
        out.push_str(&block);
    }
    out
}
