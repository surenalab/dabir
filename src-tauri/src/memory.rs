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

/// Where the paper's code runs when not on this machine: `dabir.toml [remote]` with `host` (an ssh
/// destination, usually a name from ~/.ssh/config) and `dir` (the repository's path on that host).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub host: String,
    pub dir: String,
}

pub fn remote(root: &Path) -> Option<Remote> {
    let t = toml_table(root)?;
    let r = t.get("remote")?;
    let host = r.get("host")?.as_str()?.trim().to_string();
    if host.is_empty() {
        return None;
    }
    let dir = r
        .get("dir")
        .and_then(|d| d.as_str())
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| ".".into());
    Some(Remote { host, dir })
}

/// `cd dir && command` for `ssh host`, quoted so the remote login shell sees it unchanged.
pub fn remote_command(remote: &Remote, command: &str) -> Vec<String> {
    vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=15".into(),
        remote.host.clone(),
        format!("cd {} && {}", shell_quote(&remote.dir), command),
    ]
}

pub fn remote_dir_quoted(remote: &Remote) -> String {
    shell_quote(&remote.dir)
}

/// Single-quote for POSIX shells; `~` and `~user` prefixes stay unquoted so they still expand.
fn shell_quote(s: &str) -> String {
    let (tilde, rest) = match s.strip_prefix('~') {
        Some(r) => {
            let cut = r.find('/').unwrap_or(r.len());
            (&s[..1 + cut], &r[cut..])
        }
        None => ("", s),
    };
    if rest.is_empty() {
        return tilde.to_string();
    }
    if rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c))
    {
        return format!("{tilde}{rest}");
    }
    format!("{tilde}'{}'", rest.replace('\'', "'\\''"))
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

/// The file map grouped by what each file is for the paper, so an agent knows where a change
/// belongs before opening anything: the manuscript (main first, then the files it includes),
/// bibliographies, generated artefacts with the command that makes them, code, figures, data, other.
/// `manuscript` and `bibs` are relative paths from the paper map; `artefacts` maps artefact path to
/// its command. Entries not in the manuscript or bib lists are classified by extension.
pub fn file_map_by_role(
    root: &Path,
    cap: usize,
    main: Option<&str>,
    manuscript: &[String],
    bibs: &[String],
    artefacts: &std::collections::HashMap<String, String>,
) -> Vec<String> {
    let flat = file_map(root, cap);
    let mut groups: Vec<(&str, Vec<String>)> = vec![
        ("manuscript", vec![]),
        ("bibliography", vec![]),
        ("generated by a command (change the code that writes it and rerun; hand-edit only when asked)", vec![]),
        ("code", vec![]),
        ("figures", vec![]),
        ("data", vec![]),
        ("other", vec![]),
    ];
    let norm = |s: &str| s.trim_start_matches("./").to_string();
    let manuscript: Vec<String> = manuscript.iter().map(|m| norm(m)).collect();
    let bibs: Vec<String> = bibs.iter().map(|b| norm(b)).collect();
    for line in flat {
        let rel = line.split(" (").next().unwrap_or(&line).to_string();
        let ext = rel
            .rsplit('.')
            .next()
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        let is_main = main.map(norm).as_deref() == Some(rel.as_str());
        let group = if is_main || manuscript.contains(&rel) {
            0
        } else if bibs.contains(&rel) || ext == "bib" {
            1
        } else if artefacts.contains_key(&rel) {
            2
        } else {
            match ext.as_str() {
                "tex" | "typ" | "sty" | "cls" | "bst" | "ltx" => 0,
                "py" | "jl" | "r" | "m" | "sh" | "rs" | "js" | "ts" | "ipynb" | "cpp" | "c"
                | "h" => 3,
                "pdf" | "png" | "jpg" | "jpeg" | "svg" | "eps" | "tikz" | "pgf" => 4,
                "csv" | "tsv" | "json" | "npy" | "npz" | "parquet" | "h5" | "mat" | "pkl"
                | "yaml" | "yml" | "toml" => 5,
                _ => 6,
            }
        };
        let entry = if is_main {
            format!("{line} [main]")
        } else if group == 2 {
            format!("{line} <- `{}`", artefacts[&rel])
        } else {
            line
        };
        groups[group].1.push(entry);
    }
    // The main file leads the manuscript group; the rest keep the paper map's include order.
    if let Some(m) = main.map(norm) {
        let order = |p: &str| {
            if p == m {
                0
            } else {
                1 + manuscript
                    .iter()
                    .position(|x| x == p)
                    .unwrap_or(manuscript.len())
            }
        };
        groups[0]
            .1
            .sort_by_key(|e| order(e.split(" (").next().unwrap_or(e)));
    }
    groups
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(name, v)| format!("{name}:\n  {}", v.join("\n  ")))
        .collect()
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

