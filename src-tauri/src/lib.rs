//! Dabir core: project discovery, file access, compile, and the native menu.
//!
//! Everything the front end knows about a project comes through these commands.
//! A Dabir project is just a folder; nothing here writes anything the user did
//! not ask for, except the build directory under `.dabir/build`.

mod agents;
mod export;
mod git;
mod lsp;
mod memory;
mod paper;
mod refs;
mod relay;
mod synctex;
mod templates;
mod terminal;
mod texlog;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
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
    /// True when the folder held more files than the tree shows (a home folder, not a paper).
    pub tree_truncated: bool,
    /// Where the code runs when `dabir.toml [remote]` names a host.
    pub remote: Option<memory::Remote>,
}

/// The most files the sidebar tree will list. A paper has hundreds; a home folder has hundreds of thousands.
const TREE_BUDGET: usize = 4000;

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".dabir",
];

fn classify(path: &Path) -> EntryKind {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
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

/// Lists a folder for the sidebar, depth-first, stopping once `budget` entries have been taken.
fn walk(dir: &Path, depth: usize, budget: &mut usize) -> Vec<Entry> {
    if depth > 6 || *budget == 0 {
        return vec![];
    }
    let Ok(read) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut entries: Vec<Entry> = Vec::new();
    for e in read.filter_map(|e| e.ok()) {
        if *budget == 0 {
            break;
        }
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        *budget -= 1;
        if path.is_dir() {
            entries.push(Entry {
                name,
                path: path.to_string_lossy().to_string(),
                kind: EntryKind::Dir,
                children: walk(&path, depth + 1, budget),
            });
        } else {
            entries.push(Entry {
                name,
                path: path.to_string_lossy().to_string(),
                kind: classify(&path),
                children: vec![],
            });
        }
    }
    entries.sort_by(|a, b| {
        let da = a.kind == EntryKind::Dir;
        let db = b.kind == EntryKind::Dir;
        db.cmp(&da)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

/// Find the root document: main.tex, a .tex file containing \documentclass, or main.typ.
/// The manuscript: main.tex or main.typ, else a .tex with \documentclass, in the folder or one level down.
fn find_main_tex(root: &Path) -> Option<PathBuf> {
    fn in_dir(dir: &Path) -> Option<PathBuf> {
        let preferred = dir.join("main.tex");
        if preferred.exists() {
            return Some(preferred);
        }
        let typ = dir.join("main.typ");
        if typ.exists() {
            return Some(typ);
        }
        let read = fs::read_dir(dir).ok()?;
        let mut tex: Vec<PathBuf> = read
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|e| e == "tex").unwrap_or(false))
            .collect();
        tex.sort();
        tex.into_iter().find(|p| {
            fs::read_to_string(p)
                .map(|s| s.contains("\\documentclass"))
                .unwrap_or(false)
        })
    }
    if let Some(p) = in_dir(root) {
        return Some(p);
    }
    let read = fs::read_dir(root).ok()?;
    let mut dirs: Vec<PathBuf> = read
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str())
        })
        .collect();
    dirs.sort();
    dirs.iter().take(200).find_map(|d| in_dir(d))
}

// ---------------------------------------------------------------- live session mirrors
//
// A joiner gets the host's whole working tree, not just the open file, so figures, tables and the
// .bib match. The snapshot travels inside the shared document (text as text, assets as base64
// chunks), so it works over every transport and needs no extra channel.

#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct SnapFile {
    pub path: String,           // relative, forward slashes
    pub text: Option<String>,   // editable text files
    pub base64: Option<String>, // everything else
    pub size: u64,
}

const SNAP_TEXT_EXT: &[&str] = &[
    "tex",
    "sty",
    "cls",
    "bib",
    "bst",
    "md",
    "txt",
    "toml",
    "yaml",
    "yml",
    "json",
    "csv",
    "py",
    "jl",
    "r",
    "typ",
    "cfg",
    "def",
    "gitignore",
];
const SNAP_MAX_FILE: u64 = 12 * 1024 * 1024;
const SNAP_MAX_TOTAL: u64 = 80 * 1024 * 1024;

fn snapshot_walk(
    root: &Path,
    dir: &Path,
    out: &mut Vec<SnapFile>,
    total: &mut u64,
    skipped: &mut Vec<String>,
) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        const SNAP_SKIP: &[&str] = &[
            ".git",
            "node_modules",
            "target",
            "__pycache__",
            ".venv",
            "venv",
            "dist",
            "build",
            "worktrees",
            "index",
        ];
        if SNAP_SKIP.contains(&name.as_str()) {
            continue;
        }
        if path.is_dir() {
            snapshot_walk(root, &path, out, total, skipped);
            continue;
        }
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if meta.len() > SNAP_MAX_FILE || *total + meta.len() > SNAP_MAX_TOTAL {
            skipped.push(rel);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| x.to_ascii_lowercase())
            .unwrap_or_default();
        let is_text =
            SNAP_TEXT_EXT.contains(&ext.as_str()) || name.starts_with('.') && ext.is_empty();
        let Ok(bytes) = fs::read(&path) else { continue };
        *total += meta.len();
        if is_text {
            match String::from_utf8(bytes) {
                Ok(t) => out.push(SnapFile {
                    path: rel,
                    text: Some(t),
                    base64: None,
                    size: meta.len(),
                }),
                Err(e) => out.push(SnapFile {
                    path: rel,
                    text: None,
                    base64: Some(base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        e.into_bytes(),
                    )),
                    size: meta.len(),
                }),
            }
        } else {
            out.push(SnapFile {
                path: rel,
                text: None,
                base64: Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    bytes,
                )),
                size: meta.len(),
            });
        }
    }
}

#[derive(Serialize)]
pub struct Snapshot {
    pub files: Vec<SnapFile>,
    pub skipped: Vec<String>,
    pub total: u64,
}

/// Every file of the project small enough to travel, with the paths a joiner needs to rebuild it.
#[tauri::command]
fn project_snapshot(root: String) -> Result<Snapshot, String> {
    let root = PathBuf::from(&root);
    let mut files = vec![];
    let mut skipped = vec![];
    let mut total = 0;
    snapshot_walk(&root, &root, &mut files, &mut total, &mut skipped);
    Ok(Snapshot {
        files,
        skipped,
        total,
    })
}

fn sessions_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("No home directory")?;
    Ok(home.join("Dabir Sessions"))
}

