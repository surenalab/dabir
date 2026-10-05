//! `dabir-check`: the mistakes an agent's edit makes most often, found in milliseconds without a compile.
//! A full Tectonic run costs seconds and the model then reads a log; most runs only reword a paragraph or
//! touch a table, where what can break is a brace, an environment, a label or a citation key. This reads
//! the manuscript from the main file through `\input`/`\include`, and reports unbalanced braces,
//! mismatched `\begin`/`\end`, `\ref`s with no `\label`, `\cite` keys missing from the bibliography,
//! and `\input` or `\includegraphics` files that do not exist. LaTeX only; Typst compiles fast enough.
//!
//! Errors stop a compile; warnings are worth a look (a label made by a macro, a key in a .bib this
//! cannot see). The agent runs it through the `dabir-check` wrapper Dabir puts on its PATH, which calls
//! this binary with `--check`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub error: bool,
    pub file: String,
    pub line: usize,
    pub message: String,
}

/// Environments whose body is not LaTeX: their braces and commands are not counted.
const VERBATIM: &[&str] = &[
    "verbatim",
    "verbatim*",
    "Verbatim",
    "lstlisting",
    "minted",
    "comment",
    "filecontents",
    "filecontents*",
];

const REF_CMDS: &[&str] = &[
    "ref",
    "eqref",
    "pageref",
    "autoref",
    "cref",
    "Cref",
    "vref",
    "nameref",
    "labelcref",
];

const CITE_CMDS: &[&str] = &[
    "cite",
    "citep",
    "citet",
    "citealp",
    "citealt",
    "citeauthor",
    "citeyear",
    "citeyearpar",
    "parencite",
    "textcite",
    "autocite",
    "footcite",
    "smartcite",
    "supercite",
    "nocite",
    "Cite",
    "Citep",
    "Citet",
    "Parencite",
    "Textcite",
    "Autocite",
];

const GRAPHIC_EXTS: &[&str] = &[
    "", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".PDF", ".PNG", ".JPG",
];

/// One source line with its comment removed (an unescaped `%` and what follows).
fn strip_comment(line: &str) -> &str {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'%' => return &line[..i],
            _ => i += 1,
        }
    }
    line
}

/// `\name` commands in a line with the position just after the name.
fn commands(line: &str) -> Vec<(String, usize)> {
    let b = line.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j].is_ascii_alphabetic() {
                j += 1;
            }
            if j > start {
                let mut end = j;
                if end < b.len() && b[end] == b'*' {
                    end += 1;
                }
                out.push((line[start..j].to_string(), end));
                i = j;
                continue;
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    out
}