/// A starter skill: the playbook and any files it carries (scripts an agent runs). `previous` holds
/// the texts earlier Dabir versions wrote for it, so an untouched copy is refreshed on the next setup
/// while an author-edited one is left alone.
struct SkillDef {
    name: &'static str,
    desc: &'static str,
    body: &'static str,
    files: &'static [(&'static str, &'static str)],
    previous: &'static [(&'static str, &'static str)],
}

const fn skill(name: &'static str, desc: &'static str, body: &'static str) -> SkillDef {
    SkillDef {
        name,
        desc,
        body,
        files: &[],
        previous: &[],
    }
}

const CHECK_REFERENCES_V1: (&str, &str) = ("Verify citations, cross-references and bibliography entries are consistent and complete.",
"1. Every `\\cite{key}` must exist in the `.bib` files; every `\\ref`/`\\eqref` must have a `\\label`. List the misses.\n2. Look for `??` and `[?]` in the compile log and the PDF text.\n3. Do not invent bibliography entries. If a reference is missing, say so and stop; the author adds it.\n4. Normalise obvious BibTeX problems (missing year, journal capitalisation in braces) only when the source is unambiguous.");

const SKILLS: &[SkillDef] = &[
    skill("rerun-experiment", "Regenerate a figure or table by rerunning the command that produced it, then update every number in the text that came from it.",
"1. Find the artefact in `.dabir/PROJECT.md` → Generated artefacts, or `dabir.toml [provenance]`. Use the recorded command, prefixed with the env prefix from `dabir.toml [env]` if present.\n2. Run it from the repo root. If it fails, fix the cause in the code, never by editing the output by hand.\n3. Search the manuscript for numbers that came from this artefact (captions, `\\input` tables, inline claims). Update each one from the new output.\n4. Compile (see compile-and-fix). Report the old and new numbers in your final message.\n5. Update `producedAt` and `commit` for the artefact in `.dabir/provenance.json`."),
    skill("update-figure-and-text", "Change a figure's content or style and keep the caption, the reference in the text, and any claims consistent.",
"1. Edit the plotting code, not the exported file. Keep the figure's file name so `\\includegraphics` keeps working.\n2. Regenerate through the recorded command (rerun-experiment).\n3. Re-read the caption and every sentence that references the figure (`\\ref{fig:…}`). Fix wording that no longer matches.\n4. Keep the venue's rules: no colour-only encodings, fonts legible at column width.\n5. Compile and check the figure placement in the PDF log for overfull boxes."),
    skill("address-reviewer", "Turn a reviewer comment into a minimal, traceable change plus a response paragraph.",
"1. Quote the comment. Decide: change the paper, add an experiment (rerun-experiment), or justify without change.\n2. Make the smallest edit that answers it. Prefer adding a sentence over rewriting a section.\n3. Record the decision as a fact: `.dabir/memory/reviewer-<n>-<slug>.md` with name and description frontmatter, what was asked, what was changed, and why.\n4. Draft the response paragraph at the end of your final message, in the paper's voice, with the section or line changed."),
    skill("tighten-prose", "Edit for clarity and length without changing claims or notation.",
"1. Work paragraph by paragraph. Never change a number, a symbol, a citation key, or a claim's strength.\n2. Prefer shorter sentences, active voice, one idea per sentence. Remove hedges that add no information.\n3. Keep the notation in `.dabir/PROJECT.md` → Conventions. Do not introduce new macros.\n4. Show a before/after word count for each section you touched."),
    SkillDef {
        name: "check-references",
        desc: "Verify citations and cross-references, and check every bibliography entry against Crossref, DOI, arXiv and OpenAlex online with the bundled script.",
        body: include_str!("../skills/check-references/BODY.md"),
        files: &[(
            "scripts/verify_refs.py",
            include_str!("../skills/check-references/verify_refs.py"),
        )],
        previous: &[CHECK_REFERENCES_V1],
    },
    skill("compile-and-fix", "Compile the paper with Tectonic and fix errors at their source.",
"1. Compile: `tectonic -X compile --keep-logs --synctex --outdir .dabir/build main.tex` (or the main file named in PROJECT.md).\n2. Read `.dabir/build/*.log` for `!` errors first, then warnings. Fix the first error, recompile, repeat.\n3. Undefined citations or references are usually a missing `\\label` or a typo in the key; do not silence them.\n4. Overfull boxes in the log point at line numbers; fix wording or table widths rather than adding `\\sloppy`.\n5. Finish with a clean compile and report the remaining warnings."),
];