/// Write a snapshot into ~/Dabir Sessions/<name> and return that folder. Existing files are overwritten;
/// files the host no longer has are left alone (they may be the joiner's own).
#[tauri::command]
fn session_materialize(name: String, files: Vec<SnapFile>) -> Result<String, String> {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let root = sessions_dir()?.join(safe.trim());
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for f in files {
        if f.path.contains("..") {
            continue;
        }
        let dest = root.join(&f.path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if let Some(t) = f.text {
            fs::write(&dest, t).map_err(|e| e.to_string())?;
        } else if let Some(b) = f.base64 {
            let bytes =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b.as_bytes())
                    .map_err(|e| e.to_string())?;
            fs::write(&dest, bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(root.to_string_lossy().to_string())
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
    let mut budget = TREE_BUDGET;
    let tree = walk(&root, 0, &mut budget);
    Ok(Project {
        root: root.to_string_lossy().to_string(),
        name,
        main_tex: find_main_tex(&root).map(|p| p.to_string_lossy().to_string()),
        has_git: git2::Repository::discover(&root).is_ok(),
        has_memory: root.join(".dabir").join("PROJECT.md").exists(),
        tree,
        tree_truncated: budget == 0,
        remote: memory::remote(&root),
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
    let file = fs::File::open(&zip_path)
        .map_err(|e| format!("Could not open {}: {}", zip_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a zip file: {}", e))?;
    let stem = zip_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or("overleaf-project".into());
    let target = match dest {
        Some(d) => PathBuf::from(d),
        None => zip_path.parent().unwrap_or(Path::new(".")).join(&stem),
    };
    if target.exists()
        && fs::read_dir(&target)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Err(format!(
            "{} already exists and is not empty",
            target.display()
        ));
    }
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
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
    // Overleaf zips have no .gitignore; give the project the Dabir defaults.
    let gi = target.join(".gitignore");
    if !gi.exists() {
        let _ = fs::write(
            &gi,
            ".dabir/build/\n.dabir/index/\n*.aux\n*.log\n*.bbl\n*.blg\n*.out\n*.synctex.gz\n",
        );
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
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    for c in [
        "/opt/homebrew/bin/tectonic",
        "/usr/local/bin/tectonic",
        "/usr/bin/tectonic",
    ] {
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
    if let Ok(p) = std::env::var("DABIR_TYPST") {
        return Some(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in ["typst", "typst.exe"] {
                let p = dir.join(n);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    for c in [
        "/opt/homebrew/bin/typst",
        "/usr/local/bin/typst",
        "/usr/bin/typst",
    ] {
        if Path::new(c).exists() {
            return Some(PathBuf::from(c));
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join("typst"))
            .find(|p| p.is_file())
    })
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
        let (sev, msg) = if let Some(m) = l.strip_prefix("error: ") {
            ("error", m)
        } else if let Some(m) = l.strip_prefix("warning: ") {
            ("warning", m)
        } else {
            i += 1;
            continue;
        };
        let mut file = None;
        let mut line = None;
        let mut j = i + 1;
        while j < lines.len() && j < i + 6 {
            let t = lines[j].trim();
            if let Some(rest) = t.strip_prefix("┌─ ") {
                let mut parts = rest.rsplitn(3, ':');
                let _col = parts.next();
                let ln = parts.next();
                let f = parts.next();
                line = ln.and_then(|n| n.parse().ok());
                file = f.map(|f| f.to_string());
                break;
            }
            j += 1;
        }
        let end = (j + 4).min(lines.len());
        out.push(Diagnostic {
            severity: sev.into(),
            category: "syntax".into(),
            file,
            line,
            message: msg.trim().to_string(),
            context: Some(lines[i..end].join("\n")),
        });
        i = end.max(i + 1);
    }
    out
}

fn compile_typst(
    app: &AppHandle,
    main: &Path,
    root: &Path,
    outdir: &Path,
) -> Result<CompileResult, String> {
    let Some(typst) = find_typst() else {
        return Ok(CompileResult { ok: false, pdf: None, log: String::new(), engine: "none".into(), millis: 0, diagnostics: vec![Diagnostic { severity: "error".into(), category: "other".into(), file: None, line: None, message: "Typst is not installed. Install it with `brew install typst`, or set DABIR_TYPST to its path.".into(), context: None }] });
    };
    let stem = main
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or("main".into());
    let pdf = outdir.join(format!("{}.pdf", stem));
    let started = std::time::Instant::now();
    let _ = app.emit("compile-progress", "typst compile".to_string());
    let out = Command::new(&typst)
        .current_dir(root)
        .args(["compile", "--root"])
        .arg(root)
        .arg(main)
        .arg(&pdf)
        .output()
        .map_err(|e| format!("Could not start Typst: {}", e))?;
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let ok = out.status.success() && pdf.exists();
    Ok(CompileResult {
        ok,
        pdf: if pdf.exists() {
            Some(pdf.to_string_lossy().to_string())
        } else {
            None
        },
        diagnostics: parse_typst_log(&log),
        log,
        engine: format!("typst ({})", typst.display()),
        millis: started.elapsed().as_millis(),
    })
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
        if message.is_empty()
            || message.starts_with("see the LaTeX manual")
            || message.starts_with("Type  H <return>")
        {
            continue;
        }
        out.push(Diagnostic {
            severity: severity.into(),
            category: "other".into(),
            file,
            line: lineno,
            message,
            context: None,
        });
    }
    out
}

static COMPILE_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

#[tauri::command]
fn compile_cancel() -> bool {
    let pid = COMPILE_PID.lock().unwrap().take();
    match pid {
        Some(pid) => {
            let _ = Command::new("kill").arg(pid.to_string()).output();
            true
        }
        None => false,
    }
}

#[tauri::command]
fn compile(app: AppHandle, main_tex: String) -> Result<CompileResult, String> {
    let main = PathBuf::from(&main_tex);
    let root = main
        .parent()
        .ok_or("The main .tex file has no parent folder")?;
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
        .args([
            "-X",
            "compile",
            "--keep-logs",
            "--keep-intermediates",
            "--synctex",
            "--outdir",
        ])
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
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                let msg = line.trim_start_matches("note: ").to_string();
                if !msg.is_empty() && !msg.starts_with("\"version 2\"") {
                    let _ = app2.emit("compile-progress", msg);
                }
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    });
    let out_text = {
        use std::io::Read;
        let mut s = String::new();
        if let Some(mut o) = stdout {
            let _ = o.read_to_string(&mut s);
        }
        s
    };
    let status = child.wait().map_err(|e| e.to_string())?;
    let err_text = err_thread.join().unwrap_or_default();
    let output = (status, out_text, err_text);
    let cancelled = COMPILE_PID.lock().unwrap().take().is_none();
    let millis = started.elapsed().as_millis();
    if cancelled {
        return Ok(CompileResult {
            ok: false,
            pdf: None,
            log: "Compile cancelled.".into(),
            diagnostics: vec![],
            engine: "tectonic".into(),
            millis,
        });
    }
    let log = format!("{}{}", output.1, output.2);
    let stem = main
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or("main".into());
    let pdf = outdir.join(format!("{}.pdf", stem));
    let ok = output.0.success() && pdf.exists();
    let main_name = main
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or("main.tex".into());
    let mut diagnostics = parse_log(&log);
    if let Ok(texlog_text) = fs::read_to_string(outdir.join(format!("{}.log", stem))) {
        for d in texlog::parse(&texlog_text, &main_name) {
            // Prefer the .log entry: it carries the excerpt. Drop the stderr twin.
            diagnostics.retain(|e| {
                !(e.line == d.line
                    && e.severity == d.severity
                    && d.message
                        .starts_with(e.message.split(':').next().unwrap_or(""))
                    && e.context.is_none()
                    && e.line.is_some())
            });
            if !diagnostics
                .iter()
                .any(|e| e.line == d.line && e.message == d.message)
            {
                diagnostics.push(d);
            }
        }
    }
    // Errors first, then warnings, then info; stable within a group.
    diagnostics.sort_by_key(|d| match d.severity.as_str() {
        "error" => 0,
        "warning" => 1,
        _ => 2,
    });
    Ok(CompileResult {
        ok,
        pdf: if pdf.exists() {
            Some(pdf.to_string_lossy().to_string())
        } else {
            None
        },
        diagnostics,
        log,
        engine: format!("tectonic ({})", tectonic.display()),
        millis,
    })
}

// ---------------------------------------------------------------- new paper and references

fn templates_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("templates", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|p| p.is_dir())
        .or_else(|| {
            let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../templates");
            if dev.is_dir() {
                Some(dev)
            } else {
                None
            }
        })
}

/// Fetched kits live here, keyed by id and version, so a paper can be started offline afterwards.
fn templates_cache(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("templates");
    let _ = fs::create_dir_all(&dir);
    dir
}

// ---------------------------------------------------------------- export

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportTools {
    pandoc: Option<String>,
}

#[tauri::command]
fn export_tools() -> ExportTools {
    ExportTools {
        pandoc: export::pandoc_version(),
    }
}

/// `kind`: pdf · arxiv · source · docx · html · md. `dest` is the file the user chose.
#[tauri::command]
fn export_paper(
    root: String,
    main: String,
    dest: String,
    kind: String,
) -> Result<export::Report, String> {
    let root = PathBuf::from(&root);
    let main = PathBuf::from(&main);
    let dest = PathBuf::from(&dest);
    match kind.as_str() {
        "pdf" => export::pdf(&main, &dest),
        "arxiv" => export::arxiv_zip(&root, &main, &dest),
        "source" => export::source_zip(&root, &dest),
        "docx" | "html" | "md" => export::via_pandoc(&root, &main, &dest, &kind),
        _ => Err(format!("Unknown export {}", kind)),
    }
}

#[tauri::command]
fn templates_list(app: AppHandle) -> Result<templates::Listing, String> {
    let dir = templates_dir(&app).ok_or("Templates are missing from this build")?;
    templates::list(&dir, &templates_cache(&app))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TemplateProgress {
    template: String,
    message: String,
}

/// Create a paper from a template: copy the kit (fetching an official one on first use),
/// initialise Git, and draft the memory scaffold. Progress goes out as `template-progress`.
#[tauri::command]
fn new_paper(
    app: AppHandle,
    parent: String,
    name: String,
    template: String,
) -> Result<String, String> {
    let dir = templates_dir(&app).ok_or("Templates are missing from this build")?;
    let safe = name.trim().replace(
        |c: char| !(c.is_alphanumeric() || c == '-' || c == '_'),
        "-",
    );
    if safe.is_empty() {
        return Err("Give the paper a folder name".into());
    }
    let dest = PathBuf::from(&parent).join(&safe);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let progress = |message: &str| {
        let _ = app.emit(
            "template-progress",
            TemplateProgress {
                template: template.clone(),
                message: message.to_string(),
            },
        );
    };
    if let Err(e) =
        templates::instantiate(&dir, &templates_cache(&app), &template, &dest, &progress)
    {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    for d in ["figures", "code", "tables"] {
        let _ = fs::create_dir_all(dest.join(d));
    }
    let gi = dest.join(".gitignore");
    if !gi.exists() {
        let _ = fs::write(
            &gi,
            ".dabir/build/\n.dabir/index/\n.dabir/worktrees/\n*.aux\n*.log\n*.bbl\n*.blg\n*.out\n*.synctex.gz\n",
        );
    }
    progress("Initialising Git and the memory scaffold…");
    git::init(&dest)?;
    let main = find_main_tex(&dest);
    memory::setup(&dest, main.as_deref())?;
    git::commit(&dest, "New paper from Dabir template", None)?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn bib_import_file(root: String, path: String) -> Result<String, String> {
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let r = refs::merge_into(Path::new(&root), &text)?;
    Ok(format!(
        "Added {} new entr{} to {}{}.",
        r.added,
        if r.added == 1 { "y" } else { "ies" },
        r.file,
        if r.updated > 0 {
            format!(", updated {}", r.updated)
        } else {
            String::new()
        }
    ))
}

/// Is Zotero running here, does it have Better BibTeX, and which collections are there.
#[tauri::command]
fn zotero_status() -> refs::ZoteroStatus {
    refs::zotero_status(refs::ZOTERO)
}

/// Pull a collection (or the whole library) from Zotero and merge it into the paper's .bib.
#[tauri::command]
fn zotero_sync(
    root: String,
    collection: Option<String>,
    better_bibtex: bool,
) -> Result<refs::SyncReport, String> {
    let text = refs::zotero_fetch(refs::ZOTERO, collection.as_deref(), better_bibtex)?;
    if refs::parse_entries(&text).is_empty() {
        return Err(if collection.is_some() {
            "That collection has no items Zotero can write as BibTeX.".into()
        } else {
            "Zotero answered but sent no BibTeX entries.".into()
        });
    }
    refs::merge_into(Path::new(&root), &text)
}

/// One-shot import of the whole library, kept for the Share sheet.
#[tauri::command]
fn zotero_import(root: String) -> Result<String, String> {
    let r = zotero_sync(root, None, false)?;
    Ok(format!(
        "Imported {} new entr{} from Zotero into {}.",
        r.added,
        if r.added == 1 { "y" } else { "ies" },
        r.file
    ))
}

/// Add one reference by DOI or arXiv id.
#[tauri::command]
fn refs_add(root: String, id: String) -> Result<refs::SyncReport, String> {
    let text = refs::fetch_reference(&id)?;
    refs::merge_into(Path::new(&root), &text)
}

/// Merge a linked .bib another manager maintains, when it changed since `since` (ms).
#[tauri::command]
fn refs_linked_sync(root: String, path: String, since: u64) -> Result<refs::LinkedSync, String> {
    refs::linked_sync(Path::new(&root), Path::new(&path), since)
}

// ---------------------------------------------------------------- synctex

#[tauri::command]
fn synctex_forward(
    main_tex: String,
    file: String,
    line: u32,
) -> Result<Option<synctex::PdfPos>, String> {
    let st = synctex::load(&synctex::synctex_path(Path::new(&main_tex)))?;
    Ok(st.forward(Path::new(&file), line))
}

#[tauri::command]
fn synctex_inverse(
    main_tex: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<Option<synctex::SrcPos>, String> {
    let st = synctex::load(&synctex::synctex_path(Path::new(&main_tex)))?;
    Ok(st.inverse(page, x, y))
}

// ---------------------------------------------------------------- git

#[tauri::command]
fn git_status(root: String) -> Result<git::GitStatus, String> {
    git::status(Path::new(&root))
}

#[tauri::command]
fn git_init(root: String) -> Result<(), String> {
    git::init(Path::new(&root))
}

#[tauri::command]
fn git_commit(root: String, message: String, paths: Option<Vec<String>>) -> Result<String, String> {
    git::commit(Path::new(&root), &message, paths)
}

#[tauri::command]
fn git_clone(url: String, dest: String) -> Result<String, String> {
    git::clone(&url, Path::new(&dest))
}

// ---------------------------------------------------------------- remotes and live relay

#[tauri::command]
fn git_remote_add(root: String, name: String, url: String) -> Result<(), String> {
    git::remote_add(Path::new(&root), &name, &url)
}
#[tauri::command]
fn git_remote_url(root: String, name: String) -> Option<String> {
    git::remote_url(Path::new(&root), &name)
}
#[tauri::command]
fn git_pull(root: String, remote: String) -> Result<String, String> {
    git::pull(Path::new(&root), &remote)
}
#[tauri::command]
fn git_push(root: String, remote: String) -> Result<String, String> {
    git::push(Path::new(&root), &remote)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayInfo {
    url: String,
    lan_url: String,
    pid: u32,
}

fn lan_ip() -> Option<String> {
    // Connect a UDP socket to a public address; no packet is sent, but the OS picks the outbound interface.
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("1.1.1.1:80").ok()?;
    s.local_addr()
        .ok()
        .map(|a| a.ip().to_string())
        .filter(|ip| ip != "0.0.0.0")
}

/// Start the built-in relay on this machine. Returns the local and LAN addresses.
#[tauri::command]
fn relay_start(port: u16) -> Result<RelayInfo, String> {
    relay::start(port)?;
    Ok(RelayInfo {
        url: format!("ws://127.0.0.1:{}", port),
        lan_url: format!("ws://{}:{}", lan_ip().unwrap_or("127.0.0.1".into()), port),
        pid: std::process::id(),
    })
}

#[tauri::command]
fn relay_stop() -> bool {
    relay::stop()
}

// ---------------------------------------------------------------- agents

#[tauri::command]
fn agent_providers() -> Vec<agents::Provider> {
    agents::detect()
}

/// Models and effort levels one provider's CLI accepts (asks the CLI where it can list them).
#[tauri::command]
async fn agent_models(provider: String) -> agents::ModelOptions {
    tauri::async_runtime::spawn_blocking(move || agents::models(&provider))
        .await
        .unwrap_or_else(|_| agents::models(""))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStarted {
    run_id: String,
    worktree: String,
}

/// A request that continues an unreviewed run in its own worktree, so the agent builds on what it did.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FollowUp {
    run_id: String,
    prompt: String,
    reply: String,
}

// ---- terminal pane: a shell in the paper's folder

#[tauri::command]
fn term_open(
    app: AppHandle,
    terms: tauri::State<terminal::Shared>,
    cwd: String,
    cols: u16,
    rows: u16,
    remote: Option<memory::Remote>,
) -> Result<u32, String> {
    terminal::open(&app, &terms, Path::new(&cwd), cols, rows, remote.as_ref())
}

#[tauri::command]
fn term_write(terms: tauri::State<terminal::Shared>, id: u32, data: String) -> Result<(), String> {
    terminal::write(&terms, id, &data)
}

#[tauri::command]
fn term_resize(
    terms: tauri::State<terminal::Shared>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminal::resize(&terms, id, cols, rows)
}

#[tauri::command]
fn term_close(terms: tauri::State<terminal::Shared>, id: u32) {
    terminal::close(&terms, id)
}

// ---- find in paper

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub file: String,
    pub line: usize,
    /// Column of the match in characters, for highlighting.
    pub col: usize,
    pub len: usize,
    /// The line, or a window of it around the match when the line is long.
    pub text: String,
    /// True when `text` starts after the line's beginning.
    pub cut: bool,
}

const SEARCH_EXTS: &[&str] = &[
    "tex", "sty", "cls", "bib", "typ", "md", "txt", "rst", "py", "jl", "r", "m", "sh", "bash",
    "zsh", "yml", "yaml", "json", "toml", "csv", "tsv", "js", "ts", "rs", "cfg", "ini",
];
const SEARCH_CAP: usize = 400;
const SEARCH_FILE_CAP: u64 = 4 << 20;

/// Every text file of the paper that contains `query`, as a line list. Case-insensitive unless the
/// query has an upper-case letter (smart case); files the sidebar skips are skipped here too.
fn search_files(root: &Path, query: &str) -> Vec<SearchHit> {
    let query = query.trim();
    if query.is_empty() {
        return vec![];
    }
    let smart = query.chars().any(|c| c.is_uppercase());
    let needle = if smart {
        query.to_string()
    } else {
        query.to_lowercase()
    };
    let mut hits = Vec::new();
    let mut files = Vec::new();
    collect_text_files(root, 0, &mut files);
    files.sort();
    for path in files {
        if hits.len() >= SEARCH_CAP {
            break;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        for (i, line) in text.lines().enumerate() {
            let hay = if smart {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if let Some(b) = hay.find(&needle) {
                let col = hay[..b].chars().count();
                let start = if col > 80 { col - 40 } else { 0 };
                hits.push(SearchHit {
                    file: rel.clone(),
                    line: i + 1,
                    col: col - start,
                    len: needle.chars().count(),
                    text: line.trim_end().chars().skip(start).take(300).collect(),
                    cut: start > 0,
                });
                if hits.len() >= SEARCH_CAP {
                    break;
                }
            }
        }
    }
    hits
}

fn collect_text_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 || out.len() > TREE_BUDGET {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for e in read.filter_map(|e| e.ok()) {
        let path = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if path.is_dir() {
            collect_text_files(&path, depth + 1, out);
        } else {
            let ext = path
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.to_ascii_lowercase())
                .unwrap_or_default();
            let small = e
                .metadata()
                .map(|m| m.len() <= SEARCH_FILE_CAP)
                .unwrap_or(false);
            if SEARCH_EXTS.contains(&ext.as_str()) && small {
                out.push(path);
            }
        }
    }
}

#[tauri::command]
fn search_paper(root: String, query: String) -> Vec<SearchHit> {
    search_files(Path::new(&root), &query)
}

// ---- language servers for code files

#[tauri::command]
fn lsp_available(candidates: Vec<String>) -> Vec<String> {
    lsp::available(&candidates)
}

#[tauri::command]
fn lsp_start(
    app: AppHandle,
    servers: tauri::State<lsp::Shared>,
    root: String,
    command: String,
    args: Vec<String>,
) -> Result<u32, String> {
    lsp::start(&app, &servers, Path::new(&root), &command, &args)
}

#[tauri::command]
fn lsp_send(servers: tauri::State<lsp::Shared>, id: u32, message: String) -> Result<(), String> {
    lsp::send(&servers, id, &message)
}

#[tauri::command]
fn lsp_stop(servers: tauri::State<lsp::Shared>, id: u32) {
    lsp::stop(&servers, id)
}

/// The paper's structure for the editor: sections, labels, floats, macros and bibliographies with
/// their file and line, following \input from the main file.
#[tauri::command]
fn paper_map(root: String) -> Result<paper::PaperMap, String> {
    let root = PathBuf::from(&root);
    let main = find_main_tex(&root).ok_or("no main file")?;
    Ok(paper::build(&root, &main))
}

/// Start an agent run on a fresh worktree. Events stream on the `agent-event` channel.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn agent_run(
    app: AppHandle,
    root: String,
    provider: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    follow_up: Option<FollowUp>,
    focus: Option<Focus>,
) -> Result<RunStarted, String> {
    let root_p = PathBuf::from(&root);
    // A follow-up keeps the worktree of the run under review: its changes stay in place and the next
    // request builds on them, instead of a fresh worktree that silently drops them.
    let cont = follow_up.and_then(|f| git::worktree_cwd(&root_p, &f.run_id).map(|cwd| (f, cwd)));
    let (run_id, wt, full) = match cont {
        Some((f, cwd)) => {
            // Edits the author saved since the run started come along, so the agent sees the paper as it is now.
            let carried = git::sync_working_copy(&root_p, &f.run_id).unwrap_or_default();
            let (_, prefix) = git::repo_prefix(&root_p).unwrap_or_default();
            let carried: Vec<String> = carried
                .iter()
                .map(|p| {
                    p.strip_prefix(&prefix)
                        .unwrap_or(p)
                        .trim_start_matches('/')
                        .to_string()
                })
                .collect();
            let ask = format!(
                "This request continues your previous one in this same working copy. Earlier request: {}\nYour report then: {}\nThe files still hold the changes you made; the author has not accepted them yet and now asks for the following on top of them. Do not undo your earlier work unless asked.{}\n\n{}",
                f.prompt.trim(),
                if f.reply.trim().is_empty() { "(none)" } else { f.reply.trim() },
                if carried.is_empty() { String::new() } else { format!("\nSince then the author edited {} by hand; those edits are already in the files.", carried.join(", ")) },
                prompt
            );
            let full = agent_preamble(&root_p, &cwd, &ask, &prompt, focus.as_ref());
            (f.run_id, cwd, full)
        }
        None => {
            let run_id = uuid::Uuid::new_v4().to_string()[..8].to_string();
            let wt = git::worktree_add(&root_p, &run_id)?;
            let full = agent_preamble(&root_p, &wt, &prompt, &prompt, focus.as_ref());
            (run_id, wt, full)
        }
    };
    let steer = agents::Steer { model, effort };
    if let Err(e) = agents::run(app, provider, full, wt.clone(), run_id.clone(), steer) {
        let _ = git::worktree_remove(&root_p, &run_id);
        return Err(e);
    }
    Ok(RunStarted {
        run_id,
        worktree: wt.to_string_lossy().to_string(),
    })
}

/// One sentence from the agent to continue the prose at the cursor. Runs on a throwaway
/// worktree like every other run, so a model that ignores "do not edit" cannot touch the
/// checkout; only its reply comes back. Waits at most a minute.
#[tauri::command]
async fn agent_complete(
    root: String,
    provider: String,
    file: String,
    context: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_p = PathBuf::from(&root);
        let run_id = format!("c{}", &uuid::Uuid::new_v4().to_string()[..7]);
        let wt = git::worktree_add(&root_p, &run_id)?;
        let ask = format!(
            "You are completing the author's sentence in this paper. Below is the end of `{file}` up to the cursor. \
Reply with only the text that should come next: finish the current sentence if it is unfinished, otherwise write the one sentence that follows. \
Match the voice, tense and markup conventions already in use. No quotation marks, no commentary, no headings, and do not edit or create any file.\n\n<<<\n{context}\n>>>"
        );
        let full = agent_preamble(&root_p, &wt, &ask, &ask, None);
        let (tx, rx) = std::sync::mpsc::channel::<agents::AgentEvent>();
        let steer = agents::Steer { model, effort };
        let result = (|| {
            agents::run_with(provider, full, wt.clone(), run_id.clone(), steer, move |e| {
                let _ = tx.send(e);
            })?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            let mut text = String::new();
            loop {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(left) {
                    Ok(e) if e.kind == "text" => {
                        text.push_str(&e.text);
                        text.push('\n');
                    }
                    Ok(e) if e.kind == "error" => return Err(e.text),
                    Ok(e) if e.kind == "done" => {
                        if e.ok == Some(false) && text.trim().is_empty() {
                            return Err(if e.text.is_empty() { "The agent gave no reply.".into() } else { e.text });
                        }
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        agents::cancel(&run_id);
                        return Err("The agent took longer than a minute; try again.".into());
                    }
                }
            }
            Ok(clean_continuation(&text))
        })();
        let _ = git::worktree_remove(&root_p, &run_id);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The reply as text to insert: first paragraph only, quotes and fences stripped, no trailing chatter.
fn clean_continuation(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    if t.starts_with("```") {
        t = t
            .trim_start_matches("```")
            .lines()
            .skip(1)
            .take_while(|l| !l.starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n");
    }
    let first = t.split("\n\n").next().unwrap_or("").trim();
    let first = first
        .trim_start_matches(['"', '\u{201c}', '\u{2018}', '\u{2026}', '.', ' '])
        .trim_end_matches(['"', '\u{201d}', '\u{2019}']);
    first.trim().to_string()
}

/// Where the author is in the editor when they ask: the open file, the cursor line and any selection.
/// "This paragraph", "here" and "the sentence above" resolve against it.
#[derive(serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Focus {
    /// Path relative to the paper's root.
    pub file: String,
    /// 1-based line of the cursor (or the selection's first line).
    pub line: usize,
    /// Last line of the selection, when there is one.
    #[serde(default)]
    pub end_line: Option<usize>,
    /// The selected text, if any, cut to a few hundred characters by the caller.
    #[serde(default)]
    pub selection: Option<String>,
}

impl Focus {
    fn describe(&self, map: &paper::PaperMap) -> String {
        // The deepest heading at or above the cursor in the same file.
        let section = map
            .headings
            .iter()
            .rev()
            .find(|h| h.file == self.file && h.line <= self.line)
            .map(|h| format!(", in the section “{}” ({}:{})", h.title, h.file, h.line))
            .unwrap_or_default();
        let range = match self.end_line {
            Some(e) if e > self.line => format!("lines {}-{}", self.line, e),
            _ => format!("line {}", self.line),
        };
        let mut s = format!("The editor is open at {} {}{}.", self.file, range, section);
        match &self.selection {
            Some(sel) if !sel.trim().is_empty() => {
                let cut: String = sel.chars().take(600).collect();
                s.push_str(&format!(
                    " The author has this text selected; a request that says this, here or the selection means it:\n<<<\n{}{}\n>>>",
                    cut,
                    if sel.chars().count() > 600 { "…" } else { "" }
                ));
            }
            _ => s.push_str(
                " A request that says this, here or this paragraph refers to that place.",
            ),
        }
        s
    }
}

/// The minimal context every run starts with: who the paper is, where to read more,
/// the environment prefix, and the passages most likely relevant to this request.
/// The brief an agent gets before the request. It carries everything a first turn would otherwise
/// spend tool calls on: where the paper is and where it ends, the project file, the file map, the
/// likely relevant lines, and what is on PATH. `cwd` is the paper's folder inside the run's worktree.
/// `query` is the text retrieval ranks against: the author's new words alone, so a follow-up's
/// boilerplate about the previous run does not drown them.
fn agent_preamble(
    root: &Path,
    cwd: &Path,
    prompt: &str,
    query: &str,
    focus: Option<&Focus>,
) -> String {
    let main_path = find_main_tex(root);
    let map = main_path
        .as_ref()
        .map(|m| paper::build(root, m))
        .unwrap_or_default();
    let map_text = paper::render(&map, 5000);
    let main = main_path
        .and_then(|p| {
            p.strip_prefix(root)
                .ok()
                .map(|r| r.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "main.tex".into());
    let is_typst = main.ends_with(".typ");
    let brief = fs::read_to_string(root.join(".dabir").join("PROJECT.md")).ok();
    let mem = memory::read(root).ok();
    let prefix = mem.as_ref().and_then(|m| m.env_prefix.clone());
    let skills = mem
        .as_ref()
        .map(|m| {
            m.skills
                .iter()
                .map(|s| s.name.trim_start_matches("dabir-").to_string())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let artefact_cmds: std::collections::HashMap<String, String> = mem
        .as_ref()
        .map(|m| {
            m.provenance
                .iter()
                .map(|a| {
                    (
                        a.artefact.trim_start_matches("./").to_string(),
                        a.command.clone(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let manuscript: Vec<String> = map.files.iter().map(|(f, _)| f.clone()).collect();
    let bibs: Vec<String> = map.bibs.iter().map(|(f, _)| f.clone()).collect();
    let files = memory::file_map_by_role(
        root,
        80,
        Some(main.as_str()),
        &manuscript,
        &bibs,
        &artefact_cmds,
    );
    // The author's own words, plus the selection if any: the ranking sees what they mean, not the
    // preamble of a follow-up. The paper map already routes named sections and labels.
    let query = match focus.and_then(|f| f.selection.as_deref()) {
        Some(sel) => format!("{query}\n{sel}"),
        None => query.to_string(),
    };
    let pack = memory::context_pack(root, &query, 2200);
    // Durable decisions and the commands behind generated artefacts, one line each, so the agent
    // neither opens .dabir/memory nor guesses how a figure was made.
    let facts: Vec<String> = mem
        .as_ref()
        .map(|m| {
            m.facts
                .iter()
                .take(12)
                .map(|f| {
                    let d = f.description.trim();
                    let path = Path::new(&f.path)
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| f.path.clone());
                    if d.is_empty() {
                        format!("{} ({})", f.name, path)
                    } else {
                        format!("{}: {} ({})", f.name, d, path)
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let artefacts: Vec<String> = mem
        .as_ref()
        .map(|m| {
            m.provenance
                .iter()
                .take(10)
                .map(|a| format!("{} <- `{}`", a.artefact, a.command))
                .collect()
        })
        .unwrap_or_default();
    // What happened before this run: the last runs (request, outcome, the agent's own report) and the
    // paper's last steps, so "make it bigger" or "undo that" has a referent.
    let runs = memory::recent_runs(root, 3);
    let steps: Vec<String> = git::checkpoints(root, 6)
        .unwrap_or_default()
        .into_iter()
        .map(|c| {
            let files: Vec<String> = c
                .files
                .iter()
                .take(4)
                .map(|f| {
                    if f.binary {
                        f.path.clone()
                    } else {
                        format!("{} +{} -{}", f.path, f.add, f.del)
                    }
                })
                .collect();
            format!("{} ({})", c.message, files.join(", "))
        })
        .collect();

    let mut out = String::new();
    out.push_str(&format!(
        "You are a coauthor on a {} paper. You work in `{}`, a copy of the paper's folder in a Git worktree; your changes are reviewed hunk by hunk before they reach the author's checkout.\n",
        if is_typst { "Typst" } else { "LaTeX" },
        cwd.display()
    ));
    out.push_str("This folder is the whole task. Directories above it belong to other projects: do not read, search or edit anything outside it, and ignore instruction files (AGENTS.md, CLAUDE.md) found above it.\n\n");

    out.push_str("How to work\n");
    out.push_str("1. This message already holds the project brief, the paper map (every section, label, figure, table, equation and macro with its file and line), the file list and the likely relevant lines. Do not list directories, search the tree, run git, or open AGENTS.md, CLAUDE.md, .dabir/PROJECT.md, .dabir/memory or .dabir/skills to orient yourself; go straight to the file and line the map gives and read only the lines around it.\n");
    out.push_str("2. Decide on one reading of the request and carry it out in one pass. If the request is short or ambiguous, choose the most useful reading given the paper as it stands and do not stop to ask. Prefer cheap paths: recorded commands, existing artefacts, TikZ or pgfplots for a schematic. No new experiments or long runs unless asked.\n");
    out.push_str("3. Make the smallest change that does the job. Never hand-edit generated artefacts (figures, tables, numbers copied from them); rerun their recorded command instead.\n");
    if let Some(p) = &prefix {
        out.push_str(&format!("   Run code with the prefix `{p}`.\n"));
    }
    if let Some(r) = memory::remote(root) {
        out.push_str(&format!("   The code runs on the host `{h}` in `{d}`, not here: run every experiment or artefact command as `ssh {h} 'cd {d} && <command>'` and copy results back with `scp {h}:{d}/<path> <path>`. The repository there is a clone of this one; push or pull before running if the code changed.\n", h = r.host, d = r.dir));
    }
    if is_typst {
        out.push_str(&format!("4. If `typst` is on PATH, compile once at the end with `typst compile {main}` and fix what it reports. Do not install anything, inspect the PDF or explore the build folder: Dabir compiles and reviews the result.\n"));
    } else {
        out.push_str(&format!("4. Compile once at the end with `tectonic -X compile {main} --outdir .dabir/build` (tectonic is on PATH) and fix what it reports; skip this for wording-only changes. Do not install anything, inspect the PDF or explore the build folder: Dabir compiles and reviews the result.\n"));
    }
    out.push_str("5. Finish with two or three sentences: what you changed and, if the request was ambiguous, the reading you took.\n");
    if !skills.is_empty() {
        out.push_str(&format!("\nSkills for recurring jobs are in .dabir/skills/ ({skills}); open the matching SKILL.md only when the request names one of these jobs. Durable decisions go in .dabir/memory/ as one-fact files with `name` and `description` frontmatter.\n"));
    }
    // A request about the bibliography gets the online check spelled out, since the agent would
    // otherwise reason about entries it cannot see the truth of.
    let lower = prompt.to_lowercase();
    let about_refs = [
        "referenc",
        "citation",
        "cite",
        "bibliograph",
        ".bib",
        "bibtex",
        "doi",
    ]
    .iter()
    .any(|k| lower.contains(k));
    if about_refs
        && root
            .join(".dabir/skills/check-references/scripts/verify_refs.py")
            .is_file()
    {
        out.push_str("\nThis request concerns references. Read .dabir/skills/check-references/SKILL.md and run its script, `python3 .dabir/skills/check-references/scripts/verify_refs.py <every .bib the paper uses>`; it has network access and checks each entry against Crossref, doi.org, arXiv and OpenAlex, printing verified / mismatch / not found / unchecked with the fields that differ. Fix fields of verified entries from the record, keep citation keys, and report mismatches and not-found entries to the author instead of deleting or inventing anything.\n");
    }

    if let Some(b) = brief {
        out.push_str("\nProject brief (.dabir/PROJECT.md)\n");
        out.push_str(b.trim().chars().take(3500).collect::<String>().as_str());
        out.push('\n');
    } else {
        out.push_str(&format!("\nMain file: {main}\n"));
    }
    // DABIR_BENCH_BARE=1 leaves out the map, the author's position and the memory blocks, so the
    // bench can measure what they buy; the app never sets it.
    let bare = std::env::var("DABIR_BENCH_BARE").is_ok();
    if !bare && !map_text.trim().is_empty() {
        out.push_str("\nPaper map\n");
        out.push_str(&map_text);
    }
    if let Some(f) = focus.filter(|_| !bare) {
        out.push_str("\nWhere the author is\n");
        out.push_str(&f.describe(&map));
        out.push('\n');
    }
    if !bare && !facts.is_empty() {
        out.push_str("\nDecisions on record (.dabir/memory; already applied, do not reopen)\n");
        out.push_str(&facts.join("\n"));
        out.push('\n');
    }
    if !bare && !artefacts.is_empty() {
        out.push_str("\nGenerated artefacts and the command that makes each (to change one, change the code that writes it and rerun the command; edit the artefact itself only when the author asks, since the next run overwrites it)\n");
        out.push_str(&artefacts.join("\n"));
        out.push('\n');
    }
    if !files.is_empty() {
        out.push_str("\nFiles, by role (path, size)\n");
        out.push_str(&files.join("\n"));
        if files.iter().map(|g| g.lines().count() - 1).sum::<usize>() >= 80 {
            out.push_str("\n(more files not listed)");
        }
        out.push('\n');
    }
    if !pack.is_empty() {
        out.push_str("\nLikely relevant places (path:lines)\n");
        out.push_str(&pack);
        out.push('\n');
    }
    if !runs.is_empty() || !steps.is_empty() {
        out.push_str("\nWhat happened before this request (newest first)\n");
        if !runs.is_empty() {
            out.push_str("Previous agent runs (date · agent · request · files · accepted or rejected by the author · the agent's report). The request below may refer to these; a rejected run is one the author did not want.\n");
            for r in &runs {
                out.push_str("- ");
                out.push_str(r);
                out.push('\n');
            }
        }
        if !steps.is_empty() {
            out.push_str("Recent steps in the paper's history (\"You\" is the author):\n");
            for s in &steps {
                out.push_str("- ");
                out.push_str(s);
                out.push('\n');
            }
        }
    }
    out.push_str("\n---\nRequest\n");
    out.push_str(prompt);
    out
}

#[tauri::command]
fn context_pack(root: String, query: String) -> String {
    memory::context_pack(Path::new(&root), &query, 2200)
}

#[tauri::command]
fn agent_cancel(run_id: String) -> bool {
    agents::cancel(&run_id)
}

#[tauri::command]
fn agent_diff(root: String, run_id: String) -> Result<git::WorktreeDiff, String> {
    git::worktree_diff(Path::new(&root), &run_id)
}

#[tauri::command]
fn agent_accept(
    root: String,
    run_id: String,
    message: String,
    picks: Option<Vec<git::Pick>>,
    provider: Option<String>,
    prompt: Option<String>,
    reply: Option<String>,
) -> Result<String, String> {
    let root_p = Path::new(&root);
    let files: Vec<String> = match &picks {
        Some(ps) => ps.iter().map(|p| p.path.clone()).collect(),
        None => git::worktree_diff(root_p, &run_id)
            .map(|d| d.changes.iter().map(|c| c.path.clone()).collect())
            .unwrap_or_default(),
    };
    memory::log_run_with(
        root_p,
        provider.as_deref().unwrap_or("agent"),
        prompt.as_deref().unwrap_or(&message),
        &files,
        reply.as_deref(),
        "accepted and committed",
    );
    git::worktree_accept(root_p, &run_id, &message, picks)
}

#[tauri::command]
fn agent_reject(
    root: String,
    run_id: String,
    provider: Option<String>,
    prompt: Option<String>,
    reply: Option<String>,
) -> Result<(), String> {
    let root_p = Path::new(&root);
    if let Some(p) = prompt.as_deref().filter(|p| !p.is_empty()) {
        let files: Vec<String> = git::worktree_diff(root_p, &run_id)
            .map(|d| d.changes.iter().map(|c| c.path.clone()).collect())
            .unwrap_or_default();
        memory::log_run_with(
            root_p,
            provider.as_deref().unwrap_or("agent"),
            p,
            &files,
            reply.as_deref(),
            "rejected",
        );
    }
    git::worktree_remove(root_p, &run_id)
}

/// Accept without a commit: the changes land in the checkout (autosaved, snapshotted), the user commits when they like.
#[tauri::command]
fn agent_apply(
    root: String,
    run_id: String,
    picks: Option<Vec<git::Pick>>,
    prompt: Option<String>,
    provider: Option<String>,
    reply: Option<String>,
) -> Result<Vec<String>, String> {
    let root_p = PathBuf::from(&root);
    let applied = git::worktree_apply(&root_p, &run_id, picks)?;
    let label = prompt.as_deref().unwrap_or("agent change");
    memory::log_run_with(
        &root_p,
        provider.as_deref().unwrap_or("agent"),
        label,
        &applied,
        reply.as_deref(),
        "accepted",
    );
    let short: String = label.chars().take(72).collect();
    let who = match provider.as_deref() {
        Some("claude") => "Claude Code",
        Some("codex") => "Codex",
        Some("cursor") => "Cursor",
        Some("grok") => "Grok",
        Some(other) => other,
        None => "Agent",
    };
    let _ = git::checkpoint(&root_p, &format!("{}: {}", who, short));
    Ok(applied)
}

#[tauri::command]
fn checkpoint(
    root: String,
    message: String,
    coalesce: Option<bool>,
) -> Result<Option<String>, String> {
    git::checkpoint_with(Path::new(&root), &message, coalesce.unwrap_or(false))
}
#[tauri::command]
fn checkpoint_patch(root: String, id: String) -> Result<String, String> {
    git::checkpoint_patch(Path::new(&root), &id)
}
#[tauri::command]
fn checkpoint_undo(root: String, id: String) -> Result<(), String> {
    git::checkpoint_undo(Path::new(&root), &id)
}
#[tauri::command]
fn git_discard(root: String, path: String) -> Result<(), String> {
    git::discard(Path::new(&root), &path)
}
#[tauri::command]
fn checkpoints(root: String) -> Result<Vec<git::Checkpoint>, String> {
    git::checkpoints(Path::new(&root), 60)
}
#[tauri::command]
fn checkpoint_restore(root: String, id: String) -> Result<(), String> {
    git::checkpoint_restore(Path::new(&root), &id)
}

#[tauri::command]
fn agent_pull_request(root: String, run_id: String, message: String) -> Result<String, String> {
    git::worktree_pull_request(Path::new(&root), &run_id, &message)
}

// ---------------------------------------------------------------- memory

#[tauri::command]
fn memory_read(root: String) -> Result<memory::Memory, String> {
    memory::read(Path::new(&root))
}

#[tauri::command]
fn memory_setup(root: String, main_tex: Option<String>) -> Result<Vec<String>, String> {
    memory::setup(Path::new(&root), main_tex.as_deref().map(Path::new))
}

#[tauri::command]
fn provenance_rerun(root: String, artefact: String) -> Result<memory::RunOutput, String> {
    memory::rerun(Path::new(&root), &artefact)
}

// ---------------------------------------------------------------- menu

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let about = AboutMetadata {
        name: Some("Dabir".into()),
        comments: Some("A local-first workspace for scientific writing.".into()),
        ..Default::default()
    };
    let app_menu = SubmenuBuilder::new(app, "Dabir")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About Dabir"),
            Some(about),
        )?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
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
        .item(
            &MenuItemBuilder::with_id("new", "New Paper…")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open Paper…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("import-overleaf", "Import from Overleaf…").build(app)?)
        .item(
            &MenuItemBuilder::with_id("clone", "Clone from GitHub…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("share", "Share…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("export", "Export…")
                .accelerator(if cfg!(target_os = "macos") {
                    "Alt+Cmd+E"
                } else {
                    "CmdOrCtrl+Alt+E"
                })
                .build(app)?,
        )
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
        .item(
            &MenuItemBuilder::with_id("find", "Find…")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("find-paper", "Find in Paper…")
                .accelerator("CmdOrCtrl+Shift+F")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("check-grammar", "Check Grammar")
                .accelerator("CmdOrCtrl+Shift+G")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("unicode-tex", "Convert Unicode to LaTeX").build(app)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view-visual", "Visual")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view-source", "Source")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view-pdf", "PDF")
                .accelerator("CmdOrCtrl+3")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view-split", "Editor and PDF")
                .accelerator("CmdOrCtrl+4")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("zoom-fit", "Fit Width")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("toggle-sidebar", "Show/Hide Sidebar")
                .accelerator(if cfg!(target_os = "macos") {
                    "Ctrl+Cmd+S"
                } else {
                    "CmdOrCtrl+Shift+S"
                })
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("focus-mode", "Focus Mode")
                .accelerator("Alt+CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("toggle-inspector", "Show/Hide Inspector")
                .accelerator(if cfg!(target_os = "macos") {
                    "Alt+Cmd+I"
                } else {
                    "CmdOrCtrl+Shift+I"
                })
                .build(app)?,
        )
        .separator()
        .fullscreen()
        .build()?;

    let format = SubmenuBuilder::new(app, "Format")
        .item(
            &MenuItemBuilder::with_id("fmt-bold", "Bold")
                .accelerator("CmdOrCtrl+Shift+B")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("fmt-italic", "Italic")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("fmt-emph", "Emphasis")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("fmt-code", "Code").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("fmt-section", "Section").build(app)?)
        .item(&MenuItemBuilder::with_id("fmt-subsection", "Subsection").build(app)?)
        .item(&MenuItemBuilder::with_id("fmt-subsubsection", "Subsubsection").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("fmt-itemize", "Bulleted List").build(app)?)
        .item(&MenuItemBuilder::with_id("fmt-enumerate", "Numbered List").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("fmt-math", "Inline Math")
                .accelerator("CmdOrCtrl+Shift+M")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("fmt-equation", "Equation").build(app)?)
        .item(&MenuItemBuilder::with_id("fmt-figure", "Figure").build(app)?)
        .item(&MenuItemBuilder::with_id("fmt-table", "Table").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("agent-continue", "Continue Sentence with Agent")
                .accelerator("CmdOrCtrl+Shift+Space")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("fmt-cite", "Citation…")
                .accelerator("CmdOrCtrl+Shift+C")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("fmt-ref", "Cross-reference…")
                .accelerator("CmdOrCtrl+Shift+R")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("fmt-link", "Link")
                .accelerator("CmdOrCtrl+K")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("fmt-footnote", "Footnote").build(app)?)
        .build()?;

    let paper = SubmenuBuilder::new(app, "Paper")
        .item(
            &MenuItemBuilder::with_id("compile", "Compile")
                .accelerator("CmdOrCtrl+B")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("show-log", "Show Compile Log")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("sync-pdf", "Show Line in PDF")
                .accelerator("CmdOrCtrl+Shift+J")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("show-terminal", "Show Terminal")
                .accelerator("Ctrl+`")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("commit", "Commit…")
                .accelerator("CmdOrCtrl+Alt+C")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("references", "References…")
                .accelerator("CmdOrCtrl+Alt+R")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("ask-agent", "Ask the Agent…")
                .accelerator("CmdOrCtrl+J")
                .build(app)?,
        )
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(
            &MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts")
                .accelerator("CmdOrCtrl+/")
                .build(app)?,
        )
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &format, &view, &paper, &window])
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
        .manage(terminal::Shared::default())
        .manage(lsp::Shared::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                terminal::close_all(&window.state::<terminal::Shared>());
                lsp::stop_all(&window.state::<lsp::Shared>());
            }
        })
        .setup(|app| {
            build_menu(app.handle())?;
            if let Some(dir) = find_tectonic().and_then(|p| p.parent().map(Path::to_path_buf)) {
                agents::register_tool_dir(dir);
            }
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
            open_project,
            paper_map,
            term_open,
            term_write,
            term_resize,
            term_close,
            search_paper,
            lsp_available,
            lsp_start,
            lsp_send,
            lsp_stop,
            read_text,
            write_text,
            read_binary,
            compile,
            compile_cancel,
            import_overleaf_zip,
            templates_list,
            export_tools,
            export_paper,
            new_paper,
            bib_import_file,
            zotero_import,
            zotero_status,
            zotero_sync,
            refs_add,
            refs_linked_sync,
            synctex_forward,
            synctex_inverse,
            git_status,
            git_init,
            git_commit,
            git_clone,
            git_remote_add,
            git_remote_url,
            git_pull,
            git_push,
            relay_start,
            relay_stop,
            project_snapshot,
            session_materialize,
            agent_apply,
            checkpoint,
            checkpoint_patch,
            checkpoint_undo,
            git_discard,
            checkpoints,
            checkpoint_restore,
            agent_providers,
            agent_models,
            agent_run,
            agent_complete,
            agent_cancel,
            agent_diff,
            agent_accept,
            agent_reject,
            agent_pull_request,
            memory_read,
            memory_setup,
            provenance_rerun,
            context_pack
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
    fn snapshot_round_trip() {
        let dir = std::env::temp_dir().join(format!("dabir-snap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("figures")).unwrap();
        fs::write(dir.join("main.tex"), "\\documentclass{article}").unwrap();
        fs::write(dir.join("figures/a.png"), [137u8, 80, 78, 71, 0, 1, 2]).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git/HEAD"), "ref").unwrap();
        let snap = project_snapshot(dir.to_string_lossy().to_string()).unwrap();
        let paths: Vec<_> = snap.files.iter().map(|f| f.path.clone()).collect();
        assert!(
            paths.contains(&"main.tex".to_string())
                && paths.contains(&"figures/a.png".to_string())
                && !paths.iter().any(|p| p.starts_with(".git")),
            "{:?}",
            paths
        );
        let root =
            session_materialize(format!("test-{}", uuid::Uuid::new_v4()), snap.files).unwrap();
        assert_eq!(
            fs::read(Path::new(&root).join("figures/a.png")).unwrap(),
            vec![137u8, 80, 78, 71, 0, 1, 2]
        );
        assert_eq!(
            fs::read_to_string(Path::new(&root).join("main.tex")).unwrap(),
            "\\documentclass{article}"
        );
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn git_status_commit_and_memory_setup() {
        let dir = std::env::temp_dir().join(format!("dabir-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tex"), "\\documentclass{article}\n\\title{Test Paper}\n\\begin{document}\n\\section{Intro}\nHi\n\\end{document}\n").unwrap();
        fs::write(
            dir.join("dabir.toml"),
            "[provenance]\n\"figures/a.pdf\" = \"true\"\n",
        )
        .unwrap();
        let st = git::status(&dir).unwrap();
        assert!(!st.is_repo);
        git::init(&dir).unwrap();
        let st = git::status(&dir).unwrap();
        assert!(st.is_repo);
        assert!(st
            .changes
            .iter()
            .any(|c| c.path == "main.tex" && c.status == "untracked"));
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
        assert!(
            dir.join(".agents/skills/dabir-compile-and-fix/SKILL.md")
                .exists(),
            "skill symlink resolves"
        );
        let pack = memory::context_pack(&dir, "intro section", 2000);
        assert!(
            pack.contains("main.tex:"),
            "context pack finds the manuscript: {}",
            pack
        );
        // worktree round trip
        git::commit(&dir, "memory", None).unwrap();
        let wt = git::worktree_add(&dir, "t1").unwrap();
        fs::write(wt.join("main.tex"), "changed\n").unwrap();
        let d = git::worktree_diff(&dir, "t1").unwrap();
        assert_eq!(d.changes.len(), 1);
        assert!(d.patch.contains("+changed"));
        let id = git::worktree_accept(&dir, "t1", "agent change", None).unwrap();
        assert_eq!(id.len(), 7);
        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            "changed\n"
        );
        assert!(!wt.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn follow_up_carries_the_authors_edits_but_not_over_the_agents() {
        let dir = std::env::temp_dir().join(format!("dabir-follow-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tex"), "\\documentclass{article}\nbody\n").unwrap();
        fs::write(dir.join("notes.tex"), "notes\n").unwrap();
        git::init(&dir).unwrap();
        git::commit(&dir, "init", None).unwrap();
        let wt = git::worktree_add(&dir, "f1").unwrap();
        // The agent changes main.tex; meanwhile the author edits notes.tex, adds refs.bib, and also
        // touches main.tex in the checkout.
        fs::write(wt.join("main.tex"), "\\documentclass{article}\nagent\n").unwrap();
        fs::write(dir.join("notes.tex"), "author notes\n").unwrap();
        fs::write(dir.join("refs.bib"), "@article{a}\n").unwrap();
        fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\nbody\nauthor\n",
        )
        .unwrap();
        let carried = git::sync_working_copy(&dir, "f1").unwrap();
        assert_eq!(
            carried,
            vec!["notes.tex".to_string(), "refs.bib".to_string()]
        );
        assert_eq!(
            fs::read_to_string(wt.join("notes.tex")).unwrap(),
            "author notes\n"
        );
        assert!(wt.join("refs.bib").exists());
        assert_eq!(
            fs::read_to_string(wt.join("main.tex")).unwrap(),
            "\\documentclass{article}\nagent\n",
            "the agent's file is left alone"
        );
        // The run's diff is still the agent's work alone.
        let d = git::worktree_diff(&dir, "f1").unwrap();
        assert_eq!(
            d.changes
                .iter()
                .map(|c| c.path.as_str())
                .collect::<Vec<_>>(),
            vec!["main.tex"]
        );
        // A second sync with nothing new carries nothing.
        assert!(git::sync_working_copy(&dir, "f1").unwrap().is_empty());
        let _ = git::worktree_remove(&dir, "f1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_in_paper_is_smart_case_and_spans_files() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/anchor-journal");
        let hits = search_files(&root, "\\kap");
        assert!(hits.len() > 3, "{hits:?}");
        let files: std::collections::HashSet<_> = hits.iter().map(|h| h.file.as_str()).collect();
        assert!(files.len() >= 2, "{files:?}");
        assert!(hits.iter().all(|h| h.text.contains("\\kap")));
        let lower = search_files(&root, "anchor");
        let upper = search_files(&root, "Anchor");
        assert!(
            lower.len() > upper.len(),
            "{} vs {}",
            lower.len(),
            upper.len()
        );
        assert!(upper.iter().all(|h| h.text.contains("Anchor")), "{upper:?}");
        assert!(lower.iter().any(|h| h.cut), "long lines are windowed");
        assert!(search_files(&root, "   ").is_empty());
        let one = &lower[0];
        assert_eq!(
            one.text
                .to_lowercase()
                .chars()
                .skip(one.col)
                .take(one.len)
                .collect::<String>(),
            "anchor"
        );
    }

    #[test]
    fn nested_paper_worktree_round_trip() {
        // A paper inside a larger repository: the agent works in the paper's folder of the worktree,
        // paths are reported relative to the paper, and accept lands in the paper's folder.
        let repo = std::env::temp_dir().join(format!("dabir-nested-{}", uuid::Uuid::new_v4()));
        let paper = repo.join("papers").join("one");
        fs::create_dir_all(&paper).unwrap();
        fs::write(paper.join("main.tex"), "\\documentclass{article}\n").unwrap();
        fs::write(repo.join("README.md"), "top\n").unwrap();
        git::init(&repo).unwrap();
        git::commit(&repo, "init", None).unwrap();
        let wt = git::worktree_add(&paper, "n1").unwrap();
        assert!(
            wt.ends_with("papers/one"),
            "agent cwd is the paper inside the worktree: {:?}",
            wt
        );
        // A follow-up finds the same folder while the run is under review, and nothing once it is gone.
        assert_eq!(
            git::worktree_cwd(&paper, "n1").as_deref(),
            Some(wt.as_path())
        );
        assert!(git::worktree_cwd(&paper, "missing").is_none());
        fs::write(wt.join("main.tex"), "changed\n").unwrap();
        let d = git::worktree_diff(&paper, "n1").unwrap();
        assert_eq!(d.changes.len(), 1);
        assert_eq!(d.changes[0].path, "main.tex");
        let id = git::worktree_accept(
            &paper,
            "n1",
            "agent change",
            Some(vec![git::Pick {
                path: "main.tex".into(),
                hunks: None,
            }]),
        )
        .unwrap();
        assert_eq!(id.len(), 7);
        assert_eq!(
            fs::read_to_string(paper.join("main.tex")).unwrap(),
            "changed\n"
        );
        assert!(!git::worktree_dir(&paper, "n1").exists());
        assert!(
            git::worktree_cwd(&paper, "n1").is_none(),
            "accept removes the run's worktree"
        );
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn worktree_starts_from_the_working_copy() {
        // Uncommitted edits and new files are what the agent sees; the run's diff is only its own work,
        // and accepting lands onto the same edits without a conflict.
        let dir = std::env::temp_dir().join(format!("dabir-seed-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tex"), "one\ntwo\nthree\n").unwrap();
        git::init(&dir).unwrap();
        git::commit(&dir, "init", None).unwrap();
        fs::write(dir.join("main.tex"), "one\ntwo edited\nthree\n").unwrap();
        fs::write(dir.join("notes.tex"), "new file\n").unwrap();
        let wt = git::worktree_add(&dir, "s1").unwrap();
        assert_eq!(
            fs::read_to_string(wt.join("main.tex")).unwrap(),
            "one\ntwo edited\nthree\n"
        );
        assert_eq!(
            fs::read_to_string(wt.join("notes.tex")).unwrap(),
            "new file\n"
        );
        let d = git::worktree_diff(&dir, "s1").unwrap();
        assert!(
            d.changes.is_empty(),
            "seed is not part of the run's diff: {:?}",
            d.changes
        );
        fs::write(wt.join("main.tex"), "one\ntwo edited\nthree\nfour\n").unwrap();
        let d = git::worktree_diff(&dir, "s1").unwrap();
        assert_eq!(d.changes.len(), 1);
        assert!(d.patch.contains("+four") && !d.patch.contains("+two edited"));
        git::worktree_apply(&dir, "s1", None).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            "one\ntwo edited\nthree\nfour\n"
        );
        assert_eq!(
            fs::read_to_string(dir.join("notes.tex")).unwrap(),
            "new file\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_tool_call_names() {
        let line = r#"{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"/p/main.tex"}},"hookAdditionalContexts":[],"toolCallId":"x","startedAtMs":"1"}}"#;
        let evs = agents::parse_line_for_test("cursor", line);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].2.as_deref(), Some("Read"));
        assert_eq!(evs[0].1, "/p/main.tex");
    }

    #[test]
    fn preamble_carries_brief_files_and_boundary() {
        let dir = std::env::temp_dir().join(format!("dabir-pre-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join(".dabir")).unwrap();
        fs::create_dir_all(dir.join("figures")).unwrap();
        fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}Anchoring holds a margin.\\end{document}",
        )
        .unwrap();
        fs::write(dir.join("figures/psnr.pdf"), vec![0u8; 2048]).unwrap();
        fs::write(
            dir.join(".dabir/PROJECT.md"),
            "# Paper\n\n## Identity\nA test paper.",
        )
        .unwrap();
        let cwd = dir.join(".dabir/worktrees/x");
        let out = agent_preamble(&dir, &cwd, "add a figure", "add a figure", None);
        assert!(out.contains(&format!("`{}`", cwd.display())), "cwd named");
        assert!(out.contains("do not read, search or edit anything outside it"));
        assert!(
            out.contains("A test paper."),
            "brief is inline, not a read instruction"
        );
        assert!(!out.contains("Read .dabir/PROJECT.md"));
        assert!(out.contains("figures/psnr.pdf (2 KB)"), "file map: {out}");
        assert!(out.contains("tectonic -X compile main.tex"));
        assert!(out.contains("do not stop to ask"));
        assert!(out.ends_with("Request\nadd a figure"));
        assert!(out.contains("Paper map"), "{out}");
        assert!(out.contains("Preamble main.tex:1-1"), "{out}");
        // The editor position rides along and is resolved against the map.
        fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nA.\n\\section{Method}\\label{sec:m}\nAnchoring holds a margin.\nMore.\n\\end{document}\n",
        )
        .unwrap();
        let focus = Focus {
            file: "main.tex".into(),
            line: 6,
            end_line: Some(6),
            selection: Some("Anchoring holds a margin.".into()),
        };
        let with = agent_preamble(&dir, &cwd, "shorten this", "shorten this", Some(&focus));
        assert!(with.contains("Where the author is"), "{with}");
        assert!(
            with.contains("main.tex line 6, in the section “Method” (main.tex:5)"),
            "{with}"
        );
        assert!(
            with.contains("<<<\nAnchoring holds a margin.\n>>>"),
            "{with}"
        );
        assert!(with.contains("2 Method 5  [sec:m 5]"), "{with}");
        // A later run learns what the earlier one did and whether the author kept it.
        fs::create_dir_all(dir.join(".dabir/memory")).unwrap();
        memory::log_run_with(
            &dir,
            "grok",
            "add a figure",
            &["main.tex".into()],
            Some("Added a TikZ schematic of the clip."),
            "rejected",
        );
        let again = agent_preamble(
            &dir,
            &cwd,
            "make the figure a plot instead",
            "make the figure a plot instead",
            None,
        );
        assert!(again.contains("Previous agent runs"));
        assert!(
            again.contains(
                "grok · add a figure · main.tex · rejected · Added a TikZ schematic of the clip."
            ),
            "{again}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_a_folder_that_is_not_a_paper_is_bounded_and_finds_a_nested_manuscript() {
        let dir = std::env::temp_dir().join(format!("dabir-home-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("paper")).unwrap();
        for i in 0..TREE_BUDGET + 500 {
            fs::write(dir.join(format!("f{i}.txt")), "x").unwrap();
        }
        fs::write(dir.join("paper/thesis.tex"), "\\documentclass{article}").unwrap();
        let p = open_project(dir.to_string_lossy().to_string()).unwrap();
        assert!(p.tree_truncated);
        assert!(p.tree.len() <= TREE_BUDGET);
        assert!(p.main_tex.unwrap().ends_with("paper/thesis.tex"));
        let empty = std::env::temp_dir().join(format!("dabir-empty-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&empty).unwrap();
        let q = open_project(empty.to_string_lossy().to_string()).unwrap();
        assert!(!q.tree_truncated && q.main_tex.is_none());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn continuation_replies_are_trimmed_to_one_paragraph() {
        assert_eq!(
            clean_continuation("\"The anchor is the only new hyperparameter.\"\n\nI kept the voice of the section."),
            "The anchor is the only new hyperparameter."
        );
        assert_eq!(
            clean_continuation("```latex\nSee Section~\\ref{sec:results} for its effect.\n```"),
            "See Section~\\ref{sec:results} for its effect."
        );
        assert_eq!(
            clean_continuation("… holds a margin of 1.8 dB."),
            "holds a margin of 1.8 dB."
        );
    }

    #[test]
    fn steering_flags_per_cli() {
        let cwd = Path::new("/w");
        let steer = agents::Steer {
            model: Some("opus".into()),
            effort: Some("high".into()),
        };
        let claude = agents::args_for_test("claude", "p", cwd, &steer);
        assert!(claude.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(claude.windows(2).any(|w| w == ["--effort", "high"]));
        let codex = agents::args_for_test("codex", "p", cwd, &steer);
        assert!(codex.windows(2).any(|w| w == ["-m", "opus"]));
        assert!(codex
            .windows(2)
            .any(|w| w == ["-c", "model_reasoning_effort=\"high\""]));
        assert_eq!(codex.last().unwrap(), "p", "prompt stays last for codex");
        let cursor = agents::args_for_test("cursor", "p", cwd, &steer);
        assert!(cursor.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(
            !cursor.iter().any(|a| a.contains("effort")),
            "cursor takes effort through the model id"
        );
        assert_eq!(cursor.last().unwrap(), "p");
        let grok = agents::args_for_test("grok", "p", cwd, &steer);
        assert!(grok.windows(2).any(|w| w == ["--reasoning-effort", "high"]));
        // Blank steering adds nothing.
        let none = agents::args_for_test(
            "claude",
            "p",
            cwd,
            &agents::Steer {
                model: Some("  ".into()),
                effort: None,
            },
        );
        assert!(!none.iter().any(|a| a == "--model"));
        // Deny rules: the default list for claude and grok, none for CLIs without the flag.
        let i = claude
            .iter()
            .position(|a| a == "--disallowedTools")
            .unwrap();
        assert!(claude[i + 1].contains("Bash(git log*)") && claude[i + 1].contains("Bash(tree*)"));
        assert!(grok
            .windows(2)
            .any(|w| w == ["--deny", "Bash(git status*)"]));
        assert!(!codex
            .iter()
            .any(|a| a.contains("deny") || a.contains("disallowed")));
        assert!(!cursor
            .iter()
            .any(|a| a.contains("deny") || a.contains("disallowed")));
    }

    #[test]
    fn deny_rules_come_from_dabir_toml_when_set() {
        let dir = std::env::temp_dir().join(format!("dabir-deny-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(agents::deny_rules(&dir).len(), agents::DEFAULT_DENY.len());
        fs::write(
            dir.join("dabir.toml"),
            "[agents]\ndeny = [\"WebSearch\", \" Bash(rm*) \"]\n",
        )
        .unwrap();
        assert_eq!(agents::deny_rules(&dir), vec!["WebSearch", "Bash(rm*)"]);
        fs::write(dir.join("dabir.toml"), "[agents]\ndeny = []\n").unwrap();
        assert!(agents::deny_rules(&dir).is_empty());
        let steer = agents::Steer {
            model: None,
            effort: None,
        };
        let claude = agents::args_for_test("claude", "p", &dir, &steer);
        assert!(!claude.iter().any(|a| a == "--disallowedTools"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_lists_come_from_installed_clis() {
        let installed: Vec<String> = agents::detect()
            .into_iter()
            .filter(|p| p.installed)
            .map(|p| p.id)
            .collect();
        for id in ["grok", "cursor"] {
            if !installed.iter().any(|x| x == id) {
                continue;
            }
            let m = agents::models(id);
            assert!(!m.models.is_empty(), "{} lists its models: {:?}", id, m);
            assert!(m.models.iter().all(|c| !c.id.contains(' ')));
        }
        let claude = agents::models("claude");
        assert_eq!(
            claude.efforts,
            vec!["low", "medium", "high", "xhigh", "max"]
        );
        assert!(agents::models("cursor").efforts.is_empty());
    }

    #[test]
    fn codex_error_message_is_surfaced() {
        let evs = agents::parse_line_for_test(
            "codex",
            r#"{"type":"error","message":"You've hit your usage limit."}"#,
        );
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, "done");
        assert_eq!(evs[0].3, Some(false));
        assert!(evs[0].1.contains("usage limit"));
        let evs = agents::parse_line_for_test(
            "codex",
            r#"{"type":"turn.failed","error":{"message":"boom"}}"#,
        );
        assert_eq!(evs[0].1, "boom");
    }

    #[test]
    fn checkpoints_do_not_touch_branch_or_index() {
        let dir = std::env::temp_dir().join(format!("dabir-ckpt-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("main.tex"), "one\n").unwrap();
        git::init(&dir).unwrap();
        git::commit(&dir, "init", None).unwrap();
        assert!(git::checkpoint(&dir, "nothing changed").unwrap().is_none());
        fs::write(dir.join("main.tex"), "two\n").unwrap();
        let id = git::checkpoint(&dir, "Autosave").unwrap().unwrap();
        assert_eq!(id.len(), 7);
        assert!(
            git::checkpoint(&dir, "again").unwrap().is_none(),
            "no duplicate for an unchanged tree"
        );
        let st = git::status(&dir).unwrap();
        assert!(
            st.changes.iter().any(|c| c.path == "main.tex"),
            "working tree still shows the edit as uncommitted: {:?}",
            st.changes
        );
        let list = git::checkpoints(&dir, 10).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "Autosave");
        fs::write(dir.join("main.tex"), "three\n").unwrap();
        git::checkpoint_restore(&dir, &id).unwrap();
        assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "two\n");
        assert_eq!(
            git::checkpoints(&dir, 10).unwrap().len(),
            3,
            "restoring snapshots the state it replaces, then the restored state"
        );
        // Each step knows what it changed, and its diff can be read.
        let list = git::checkpoints(&dir, 10).unwrap();
        assert_eq!(list[2].files.len(), 1);
        assert_eq!(
            (
                list[2].files[0].path.as_str(),
                list[2].files[0].add,
                list[2].files[0].del
            ),
            ("main.tex", 1, 1)
        );
        assert!(git::checkpoint_patch(&dir, &id).unwrap().contains("+two"));
        // Author snapshots within the window fold into one entry; a different message starts a new one.
        fs::write(dir.join("main.tex"), "four\n").unwrap();
        let a = git::checkpoint_with(&dir, "You edited main.tex", true)
            .unwrap()
            .unwrap();
        fs::write(dir.join("main.tex"), "five\n").unwrap();
        let b = git::checkpoint_with(&dir, "You edited main.tex", true)
            .unwrap()
            .unwrap();
        assert_ne!(a, b);
        let list = git::checkpoints(&dir, 10).unwrap();
        assert_eq!(
            list.len(),
            4,
            "folded: {:?}",
            list.iter().map(|c| &c.message).collect::<Vec<_>>()
        );
        assert_eq!(list[0].message, "You edited main.tex");
        // Undo one step in the middle, leaving a later, non-overlapping edit in place.
        fs::write(dir.join("notes.txt"), "later\n").unwrap();
        git::checkpoint(&dir, "You edited notes.txt")
            .unwrap()
            .unwrap();
        git::checkpoint_undo(&dir, &b).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("main.tex")).unwrap(),
            "two\n",
            "the step's edit is gone"
        );
        assert!(dir.join("notes.txt").exists(), "the later edit stays");
        assert!(git::checkpoints(&dir, 10).unwrap()[0]
            .message
            .starts_with("Undid:"));
        // Discard puts a file back to HEAD and is itself snapshotted.
        git::discard(&dir, "main.tex").unwrap();
        assert_eq!(fs::read_to_string(dir.join("main.tex")).unwrap(), "one\n");
        git::discard(&dir, "notes.txt").unwrap();
        assert!(!dir.join("notes.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn merges_bib_without_duplicates() {
        let dir = std::env::temp_dir().join(format!("dabir-bib-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("refs.bib"),
            "@article{a2020,\n  title={A},\n  year={2020}\n}\n",
        )
        .unwrap();
        let r = refs::merge_into(
            &dir,
            "@article{a2020,\n  title={A, revised},\n  year={2020}\n}\n@book{b2021,\n  title={B},\n  publisher={P}\n}\n",
        )
        .unwrap();
        assert_eq!((r.added, r.updated, r.file.as_str()), (1, 1, "refs.bib"));
        let out = fs::read_to_string(dir.join("refs.bib")).unwrap();
        assert!(
            out.contains("b2021")
                && out.contains("A, revised")
                && out.matches("a2020").count() == 1
        );
        let d =
            parse_typst_log("error: unknown variable: foo\n  ┌─ main.typ:12:5\n  │\n12 │ #foo\n");
        assert_eq!(d[0].line, Some(12));
        assert_eq!(d[0].file.as_deref(), Some("main.typ"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn filters_patch_by_file_and_hunk() {
        let filter = |p: &str, picks: &[git::Pick]| {
            String::from_utf8(git::filter_patch_bytes(p.as_bytes(), picks)).unwrap()
        };
        let patch = "diff --git a/a.tex b/a.tex\n--- a/a.tex\n+++ b/a.tex\n@@ -1,1 +1,1 @@\n-x\n+y\n@@ -10,1 +10,1 @@\n-p\n+q\ndiff --git a/b.tex b/b.tex\n--- a/b.tex\n+++ b/b.tex\n@@ -1,1 +1,1 @@\n-m\n+n\n";
        let only_b = filter(
            patch,
            &[git::Pick {
                path: "b.tex".into(),
                hunks: None,
            }],
        );
        assert!(only_b.contains("+n") && !only_b.contains("+y"));
        let second_hunk = filter(
            patch,
            &[git::Pick {
                path: "a.tex".into(),
                hunks: Some(vec![1]),
            }],
        );
        assert!(
            second_hunk.contains("+q")
                && !second_hunk.contains("+y")
                && second_hunk.contains("+++ b/a.tex")
        );
        let none = filter(
            patch,
            &[git::Pick {
                path: "a.tex".into(),
                hunks: Some(vec![]),
            }],
        );
        assert!(none.trim().is_empty());
    }

    #[test]
    fn filter_patch_keeps_non_utf8_bytes() {
        // A PDF Git treats as text carries bytes outside UTF-8; they must survive filtering untouched.
        let mut patch =
            b"diff --git a/f.pdf b/f.pdf\n--- a/f.pdf\n+++ b/f.pdf\n@@ -1,1 +1,1 @@\n-".to_vec();
        patch.extend_from_slice(&[0xE9, 0xFF, 0x80]);
        patch.extend_from_slice(b"\n+ok\n");
        let out = git::filter_patch_bytes(
            &patch,
            &[git::Pick {
                path: "f.pdf".into(),
                hunks: None,
            }],
        );
        assert_eq!(out, patch);
        let none = git::filter_patch_bytes(
            &patch,
            &[git::Pick {
                path: "other.tex".into(),
                hunks: None,
            }],
        );
        assert!(none.is_empty());
    }

    /// Native relay round trip: two y-websocket clients through the in-process server.
    #[test]
    fn relay_syncs_two_clients() {
        if which("node").is_none() {
            eprintln!("node not found; skipping");
            return;
        }
        relay::start(1240).unwrap();
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let out = Command::new("node")
            .current_dir(&repo)
            .args(["relay/test-client.mjs", "ws://127.0.0.1:1240", "test-room"])
            .output()
            .unwrap();
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        relay::stop();
        eprintln!("relay client output: {}", text.trim());
        assert!(text.contains("SYNC_OK"), "relay sync failed: {}", text);
    }

    fn which(bin: &str) -> Option<PathBuf> {
        let mut dirs: Vec<PathBuf> = vec![
            "/opt/homebrew/bin".into(),
            "/opt/homebrew/opt/node@22/bin".into(),
            "/usr/local/bin".into(),
        ];
        if let Some(p) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
        dirs.into_iter().map(|d| d.join(bin)).find(|p| p.is_file())
    }

    #[test]
    fn synctex_parses_records() {
        let text = "SyncTeX Version:1\nInput:1:/tmp/x/main.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n[1,1:4736286,4736286:0,0,0\nh1,12:4736286,9000000:100,10,2\nx1,13:4800000,9500000\n]\n}1\n";
        let tmp =
            std::env::temp_dir().join(format!("dabir-synctex-{}.synctex", std::process::id()));
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
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/score-anchor");
        let dir =
            std::env::temp_dir().join(format!("dabir-live-{}-{}", provider, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for f in [
            "main.tex",
            "refs.bib",
            "dabir.toml",
            "AGENTS.md",
            "CLAUDE.md",
            ".gitignore",
        ] {
            let _ = fs::copy(src.join(f), dir.join(f));
        }
        for d in ["code", "tables", "figures", ".dabir", ".dabir/memory"] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        for f in [
            "code/sweep.py",
            "tables/psnr-sweep.tex",
            "figures/psnr-vs-noise.pdf",
            ".dabir/PROJECT.md",
            ".dabir/provenance.json",
            ".dabir/memory/reviewer-2-anchor-ratio.md",
        ] {
            let _ = fs::copy(src.join(f), dir.join(f));
        }
        git::init(&dir).unwrap();
        git::commit(&dir, "seed", None).unwrap();
        let run_id = "live1".to_string();
        let wt = git::worktree_add(&dir, &run_id).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<agents::AgentEvent>();
        let started = std::time::Instant::now();
        agents::run_with(provider.clone(), "Open main.tex and change the abstract's phrase 'three baselines' to 'three strong baselines'. Do not touch anything else. Reply DONE when finished.".into(), wt.clone(), run_id.clone(), agents::Steer::default(), move |e| { let _ = tx.send(e); }).unwrap();
        let mut ok = None;
        let mut tools = 0;
        while let Ok(e) = rx.recv_timeout(std::time::Duration::from_secs(240)) {
            eprintln!(
                "[{}] {} {:?} {}",
                e.kind,
                e.run_id,
                e.tool,
                e.text.chars().take(120).collect::<String>()
            );
            if e.kind == "tool" {
                tools += 1;
            }
            if e.kind == "done" {
                ok = e.ok;
                break;
            }
        }
        eprintln!("finished in {:?}, tools={}", started.elapsed(), tools);
        assert_eq!(ok, Some(true), "agent did not finish successfully");
        let d = git::worktree_diff(&dir, &run_id).unwrap();
        eprintln!(
            "changed: {:?}",
            d.changes.iter().map(|c| &c.path).collect::<Vec<_>>()
        );
        assert!(
            d.changes.iter().any(|c| c.path == "main.tex"),
            "main.tex should have changed"
        );
        assert!(d.patch.contains("strong baselines"));
        let id = git::worktree_accept(
            &dir,
            &run_id,
            "live agent change",
            Some(vec![git::Pick {
                path: "main.tex".into(),
                hunks: None,
            }]),
        )
        .unwrap();
        assert_eq!(id.len(), 7);
        assert!(fs::read_to_string(dir.join("main.tex"))
            .unwrap()
            .contains("1.8 dB PSNR margin"));
        assert!(!wt.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Twenty-task agent benchmark. Reuses the live worktree pipeline.
    ///   DABIR_LIVE_PROVIDER=claude cargo test agent_bench -- --ignored --nocapture
    ///   DABIR_BENCH_TASK=01-strong-baselines … to run one task.
    #[test]
    #[ignore]
    fn agent_bench() {
        #[derive(serde::Deserialize)]
        struct Expect {
            file: String,
            text: String,
        }
        #[derive(serde::Deserialize)]
        struct Mutate {
            file: String,
            find: String,
            replace: String,
        }
        #[derive(serde::Deserialize)]
        struct Count {
            file: String,
            text: String,
            min: usize,
        }
        #[derive(serde::Deserialize)]
        struct Task {
            id: String,
            prompt: String,
            /// Folder under examples/ the task runs on; score-anchor unless said otherwise.
            #[serde(default = "default_fixture")]
            fixture: String,
            /// Where the author's editor is, as the app would send it.
            #[serde(default)]
            focus: Option<Focus>,
            #[serde(default)]
            mutate: Vec<Mutate>,
            #[serde(default)]
            expect_count: Vec<Count>,
            #[serde(default)]
            expect_files: Vec<String>,
            #[serde(default)]
            expect_contains: Vec<Expect>,
            #[serde(default)]
            expect_absent: Vec<Expect>,
            #[serde(default = "default_timeout")]
            timeout_secs: u64,
        }
        fn default_timeout() -> u64 {
            180
        }
        fn default_fixture() -> String {
            "score-anchor".into()
        }
        /// Copy a fixture without its git state, build output and worktrees.
        fn copy_fixture(src: &Path, dst: &Path) {
            let Ok(rd) = fs::read_dir(src) else { return };
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".git" {
                    continue;
                }
                let p = e.path();
                let d = dst.join(&name);
                if p.is_dir() {
                    if name == ".dabir" {
                        fs::create_dir_all(&d).unwrap();
                        for sub in fs::read_dir(&p).unwrap().flatten() {
                            let n = sub.file_name().to_string_lossy().to_string();
                            if ["worktrees", "build", "index"].contains(&n.as_str()) {
                                continue;
                            }
                            if sub.path().is_dir() {
                                copy_fixture(&sub.path(), &d.join(&n));
                            } else {
                                let _ = fs::copy(sub.path(), d.join(&n));
                            }
                        }
                    } else {
                        copy_fixture(&p, &d);
                    }
                } else {
                    fs::create_dir_all(dst).unwrap();
                    let _ = fs::copy(&p, &d);
                }
            }
        }
        /// What a tool call was for. Orientation calls (listing, searching, opening the brief or
        /// memory) are the waste the preamble exists to remove; reads and edits are the work.
        fn classify(tool: &str, text: &str) -> &'static str {
            let n = tool.to_lowercase();
            let t = text.to_lowercase();
            // A shell-only agent does everything through Bash; sort its commands by what they do.
            let mut first = t.trim_start();
            if first.starts_with("cd ") {
                first = first.split("&&").nth(1).unwrap_or("").trim_start();
            }
            let first = first.split("&&").next().unwrap_or("").trim();
            let orient_cmd = first.starts_with("ls")
                || first.starts_with("find ")
                || first.starts_with("rg ")
                || first.starts_with("grep ")
                || first.starts_with("tree")
                || first.starts_with("git ")
                || first.starts_with("pwd");
            let read_cmd = first.starts_with("cat ")
                || first.starts_with("sed -n")
                || first.starts_with("head ")
                || first.starts_with("tail ")
                || first.starts_with("nl ");
            let edit_cmd = t.contains("sed -i")
                || t.contains("perl -")
                || t.contains(".write(")
                || t.contains(".write_text(")
                || (t.contains("open(") && (t.contains("'w'") || t.contains("\"w\"")))
                || t.contains("cat >")
                || t.contains("tee ");
            let orient_file = t.contains("project.md")
                || t.contains("agents.md")
                || t.contains("claude.md")
                || t.contains(".dabir/memory")
                || t.contains("skill.md");
            // Edits first: Grok's `search_replace` is an edit, not a search.
            if n.contains("edit")
                || n.contains("write")
                || n.contains("create")
                || n.contains("replace")
                || n.contains("patch")
                || n.contains("apply")
                || n.contains("multi")
            {
                "edit"
            } else if n.contains("grep")
                || n.contains("glob")
                || n.contains("search")
                || n.contains("ls")
                || n.contains("list")
            {
                "orient"
            } else if n.contains("read") || n.contains("view") || n.contains("open") {
                if orient_file {
                    "orient"
                } else {
                    "read"
                }
            } else if n.contains("bash")
                || n.contains("shell")
                || n.contains("command")
                || n.contains("exec")
                || n.contains("terminal")
                || n.contains("run")
            {
                if first.contains("tectonic")
                    || first.contains("typst")
                    || first.contains("latexmk")
                    || first.contains("pdflatex")
                {
                    "compile"
                } else if edit_cmd {
                    "edit"
                } else if orient_file {
                    "orient"
                } else if read_cmd {
                    "read"
                } else if orient_cmd {
                    "orient"
                } else {
                    "run"
                }
            } else {
                "other"
            }
        }

        let provider = std::env::var("DABIR_LIVE_PROVIDER").unwrap_or_else(|_| "claude".into());
        let only = std::env::var("DABIR_BENCH_TASK").ok();
        // DABIR_BENCH_VERBOSE=1 prints every tool call and reply as it happens.
        let verbose = std::env::var("DABIR_BENCH_VERBOSE").is_ok();
        let tasks_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bench/tasks");
        let results_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bench/results");
        fs::create_dir_all(&results_dir).unwrap();
        let mut paths: Vec<_> = fs::read_dir(&tasks_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        paths.sort();
        let mut report =
            serde_json::json!({ "provider": provider, "at": chrono_like(), "tasks": [] });
        let mut passed = 0usize;
        let mut total = 0usize;
        let mut all_tools = 0usize;
        let mut all_orient = 0usize;

        for path in paths {
            let task: Task = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            // DABIR_BENCH_TASK picks one task by id or a family by a substring such as "mf".
            if let Some(ref id) = only {
                if !task.id.contains(id.as_str()) {
                    continue;
                }
            }
            total += 1;
            eprintln!("\n=== {} ===", task.id);
            let dir = std::env::temp_dir().join(format!(
                "dabir-bench-{}-{}-{}",
                provider,
                task.id,
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../examples")
                .join(&task.fixture);
            assert!(
                fixture.is_dir(),
                "{}: fixture {} missing",
                task.id,
                task.fixture
            );
            copy_fixture(&fixture, &dir);
            for m in &task.mutate {
                let p = dir.join(&m.file);
                let body = fs::read_to_string(&p).unwrap_or_default();
                assert!(
                    body.contains(&m.find),
                    "{}: mutate find missed in {}",
                    task.id,
                    m.file
                );
                fs::write(&p, body.replacen(&m.find, &m.replace, 1)).unwrap();
            }
            git::init(&dir).unwrap();
            git::commit(&dir, "seed", None).unwrap();
            let run_id = format!("bench-{}", task.id);
            let wt = git::worktree_add(&dir, &run_id).unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<agents::AgentEvent>();
            let started = std::time::Instant::now();
            // The prompt the app would send, so the bench measures the preamble too.
            let launch = agents::run_with(
                provider.clone(),
                agent_preamble(&dir, &wt, &task.prompt, &task.prompt, task.focus.as_ref()),
                wt.clone(),
                run_id.clone(),
                agents::Steer::default(),
                move |e| {
                    let _ = tx.send(e);
                },
            );
            let mut ok_agent = false;
            let mut err = String::new();
            let mut tools = 0usize;
            let mut kinds: std::collections::BTreeMap<&'static str, usize> = Default::default();
            if let Err(e) = launch {
                err = e;
            } else {
                while let Ok(e) = rx.recv_timeout(std::time::Duration::from_secs(task.timeout_secs))
                {
                    if e.kind == "tool" {
                        tools += 1;
                        *kinds
                            .entry(classify(e.tool.as_deref().unwrap_or(""), &e.text))
                            .or_default() += 1;
                    }
                    if verbose && (e.kind == "tool" || e.kind == "text") {
                        eprintln!(
                            "  [{:>5.1}s] {} {} {}",
                            started.elapsed().as_secs_f64(),
                            e.kind,
                            e.tool.clone().unwrap_or_default(),
                            e.text
                                .chars()
                                .take(160)
                                .collect::<String>()
                                .replace('\n', " ")
                        );
                    }
                    if e.kind == "done" {
                        ok_agent = e.ok.unwrap_or(false);
                        if !ok_agent {
                            err = e.text; // the CLI's own reason (usage limit, sign-in), not a bare failure
                        }
                        break;
                    }
                    if e.kind == "error" {
                        err = e.text;
                        break;
                    }
                }
                if !ok_agent && err.is_empty() {
                    err = "timeout or incomplete".into();
                }
            }
            let mut ok = ok_agent;
            let mut detail = String::new();
            if ok_agent {
                match git::worktree_diff(&dir, &run_id) {
                    Ok(d) => {
                        for f in &task.expect_files {
                            if !d.changes.iter().any(|c| &c.path == f) {
                                ok = false;
                                detail = format!("missing change to {f}");
                                break;
                            }
                        }
                        if ok {
                            let picks: Vec<git::Pick> = d
                                .changes
                                .iter()
                                .map(|c| git::Pick {
                                    path: c.path.clone(),
                                    hunks: None,
                                })
                                .collect();
                            if let Err(e) = git::worktree_apply(&dir, &run_id, Some(picks)) {
                                ok = false;
                                detail = e;
                            } else {
                                let _ = git::worktree_remove(&dir, &run_id);
                                for ex in &task.expect_contains {
                                    let body =
                                        fs::read_to_string(dir.join(&ex.file)).unwrap_or_default();
                                    if !body.contains(&ex.text) {
                                        ok = false;
                                        detail = format!("{} missing {:?}", ex.file, ex.text);
                                        break;
                                    }
                                }
                                for ex in &task.expect_absent {
                                    let body =
                                        fs::read_to_string(dir.join(&ex.file)).unwrap_or_default();
                                    if body.contains(&ex.text) {
                                        ok = false;
                                        detail = format!("{} still has {:?}", ex.file, ex.text);
                                        break;
                                    }
                                }
                                for ex in &task.expect_count {
                                    let body =
                                        fs::read_to_string(dir.join(&ex.file)).unwrap_or_default();
                                    let n = body.matches(ex.text.as_str()).count();
                                    if n < ex.min {
                                        ok = false;
                                        detail = format!(
                                            "{} has {} of {:?}, wanted {}",
                                            ex.file, n, ex.text, ex.min
                                        );
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        ok = false;
                        detail = e;
                    }
                }
            } else {
                detail = err;
                let _ = git::worktree_remove(&dir, &run_id);
            }
            let secs = started.elapsed().as_secs_f64();
            let orient = kinds.get("orient").copied().unwrap_or(0);
            let kinds_text = kinds
                .iter()
                .map(|(k, v)| format!("{k} {v}"))
                .collect::<Vec<_>>()
                .join(", ");
            if ok {
                passed += 1;
                eprintln!(
                    "PASS {} ({:.1}s, {} tool calls: {})",
                    task.id, secs, tools, kinds_text
                );
            } else {
                eprintln!(
                    "FAIL {} ({:.1}s, {} tool calls: {}): {}",
                    task.id, secs, tools, kinds_text, detail
                );
            }
            all_tools += tools;
            all_orient += orient;
            report["tasks"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({
                    "id": task.id, "ok": ok, "secs": secs, "tools": tools, "orient": orient,
                    "kinds": kinds, "detail": detail,
                }));
            let _ = fs::remove_dir_all(&dir);
        }

        report["passed"] = passed.into();
        report["total"] = total.into();
        report["tools"] = all_tools.into();
        report["orient"] = all_orient.into();
        report["rate"] = if total == 0 {
            0.0.into()
        } else {
            ((passed as f64) / (total as f64)).into()
        };
        // A single-task run must not overwrite the full suite's result file.
        let out = match &only {
            Some(t) => results_dir.join(format!("{provider}-{t}.json")),
            None => results_dir.join(format!("{provider}.json")),
        };
        fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        eprintln!(
            "\n{passed}/{total} passed, {all_tools} tool calls of which {all_orient} orientation → {}",
            out.display()
        );
        assert!(total > 0, "no tasks ran");
        // Soft: do not fail the cargo test on a low rate; the JSON is the artifact.
        fn chrono_like() -> String {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default()
        }
    }

    #[test]
    fn imports_overleaf_zip() {
        let zip = std::env::var("DABIR_TEST_ZIP").unwrap_or_default();
        if zip.is_empty() {
            return;
        }
        let dest = std::env::temp_dir().join(format!("dabir-import-{}", std::process::id()));
        let out = import_overleaf_zip(zip, Some(dest.to_string_lossy().to_string())).unwrap();
        let p = open_project(out).unwrap();
        assert!(p.main_tex.is_some(), "main.tex should be detected");
        assert!(dest.join(".gitignore").exists());
        let _ = fs::remove_dir_all(dest);
    }
}
