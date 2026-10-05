//! A paper opened through one file (File › Open File…, or a double-click on a .tex, .typ or .docx) rather than
//! a folder. The file often sits in Downloads or on the Desktop among unrelated things, so Dabir keeps to it:
//! the sidebar lists only the files the paper reads, nothing is written into the folder (the build goes to a
//! temporary folder of its own), and history and agents, which need a Git repository, wait until the author
//! makes the paper a project. That copies the file and what it reads into a new folder set up as New Paper
//! sets one up.

use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static LOOSE: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Remember that `root` was opened through one of its files.
pub fn register(root: &Path) {
    LOOSE
        .lock()
        .unwrap()
        .get_or_insert_with(HashSet::new)
        .insert(root.to_path_buf());
}

pub fn is_loose(root: &Path) -> bool {
    LOOSE
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.contains(root))
}

/// Where a compile of a paper under `root` writes: `.dabir/build` in a project, a folder under the system's
/// temporary directory for a file opened on its own, named after the folder so two such files do not mix.
pub fn build_dir(root: &Path) -> PathBuf {
    if is_loose(root) {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        root.hash(&mut h);
        std::env::temp_dir()
            .join("dabir-build")
            .join(format!("{:016x}", h.finish()))
    } else {
        root.join(".dabir").join("build")
    }
}

/// The files a paper reads, `main` first: for LaTeX its `\input`s, images and bibliography; a Typst or Word
/// paper is its one file.
pub fn files(root: &Path, main: &Path) -> Vec<PathBuf> {
    let latex = main.extension().is_some_and(|e| e == "tex");
    let mut out = vec![main.to_path_buf()];
    if latex {
        for f in crate::check::referenced(root, main) {
            if !out.contains(&f) {
                out.push(f);
            }
        }
    }
    out
}

/// Copy the paper opened from `main` into `dest` (a new folder), keeping each file's place relative to the
/// original folder, so `\input{sections/intro}` and `figures/plot.pdf` still resolve. Returns the copied main.
pub fn copy_into(main: &Path, dest: &Path) -> Result<PathBuf, String> {
    let root = main.parent().ok_or("The file has no folder")?;
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for f in files(root, main) {
        let Ok(rel) = f.strip_prefix(root) else {
            continue;
        };
        let to = dest.join(rel);
        if let Some(p) = to.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        fs::copy(&f, &to).map_err(|e| format!("Could not copy {}: {}", f.display(), e))?;
    }
    Ok(dest.join(main.file_name().ok_or("The file has no name")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_opened_alone_builds_outside_its_folder_and_copies_what_it_reads() {
        let root = std::env::temp_dir().join(format!("dabir-single-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("sec")).unwrap();
        fs::create_dir_all(root.join("figures")).unwrap();
        fs::write(
            root.join("paper.tex"),
            "\\documentclass{article}\n\\begin{document}\n\\input{sec/intro}\n\\includegraphics{figures/plot}\n\\bibliography{refs}\n\\end{document}\n",
        )
        .unwrap();
        fs::write(root.join("sec/intro.tex"), "Hello.\n").unwrap();
        fs::write(root.join("figures/plot.pdf"), "%PDF").unwrap();
        fs::write(root.join("refs.bib"), "@book{a, title={A}}\n").unwrap();
        fs::write(root.join("unrelated.xlsx"), "x").unwrap();

        assert_eq!(build_dir(&root), root.join(".dabir/build"));
        register(&root);
        assert!(
            !build_dir(&root).starts_with(&root),
            "nothing is written into the folder"
        );

        let names: Vec<String> = files(&root, &root.join("paper.tex"))
            .iter()
            .map(|p| {
                p.strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(names[0], "paper.tex");
        for n in ["sec/intro.tex", "figures/plot.pdf", "refs.bib"] {
            assert!(names.contains(&n.to_string()), "{names:?}");
        }
        assert!(!names.contains(&"unrelated.xlsx".to_string()));

        let dest = std::env::temp_dir().join(format!("dabir-single-dest-{}", uuid::Uuid::new_v4()));
        let main = copy_into(&root.join("paper.tex"), &dest).unwrap();
        assert_eq!(main, dest.join("paper.tex"));
        assert!(dest.join("sec/intro.tex").is_file() && dest.join("figures/plot.pdf").is_file());
        assert!(!dest.join("unrelated.xlsx").exists());
        assert!(
            copy_into(&root.join("paper.tex"), &dest).is_err(),
            "never into an existing folder"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&dest);
    }
}