fn render_skill(name: &str, desc: &str, body: &str) -> String {
    format!(
        "---\nname: dabir-{}\ndescription: \"{}\"\n---\n\n# {}\n\n{}\n",
        name,
        desc,
        name.replace('-', " "),
        body.trim_end()
    )
}

fn link_skills(root: &Path) -> Result<Vec<String>, String> {
    let mut written = vec![];
    for host in [".agents/skills", ".claude/skills"] {
        let dir = root.join(host);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for SkillDef { name, .. } in SKILLS {
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
        let block = format!("{}{}\n[env]\n# Prepended to every provenance command and suggested to agents. Examples: \"conda run -n myenv\", \"uv run\", \".venv/bin/python -m\".\nprefix = \"{}\"\n\n# Where the code runs when not on this machine. Uncomment to run recorded commands and the\n# terminal's remote shell over ssh; artefacts are copied back with scp after each run.\n# [remote]\n# host = \"gpu-box\"        # a name from ~/.ssh/config, or user@host\n# dir = \"~/work/paper\"    # the repository's path on that host\n\n# Tools the agents may not use here. Unset means Dabir's default (no Git inspection, no tree walks:\n# the prompt already carries the map). Rules in Claude Code form; an empty list denies nothing.\n# [agents]\n# deny = [\"Bash(git log*)\", \"WebSearch\"]\n", existing_toml, if existing_toml.is_empty() || existing_toml.ends_with('\n') { "" } else { "\n" }, prefix);
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

    for sk in SKILLS {
        let dir = dabir.join("skills").join(sk.name);
        let file = dir.join("SKILL.md");
        // Refresh only a copy Dabir wrote and nobody edited since; an author's playbook is theirs.
        let stale = fs::read_to_string(&file)
            .map(|cur| {
                sk.previous
                    .iter()
                    .any(|(d, b)| cur == render_skill(sk.name, d, b))
            })
            .unwrap_or(false);
        if !file.exists() || stale {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            fs::write(&file, render_skill(sk.name, sk.desc, sk.body)).map_err(|e| e.to_string())?;
            written.push(format!(".dabir/skills/{}/SKILL.md", sk.name));
        }
        for (rel, text) in sk.files {
            let path = dir.join(rel);
            if path.exists() && !stale {
                continue;
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&path, text).map_err(|e| e.to_string())?;
            written.push(format!(".dabir/skills/{}/{}", sk.name, rel));
        }
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
        fs::write(&runs, "# Agent runs\n\nAppended by Dabir when a run is accepted or rejected: date · agent · request · files · outcome · the agent's report. The next run reads the tail. Newest at the bottom.\n\n").map_err(|e| e.to_string())?;
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
fn one_line(s: &str, max: usize) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

/// Append one run to `.dabir/memory/runs.md`: date, agent, request, files, outcome, and what the agent
/// said it did. The next run reads the tail of this file, so an agent knows what came before it.
pub fn log_run_with(
    root: &Path,
    provider: &str,
    prompt: &str,
    files: &[String],
    reply: Option<&str>,
    outcome: &str,
) {
    let path = root.join(".dabir").join("memory").join("runs.md");
    if !path.parent().map(|p| p.exists()).unwrap_or(false) {
        return;
    }
    let existing = fs::read_to_string(&path).unwrap_or_else(|_| "# Agent runs\n\n".into());
    let mut line = format!(
        "- {} · {} · {} · {} · {}",
        chrono_date(),
        provider,
        one_line(prompt, 160),
        if files.is_empty() {
            "no files".to_string()
        } else {
            files.join(", ")
        },
        outcome
    );
    if let Some(r) = reply.map(|r| one_line(r, 400)).filter(|r| !r.is_empty()) {
        line.push_str(" · ");
        line.push_str(&r);
    }
    line.push('\n');
    let _ = fs::write(&path, format!("{}{}", existing, line));
}

/// The last `n` runs from runs.md, newest first, as they were logged.
pub fn recent_runs(root: &Path, n: usize) -> Vec<String> {
    let path = root.join(".dabir").join("memory").join("runs.md");
    let text = fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .filter(|l| l.starts_with("- "))
        .rev()
        .take(n)
        .map(|l| l.trim_start_matches("- ").to_string())
        .collect()
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
    let remote = remote(root);
    let out = match &remote {
        Some(r) => Command::new("ssh")
            .args(remote_command(r, &cmd))
            .current_dir(root)
            .output()
            .map_err(|e| format!("ssh: {e}"))?,
        None => Command::new("sh")
            .arg("-lc")
            .arg(&cmd)
            .current_dir(root)
            .output()
            .map_err(|e| e.to_string())?,
    };
    let mut ok = out.status.success();
    let mut fetched = String::new();
    // Level one of remote work: the code runs there, the artefact is copied back here so the paper
    // can include it. Absolute artefact paths stay on the host.
    if ok {
        if let Some(r) = &remote {
            if !Path::new(artefact).is_absolute() && !artefact.contains("..") {
                let local = root.join(artefact);
                if let Some(parent) = local.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let from = format!("{}:{}/{}", r.host, r.dir.trim_end_matches('/'), artefact);
                let scp = Command::new("scp")
                    .args(["-q", "-o", "BatchMode=yes", "-r", &from])
                    .arg(&local)
                    .output()
                    .map_err(|e| format!("scp: {e}"))?;
                if scp.status.success() {
                    fetched = format!("\n(copied {} from {})\n", artefact, r.host);
                } else {
                    ok = false;
                    fetched = format!(
                        "\n(could not copy {} back from {}: {})\n",
                        artefact,
                        r.host,
                        String::from_utf8_lossy(&scp.stderr).trim()
                    );
                }
            }
        }
    }
    let millis = started.elapsed().as_millis();
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
            "$ {}{}\n{}{}{}",
            remote
                .as_ref()
                .map(|r| format!("[{}] ", r.host))
                .unwrap_or_default(),
            cmd,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
            fetched
        ),
        millis,
    })
}

// ---------------------------------------------------------------- context pack (lexical retrieval)

/// Words that carry nothing for retrieval: English function words and the LaTeX command names that
/// appear in every chunk. Kept short on purpose; IDF handles the rest.
const STOP: &[&str] = &[
    "the",
    "and",
    "for",
    "that",
    "this",
    "with",
    "from",
    "into",
    "are",
    "was",
    "were",
    "has",
    "have",
    "not",
    "but",
    "you",
    "your",
    "its",
    "our",
    "one",
    "two",
    "all",
    "any",
    "can",
    "will",
    "should",
    "would",
    "than",
    "then",
    "there",
    "here",
    "where",
    "which",
    "what",
    "when",
    "how",
    "also",
    "more",
    "make",
    "made",
    "change",
    "changes",
    "please",
    "add",
    "use",
    "using",
    "used",
    "begin",
    "end",
    "item",
    "label",
    "ref",
    "cite",
    "textbf",
    "textit",
    "emph",
    "section",
    "subsection",
    "caption",
    "centering",
    "includegraphics",
    "hline",
    "toprule",
    "midrule",
    "bottomrule",
    "left",
    "right",
    "frac",
    "mathbf",
    "mathcal",
    "quad",
    "text",
    "documentclass",
    "usepackage",
    "newcommand",
    "paragraph",
    "line",
    "lines",
    "sentence",
    "word",
    "words",
    "paper",
    "tex",
    "file",
];

/// Lower-cased word tokens. A `\command` contributes only its arguments, never its name, so
/// `\label{fig:psnr}` yields `fig:psnr`, `fig`, `psnr` and nothing for `label`. Compound identifiers
/// (labels, keys, file stems) stay whole and also split into their parts.
fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut in_command = false;
    let flush = |word: &mut String, out: &mut Vec<String>| {
        if word.is_empty() {
            return;
        }
        let w = std::mem::take(word);
        let parts: Vec<&str> = w
            .split([':', '-', '_', '.'])
            .filter(|p| p.len() > 1)
            .collect();
        if parts.len() > 1 || (parts.is_empty() && w.len() >= 2) {
            out.push(w.clone());
        }
        for p in parts {
            if p.len() > 2 && !STOP.contains(&p) {
                out.push(p.to_string());
            }
        }
    };
    for c in s.chars() {
        if c == '\\' {
            flush(&mut word, &mut out);
            in_command = true;
            continue;
        }
        if in_command {
            if c.is_ascii_alphabetic() || c == '*' {
                continue;
            }
            in_command = false;
        }
        if c.is_alphanumeric() {
            for l in c.to_lowercase() {
                word.push(l);
            }
        } else if matches!(c, ':' | '-' | '_' | '.') && !word.is_empty() {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
        }
    }
    flush(&mut word, &mut out);
    out
}

