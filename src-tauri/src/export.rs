//! Export: the compiled PDF, a source zip for arXiv or for coauthors, and Word or HTML through pandoc.
//!
//! The arXiv zip holds what arXiv's AutoTeX needs and nothing else: sources, styles, figures, and the
//! `.bbl` the last compile produced (arXiv does not run BibTeX). Code, data, Dabir's own folder and
//! Git stay out. The plain source zip is the folder as a coauthor or Overleaf would want it: everything
//! but `.dabir`, `.git` and build residue.

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
    /// Things the author should know about what went in or was left out.
    pub notes: Vec<String>,
}

const ARXIV_SOURCE: &[&str] = &[
    "tex", "sty", "cls", "bst", "bib", "clo", "def", "cfg", "fd", "ldf", "ist", "bbl", "ind",
    "gls", "tikz", "pgf", "cbx", "bbx", "dbx", "lbx",
];
const ARXIV_IMAGE: &[&str] = &["pdf", "png", "jpg", "jpeg", "eps", "ps"];
const RESIDUE: &[&str] = &[
    "aux",
    "log",
    "blg",
    "out",
    "fls",
    "fdb_latexmk",
    "toc",
    "lof",
    "lot",
    "nav",
    "snm",
    "vrb",
    "synctex",
    "gz",
    "xdv",
    "dvi",
    "run.xml",
    "bcf",
];
const SKIP_DIRS: &[&str] = &[
    ".dabir",
    ".git",
    "node_modules",
    "__pycache__",
    "Dabir Sessions",
    ".venv",
    "venv",
    "target",
];

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = read.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if p.is_dir() {
            if SKIP_DIRS.contains(&name) || name.starts_with('.') {
                continue;
            }
            walk(&p, out);
        } else if name != ".DS_Store" && !name.starts_with("._") {
            out.push(p);
        }
    }
}

fn is_residue(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    RESIDUE.iter().any(|r| name.ends_with(&format!(".{}", r)))
}

fn build_dir(main: &Path) -> PathBuf {
    main.parent()
        .unwrap_or(Path::new("."))
        .join(".dabir")
        .join("build")
}

