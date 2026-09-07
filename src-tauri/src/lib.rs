//! Dabir core: project discovery and file access.
//!
//! Everything the front end knows about a project comes through these commands.
//! A Dabir project is just a folder; nothing here writes anything the user did
//! not ask for.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_project, read_text, write_text])
        .run(tauri::generate_context!())
        .expect("error while running Dabir");
}