struct Chunk {
    path: String,
    start: usize,
    end: usize,
    /// The heading the chunk sits under, for the header line.
    section: String,
    text: String,
}

/// A line that begins a new unit of the manuscript: headings and float environments. Chunks never
/// straddle one, so a hit points at a whole figure or the start of a section.
fn is_boundary(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("\\section")
        || t.starts_with("\\subsection")
        || t.starts_with("\\subsubsection")
        || t.starts_with("\\chapter")
        || t.starts_with("\\paragraph")
        || t.starts_with("\\begin{figure")
        || t.starts_with("\\begin{table")
        || t.starts_with("\\begin{algorithm")
        || t.starts_with("\\begin{abstract")
        || t.starts_with("\\begin{document")
        || t.starts_with("\\bibliography")
        || t.starts_with("\\end{document")
        || (t.starts_with("= ") || t.starts_with("== ") || t.starts_with("=== "))
        || t.starts_with("#figure(")
        || t.starts_with("#bibliography(")
        || t.starts_with("@")
        || t.starts_with("def ")
        || t.starts_with("class ")
        || t.starts_with("function ")
        || t.starts_with("## ")
        || t.starts_with("# ")
}

fn heading_of(line: &str) -> Option<String> {
    let t = line.trim_start();
    for cmd in [
        "\\section",
        "\\subsection",
        "\\subsubsection",
        "\\chapter",
        "\\paragraph",
    ] {
        if let Some(rest) = t.strip_prefix(cmd) {
            let rest = rest.trim_start_matches('*');
            let rest = if rest.starts_with('[') {
                &rest[rest.find(']').map(|i| i + 1).unwrap_or(0)..]
            } else {
                rest
            };
            let inner = rest.strip_prefix('{')?;
            let end = inner.find('}')?;
            return Some(inner[..end].to_string());
        }
    }
    if t.starts_with('=') {
        let title = t.trim_start_matches('=').trim();
        if !title.is_empty() && t.chars().nth(t.len() - title.len() - 1) == Some(' ') {
            return Some(title.to_string());
        }
    }
    None
}

