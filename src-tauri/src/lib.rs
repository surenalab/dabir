//! Dabir core: project discovery, file access, compile, and the native menu.
//!
//! Everything the front end knows about a project comes through these commands.
//! A Dabir project is just a folder; nothing here writes anything the user did
//! not ask for, except the build directory under `.dabir/build`.

mod agents;
mod git;
mod memory;
mod relay;
mod synctex;
mod texlog;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------- project

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub children: Vec<Entry>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    Tex,
    Bib,
    Code,
    Figure,
    Data,
    Other,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    pub main_tex: Option<String>,
    pub has_git: bool,
    pub has_memory: bool,
    pub tree: Vec<Entry>,
}

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "__pycache__", ".venv", "venv", "dist", "build", ".dabir",
];

fn classify(path: &Path) -> EntryKind {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
        Some(ext) => match ext.as_str() {
            "tex" | "sty" | "cls" => EntryKind::Tex,
            "bib" => EntryKind::Bib,
            "py" | "jl" | "r" | "m" | "rs" | "js" | "ts" | "sh" | "ipynb" => EntryKind::Code,
            "pdf" | "png" | "jpg" | "jpeg" | "svg" | "eps" => EntryKind::Figure,
            "csv" | "json" | "npy" | "npz" | "parquet" | "h5" | "mat" | "toml" | "yaml" | "yml" => {
                EntryKind::Data
            }
            _ => EntryKind::Other,
        },
        None => EntryKind::Other,
    }
}

fn walk(dir: &Path, depth: usize) -> Vec<Entry> {
    if depth > 6 {
        return vec![];
    }
    let Ok(read) = fs::read_dir(dir) else { return vec![] };
    let mut entries: Vec<Entry> = read
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                return None;
            }
            if path.is_dir() {
                Some(Entry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    kind: EntryKind::Dir,
                    children: walk(&path, depth + 1),
                })
            } else {
                Some(Entry {
                    name,
                    path: path.to_string_lossy().to_string(),
                    kind: classify(&path),
                    children: vec![],
                })
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        let da = a.kind == EntryKind::Dir;
        let db = b.kind == EntryKind::Dir;
        db.cmp(&da).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// Find the root document: main.tex, a .tex file containing \documentclass, or main.typ.
fn find_main_tex(root: &Path) -> Option<PathBuf> {
    let preferred = root.join("main.tex");
    if preferred.exists() {
        return Some(preferred);
    }
    let typ = root.join("main.typ");
    if typ.exists() {
        return Some(typ);
    }
    let Ok(read) = fs::read_dir(root) else { return None };
    read.filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|e| e == "tex").unwrap_or(false))
        .find(|p| fs::read_to_string(p).map(|s| s.contains("\\documentclass")).unwrap_or(false))
}

#[tauri::command]
fn open_project(path: String) -> Result<Project, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", path));
    }
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());
    Ok(Project {
        root: root.to_string_lossy().to_string(),
        name,
        main_tex: find_main_tex(&root).map(|p| p.to_string_lossy().to_string()),
        has_git: root.join(".git").exists(),
        has_memory: root.join(".dabir").join("PROJECT.md").exists(),
        tree: walk(&root, 0),
    })
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {}", path, e))
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("Could not save {}: {}", path, e))
}

#[tauri::command]
fn read_binary(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("Could not read {}: {}", path, e))
}

// ---------------------------------------------------------------- import

/// Unpack an Overleaf project zip (File › Download › Source) into a new folder
/// next to the zip, or into `dest` when given. Returns the folder path.
#[tauri::command]
fn import_overleaf_zip(zip_path: String, dest: Option<String>) -> Result<String, String> {
    let zip_path = PathBuf::from(&zip_path);
    let file = fs::File::open(&zip_path).map_err(|e| format!("Could not open {}: {}", zip_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a zip file: {}", e))?;
    let stem = zip_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("overleaf-project".into());
    let target = match dest {
        Some(d) => PathBuf::from(d),
        None => zip_path.parent().unwrap_or(Path::new(".")).join(&stem),
    };
    if target.exists() && fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("{} already exists and is not empty", target.display()));
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else { continue };
        let out = target.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    // Overleaf zips have no .gitignore; give the project the Dabir defaults.
    let gi = target.join(".gitignore");
    if !gi.exists() {
        let _ = fs::write(&gi, ".dabir/build/\n.dabir/index/\n*.aux\n*.log\n*.bbl\n*.blg\n*.out\n*.synctex.gz\n");
    }
    Ok(target.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- compile

pub use texlog::Diagnostic;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub ok: bool,
    pub pdf: Option<String>,
    pub log: String,
    pub diagnostics: Vec<Diagnostic>,
    pub engine: String,
    pub millis: u128,
}

fn find_tectonic() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DABIR_TECTONIC") {
        return Some(PathBuf::from(p));
    }
    // Bundled sidecar: Tauri places external binaries next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["tectonic", "tectonic.exe"] {
                let p = dir.join(name);
                if p.is_file() { return Some(p); }
            }
        }
    }
    for c in ["/opt/homebrew/bin/tectonic", "/usr/local/bin/tectonic", "/usr/bin/tectonic"] {
        if Path::new(c).exists() {
            return Some(PathBuf::from(c));
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join("tectonic"))
            .find(|p| p.is_file())
    })
}