/// The mandatory `{...}` argument after `pos`, skipping spaces and any `[...]` optional arguments.
fn arg_after(line: &str, pos: usize) -> Option<String> {
    let b = line.as_bytes();
    let mut i = pos;
    loop {
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        if i < b.len() && b[i] == b'[' {
            let mut depth = 0;
            while i < b.len() {
                match b[i] {
                    b'[' => depth += 1,
                    b']' => {
                        depth -= 1;
                        if depth == 0 {
                            i += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            continue;
        }
        break;
    }
    if i >= b.len() || b[i] != b'{' {
        return None;
    }
    let mut depth = 0;
    for (k, &c) in b[i..].iter().enumerate() {
        match c {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(line[i + 1..i + k].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn keys(arg: &str) -> impl Iterator<Item = String> + '_ {
    arg.split(',')
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// What the walk collects across every file of the paper.
#[derive(Default)]
struct Paper {
    findings: Vec<Finding>,
    labels: HashMap<String, (String, usize)>,
    refs: Vec<(String, String, usize)>,
    cites: Vec<(String, String, usize)>,
    bib_files: Vec<String>,
    bibitems: HashSet<String>,
    graphics: Vec<(String, String, usize)>,
    graphic_dirs: Vec<String>,
    seen: HashSet<PathBuf>,
}

impl Paper {
    fn find(&mut self, error: bool, file: &str, line: usize, message: String) {
        self.findings.push(Finding {
            error,
            file: file.to_string(),
            line,
            message,
        });
    }

    fn walk(&mut self, root: &Path, path: &Path, depth: usize) {
        if depth > 12 || !self.seen.insert(path.to_path_buf()) {
            return;
        }
        let Ok(text) = fs::read_to_string(path) else {
            return;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        // Brace depth with the line each open brace is on; environments as a stack.
        let mut open: Vec<usize> = vec![];
        let mut envs: Vec<(String, usize)> = vec![];
        let mut verbatim: Option<String> = None;
        for (n, raw) in text.lines().enumerate() {
            let ln = n + 1;
            if let Some(v) = &verbatim {
                if raw.contains(&format!("\\end{{{v}}}")) {
                    if let Some(pos) = envs.iter().rposition(|(e, _)| e == v) {
                        envs.truncate(pos);
                    }
                    verbatim = None;
                }
                continue;
            }
            let line = strip_comment(raw);
            // `\verb|...|` bodies are text, not LaTeX.
            let line = blank_verb(line);
            let b = line.as_bytes();
            let mut i = 0;
            while i < b.len() {
                match b[i] {
                    b'\\' => i += 2,
                    b'{' => {
                        open.push(ln);
                        i += 1;
                    }
                    b'}' => {
                        if open.pop().is_none() {
                            self.find(
                                true,
                                &rel,
                                ln,
                                "a `}` closes a brace that was never opened".into(),
                            );
                        }
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
            for (cmd, end) in commands(&line) {
                match cmd.as_str() {
                    "begin" => {
                        if let Some(env) = arg_after(&line, end) {
                            if VERBATIM.contains(&env.as_str()) {
                                verbatim = Some(env.clone());
                            }
                            envs.push((env, ln));
                        }
                    }
                    "end" => {
                        if let Some(env) = arg_after(&line, end) {
                            match envs.last() {
                                Some((top, _)) if *top == env => {
                                    envs.pop();
                                }
                                Some((top, at)) => {
                                    let (top, at) = (top.clone(), *at);
                                    self.find(true, &rel, ln, format!("`\\end{{{env}}}` closes `\\begin{{{top}}}` from line {at}"));
                                    if let Some(pos) = envs.iter().rposition(|(e, _)| *e == env) {
                                        envs.truncate(pos);
                                    }
                                }
                                None => self.find(
                                    true,
                                    &rel,
                                    ln,
                                    format!("`\\end{{{env}}}` has no `\\begin{{{env}}}`"),
                                ),
                            }
                        }
                    }
                    "label" => {
                        if let Some(l) = arg_after(&line, end) {
                            let l = l.trim().to_string();
                            let dup = self
                                .labels
                                .get(&l)
                                .map(|(f, at)| format!("label `{l}` is also defined at {f}:{at}"));
                            if let Some(msg) = dup {
                                self.find(false, &rel, ln, msg);
                            } else {
                                self.labels.insert(l, (rel.clone(), ln));
                            }
                        }
                    }
                    "bibitem" => {
                        if let Some(k) = arg_after(&line, end) {
                            self.bibitems.insert(k.trim().to_string());
                        }
                    }
                    "bibliography" | "addbibresource" => {
                        if let Some(a) = arg_after(&line, end) {
                            for k in keys(&a) {
                                self.bib_files.push(if k.ends_with(".bib") {
                                    k
                                } else {
                                    format!("{k}.bib")
                                });
                            }
                        }
                    }
                    "graphicspath" => {
                        // \graphicspath{{figures/}{img/}}
                        if let Some(a) = arg_after(&line, end) {
                            for d in a.split(['{', '}']).map(str::trim).filter(|d| !d.is_empty()) {
                                self.graphic_dirs.push(d.to_string());
                            }
                        }
                    }
                    "includegraphics" => {
                        if let Some(f) = arg_after(&line, end) {
                            self.graphics.push((f.trim().to_string(), rel.clone(), ln));
                        }
                    }
                    "input" | "include" | "subfile" => {
                        if let Some(f) = arg_after(&line, end) {
                            let f = f.trim();
                            let mut target = root.join(f);
                            if target.extension().is_none() {
                                target = root.join(format!("{f}.tex"));
                            }
                            if target.is_file() {
                                self.walk(root, &target, depth + 1);
                            } else if !root.join(f).is_file() {
                                self.find(
                                    true,
                                    &rel,
                                    ln,
                                    format!("`\\{cmd}{{{f}}}`: no such file"),
                                );
                            }
                        }
                    }
                    c if REF_CMDS.contains(&c) => {
                        if let Some(a) = arg_after(&line, end) {
                            for k in keys(&a) {
                                self.refs.push((k, rel.clone(), ln));
                            }
                        }
                    }
                    c if CITE_CMDS.contains(&c) => {
                        if let Some(a) = arg_after(&line, end) {
                            for k in keys(&a) {
                                if k != "*" {
                                    self.cites.push((k, rel.clone(), ln));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        if let Some(at) = open.first() {
            self.find(
                true,
                &rel,
                *at,
                format!(
                    "a `{{` opened here is never closed ({} unclosed in this file)",
                    open.len()
                ),
            );
        }
        for (env, at) in envs {
            if env != "document" || depth == 0 {
                self.find(
                    true,
                    &rel,
                    at,
                    format!("`\\begin{{{env}}}` is never closed"),
                );
            }
        }
    }
}

/// `\verb|x|` (any delimiter) blanked out, so its braces and percent signs are not read as LaTeX.
fn blank_verb(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find("\\verb") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 5..];
        let after = after.strip_prefix('*').unwrap_or(after);
        let mut chars = after.chars();
        match chars.next() {
            Some(d) if !d.is_alphabetic() => {
                let body = chars.as_str();
                match body.find(d) {
                    Some(j) => rest = &body[j + d.len_utf8()..],
                    None => return out,
                }
            }
            _ => {
                out.push_str("\\verb");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn bib_keys(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix('@') {
            let kind: String = rest.chars().take_while(|c| c.is_alphabetic()).collect();
            if matches!(
                kind.to_lowercase().as_str(),
                "comment" | "preamble" | "string"
            ) {
                continue;
            }
            if let Some(open) = rest.find(['{', '(']) {
                let key: String = rest[open + 1..]
                    .chars()
                    .take_while(|c| *c != ',' && !c.is_whitespace())
                    .collect();
                if !key.is_empty() {
                    out.insert(key);
                }
            }
        }
    }
    out
}

/// Check the paper whose main file is `main`, with paths reported relative to `root`.
pub fn check(root: &Path, main: &Path) -> Vec<Finding> {
    let mut p = Paper::default();
    p.walk(root, main, 0);

    for (k, f, ln) in std::mem::take(&mut p.refs) {
        if !p.labels.contains_key(&k) {
            p.find(
                false,
                &f,
                ln,
                format!("`{k}` is referenced but no `\\label{{{k}}}` exists"),
            );
        }
    }

    // Bibliography: the files the paper names, or every .bib at the root when it names none.
    let mut bibs: Vec<PathBuf> = p.bib_files.iter().map(|b| root.join(b)).collect();
    let mut missing_bib = false;
    for (b, path) in p.bib_files.clone().iter().zip(bibs.clone()) {
        if !path.is_file() {
            missing_bib = true;
            let at = main
                .strip_prefix(root)
                .unwrap_or(main)
                .to_string_lossy()
                .replace('\\', "/");
            p.find(
                true,
                &at,
                0,
                format!("bibliography file `{b}` does not exist"),
            );
        }
    }
    if bibs.is_empty() {
        if let Ok(rd) = fs::read_dir(root) {
            bibs = rd
                .flatten()
                .map(|e| e.path())
                .filter(|x| x.extension().is_some_and(|e| e == "bib"))
                .collect();
        }
    }
    let mut known = p.bibitems.clone();
    for b in &bibs {
        if let Ok(t) = fs::read_to_string(b) {
            known.extend(bib_keys(&t));
        }
    }
    if !missing_bib && (!bibs.is_empty() || !known.is_empty()) {
        for (k, f, ln) in std::mem::take(&mut p.cites) {
            if !known.contains(&k) {
                p.find(
                    false,
                    &f,
                    ln,
                    format!("citation key `{k}` is not in the bibliography"),
                );
            }
        }
    }

    let mut dirs: Vec<PathBuf> = vec![root.to_path_buf()];
    dirs.extend(p.graphic_dirs.iter().map(|d| root.join(d)));
    for (g, f, ln) in std::mem::take(&mut p.graphics) {
        let found = dirs.iter().any(|d| {
            GRAPHIC_EXTS
                .iter()
                .any(|e| d.join(format!("{g}{e}")).is_file())
        });
        if !found {
            p.find(
                true,
                &f,
                ln,
                format!("`\\includegraphics{{{g}}}`: no such image"),
            );
        }
    }

    let mut out = p.findings;
    out.sort_by(|a, b| {
        b.error
            .cmp(&a.error)
            .then(a.file.cmp(&b.file))
            .then(a.line.cmp(&b.line))
    });
    out
}

/// Every file the paper reads besides `main`: its `\\input`s, the images it includes and its bibliography
/// files, as they resolve on disk. Files that do not exist are left out (`check` reports them).
pub fn referenced(root: &Path, main: &Path) -> Vec<PathBuf> {
    let mut p = Paper::default();
    p.walk(root, main, 0);
    let mut out: Vec<PathBuf> = p
        .seen
        .iter()
        .filter(|f| f.as_path() != main)
        .cloned()
        .collect();
    for b in &p.bib_files {
        let f = root.join(b);
        if f.is_file() {
            out.push(f);
        }
    }
    let mut dirs: Vec<PathBuf> = vec![root.to_path_buf()];
    dirs.extend(p.graphic_dirs.iter().map(|d| root.join(d)));
    for (g, _, _) in &p.graphics {
        if let Some(f) = dirs
            .iter()
            .flat_map(|d| GRAPHIC_EXTS.iter().map(move |e| d.join(format!("{g}{e}"))))
            .find(|f| f.is_file())
        {
            out.push(f);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The paper's main file under `root`: `main = ` in `dabir.toml`, else `main.tex`, else the one `.tex`
/// at the top level with a `\documentclass`.
pub fn find_main(root: &Path) -> Option<PathBuf> {
    if let Ok(t) = fs::read_to_string(root.join("dabir.toml")) {
        for line in t.lines() {
            let l = line.trim();
            if let Some(v) = l.strip_prefix("main") {
                let v = v.trim_start();
                if let Some(v) = v.strip_prefix('=') {
                    let v = v.trim().trim_matches('"');
                    let p = root.join(v);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
    }
    let m = root.join("main.tex");
    if m.is_file() {
        return Some(m);
    }
    let mut cands: Vec<PathBuf> = fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "tex"))
        .filter(|p| fs::read_to_string(p).is_ok_and(|t| t.contains("\\documentclass")))
        .collect();
    cands.sort();
    cands.into_iter().next()
}

/// The command-line entry: `dabir-check [main.tex]` from the paper's folder. Prints one line per
/// finding as `file:line: error|warning: message` and returns the exit code (1 when there are errors).
pub fn cli(args: &[String]) -> i32 {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let main = match args.first() {
        Some(a) => {
            let p = cwd.join(a);
            if p.is_file() {
                p
            } else {
                eprintln!("dabir-check: no such file: {a}");
                return 2;
            }
        }
        None => match find_main(&cwd) {
            Some(m) => m,
            None => {
                eprintln!("dabir-check: no main .tex here; pass it: dabir-check paper.tex");
                return 2;
            }
        },
    };
    if main.extension().is_some_and(|e| e == "typ") {
        println!("dabir-check covers LaTeX. For Typst, `typst compile` is fast: use it.");
        return 0;
    }
    let root = main.parent().unwrap_or(&cwd).to_path_buf();
    let found = check(&root, &main);
    let errors = found.iter().filter(|f| f.error).count();
    for f in &found {
        let at = if f.line > 0 {
            format!("{}:{}", f.file, f.line)
        } else {
            f.file.clone()
        };
        println!(
            "{at}: {}: {}",
            if f.error { "error" } else { "warning" },
            f.message
        );
    }
    println!(
        "dabir-check: {} error{}, {} warning{}{}",
        errors,
        if errors == 1 { "" } else { "s" },
        found.len() - errors,
        if found.len() - errors == 1 { "" } else { "s" },
        if errors == 0 {
            ". No compile needed for this change unless you changed the preamble, packages or macros."
        } else {
            "."
        }
    );
    i32::from(errors > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn paper(files: &[(&str, &str)]) -> Dir {
        let dir = Dir(std::env::temp_dir().join(format!("dabir-check-{}", uuid::Uuid::new_v4())));
        fs::create_dir_all(dir.path()).unwrap();
        for (name, text) in files {
            let p = dir.path().join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        dir
    }

    fn run(dir: &Dir) -> Vec<Finding> {
        check(dir.path(), &dir.path().join("main.tex"))
    }

    const CLEAN: &str = "\\documentclass{article}\n\\begin{document}\nSee Fig.~\\ref{fig:a} and \\cite{knuth84}. % a comment with } and {\n\\begin{figure}\\includegraphics[width=\\linewidth]{figs/plot}\\caption{x}\\label{fig:a}\\end{figure}\n\\verb|}{|\n\\bibliography{refs}\n\\end{document}\n";

    #[test]
    fn a_clean_paper_has_nothing_to_say() {
        let d = paper(&[
            ("main.tex", CLEAN),
            (
                "refs.bib",
                "@article{knuth84,\n title={TeX}}\n@comment{x}\n",
            ),
            ("figs/plot.pdf", "%PDF"),
        ]);
        assert_eq!(run(&d), vec![]);
    }

    #[test]
    fn unbalanced_braces_and_environments_are_errors_with_their_line() {
        let d = paper(&[(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\n\\textbf{oops\n\\begin{itemize}\n\\item a\n\\end{enumerate}\n\\end{document}\n",
        )]);
        let f = run(&d);
        assert!(
            f.iter()
                .any(|x| x.error && x.line == 3 && x.message.contains("never closed")),
            "{f:?}"
        );
        assert!(
            f.iter().any(|x| x.error
                && x.line == 6
                && x.message.contains("closes `\\begin{itemize}` from line 4")),
            "{f:?}"
        );
    }

    #[test]
    fn missing_labels_keys_inputs_and_images_are_named() {
        let d = paper(&[
            ("main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{sec/intro}\n\\input{sec/gone}\n\\includegraphics{nothere}\n\\bibliography{refs}\n\\end{document}\n"),
            ("sec/intro.tex", "As in \\eqref{eq:x} and \\citep[p.~3]{a, b}.\n\\label{sec:intro}\\label{sec:intro}\n"),
            ("refs.bib", "@book{a, title={A}}\n"),
        ]);
        let f = run(&d);
        let has = |error: bool, file: &str, line: usize, s: &str| {
            f.iter().any(|x| {
                x.error == error && x.file == file && x.line == line && x.message.contains(s)
            })
        };
        assert!(has(true, "main.tex", 4, "sec/gone"), "{f:?}");
        assert!(has(true, "main.tex", 5, "nothere"), "{f:?}");
        assert!(has(false, "sec/intro.tex", 1, "`eq:x`"), "{f:?}");
        assert!(has(false, "sec/intro.tex", 1, "`b`"), "{f:?}");
        assert!(!f.iter().any(|x| x.message.contains("`a`")), "{f:?}");
        assert!(has(false, "sec/intro.tex", 2, "also defined"), "{f:?}");
        // Errors first.
        assert!(f.first().unwrap().error);
    }

    #[test]
    fn verbatim_bodies_and_escaped_characters_are_not_latex() {
        let d = paper(&[(
            "main.tex",
            "\\documentclass{article}\n\\begin{document}\n50\\% and \\{ set \\}\n\\begin{lstlisting}\nint f() { return 1;\n\\end{lstlisting}\n\\end{document}\n",
        )]);
        assert_eq!(run(&d), vec![]);
    }

    #[test]
    fn the_main_file_is_found_the_way_the_app_finds_it() {
        let d = paper(&[
            ("dabir.toml", "main = \"paper.tex\"\n"),
            ("paper.tex", "\\documentclass{article}"),
        ]);
        assert_eq!(find_main(d.path()).unwrap(), d.path().join("paper.tex"));
        let d = paper(&[("notes.tex", "hi"), ("thesis.tex", "\\documentclass{book}")]);
        assert_eq!(find_main(d.path()).unwrap(), d.path().join("thesis.tex"));
    }
}