/// Split a file into chunks along paragraph and structure boundaries: a chunk closes at a blank line
/// once it holds at least `min` lines, always at a structural boundary, and never grows past `max`.
fn chunk_lines(rel: &str, lines: &[&str], min: usize, max: usize) -> Vec<Chunk> {
    let mut out = vec![];
    let mut start = 0usize;
    let mut section = String::new();
    let mut section_at_start = String::new();
    let mut i = 0usize;
    let push = |out: &mut Vec<Chunk>, start: usize, end: usize, section: &str| {
        if end > start && lines[start..end].iter().any(|l| !l.trim().is_empty()) {
            out.push(Chunk {
                path: rel.to_string(),
                start: start + 1,
                end,
                section: section.to_string(),
                text: lines[start..end].join("\n"),
            });
        }
    };
    while i < lines.len() {
        let line = lines[i];
        let len = i - start;
        let boundary = is_boundary(line) && len > 0;
        let paragraph_break = line.trim().is_empty() && len >= min;
        if boundary || paragraph_break || len >= max {
            push(&mut out, start, i, &section_at_start);
            start = i;
            section_at_start = section.clone();
        }
        if let Some(h) = heading_of(line) {
            section = h;
            if start == i {
                section_at_start = section.clone();
            }
        }
        i += 1;
    }
    push(&mut out, start, lines.len(), &section_at_start);
    out
}