fn find_typst() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("DABIR_TYPST") { return Some(PathBuf::from(p)); }
    if let Ok(exe) = std::env::current_exe() { if let Some(dir) = exe.parent() { for n in ["typst", "typst.exe"] { let p = dir.join(n); if p.is_file() { return Some(p); } } } }
    for c in ["/opt/homebrew/bin/typst", "/usr/local/bin/typst", "/usr/bin/typst"] { if Path::new(c).exists() { return Some(PathBuf::from(c)); } }
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join("typst")).find(|p| p.is_file()))
}

/// Typst diagnostics look like:
///   error: unknown variable: foo
///     ┌─ main.typ:12:5
fn parse_typst_log(log: &str) -> Vec<Diagnostic> {
    let lines: Vec<&str> = log.lines().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i].trim_start();
        let (sev, msg) = if let Some(m) = l.strip_prefix("error: ") { ("error", m) } else if let Some(m) = l.strip_prefix("warning: ") { ("warning", m) } else { i += 1; continue };
        let mut file = None; let mut line = None; let mut j = i + 1;
        while j < lines.len() && j < i + 6 {
            let t = lines[j].trim();
            if let Some(rest) = t.strip_prefix("┌─ ") {
                let mut parts = rest.rsplitn(3, ':');
                let _col = parts.next(); let ln = parts.next(); let f = parts.next();
                line = ln.and_then(|n| n.parse().ok()); file = f.map(|f| f.to_string());
                break;
            }
            j += 1;
        }
        let end = (j + 4).min(lines.len());
        out.push(Diagnostic { severity: sev.into(), category: "syntax".into(), file, line, message: msg.trim().to_string(), context: Some(lines[i..end].join("\n")) });
        i = end.max(i + 1);
    }
    out
}

fn compile_typst(app: &AppHandle, main: &Path, root: &Path, outdir: &Path) -> Result<CompileResult, String> {
    let Some(typst) = find_typst() else {
        return Ok(CompileResult { ok: false, pdf: None, log: String::new(), engine: "none".into(), millis: 0, diagnostics: vec![Diagnostic { severity: "error".into(), category: "other".into(), file: None, line: None, message: "Typst is not installed. Install it with `brew install typst`, or set DABIR_TYPST to its path.".into(), context: None }] });
    };
    let stem = main.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("main".into());
    let pdf = outdir.join(format!("{}.pdf", stem));
    let started = std::time::Instant::now();
    let _ = app.emit("compile-progress", "typst compile".to_string());
    let out = Command::new(&typst).current_dir(root).args(["compile", "--root"]).arg(root).arg(main).arg(&pdf).output().map_err(|e| format!("Could not start Typst: {}", e))?;
    let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let ok = out.status.success() && pdf.exists();
    Ok(CompileResult { ok, pdf: if pdf.exists() { Some(pdf.to_string_lossy().to_string()) } else { None }, diagnostics: parse_typst_log(&log), log, engine: format!("typst ({})", typst.display()), millis: started.elapsed().as_millis() })
}

/// Parse Tectonic's output into diagnostics. Tectonic prints lines like
/// `error: main.tex:12: Undefined control sequence.` and
/// `warning: main.tex:40: Citation `foo' on page 2 undefined`.
fn parse_log(log: &str) -> Vec<Diagnostic> {
    let mut out = vec![];
    for line in log.lines() {
        let line = line.trim();
        let (severity, rest) = if let Some(r) = line.strip_prefix("error: ") {
            ("error", r)
        } else if let Some(r) = line.strip_prefix("warning: ") {
            ("warning", r)
        } else {
            continue;
        };
        let mut file = None;
        let mut lineno = None;
        let mut message = rest.to_string();
        let parts: Vec<&str> = rest.splitn(3, ':').collect();
        if parts.len() == 3 {
            if let Ok(n) = parts[1].trim().parse::<u32>() {
                file = Some(parts[0].trim().to_string());
                lineno = Some(n);
                message = parts[2].trim().to_string();
            }
        }
        if message.is_empty() || message.starts_with("see the LaTeX manual") || message.starts_with("Type  H <return>") {
            continue;
        }
        out.push(Diagnostic { severity: severity.into(), category: "other".into(), file, line: lineno, message, context: None });
    }
    out
}

static COMPILE_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

#[tauri::command]
fn compile_cancel() -> bool {
    let pid = COMPILE_PID.lock().unwrap().take();
    match pid { Some(pid) => { let _ = Command::new("kill").arg(pid.to_string()).output(); true } None => false }
}

