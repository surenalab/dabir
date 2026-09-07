//! Dabir core: project discovery, file access, compile, and the native menu.
//!
//! Everything the front end knows about a project comes through these commands.
//! A Dabir project is just a folder; nothing here writes anything the user did
//! not ask for, except the build directory under `.dabir/build`.

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

/// Find the root document: a .tex file containing \documentclass, preferring main.tex.
fn find_main_tex(root: &Path) -> Option<PathBuf> {
    let preferred = root.join("main.tex");
    if preferred.exists() {
        return Some(preferred);
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: String, // "error" | "warning"
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
}

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
        out.push(Diagnostic { severity: severity.into(), file, line: lineno, message });
    }
    out
}

#[tauri::command]
fn compile(main_tex: String) -> Result<CompileResult, String> {
    let main = PathBuf::from(&main_tex);
    let root = main.parent().ok_or("The main .tex file has no parent folder")?;
    let outdir = root.join(".dabir").join("build");
    fs::create_dir_all(&outdir).map_err(|e| e.to_string())?;

    let Some(tectonic) = find_tectonic() else {
        return Ok(CompileResult {
            ok: false,
            pdf: None,
            log: String::new(),
            diagnostics: vec![Diagnostic {
                severity: "error".into(),
                file: None,
                line: None,
                message: "Tectonic is not installed. Install it with `brew install tectonic`, or set DABIR_TECTONIC to its path.".into(),
            }],
            engine: "none".into(),
            millis: 0,
        });
    };

    let started = std::time::Instant::now();
    let output = Command::new(&tectonic)
        .current_dir(root)
        .args(["-X", "compile", "--keep-logs", "--synctex", "--outdir"])
        .arg(&outdir)
        .arg(&main)
        .output()
        .map_err(|e| format!("Could not start Tectonic: {}", e))?;
    let millis = started.elapsed().as_millis();
    let log = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stem = main.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or("main".into());
    let pdf = outdir.join(format!("{}.pdf", stem));
    let ok = output.status.success() && pdf.exists();
    Ok(CompileResult {
        ok,
        pdf: if pdf.exists() { Some(pdf.to_string_lossy().to_string()) } else { None },
        diagnostics: parse_log(&log),
        log,
        engine: format!("tectonic ({})", tectonic.display()),
        millis,
    })
}

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
        .item(&MenuItemBuilder::with_id("settings", "Settings…").accelerator("Cmd+,").build(app)?)
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
        .item(&MenuItemBuilder::with_id("open", "Open Paper…").accelerator("Cmd+O").build(app)?)
        .item(&MenuItemBuilder::with_id("import-overleaf", "Import from Overleaf…").build(app)?)
        .item(&MenuItemBuilder::with_id("clone", "Clone from GitHub…").accelerator("Cmd+Shift+O").enabled(false).build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("save", "Save").accelerator("Cmd+S").build(app)?)
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
        .item(&MenuItemBuilder::with_id("find", "Find…").accelerator("Cmd+F").build(app)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("view-visual", "Visual").accelerator("Cmd+1").build(app)?)
        .item(&MenuItemBuilder::with_id("view-source", "Source").accelerator("Cmd+2").build(app)?)
        .item(&MenuItemBuilder::with_id("view-pdf", "PDF").accelerator("Cmd+3").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("toggle-sidebar", "Show/Hide Sidebar").accelerator("Ctrl+Cmd+S").build(app)?)
        .item(&MenuItemBuilder::with_id("toggle-inspector", "Show/Hide Inspector").accelerator("Alt+Cmd+I").build(app)?)
        .separator()
        .fullscreen()
        .build()?;

    let paper = SubmenuBuilder::new(app, "Paper")
        .item(&MenuItemBuilder::with_id("compile", "Compile").accelerator("Cmd+B").build(app)?)
        .item(&MenuItemBuilder::with_id("show-log", "Show Compile Log").accelerator("Cmd+Shift+L").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("ask-agent", "Ask the Agent…").accelerator("Cmd+K").build(app)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&MenuItemBuilder::with_id("shortcuts", "Keyboard Shortcuts").accelerator("Cmd+/").build(app)?)
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
        .invoke_handler(tauri::generate_handler![open_project, read_text, write_text, read_binary, compile, import_overleaf_zip])
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