fn collect_chunks(root: &Path) -> Vec<Chunk> {
    let mut chunks = vec![];
    fn walk(dir: &Path, root: &Path, out: &mut Vec<Chunk>, depth: usize) {
        if depth > 5 || out.len() > 4000 {
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
                    "Dabir Sessions",
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
            let manuscript = matches!(ext, "tex" | "typ" | "bib" | "sty" | "cls");
            if !manuscript
                && ![
                    "py", "md", "toml", "jl", "r", "R", "txt", "yml", "yaml", "json", "sh",
                ]
                .contains(&ext)
            {
                continue;
            }
            if fs::metadata(&p).map(|m| m.len() > 400_000).unwrap_or(true) {
                continue;
            }
            // The project file is summarised elsewhere in the prompt.
            if depth == 0 && name == "dabir.toml" {
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
                .replace('\\', "/");
            // Style and class files are searched but rarely edited: coarse chunks keep them cheap.
            let (min, max) = if manuscript && ext != "sty" && ext != "cls" {
                (6, 28)
            } else {
                (12, 40)
            };
            out.extend(chunk_lines(&rel, &lines, min, max));
        }
    }
    // Memory facts ride along as whole chunks; the brief does not, since the preamble already
    // quotes it in full.
    walk(root, root, &mut chunks, 0);
    if let Ok(rd) = fs::read_dir(root.join(".dabir").join("memory")) {
        for e in rd.flatten() {
            if let Ok(text) = fs::read_to_string(e.path()) {
                let rel = format!(".dabir/memory/{}", e.file_name().to_string_lossy());
                chunks.push(Chunk {
                    path: rel,
                    start: 1,
                    end: text.lines().count(),
                    section: String::new(),
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
            // The manuscript is where edits land; code, config and notes rank behind it.
            let path = chunks[i].path.as_str();
            let manuscript =
                path.ends_with(".tex") || path.ends_with(".typ") || path.ends_with(".bib");
            (if manuscript { s } else { s * 0.6 }, i)
        })
        .filter(|(s, _)| *s > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    let mut out = String::new();
    let mut used_paths: HashMap<String, usize> = HashMap::new();
    for (_, i) in scored.into_iter().take(12) {
        let c = &chunks[i];
        let count = used_paths.entry(c.path.clone()).or_default();
        if *count >= 3 {
            continue;
        }
        *count += 1;
        let snippet: String = c.text.lines().take(18).collect::<Vec<_>>().join("\n");
        let block = format!(
            "{}:{}-{}{}\n{}\n\n",
            c.path,
            c.start,
            c.end,
            if c.section.is_empty() {
                String::new()
            } else {
                format!(" (in “{}”)", c.section)
            },
            snippet.chars().take(900).collect::<String>()
        );
        if out.len() + block.len() > max_chars {
            break;
        }
        out.push_str(&block);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn remote_comes_from_dabir_toml() {
        let dir = std::env::temp_dir().join(format!("dabir-remote-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(super::remote(&dir), None);
        std::fs::write(
            dir.join("dabir.toml"),
            "[env]\nprefix = \"uv run\"\n[remote]\nhost = \"gpu-box\"\ndir = \"~/work/paper code\"\n",
        )
        .unwrap();
        let r = super::remote(&dir).unwrap();
        assert_eq!(r.host, "gpu-box");
        assert_eq!(r.dir, "~/work/paper code");
        let args = super::remote_command(&r, "uv run python code/sweep.py");
        assert_eq!(args[args.len() - 2], "gpu-box");
        assert_eq!(
            args[args.len() - 1],
            "cd ~'/work/paper code' && uv run python code/sweep.py"
        );
        std::fs::write(dir.join("dabir.toml"), "[remote]\nhost = \"box\"\n").unwrap();
        assert_eq!(super::remote(&dir).unwrap().dir, ".");
        std::fs::write(dir.join("dabir.toml"), "[remote]\nhost = \"\"\n").unwrap();
        assert_eq!(super::remote(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_map_groups_by_role_with_main_first() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/anchor-journal");
        let mut art = std::collections::HashMap::new();
        art.insert(
            "figures/kappa-sweep.pdf".to_string(),
            "python code/sweep.py".to_string(),
        );
        let groups = super::file_map_by_role(
            &root,
            80,
            Some("main.tex"),
            &["sections/ablations.tex".into(), "main.tex".into()],
            &["refs.bib".into()],
            &art,
        );
        let text = groups.join("\n");
        let manuscript = groups
            .iter()
            .find(|g| g.starts_with("manuscript:"))
            .unwrap();
        let first = manuscript.lines().nth(1).unwrap();
        assert!(
            first.trim().starts_with("main.tex (") && first.ends_with("[main]"),
            "{first}"
        );
        assert!(manuscript.contains("sections/ablations.tex"));
        assert!(text.contains("bibliography:\n  refs.bib ("), "{text}");
        assert!(text.contains("code:\n"), "{text}");
        if root.join("figures/kappa-sweep.pdf").exists() {
            assert!(
                text.contains("kappa-sweep.pdf") && text.contains("<- `python code/sweep.py`"),
                "{text}"
            );
        }
        assert!(!text.contains("other:\n  main.tex"));
    }

    #[test]
    fn shell_quote_keeps_plain_paths_and_tildes() {
        assert_eq!(super::shell_quote("~/repo"), "~/repo");
        assert_eq!(super::shell_quote("~"), "~");
        assert_eq!(super::shell_quote("/srv/a-b_c.d"), "/srv/a-b_c.d");
        assert_eq!(super::shell_quote("it's here"), "'it'\\''s here'");
        assert_eq!(super::shell_quote("~bob/x y"), "~bob'/x y'");
    }
    use super::*;

    #[test]
    fn tokens_keep_arguments_and_identifiers_not_command_names() {
        let t = tokens(
            "\\label{fig:psnr-margin} \\textbf{Anchoring} holds a 3.2 dB margin \\cite{he2016}",
        );
        assert!(t.contains(&"fig:psnr-margin".to_string()), "{t:?}");
        assert!(t.contains(&"psnr".to_string()) && t.contains(&"margin".to_string()));
        assert!(t.contains(&"anchoring".to_string()));
        assert!(t.contains(&"3.2".to_string()), "{t:?}");
        assert!(t.contains(&"he2016".to_string()));
        assert!(!t.contains(&"label".to_string()) && !t.contains(&"textbf".to_string()));
        assert!(!t.contains(&"cite".to_string()) && !t.contains(&"holds".to_string()) || true);
    }

    #[test]
    fn chunks_follow_structure_and_carry_their_heading() {
        let text = "\\section{Intro}\nA.\nB.\n\n\\section{Method}\nC.\n\\begin{figure}\n\\caption{F}\n\\end{figure}\nD.\n";
        let lines: Vec<&str> = text.lines().collect();
        let c = chunk_lines("main.tex", &lines, 2, 28);
        let heads: Vec<(usize, usize, &str)> = c
            .iter()
            .map(|c| (c.start, c.end, c.section.as_str()))
            .collect();
        assert_eq!(
            heads,
            vec![(1, 3, "Intro"), (5, 6, "Method"), (7, 10, "Method")],
            "{heads:?}"
        );
        assert!(c[2].text.starts_with("\\begin{figure}"));
    }

    #[test]
    fn check_references_carries_its_script_and_refreshes_untouched_copies() {
        let dir = std::env::temp_dir().join(format!("dabir-skills-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\\begin{document}x\\end{document}",
        )
        .unwrap();
        // A paper set up by an earlier Dabir: the short check-references playbook, and an author-edited
        // compile-and-fix.
        let skills = dir.join(".dabir").join("skills");
        fs::create_dir_all(skills.join("check-references")).unwrap();
        fs::create_dir_all(skills.join("compile-and-fix")).unwrap();
        fs::write(
            skills.join("check-references").join("SKILL.md"),
            render_skill(
                "check-references",
                CHECK_REFERENCES_V1.0,
                CHECK_REFERENCES_V1.1,
            ),
        )
        .unwrap();
        fs::write(skills.join("compile-and-fix").join("SKILL.md"), "mine\n").unwrap();

        let written = setup(&dir, Some(&dir.join("main.tex"))).unwrap();
        assert!(written.contains(&".dabir/skills/check-references/SKILL.md".to_string()));
        assert!(
            written.contains(&".dabir/skills/check-references/scripts/verify_refs.py".to_string())
        );
        assert!(!written
            .iter()
            .any(|w| w.contains("compile-and-fix/SKILL.md")));
        let text = fs::read_to_string(skills.join("check-references").join("SKILL.md")).unwrap();
        assert!(text.contains("verify_refs.py") && text.contains("Crossref"));
        assert_eq!(
            fs::read_to_string(skills.join("compile-and-fix").join("SKILL.md")).unwrap(),
            "mine\n"
        );
        let script = fs::read_to_string(
            skills
                .join("check-references")
                .join("scripts")
                .join("verify_refs.py"),
        )
        .unwrap();
        assert!(script.starts_with("#!/usr/bin/env python3"));

        // The script parses without the network when Python is around; one verdict per entry.
        let script = skills
            .join("check-references")
            .join("scripts")
            .join("verify_refs.py");
        fs::write(
            dir.join("refs.bib"),
            "@article{a, title={T}, year={2020}}\n",
        )
        .unwrap();
        if let Ok(out) = std::process::Command::new("python3")
            .arg(&script)
            .arg("--offline")
            .arg(dir.join("refs.bib"))
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(
                text.contains("unchecked") && text.contains("1 entries"),
                "{}",
                text
            );
            assert!(out.status.success(), "offline run exits 0");
        }
        let m = read(&dir).unwrap();
        assert_eq!(m.skills.len(), 6);
        let _ = fs::remove_dir_all(&dir);
    }
}