#[tauri::command]
fn compile(app: AppHandle, main_tex: String) -> Result<CompileResult, String> {
    let main = PathBuf::from(&main_tex);
    let root = main.parent().ok_or("The main .tex file has no parent folder")?;
    let outdir = root.join(".dabir").join("build");
    fs::create_dir_all(&outdir).map_err(|e| e.to_string())?;
    if main.extension().map(|e| e == "typ").unwrap_or(false) {
        return compile_typst(&app, &main, root, &outdir);
    }

    let Some(tectonic) = find_tectonic() else {
        return Ok(CompileResult {
            ok: false,
            pdf: None,
            log: String::new(),
            diagnostics: vec![Diagnostic {
                severity: "error".into(),
                category: "other".into(),
                file: None,
                line: None,
                message: "Tectonic is not installed. Install it with `brew install tectonic`, or set DABIR_TECTONIC to its path.".into(),
                context: None,
            }],
            engine: "none".into(),
            millis: 0,
        });
    };

    let started = std::time::Instant::now();
    let child = Command::new(&tectonic)
        .current_dir(root)
        .args(["-X", "compile", "--keep-logs", "--synctex", "--outdir"])
        .arg(&outdir)
        .arg(&main)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Tectonic: {}", e))?;
    *COMPILE_PID.lock().unwrap() = Some(child.id());
    // Stream Tectonic's progress lines to the status bar while it runs.
    let mut child = child;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let app2 = app.clone();
    let err_thread = std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let mut collected = String::new();
        if let Some(e) = stderr {
            for line in BufReader::new(e).lines().flatten() {
                let msg = line.trim_start_matches("note: ").to_string();
                if !msg.is_empty() && !msg.starts_with("\"version 2\"") { let _ = app2.emit("compile-progress", msg); }
                collected.push_str(&line); collected.push('\n');
            }
        }
        collected
    });
    let out_text = {
        use std::io::Read;
        let mut s = String::new();
        if let Some(mut o) = stdout { let _ = o.read_to_string(&mut s); }
        s
    };
    let status = child.wait().map_err(|e| e.to_string())?;
    let err_text = err_thread.join().unwrap_or_default();
    let output = (status, out_text, err_text);
    let cancelled = COMPILE_PID.lock().unwrap().take().is_none();
    let millis = started.elapsed().as_millis();
    if cancelled {
        return Ok(CompileResult { ok: false, pdf: None, log: "Compile cancelled.".into(), diagnostics: vec![], engine: "tectonic".into(), millis });
    }
    let log = format!("{}{}", output.1, output.2);
    let stem = main.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("main".into());
    let pdf = outdir.join(format!("{}.pdf", stem));
    let ok = output.0.success() && pdf.exists();
    let main_name = main.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or("main.tex".into());
    let mut diagnostics = parse_log(&log);
    if let Ok(texlog_text) = fs::read_to_string(outdir.join(format!("{}.log", stem))) {
        for d in texlog::parse(&texlog_text, &main_name) {
            // Prefer the .log entry: it carries the excerpt. Drop the stderr twin.
            diagnostics.retain(|e| !(e.line == d.line && e.severity == d.severity && d.message.starts_with(e.message.split(':').next().unwrap_or("")) && e.context.is_none() && e.line.is_some()));
            if !diagnostics.iter().any(|e| e.line == d.line && e.message == d.message) { diagnostics.push(d); }
        }
    }
    // Errors first, then warnings, then info; stable within a group.
    diagnostics.sort_by_key(|d| match d.severity.as_str() { "error" => 0, "warning" => 1, _ => 2 });
    Ok(CompileResult {
        ok,
        pdf: if pdf.exists() { Some(pdf.to_string_lossy().to_string()) } else { None },
        diagnostics,
        log,
        engine: format!("tectonic ({})", tectonic.display()),
        millis,
    })
}

// ---------------------------------------------------------------- new paper and references

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Template { id: String, label: String, main: String }