/// The last compile's PDF, copied to `dest`.
pub fn pdf(main: &Path, dest: &Path) -> Result<Report, String> {
    let stem = main
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("The main file has no name")?;
    let src = build_dir(main).join(format!("{}.pdf", stem));
    if !src.is_file() {
        return Err("The paper has not been compiled yet. Compile it (⌘B), then export.".into());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes =
        fs::copy(&src, dest).map_err(|e| format!("Could not write {}: {}", dest.display(), e))?;
    Ok(Report {
        path: dest.to_string_lossy().to_string(),
        files: 1,
        bytes,
        notes: vec![],
    })
}

fn zip_files(root: &Path, files: &[(PathBuf, String)], dest: &Path) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file =
        fs::File::create(dest).map_err(|e| format!("Could not write {}: {}", dest.display(), e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut total = 0u64;
    for (path, name) in files {
        let bytes = fs::read(path).map_err(|e| {
            format!(
                "{}: {}",
                path.strip_prefix(root).unwrap_or(path).display(),
                e
            )
        })?;
        total += bytes.len() as u64;
        zip.start_file(name.as_str(), opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(total)
}

fn rel_name(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Sources, styles, figures and the compiled bibliography: what arXiv builds from.
pub fn arxiv_zip(root: &Path, main: &Path, dest: &Path) -> Result<Report, String> {
    let stem = main
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("The main file has no name")?
        .to_string();
    let mut all = Vec::new();
    walk(root, &mut all);
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut notes = Vec::new();
    let mut has_bib = false;
    let mut skipped_code = 0usize;
    for p in all {
        let rel = rel_name(root, &p);
        let top = rel.split('/').next().unwrap_or("");
        if top == "code" {
            skipped_code += 1;
            continue;
        }
        let ext = ext_of(&p);
        if is_residue(&p) {
            continue;
        }
        // A compiled copy of the paper at the root would make arXiv treat the submission as a PDF.
        if ext == "pdf"
            && p.file_stem().and_then(|s| s.to_str()) == Some(stem.as_str())
            && p.parent() == Some(root)
        {
            notes.push(format!("{} left out: arXiv builds the PDF itself.", rel));
            continue;
        }
        if ARXIV_SOURCE.contains(&ext.as_str()) || ARXIV_IMAGE.contains(&ext.as_str()) {
            if ext == "bib" {
                has_bib = true;
            }
            files.push((p, rel));
        }
    }
    let bbl = build_dir(main).join(format!("{}.bbl", stem));
    if bbl.is_file() {
        files.push((bbl, format!("{}.bbl", stem)));
    } else if has_bib {
        notes.push("No compiled bibliography (.bbl) was found: compile once before exporting, since arXiv does not run BibTeX.".into());
    }
    if skipped_code > 0 {
        notes.push(format!(
            "{} file{} under code/ left out; arXiv only needs what compiles.",
            skipped_code,
            if skipped_code == 1 { "" } else { "s" }
        ));
    }
    if files.is_empty() {
        return Err("Nothing to export: no LaTeX sources were found in the paper's folder.".into());
    }
    let bytes = zip_files(root, &files, dest)?;
    if bytes > 50 * 1024 * 1024 {
        notes.push(
            "The sources are over 50 MB; arXiv asks authors to shrink figures beyond that.".into(),
        );
    }
    Ok(Report {
        path: dest.to_string_lossy().to_string(),
        files: files.len(),
        bytes,
        notes,
    })
}

/// The folder for a coauthor or Overleaf: everything but Dabir's state, Git and build residue.
pub fn source_zip(root: &Path, dest: &Path) -> Result<Report, String> {
    let mut all = Vec::new();
    walk(root, &mut all);
    let files: Vec<(PathBuf, String)> = all
        .into_iter()
        .filter(|p| !is_residue(p))
        .map(|p| {
            let rel = rel_name(root, &p);
            (p, rel)
        })
        .collect();
    if files.is_empty() {
        return Err("The folder is empty.".into());
    }
    let bytes = zip_files(root, &files, dest)?;
    Ok(Report {
        path: dest.to_string_lossy().to_string(),
        files: files.len(),
        bytes,
        notes: vec![],
    })
}

/// pandoc, if the user has it; looked up on the same PATH the agents get.
pub fn pandoc() -> Option<PathBuf> {
    std::env::split_paths(&crate::agents::agent_path())
        .map(|d| d.join("pandoc"))
        .find(|p| p.is_file())
}

pub fn pandoc_version() -> Option<String> {
    let out = std::process::Command::new(pandoc()?)
        .arg("--version")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.trim().to_string())
}

/// Word or HTML through pandoc, with the paper's .bib files for citations.
pub fn via_pandoc(root: &Path, main: &Path, dest: &Path, format: &str) -> Result<Report, String> {
    let pandoc = pandoc().ok_or("pandoc is not installed. Install it with `brew install pandoc` (or from pandoc.org), then export again.")?;
    let to = match format {
        "docx" => "docx",
        "html" => "html5",
        "md" => "gfm",
        _ => return Err(format!("Unknown export format {}", format)),
    };
    let from = if ext_of(main) == "typ" {
        "typst"
    } else {
        "latex"
    };
    let mut all = Vec::new();
    walk(root, &mut all);
    let bibs: Vec<PathBuf> = all.into_iter().filter(|p| ext_of(p) == "bib").collect();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new(pandoc);
    cmd.current_dir(root)
        .arg(main)
        .args(["--from", from, "--to", to, "--standalone", "--citeproc"])
        .arg("--resource-path")
        .arg(root);
    for b in &bibs {
        cmd.arg("--bibliography").arg(b);
    }
    if to == "html5" {
        cmd.arg("--mathjax");
    }
    cmd.arg("-o").arg(dest);
    let out = cmd
        .output()
        .map_err(|e| format!("Could not start pandoc: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "pandoc could not convert the paper: {}",
            err.lines().take(6).collect::<Vec<_>>().join(" ")
        ));
    }
    let bytes = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    let mut notes = Vec::new();
    let warnings = String::from_utf8_lossy(&out.stderr);
    if !warnings.trim().is_empty() {
        let n = warnings.lines().count();
        notes.push(format!(
            "pandoc noted {} thing{} it could not carry over exactly; custom macros and some environments come through as plain text.",
            n,
            if n == 1 { "" } else { "s" }
        ));
    }
    if bibs.is_empty() {
        notes.push("No .bib file in the paper, so citations stay as keys.".into());
    }
    Ok(Report {
        path: dest.to_string_lossy().to_string(),
        files: 1,
        bytes,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paper() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dabir-export-{}", uuid::Uuid::new_v4()));
        for d in [
            "figures",
            "code",
            "tables",
            ".dabir/build",
            ".git",
            "sections",
        ] {
            fs::create_dir_all(dir.join(d)).unwrap();
        }
        fs::write(dir.join("main.tex"), "\\documentclass{article}\\begin{document}\\input{sections/intro}\\cite{a}\\bibliography{refs}\\end{document}").unwrap();
        fs::write(dir.join("sections/intro.tex"), "Intro").unwrap();
        fs::write(dir.join("refs.bib"), "@article{a, title={A}}").unwrap();
        fs::write(dir.join("style.sty"), "% sty").unwrap();
        fs::write(dir.join("figures/plot.pdf"), "%PDF").unwrap();
        fs::write(dir.join("figures/plot.png"), "png").unwrap();
        fs::write(dir.join("tables/results.tex"), "table").unwrap();
        fs::write(dir.join("code/sweep.py"), "print(1)").unwrap();
        fs::write(dir.join("data.csv"), "1,2").unwrap();
        fs::write(dir.join("main.pdf"), "%PDF compiled copy").unwrap();
        fs::write(dir.join("main.aux"), "aux").unwrap();
        fs::write(dir.join(".dabir/build/main.pdf"), "%PDF-1.7 built").unwrap();
        fs::write(
            dir.join(".dabir/build/main.bbl"),
            "\\begin{thebibliography}",
        )
        .unwrap();
        fs::write(dir.join(".dabir/PROJECT.md"), "brief").unwrap();
        fs::write(dir.join(".git/HEAD"), "ref").unwrap();
        dir
    }

    fn names(zip_path: &Path) -> Vec<String> {
        let f = fs::File::open(zip_path).unwrap();
        let mut z = zip::ZipArchive::new(f).unwrap();
        let mut v: Vec<String> = (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().to_string())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn arxiv_zip_holds_sources_figures_and_bbl_only() {
        let dir = paper();
        let dest = dir.join("out").join("paper-arxiv.zip");
        let r = arxiv_zip(&dir, &dir.join("main.tex"), &dest).unwrap();
        assert_eq!(
            names(&dest),
            vec![
                "figures/plot.pdf",
                "figures/plot.png",
                "main.bbl",
                "main.tex",
                "refs.bib",
                "sections/intro.tex",
                "style.sty",
                "tables/results.tex"
            ]
        );
        assert_eq!(r.files, 8);
        assert!(r.notes.iter().any(|n| n.contains("code/")), "{:?}", r.notes);
        assert!(
            r.notes.iter().any(|n| n.contains("main.pdf left out")),
            "{:?}",
            r.notes
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn source_zip_is_the_folder_without_dabir_git_and_residue() {
        let dir = paper();
        let dest = std::env::temp_dir().join(format!("dabir-src-{}.zip", uuid::Uuid::new_v4()));
        let r = source_zip(&dir, &dest).unwrap();
        let n = names(&dest);
        assert!(n.contains(&"code/sweep.py".to_string()) && n.contains(&"data.csv".to_string()));
        assert!(
            !n.iter()
                .any(|x| x.starts_with(".dabir") || x.starts_with(".git") || x.ends_with(".aux")),
            "{:?}",
            n
        );
        assert_eq!(r.files, n.len());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn pdf_export_copies_the_build_and_says_when_there_is_none() {
        let dir = paper();
        let dest = dir.join("Paper.pdf");
        let r = pdf(&dir.join("main.tex"), &dest).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "%PDF-1.7 built");
        assert_eq!(r.files, 1);
        fs::remove_file(dir.join(".dabir/build/main.pdf")).unwrap();
        assert!(pdf(&dir.join("main.tex"), &dest)
            .unwrap_err()
            .contains("compiled"));
        let _ = fs::remove_dir_all(&dir);
    }
}