fn templates_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resolve("templates", tauri::path::BaseDirectory::Resource).ok().filter(|p| p.is_dir())
        .or_else(|| { let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../templates"); if dev.is_dir() { Some(dev) } else { None } })
}

#[tauri::command]
fn templates_list(app: AppHandle) -> Vec<Template> {
    let labels = [("ieee-journal", "IEEE journal (IEEEtran)"), ("acm-sigconf", "ACM conference (acmart)"), ("elsevier-article", "Elsevier article (elsarticle)"), ("article", "Plain article"), ("typst-article", "Typst article")];
    let Some(dir) = templates_dir(&app) else { return vec![] };
    labels.iter().filter(|(id, _)| dir.join(id).is_dir()).map(|(id, label)| {
        let main = if dir.join(id).join("main.typ").exists() { "main.typ" } else { "main.tex" };
        Template { id: id.to_string(), label: label.to_string(), main: main.into() }
    }).collect()
}

/// Copy a template into a new folder, initialise Git, and draft the memory scaffold.
#[tauri::command]
fn new_paper(app: AppHandle, parent: String, name: String, template: String) -> Result<String, String> {
    let dir = templates_dir(&app).ok_or("Templates are missing from this build")?.join(&template);
    if !dir.is_dir() { return Err(format!("Unknown template {}", template)); }
    let safe = name.trim().replace(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'), "-");
    if safe.is_empty() { return Err("Give the paper a folder name".into()); }
    let dest = PathBuf::from(&parent).join(&safe);
    if dest.exists() { return Err(format!("{} already exists", dest.display())); }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if p.is_file() { fs::copy(&p, dest.join(e.file_name())).map_err(|e| e.to_string())?; }
    }
    for d in ["figures", "code", "tables"] { let _ = fs::create_dir_all(dest.join(d)); }
    git::init(&dest)?;
    let main = find_main_tex(&dest);
    memory::setup(&dest, main.as_deref())?;
    git::commit(&dest, "New paper from Dabir template", None)?;
    Ok(dest.to_string_lossy().to_string())
}

fn bib_keys(text: &str) -> std::collections::HashSet<String> {
    text.lines().filter_map(|l| { let t = l.trim(); if t.starts_with('@') { t.split('{').nth(1).map(|k| k.trim_end_matches(',').trim().to_string()) } else { None } }).collect()
}

/// Merge BibTeX text into the project's references file, skipping keys already present.
fn merge_bib(root: &Path, incoming: &str) -> Result<(usize, String), String> {
    let target = ["refs.bib", "references.bib", "bibliography.bib"].iter().map(|n| root.join(n)).find(|p| p.exists()).unwrap_or_else(|| root.join("refs.bib"));
    let existing = fs::read_to_string(&target).unwrap_or_default();
    let have = bib_keys(&existing);
    let mut added = 0;
    let mut out = existing.clone();
    let mut entry = String::new();
    let mut depth = 0i32;
    let flush = |entry: &mut String, out: &mut String, added: &mut usize| {
        let key = bib_keys(entry).into_iter().next();
        if let Some(k) = key { if !have.contains(&k) { if !out.ends_with("\n\n") && !out.is_empty() { out.push_str("\n"); } out.push_str(entry.trim()); out.push_str("\n\n"); *added += 1; } }
        entry.clear();
    };
    for l in incoming.lines() {
        if l.trim_start().starts_with('@') && depth == 0 && !entry.trim().is_empty() { flush(&mut entry, &mut out, &mut added); }
        entry.push_str(l); entry.push('\n');
        depth += l.matches('{').count() as i32 - l.matches('}').count() as i32;
        if depth <= 0 && entry.trim_start().starts_with('@') { depth = 0; flush(&mut entry, &mut out, &mut added); }
    }
    if !entry.trim().is_empty() { flush(&mut entry, &mut out, &mut added); }
    fs::write(&target, out).map_err(|e| e.to_string())?;
    Ok((added, target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()))
}

#[tauri::command]
fn bib_import_file(root: String, path: String) -> Result<String, String> {
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (n, target) = merge_bib(Path::new(&root), &text)?;
    Ok(format!("Added {} new entr{} to {}.", n, if n == 1 { "y" } else { "ies" }, target))
}

/// Pull the whole library (or a collection) from Zotero's local API as BibTeX and merge it.
#[tauri::command]
fn zotero_import(root: String) -> Result<String, String> {
    let url = "http://127.0.0.1:23119/api/users/0/items?format=bibtex&limit=100&sort=dateModified&direction=desc";
    let text = ureq::get(url).config().timeout_global(Some(std::time::Duration::from_secs(8))).build().call()
        .map_err(|_| "Zotero is not reachable. Start Zotero 7 and enable Settings → Advanced → Allow other applications to communicate with Zotero.".to_string())?
        .body_mut().read_to_string().map_err(|e| e.to_string())?;
    if !text.contains('@') { return Err("Zotero answered but sent no BibTeX entries.".into()); }
    let (n, target) = merge_bib(Path::new(&root), &text)?;
    Ok(format!("Imported {} new entr{} from Zotero into {}.", n, if n == 1 { "y" } else { "ies" }, target))
}

// ---------------------------------------------------------------- synctex

#[tauri::command]
fn synctex_forward(main_tex: String, file: String, line: u32) -> Result<Option<synctex::PdfPos>, String> {
    let st = synctex::load(&synctex::synctex_path(Path::new(&main_tex)))?;
    Ok(st.forward(Path::new(&file), line))
}

#[tauri::command]
fn synctex_inverse(main_tex: String, page: u32, x: f64, y: f64) -> Result<Option<synctex::SrcPos>, String> {
    let st = synctex::load(&synctex::synctex_path(Path::new(&main_tex)))?;
    Ok(st.inverse(page, x, y))
}

// ---------------------------------------------------------------- git

#[tauri::command]
fn git_status(root: String) -> Result<git::GitStatus, String> { git::status(Path::new(&root)) }

#[tauri::command]
fn git_init(root: String) -> Result<(), String> { git::init(Path::new(&root)) }

#[tauri::command]
fn git_commit(root: String, message: String, paths: Option<Vec<String>>) -> Result<String, String> { git::commit(Path::new(&root), &message, paths) }

#[tauri::command]
fn git_clone(url: String, dest: String) -> Result<String, String> { git::clone(&url, Path::new(&dest)) }

// ---------------------------------------------------------------- remotes and live relay

#[tauri::command]
fn git_remote_add(root: String, name: String, url: String) -> Result<(), String> { git::remote_add(Path::new(&root), &name, &url) }
#[tauri::command]
fn git_remote_url(root: String, name: String) -> Option<String> { git::remote_url(Path::new(&root), &name) }
#[tauri::command]
fn git_pull(root: String, remote: String) -> Result<String, String> { git::pull(Path::new(&root), &remote) }
#[tauri::command]
fn git_push(root: String, remote: String) -> Result<String, String> { git::push(Path::new(&root), &remote) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayInfo { url: String, lan_url: String, pid: u32 }

fn lan_ip() -> Option<String> {
    // Connect a UDP socket to a public address; no packet is sent, but the OS picks the outbound interface.
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("1.1.1.1:80").ok()?;
    s.local_addr().ok().map(|a| a.ip().to_string()).filter(|ip| ip != "0.0.0.0")
}

/// Start the built-in relay on this machine. Returns the local and LAN addresses.
#[tauri::command]
fn relay_start(port: u16) -> Result<RelayInfo, String> {
    relay::start(port)?;
    Ok(RelayInfo { url: format!("ws://127.0.0.1:{}", port), lan_url: format!("ws://{}:{}", lan_ip().unwrap_or("127.0.0.1".into()), port), pid: std::process::id() })
}

#[tauri::command]
fn relay_stop() -> bool { relay::stop() }

// ---------------------------------------------------------------- agents

#[tauri::command]
fn agent_providers() -> Vec<agents::Provider> { agents::detect() }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStarted { run_id: String, worktree: String }

/// Start an agent run on a fresh worktree. Events stream on the `agent-event` channel.
#[tauri::command]
fn agent_run(app: AppHandle, root: String, provider: String, prompt: String) -> Result<RunStarted, String> {
    let run_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
    let root_p = PathBuf::from(&root);
    let wt = git::worktree_add(&root_p, &run_id)?;
    let full = agent_preamble(&root_p, &prompt);
    if let Err(e) = agents::run(app, provider, full, wt.clone(), run_id.clone()) {
        let _ = git::worktree_remove(&root_p, &run_id);
        return Err(e);
    }
    Ok(RunStarted { run_id, worktree: wt.to_string_lossy().to_string() })
}

/// The minimal context every run starts with: who the paper is, where to read more,
/// the environment prefix, and the passages most likely relevant to this request.
fn agent_preamble(root: &Path, prompt: &str) -> String {
    let has_brief = root.join(".dabir").join("PROJECT.md").exists();
    if !has_brief {
        return format!("You are editing a LaTeX paper in a Git worktree. Make the smallest change that does the job and compile before you finish.\n\n{}", prompt);
    }
    let mem = memory::read(root).ok();
    let identity = mem.as_ref().and_then(|m| m.identity.clone()).unwrap_or_default();
    let prefix = mem.as_ref().and_then(|m| m.env_prefix.clone());
    let skills = mem.as_ref().map(|m| m.skills.iter().map(|s| s.name.trim_start_matches("dabir-").to_string()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let pack = memory::context_pack(root, prompt, 2200);
    let mut out = String::new();
    out.push_str("You are a coauthor on this paper, working in a Git worktree that will be reviewed hunk by hunk before it touches the author's checkout.\n");
    if !identity.is_empty() { out.push_str(&format!("Paper: {}\n", identity.chars().take(300).collect::<String>())); }
    out.push_str("Read .dabir/PROJECT.md before changing anything (identity, conventions, repo map, how to run). ");
    if let Some(p) = prefix { out.push_str(&format!("Run code with the prefix `{}`. ", p)); }
    if !skills.is_empty() { out.push_str(&format!("Skills in .dabir/skills/: {}. Follow the matching one. ", skills)); }
    out.push_str("Never hand-edit generated artefacts; rerun their recorded command. Record durable decisions as one-fact files in .dabir/memory/.\n");
    if !pack.is_empty() { out.push_str("\nLikely relevant places (path:lines):\n"); out.push_str(&pack); }
    out.push_str("\n---\nRequest:\n");
    out.push_str(prompt);
    out
}

#[tauri::command]
fn context_pack(root: String, query: String) -> String { memory::context_pack(Path::new(&root), &query, 2200) }

#[tauri::command]
fn agent_cancel(run_id: String) -> bool { agents::cancel(&run_id) }

#[tauri::command]
fn agent_diff(root: String, run_id: String) -> Result<git::WorktreeDiff, String> { git::worktree_diff(Path::new(&root), &run_id) }

#[tauri::command]
fn agent_accept(root: String, run_id: String, message: String, picks: Option<Vec<git::Pick>>, provider: Option<String>, prompt: Option<String>) -> Result<String, String> {
    let root_p = Path::new(&root);
    let files: Vec<String> = match &picks { Some(ps) => ps.iter().map(|p| p.path.clone()).collect(), None => git::worktree_diff(root_p, &run_id).map(|d| d.changes.iter().map(|c| c.path.clone()).collect()).unwrap_or_default() };
    memory::log_run(root_p, provider.as_deref().unwrap_or("agent"), prompt.as_deref().unwrap_or(&message), &files);
    git::worktree_accept(root_p, &run_id, &message, picks)
}

#[tauri::command]
fn agent_reject(root: String, run_id: String) -> Result<(), String> { git::worktree_remove(Path::new(&root), &run_id) }

#[tauri::command]
fn agent_pull_request(root: String, run_id: String, message: String) -> Result<String, String> { git::worktree_pull_request(Path::new(&root), &run_id, &message) }

// ---------------------------------------------------------------- memory

#[tauri::command]
fn memory_read(root: String) -> Result<memory::Memory, String> { memory::read(Path::new(&root)) }

#[tauri::command]
fn memory_setup(root: String, main_tex: Option<String>) -> Result<Vec<String>, String> {
    memory::setup(Path::new(&root), main_tex.as_deref().map(Path::new))
}

#[tauri::command]
fn provenance_rerun(root: String, artefact: String) -> Result<memory::RunOutput, String> { memory::rerun(Path::new(&root), &artefact) }

// ---------------------------------------------------------------- menu

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let about = AboutMetadata {
        name: Some("Dabir".into()),
        comments: Some("A local-first workspace for scientific writing.".into()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "Dabir")
        .item(&PredefinedMenuItem::about(app, Some("About Dabir"), Some(about))?)
        .separator()
        .item(&MenuItemBuilder::with_id("settings", "Settings…").accelerator("CmdOrCtrl+,").build(app)?)
        .item(&MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&MenuItemBuilder::with_id("new", "New Paper…").accelerator("CmdOrCtrl+N").build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open Paper…").accelerator("CmdOrCtrl+O").build(app)?)
        .item(&MenuItemBuilder::with_id("import-overleaf", "Import from Overleaf…").build(app)?)
        .item(&MenuItemBuilder::with_id("clone", "Clone from GitHub…").accelerator("CmdOrCtrl+Shift+O").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("CmdOrCtrl+S").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("share", "Share…").accelerator("CmdOrCtrl+Shift+S").build(app)?)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&MenuItemBuilder::with_id("find", "Find…").accelerator("CmdOrCtrl+F").build(app)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("view-visual", "Visual").accelerator("CmdOrCtrl+1").build(app)?)
        .item(&MenuItemBuilder::with_id("view-source", "Source").accelerator("CmdOrCtrl+2").build(app)?)
        .item(&MenuItemBuilder::with_id("view-pdf", "PDF").accelerator("CmdOrCtrl+3").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggle-sidebar", "Show/Hide Sidebar").accelerator(if cfg!(target_os = "macos") { "Ctrl+Cmd+S" } else { "CmdOrCtrl+Shift+S" }).build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-inspector", "Show/Hide Inspector").accelerator(if cfg!(target_os = "macos") { "Alt+Cmd+I" } else { "CmdOrCtrl+Shift+I" }).build(app)?)
        .separator()
        .fullscreen()
        .build()?;

    let paper = SubmenuBuilder::new(app, "Paper")
        .item(&MenuItemBuilder::with_id("compile", "Compile").accelerator("CmdOrCtrl+B").build(app)?)
        .item(&MenuItemBuilder::with_id("show-log", "Show Compile Log").accelerator("CmdOrCtrl+Shift+L").build(app)?)
        .item(&MenuItemBuilder::with_id("sync-pdf", "Show Line in PDF").accelerator("CmdOrCtrl+Shift+J").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("commit", "Commit…").accelerator("CmdOrCtrl+Shift+C").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("ask-agent", "Ask the Agent…").accelerator("CmdOrCtrl+K").build(app)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts").accelerator("CmdOrCtrl+/").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &paper, &window])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            build_menu(app.handle())?;
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                if let Some(window) = app.get_webview_window("main") {
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None);
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![
            open_project, read_text, write_text, read_binary, compile, compile_cancel, import_overleaf_zip,
            templates_list, new_paper, bib_import_file, zotero_import,
            synctex_forward, synctex_inverse,
            git_status, git_init, git_commit, git_clone, git_remote_add, git_remote_url, git_pull, git_push, relay_start, relay_stop,
            agent_providers, agent_run, agent_cancel, agent_diff, agent_accept, agent_reject, agent_pull_request,
            memory_read, memory_setup, provenance_rerun, context_pack
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dabir");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tectonic_diagnostics() {
        let log = "note: generating format\nerror: main.tex:36: Unable to load picture or PDF file 'figures/x.pdf'\nwarning: main.tex:40: Citation `foo' undefined\nerror: something bad happened inside XeTeX; its output follows:\n";
        let d = parse_log(log);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0].severity, "error");
        assert_eq!(d[0].file.as_deref(), Some("main.tex"));
        assert_eq!(d[0].line, Some(36));
        assert_eq!(d[1].severity, "warning");
        assert_eq!(d[1].line, Some(40));
        assert_eq!(d[2].line, None);
    }

    #[test]
    fn git_status_commit_and_memory_setup() {
        let dir = std::env::temp_dir().join(format!("dabir-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tex"), "\\documentclass{article}\n\\title{Test Paper}\n\\begin{document}\n\\section{Intro}\nHi\n\\end{document}\n").unwrap();
        fs::write(dir.join("dabir.toml"), "[provenance]\n\"figures/a.pdf\" = \"true\"\n").unwrap();
        let st = git::status(&dir).unwrap();
        assert!(!st.is_repo);
        git::init(&dir).unwrap();
        let st = git::status(&dir).unwrap();
        assert!(st.is_repo);
        assert!(st.changes.iter().any(|c| c.path == "main.tex" && c.status == "untracked"));
        let id = git::commit(&dir, "first", None).unwrap();
        assert_eq!(id.len(), 7);
        let st = git::status(&dir).unwrap();
        assert!(st.changes.is_empty());
        assert_eq!(st.recent[0].summary, "first");
        // memory
        let written = memory::setup(&dir, Some(&dir.join("main.tex"))).unwrap();
        assert!(written.contains(&".dabir/PROJECT.md".to_string()));
        let m = memory::read(&dir).unwrap();
        assert!(m.brief.unwrap().contains("Test Paper"));
        assert_eq!(m.provenance.len(), 1);
        assert!(m.provenance[0].missing);
        assert!(m.pointers.contains(&"AGENTS.md".to_string()));
        assert_eq!(m.skills.len(), 6, "starter skills");
        assert!(dir.join(".agents/skills/dabir-compile-and-fix/SKILL.md").exists(), "skill symlink resolves");
        let pack = memory::context_pack(&dir, "intro section", 2000);
        assert!(pack.contains("main.tex:"), "context pack finds the manuscript: {}", pack);
        // worktree round trip
        git::commit(&dir, "memory", None).unwrap();
        let wt = git::worktree_add(&dir, "t1").unwrap();
        fs::write(wt.join("main.tex"), "changed\n").unwrap();
        let d = git::worktree_diff(&dir, "t1").unwrap();
        assert_eq!(d.changes.len(), 1);
        assert!(d.patch.contains("+changed"));
        let id = git::worktree_accept(&dir, "t1", "agent change", None).unwrap();
        assert_eq!(id.len(), 7);
        assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "changed\n");
        assert!(!wt.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merges_bib_without_duplicates() {
        let dir = std::env::temp_dir().join(format!("dabir-bib-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir); fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("refs.bib"), "@article{a2020,\n  title={A},\n  year={2020}\n}\n").unwrap();
        let (n, t) = merge_bib(&dir, "@article{a2020,\n  title={A dup}\n}\n@book{b2021,\n  title={B},\n  publisher={P}\n}\n").unwrap();
        assert_eq!((n, t.as_str()), (1, "refs.bib"));
        let out = fs::read_to_string(dir.join("refs.bib")).unwrap();
        assert!(out.contains("b2021") && !out.contains("A dup"));
        let d = parse_typst_log("error: unknown variable: foo\n  ┌─ main.typ:12:5\n  │\n12 │ #foo\n");
        assert_eq!(d[0].line, Some(12)); assert_eq!(d[0].file.as_deref(), Some("main.typ"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filters_patch_by_file_and_hunk() {
        let patch = "diff --git a/a.tex b/a.tex\n--- a/a.tex\n+++ b/a.tex\n@@ -1,1 +1,1 @@\n-x\n+y\n@@ -10,1 +10,1 @@\n-p\n+q\ndiff --git a/b.tex b/b.tex\n--- a/b.tex\n+++ b/b.tex\n@@ -1,1 +1,1 @@\n-m\n+n\n";
        let only_b = git::filter_patch(patch, &[git::Pick { path: "b.tex".into(), hunks: None }]);
        assert!(only_b.contains("+n") && !only_b.contains("+y"));
        let second_hunk = git::filter_patch(patch, &[git::Pick { path: "a.tex".into(), hunks: Some(vec![1]) }]);
        assert!(second_hunk.contains("+q") && !second_hunk.contains("+y") && second_hunk.contains("+++ b/a.tex"));
        let none = git::filter_patch(patch, &[git::Pick { path: "a.tex".into(), hunks: Some(vec![]) }]);
        assert!(none.trim().is_empty());
    }

    /// Native relay round trip: two y-websocket clients through the in-process server.
    #[test]
    fn relay_syncs_two_clients() {
        if which("node").is_none() { eprintln!("node not found; skipping"); return; }
        relay::start(1240).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let out = Command::new("node").current_dir(&repo).args(["relay/test-client.mjs", "ws://127.0.0.1:1240", "test-room"]).output().unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        relay::stop();
        eprintln!("relay client output: {}", text.trim());
        assert!(text.contains("SYNC_OK"), "relay sync failed: {}", text);
    }

    fn which(bin: &str) -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = vec!["/opt/homebrew/bin".into(), "/opt/homebrew/opt/node@22/bin".into(), "/usr/local/bin".into()];
        if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
        dirs.into_iter().map(|d| d.join(bin)).find(|p| p.is_file())
    }

    #[test]
    fn synctex_parses_records() {
        let text = "SyncTeX Version:1\nInput:1:/tmp/x/main.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n[1,1:4736286,4736286:0,0,0\nh1,12:4736286,9000000:100,10,2\nx1,13:4800000,9500000\n]\n}1\n";
        let tmp = std::env::temp_dir().join(format!("dabir-synctex-{}.synctex", std::process::id()));
        fs::write(&tmp, text).unwrap();
        let st = synctex::load(&tmp).unwrap();
        let f = st.forward(Path::new("main.tex"), 12).unwrap();
        assert_eq!(f.page, 1);
        assert!((f.y - 9000000.0 / 65536.0).abs() < 0.01);
        let inv = st.inverse(1, 73.0, 145.0).unwrap();
        assert_eq!(inv.line, 13);
        let _ = fs::remove_file(&tmp);
    }

    /// Regenerate a project's memory scaffold in place. Run with:
    ///   DABIR_SETUP_DIR=/path/to/paper cargo test setup_dir -- --ignored --nocapture
    #[test]
    #[ignore]
    fn setup_dir() {
        let dir = PathBuf::from(std::env::var("DABIR_SETUP_DIR").expect("DABIR_SETUP_DIR"));
        let main = find_main_tex(&dir);
        let written = memory::setup(&dir, main.as_deref()).unwrap();
        eprintln!("wrote: {:?}", written);
    }

    /// Full pipeline against a real agent CLI. Run with:
    ///   DABIR_LIVE_PROVIDER=grok cargo test live_agent -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_agent_run() {
        let provider = std::env::var("DABIR_LIVE_PROVIDER").unwrap_or_else(|_| "grok".into());
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/isgd-tci");
        let dir = std::env::temp_dir().join(format!("dabir-live-{}-{}", provider, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for f in ["main.tex", "refs.bib", "dabir.toml", "AGENTS.md", "CLAUDE.md", ".gitignore"] { let _ = fs::copy(src.join(f), dir.join(f)); }
        for d in ["code", "tables", "figures", ".dabir", ".dabir/memory"] { fs::create_dir_all(dir.join(d)).unwrap(); }
        for f in ["code/sweep.py", "tables/psnr-sweep.tex", "figures/psnr-vs-noise.pdf", ".dabir/PROJECT.md", ".dabir/provenance.json", ".dabir/memory/reviewer-2-injectivity-proof.md"] { let _ = fs::copy(src.join(f), dir.join(f)); }
        git::init(&dir).unwrap();
        git::commit(&dir, "seed", None).unwrap();
        let run_id = "live1".to_string();
        let wt = git::worktree_add(&dir, &run_id).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<agents::AgentEvent>();
        let started = std::time::Instant::now();
        agents::run_with(provider.clone(), "Open main.tex and change the abstract's phrase '1.8 dB margin' to '1.8 dB PSNR margin'. Do not touch anything else. Reply DONE when finished.".into(), wt.clone(), run_id.clone(), move |e| { let _ = tx.send(e); }).unwrap();
        let mut ok = None;
        let mut tools = 0;
        while let Ok(e) = rx.recv_timeout(std::time::Duration::from_secs(240)) {
            eprintln!("[{}] {} {:?} {}", e.kind, e.run_id, e.tool, e.text.chars().take(120).collect::<String>());
            if e.kind == "tool" { tools += 1; }
            if e.kind == "done" { ok = e.ok; break; }
        }
        eprintln!("finished in {:?}, tools={}", started.elapsed(), tools);
        assert_eq!(ok, Some(true), "agent did not finish successfully");
        let d = git::worktree_diff(&dir, &run_id).unwrap();
        eprintln!("changed: {:?}", d.changes.iter().map(|c| &c.path).collect::<Vec<_>>());
        assert!(d.changes.iter().any(|c| c.path == "main.tex"), "main.tex should have changed");
        assert!(d.patch.contains("PSNR margin"));
        let id = git::worktree_accept(&dir, &run_id, "live agent change", Some(vec![git::Pick { path: "main.tex".into(), hunks: None }])).unwrap();
        assert_eq!(id.len(), 7);
        assert!(fs::read_to_string(dir.join("main.tex")).unwrap().contains("1.8 dB PSNR margin"));
        assert!(!wt.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn imports_overleaf_zip() {
        let zip = std::env::var("DABIR_TEST_ZIP").unwrap_or_default();
        if zip.is_empty() { return; }
        let dest = std::env::temp_dir().join(format!("dabir-import-{}", std::process::id()));
        let out = import_overleaf_zip(zip, Some(dest.to_string_lossy().to_string())).unwrap();
        let p = open_project(out).unwrap();
        assert!(p.main_tex.is_some(), "main.tex should be detected");
        assert!(dest.join(".gitignore").exists());
        let _ = fs::remove_dir_all(dest);
    }
}
