//! The paper map: the manuscript's structure with a file and line for everything an agent might be
//! asked to change. Sections in reading order across `\input`/`\include`d files, the labels, figures,
//! tables and equations under each, the macros the preamble defines, and the bibliography files. It
//! goes at the top of every agent prompt so the first action is opening the right file at the right
//! line, not listing directories or grepping for a phrase. LaTeX and Typst.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub title: String,
    pub file: String,
    pub line: usize,
    /// False for starred (`\section*`) headings, which the paper does not number.
    pub numbered: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// `label`, `figure`, `table`, `equation`, `macro`.
    pub kind: String,
    pub name: String,
    pub file: String,
    pub line: usize,
    /// Caption start, macro body, or empty.
    pub detail: String,
    /// Index into `headings` of the section it sits in, if any.
    pub section: Option<usize>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PaperMap {
    pub main: String,
    /// Manuscript files in reading order, with their line counts.
    pub files: Vec<(String, usize)>,
    pub begin_document: Option<(String, usize)>,
    pub headings: Vec<Heading>,
    pub anchors: Vec<Anchor>,
    /// Bibliography files with entry counts.
    pub bibs: Vec<(String, usize)>,
    pub cites: usize,
    pub typst: bool,
}

/// Argument of the first `{...}` after `pos`, brace-balanced, on one line.
fn brace_arg(line: &str, pos: usize) -> Option<(String, usize)> {
    let rest = &line[pos..];
    let open = rest.find('{')?;
    let mut depth = 0usize;
    for (i, c) in rest[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((rest[open + 1..open + i].to_string(), pos + open + i + 1));
                }
            }
            _ => {}
        }
    }
    // Unclosed on this line: take what is there.
    Some((rest[open + 1..].trim_end().to_string(), line.len()))
}

/// The text of a caption or title with TeX stripped enough to read, cut short.
fn plain(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                // Drop the command name; keep its argument text (\textbf{x} → x).
                while let Some(n) = chars.peek() {
                    if n.is_alphabetic() {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
            '{' | '}' | '~' => out.push(' '),
            '$' => {}
            _ => out.push(c),
        }
    }
    let joined: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > max {
        let cut: String = joined.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    } else {
        joined
    }
}

fn line_is_comment(line: &str, typst: bool) -> bool {
    let t = line.trim_start();
    if typst {
        t.starts_with("//")
    } else {
        t.starts_with('%')
    }
}

fn strip_comment(line: &str) -> &str {
    // A % not preceded by a backslash ends the LaTeX line.
    let bytes = line.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'%' && (i == 0 || bytes[i - 1] != b'\\') {
            return &line[..i];
        }
    }
    line
}

/// A float environment that has begun and not yet ended: kind, start line, file, label, caption.
type OpenFloat = (String, usize, String, Option<String>, Option<String>);

struct Walker<'a> {
    root: &'a Path,
    map: PaperMap,
    seen: HashSet<PathBuf>,
    /// Open float environments.
    floats: Vec<OpenFloat>,
}

impl Walker<'_> {
    fn rel(&self, p: &Path) -> String {
        p.strip_prefix(self.root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/")
    }

    fn resolve(&self, from: &Path, name: &str, ext: &str) -> Option<PathBuf> {
        let name = name.trim().trim_matches('"');
        if name.is_empty() {
            return None;
        }
        let mut candidates = vec![];
        let with_ext = if Path::new(name).extension().is_some() {
            name.to_string()
        } else {
            format!("{}.{}", name, ext)
        };
        candidates.push(self.root.join(&with_ext));
        if let Some(dir) = from.parent() {
            candidates.push(dir.join(&with_ext));
        }
        candidates.into_iter().find(|p| p.is_file())
    }

    fn walk(&mut self, path: &Path, depth: usize) {
        if depth > 6 || !self.seen.insert(path.to_path_buf()) {
            return;
        }
        let Ok(text) = fs::read_to_string(path) else {
            return;
        };
        let typst = self.map.typst;
        let rel = self.rel(path);
        let lines: Vec<&str> = text.lines().collect();
        self.map.files.push((rel.clone(), lines.len()));
        for (idx, raw) in lines.iter().enumerate() {
            let n = idx + 1;
            if line_is_comment(raw, typst) {
                continue;
            }
            if typst {
                self.typst_line(path, &rel, n, raw, depth);
            } else {
                self.latex_line(path, &rel, n, strip_comment(raw), depth);
            }
        }
    }

    fn section_idx(&self) -> Option<usize> {
        if self.map.headings.is_empty() {
            None
        } else {
            Some(self.map.headings.len() - 1)
        }
    }

    fn push_anchor(&mut self, kind: &str, name: String, file: &str, line: usize, detail: String) {
        let section = self.section_idx();
        self.map.anchors.push(Anchor {
            kind: kind.into(),
            name,
            file: file.into(),
            line,
            detail,
            section,
        });
    }

    fn latex_line(&mut self, path: &Path, rel: &str, n: usize, line: &str, depth: usize) {
        const HEADINGS: &[(&str, u8)] = &[
            ("\\chapter", 0),
            ("\\section", 1),
            ("\\subsection", 2),
            ("\\subsubsection", 3),
            ("\\paragraph", 4),
        ];
        let mut i = 0;
        while let Some(off) = line[i..].find('\\') {
            let at = i + off;
            let rest = &line[at..];
            let name_end = rest[1..]
                .find(|c: char| !c.is_alphabetic() && c != '*')
                .map(|e| e + 1)
                .unwrap_or(rest.len());
            let cmd = &rest[..name_end];
            let cmd_plain = cmd.trim_end_matches('*');
            let next = at + name_end.max(1);
            if let Some((_, level)) = HEADINGS.iter().find(|(h, _)| *h == cmd_plain) {
                // Skip an optional short title.
                let mut arg_from = at + cmd.len();
                if line[arg_from..].trim_start().starts_with('[') {
                    if let Some(close) = line[arg_from..].find(']') {
                        arg_from += close + 1;
                    }
                }
                if let Some((title, _)) = brace_arg(line, arg_from) {
                    self.map.headings.push(Heading {
                        level: *level,
                        title: plain(&title, 70),
                        file: rel.into(),
                        line: n,
                        numbered: !cmd.ends_with('*'),
                    });
                }
            } else if cmd_plain == "\\label" {
                if let Some((name, _)) = brace_arg(line, at) {
                    if let Some(f) = self.floats.last_mut() {
                        if f.3.is_none() {
                            f.3 = Some(name.trim().to_string());
                        }
                    } else {
                        self.push_anchor("label", name.trim().into(), rel, n, String::new());
                    }
                }
            } else if cmd_plain == "\\caption" {
                if let Some((cap, _)) = brace_arg(line, at) {
                    if let Some(f) = self.floats.last_mut() {
                        if f.4.is_none() {
                            f.4 = Some(plain(&cap, 60));
                        }
                    }
                }
            } else if cmd_plain == "\\begin" {
                if let Some((env, _)) = brace_arg(line, at) {
                    let env = env.trim().trim_end_matches('*');
                    match env {
                        "figure" | "table" | "algorithm" | "listing" | "wrapfigure"
                        | "subfigure" | "figure*" | "table*" => {
                            let kind = if env.starts_with("table") {
                                "table"
                            } else {
                                "figure"
                            };
                            self.floats.push((kind.into(), n, rel.into(), None, None));
                        }
                        "equation" | "align" | "gather" | "multline" | "eqnarray" | "theorem"
                        | "lemma" | "proposition" | "corollary" | "definition" | "algorithmic" => {
                            let kind = if matches!(
                                env,
                                "theorem" | "lemma" | "proposition" | "corollary" | "definition"
                            ) {
                                env
                            } else {
                                "equation"
                            };
                            self.floats.push((kind.into(), n, rel.into(), None, None));
                        }
                        "document" => self.map.begin_document = Some((rel.into(), n)),
                        _ => {}
                    }
                }
            } else if cmd_plain == "\\end" {
                if let Some((env, _)) = brace_arg(line, at) {
                    let env = env.trim().trim_end_matches('*');
                    let closes = matches!(
                        env,
                        "figure"
                            | "table"
                            | "algorithm"
                            | "listing"
                            | "wrapfigure"
                            | "subfigure"
                            | "equation"
                            | "align"
                            | "gather"
                            | "multline"
                            | "eqnarray"
                            | "theorem"
                            | "lemma"
                            | "proposition"
                            | "corollary"
                            | "definition"
                            | "algorithmic"
                    );
                    if closes {
                        if let Some((kind, start, file, label, caption)) = self.floats.pop() {
                            // A subfigure inside a figure is not its own anchor; only labelled or
                            // captioned environments are worth a line.
                            if env != "subfigure" && env != "algorithmic" {
                                if let Some(label) = label {
                                    self.push_anchor(
                                        &kind,
                                        label,
                                        &file,
                                        start,
                                        caption.unwrap_or_default(),
                                    );
                                } else if let Some(caption) = caption {
                                    self.push_anchor(&kind, String::new(), &file, start, caption);
                                }
                            } else if let (Some(label), Some(parent)) =
                                (label, self.floats.last_mut())
                            {
                                if parent.3.is_none() {
                                    parent.3 = Some(label);
                                }
                            }
                        }
                    }
                }
            } else if matches!(
                cmd_plain,
                "\\newcommand"
                    | "\\renewcommand"
                    | "\\providecommand"
                    | "\\DeclareMathOperator"
                    | "\\NewDocumentCommand"
                    | "\\DeclarePairedDelimiter"
            ) {
                let after = &line[at + cmd.len()..];
                let after_trim = after.trim_start();
                let name = if let Some(stripped) = after_trim.strip_prefix('{') {
                    stripped.split('}').next().unwrap_or("").trim().to_string()
                } else if let Some(rest) = after_trim.strip_prefix('\\') {
                    let end = rest
                        .find(|c: char| !c.is_alphabetic())
                        .map(|e| e + 1)
                        .unwrap_or(after_trim.len());
                    after_trim[..end].to_string()
                } else {
                    String::new()
                };
                if !name.is_empty() {
                    let body = brace_arg(
                        line,
                        at + cmd.len() + (after.len() - after_trim.len()) + name.len(),
                    )
                    .map(|(b, _)| {
                        let b: String = b.split_whitespace().collect::<Vec<_>>().join(" ");
                        if b.chars().count() > 40 {
                            format!("{}…", b.chars().take(39).collect::<String>())
                        } else {
                            b
                        }
                    })
                    .unwrap_or_default();
                    self.push_anchor("macro", name, rel, n, body);
                }
            } else if cmd_plain == "\\def" {
                let after = line[at + 4..].trim_start();
                if let Some(rest) = after.strip_prefix('\\') {
                    let end = rest
                        .find(|c: char| !c.is_alphabetic())
                        .map(|e| e + 1)
                        .unwrap_or(after.len());
                    self.push_anchor("macro", after[..end].into(), rel, n, String::new());
                }
            } else if matches!(
                cmd_plain,
                "\\input" | "\\include" | "\\subfile" | "\\import" | "\\subimport"
            ) {
                let mut arg_at = at;
                let mut prefix_dir = None;
                if matches!(cmd_plain, "\\import" | "\\subimport") {
                    if let Some((dir, end)) = brace_arg(line, at) {
                        prefix_dir = Some(dir);
                        arg_at = end;
                    }
                }
                if let Some((name, _)) = brace_arg(line, arg_at) {
                    let name = match prefix_dir {
                        Some(d) => format!("{}/{}", d.trim_end_matches('/'), name.trim()),
                        None => name,
                    };
                    if let Some(p) = self.resolve(path, &name, "tex") {
                        self.walk(&p, depth + 1);
                    }
                }
            } else if matches!(cmd_plain, "\\bibliography" | "\\addbibresource") {
                if let Some((names, _)) = brace_arg(line, at) {
                    for name in names.split(',') {
                        if let Some(p) = self.resolve(path, name, "bib") {
                            let count = fs::read_to_string(&p)
                                .map(|t| {
                                    t.lines()
                                        .filter(|l| l.trim_start().starts_with('@'))
                                        .count()
                                })
                                .unwrap_or(0);
                            let rel = self.rel(&p);
                            if !self.map.bibs.iter().any(|(r, _)| *r == rel) {
                                self.map.bibs.push((rel, count));
                            }
                        }
                    }
                }
            } else if cmd_plain.starts_with("\\cite")
                || matches!(
                    cmd_plain,
                    "\\parencite" | "\\textcite" | "\\autocite" | "\\citep" | "\\citet"
                )
            {
                self.map.cites += 1;
            }
            i = next;
        }
    }

    fn typst_line(&mut self, path: &Path, rel: &str, n: usize, raw: &str, depth: usize) {
        let t = raw.trim_start();
        if t.starts_with('=') {
            let level = t.chars().take_while(|c| *c == '=').count() as u8;
            let title = t.trim_start_matches('=').trim();
            if !title.is_empty() && t.chars().nth(level as usize) == Some(' ') {
                self.map.headings.push(Heading {
                    level,
                    title: plain(title, 70),
                    file: rel.into(),
                    line: n,
                    numbered: true,
                });
                // A label on the heading line, `= Title <sec:x>`, belongs to it.
            }
        }
        if let Some(i) = t.find("#figure(") {
            let _ = i;
            let caption = t
                .find("caption:")
                .and_then(|c| brace_like(&t[c + 8..]))
                .unwrap_or_default();
            let label = trailing_label(t);
            if label.is_some() || !caption.is_empty() {
                let kind = if t.contains("table(") {
                    "table"
                } else {
                    "figure"
                };
                self.push_anchor(kind, label.unwrap_or_default(), rel, n, plain(&caption, 60));
            }
        } else if t.starts_with('$') && t.ends_with('$') || t.contains("$ <") {
            if let Some(label) = trailing_label(t) {
                self.push_anchor("equation", label, rel, n, String::new());
            }
        } else if let Some(label) = trailing_label(t) {
            if !t.starts_with('=') {
                self.push_anchor("label", label, rel, n, String::new());
            }
        }
        if let Some(rest) = t.strip_prefix("#let ") {
            let name: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !name.is_empty() && rest[name.len()..].starts_with('(') {
                self.push_anchor("macro", name, rel, n, String::new());
            }
        }
        if let Some(i) = t.find("#include ") {
            let arg = t[i + 9..].trim().trim_matches(|c| c == '"' || c == ';');
            if let Some(p) = self.resolve(path, arg, "typ") {
                self.walk(&p, depth + 1);
            }
        }
        if let Some(i) = t.find("#bibliography(") {
            let args = &t[i + 14..];
            for name in args.split(['"', ',', '(', ')']) {
                if name.ends_with(".bib") || name.ends_with(".yml") || name.ends_with(".yaml") {
                    if let Some(p) = self.resolve(path, name, "bib") {
                        let count = fs::read_to_string(&p)
                            .map(|t| {
                                t.lines()
                                    .filter(|l| l.trim_start().starts_with('@'))
                                    .count()
                            })
                            .unwrap_or(0);
                        let rel = self.rel(&p);
                        if !self.map.bibs.iter().any(|(r, _)| *r == rel) {
                            self.map.bibs.push((rel, count));
                        }
                    }
                }
            }
        }
        self.map.cites += t.matches("@").count().min(20);
    }
}

/// Typst `<name>` label at the end of a line.
fn trailing_label(t: &str) -> Option<String> {
    let t = t.trim_end();
    if !t.ends_with('>') {
        return None;
    }
    let open = t.rfind('<')?;
    let name = &t[open + 1..t.len() - 1];
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ':' | '-' | '_' | '.'))
    {
        return None;
    }
    Some(name.to_string())
}

/// A Typst `[...]` content block after `caption:`.
fn brace_like(s: &str) -> Option<String> {
    let s = s.trim_start();
    let open = s.find('[')?;
    let mut depth = 0usize;
    for (i, c) in s[open..].char_indices() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[open + 1..open + i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Build the map from the main file, following includes.
pub fn build(root: &Path, main: &Path) -> PaperMap {
    let typst = main.extension().map(|e| e == "typ").unwrap_or(false);
    let mut w = Walker {
        root,
        map: PaperMap {
            main: main
                .strip_prefix(root)
                .unwrap_or(main)
                .to_string_lossy()
                .replace('\\', "/"),
            typst,
            ..Default::default()
        },
        seen: HashSet::new(),
        floats: vec![],
    };
    w.walk(main, 0);
    // Bib files nothing references but that sit at the root still count.
    if w.map.bibs.is_empty() {
        if let Ok(rd) = fs::read_dir(root) {
            let mut bibs: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "bib").unwrap_or(false))
                .collect();
            bibs.sort();
            for p in bibs {
                let count = fs::read_to_string(&p)
                    .map(|t| {
                        t.lines()
                            .filter(|l| l.trim_start().starts_with('@'))
                            .count()
                    })
                    .unwrap_or(0);
                let rel = w.rel(&p);
                w.map.bibs.push((rel, count));
            }
        }
    }
    w.map
}

/// The map as the text an agent reads: reading order, one line per heading, anchors under their
/// heading. Trimmed from the least useful end (macro bodies, captions, then anchors on deep
/// headings) until it fits `max_chars`.
pub fn render(map: &PaperMap, max_chars: usize) -> String {
    for detail in [3u8, 2, 1, 0] {
        let s = render_at(map, detail);
        if s.len() <= max_chars {
            return s;
        }
    }
    // Still too long: keep whole lines and say what fell off, so no location is half-quoted.
    let s = render_at(map, 0);
    let mut out = String::new();
    let mut dropped = 0usize;
    for line in s.lines() {
        if dropped == 0 && out.len() + line.len() < max_chars.saturating_sub(60) {
            out.push_str(line);
            out.push('\n');
        } else {
            dropped += 1;
        }
    }
    if dropped > 0 {
        out.push_str(&format!(
            "({dropped} more lines of the map not shown; later sections and the bibliography are in the files listed above)\n"
        ));
    }
    out
}

fn render_at(map: &PaperMap, detail: u8) -> String {
    let mut out = String::new();
    let multi = map.files.len() > 1;
    if multi {
        let list: Vec<String> = map
            .files
            .iter()
            .map(|(f, n)| {
                if detail >= 1 {
                    format!("{} ({} lines)", f, n)
                } else {
                    f.clone()
                }
            })
            .collect();
        out.push_str(&format!(
            "Manuscript files in reading order: {}\n",
            list.join(", ")
        ));
    } else if let Some((f, n)) = map.files.first() {
        out.push_str(&format!("Manuscript: {} ({} lines)\n", f, n));
    }
    if let Some((f, n)) = &map.begin_document {
        out.push_str(&format!(
            "Preamble {}:1-{}; the text starts after \\begin{{document}} at line {}\n",
            f,
            n.saturating_sub(1),
            n
        ));
    }
    let loc = |file: &str, line: usize| -> String {
        if multi {
            format!("{}:{}", file, line)
        } else {
            format!("{}", line)
        }
    };
    if !multi && !map.headings.is_empty() {
        out.push_str("Sections (line numbers in the manuscript):\n");
    } else if !map.headings.is_empty() {
        out.push_str("Sections (file:line):\n");
    }
    // Number headings the way the paper would.
    let mut counters = [0usize; 5];
    for (hi, h) in map.headings.iter().enumerate() {
        let lvl = h.level.min(4) as usize;
        if h.numbered {
            counters[lvl] += 1;
            for c in counters.iter_mut().skip(lvl + 1) {
                *c = 0;
            }
        }
        let number: Vec<String> = (1..=lvl)
            .filter(|l| counters[*l] > 0)
            .map(|l| counters[l].to_string())
            .collect();
        let indent = "  ".repeat(lvl.saturating_sub(1));
        let num = if lvl == 4 || number.is_empty() || !h.numbered {
            String::new()
        } else {
            format!("{} ", number.join("."))
        };
        out.push_str(&format!(
            "{}{}{} {}",
            indent,
            num,
            h.title,
            loc(&h.file, h.line)
        ));
        let anchors: Vec<&Anchor> = map
            .anchors
            .iter()
            .filter(|a| a.section == Some(hi) && a.kind != "macro")
            .collect();
        let show_anchors = detail >= 1 || lvl <= 2;
        if show_anchors && !anchors.is_empty() {
            let items: Vec<String> = anchors
                .iter()
                .map(|a| {
                    let name = if a.name.is_empty() {
                        a.kind.clone()
                    } else {
                        a.name.clone()
                    };
                    if detail >= 2 && !a.detail.is_empty() {
                        format!("{} {} “{}”", name, loc(&a.file, a.line), a.detail)
                    } else {
                        format!("{} {}", name, loc(&a.file, a.line))
                    }
                })
                .collect();
            out.push_str(&format!("  [{}]", items.join("; ")));
        }
        out.push('\n');
    }
    // Anchors before the first heading (abstract figures, preamble labels).
    let loose: Vec<&Anchor> = map
        .anchors
        .iter()
        .filter(|a| a.section.is_none() && a.kind != "macro")
        .collect();
    if !loose.is_empty() {
        let items: Vec<String> = loose
            .iter()
            .map(|a| {
                let name = if a.name.is_empty() {
                    a.kind.clone()
                } else {
                    a.name.clone()
                };
                format!("{} {}", name, loc(&a.file, a.line))
            })
            .collect();
        out.push_str(&format!("Before the first section: {}\n", items.join("; ")));
    }
    let macros: Vec<&Anchor> = map.anchors.iter().filter(|a| a.kind == "macro").collect();
    if !macros.is_empty() {
        let items: Vec<String> = macros
            .iter()
            .take(if detail >= 1 { 40 } else { 12 })
            .map(|a| {
                if detail >= 3 && !a.detail.is_empty() {
                    format!("{} {} = {}", a.name, loc(&a.file, a.line), a.detail)
                } else {
                    format!("{} {}", a.name, loc(&a.file, a.line))
                }
            })
            .collect();
        let more = macros.len().saturating_sub(items.len());
        out.push_str(&format!(
            "Macros defined: {}{}\n",
            items.join(", "),
            if more > 0 {
                format!(" (+{} more)", more)
            } else {
                String::new()
            }
        ));
    }
    if !map.bibs.is_empty() {
        let items: Vec<String> = map
            .bibs
            .iter()
            .map(|(f, n)| format!("{} ({} entries)", f, n))
            .collect();
        out.push_str(&format!(
            "Bibliography: {}; {} citation commands in the text\n",
            items.join(", "),
            map.cites
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paper() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dabir-map-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("sections")).unwrap();
        fs::write(
            dir.join("main.tex"),
            "\\documentclass{article}\n\\newcommand{\\E}{\\mathbb{E}}\n\\DeclareMathOperator{\\score}{s}\n\\input{macros}\n% \\section{Not this}\n\\begin{document}\n\\title{T}\n\\begin{abstract}x\\end{abstract}\n\\section{Introduction}\\label{sec:intro}\nText \\cite{a,b} and \\citep{c}.\n\\input{sections/method}\n\\section*{Acknowledgements}\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n",
        )
        .unwrap();
        fs::write(
            dir.join("macros.tex"),
            "\\def\\norm#1{\\lVert #1 \\rVert}\n",
        )
        .unwrap();
        fs::write(
            dir.join("sections").join("method.tex"),
            "\\section[Short]{Method and \\textbf{prior}}\n\\subsection{Forward model}\n\\begin{equation}\n y = Ax + n \\label{eq:forward}\n\\end{equation}\n\\begin{figure}[t]\n\\centering\n\\includegraphics{f.pdf}\n\\caption{PSNR against noise level for three samplers.}\n\\label{fig:psnr}\n\\end{figure}\n\\subsection{Sampler}\\label{sec:sampler}\n\\begin{table}\\caption{Ablation}\\label{tab:abl}\\end{table}\n\\paragraph{Cost.} Cheap \\cite{d}.\n",
        )
        .unwrap();
        fs::write(
            dir.join("refs.bib"),
            "@article{a,}\n@book{b,}\n@misc{c,}\n@misc{d,}\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn map_follows_inputs_and_places_anchors_under_headings() {
        let dir = paper();
        let m = build(&dir, &dir.join("main.tex"));
        assert_eq!(
            m.files.iter().map(|(f, _)| f.as_str()).collect::<Vec<_>>(),
            vec!["main.tex", "macros.tex", "sections/method.tex"]
        );
        assert_eq!(m.begin_document, Some(("main.tex".into(), 6)));
        let titles: Vec<&str> = m.headings.iter().map(|h| h.title.as_str()).collect();
        assert_eq!(
            titles,
            vec![
                "Introduction",
                "Method and prior",
                "Forward model",
                "Sampler",
                "Cost.",
                "Acknowledgements"
            ]
        );
        assert_eq!(m.headings[1].file, "sections/method.tex");
        let by_name = |n: &str| m.anchors.iter().find(|a| a.name == n).unwrap();
        assert_eq!(by_name("eq:forward").kind, "equation");
        assert_eq!(by_name("eq:forward").line, 3);
        assert_eq!(
            by_name("fig:psnr").detail,
            "PSNR against noise level for three samplers."
        );
        assert_eq!(by_name("fig:psnr").section, Some(2));
        assert_eq!(by_name("tab:abl").kind, "table");
        assert_eq!(by_name("sec:intro").kind, "label");
        assert_eq!(by_name("\\E").kind, "macro");
        assert!(m.anchors.iter().any(|a| a.name == "\\score"));
        assert!(m.anchors.iter().any(|a| a.name == "\\norm"));
        assert_eq!(m.bibs, vec![("refs.bib".to_string(), 4)]);
        assert_eq!(m.cites, 3);

        let text = render(&m, 4000);
        assert!(text.contains("Manuscript files in reading order: main.tex (15 lines), macros.tex (1 lines), sections/method.tex (14 lines)"), "{text}");
        assert!(
            text.contains("1 Introduction main.tex:9  [sec:intro main.tex:9]"),
            "{text}"
        );
        assert!(
            text.contains("2 Method and prior sections/method.tex:1"),
            "{text}"
        );
        assert!(text.contains("  2.1 Forward model sections/method.tex:2  [eq:forward sections/method.tex:3; fig:psnr sections/method.tex:6 “PSNR against noise level for three samplers.”]"), "{text}");
        assert!(
            text.contains("Bibliography: refs.bib (4 entries); 3 citation commands"),
            "{text}"
        );
        assert!(
            text.contains("\nAcknowledgements main.tex:12\n"),
            "starred heading unnumbered: {text}"
        );
        assert!(text.contains("\\E main.tex:2 = \\mathbb{E}"), "{text}");
        // Tight budgets shed detail but keep the skeleton.
        let short = render(&m, 500);
        assert!(
            short.len() <= 500 && short.contains("2 Method and prior"),
            "{short}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn typst_headings_labels_and_includes() {
        let dir = std::env::temp_dir().join(format!("dabir-map-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("main.typ"),
            "#let score(x) = $s(x)$\n= Introduction <sec:intro>\nSee @smith.\n#include \"method.typ\"\n#bibliography(\"refs.bib\")\n",
        )
        .unwrap();
        fs::write(
            dir.join("method.typ"),
            "== Forward model\n$ y = A x + n $ <eq:forward>\n#figure(image(\"f.png\"), caption: [PSNR against noise]) <fig:psnr>\n",
        )
        .unwrap();
        fs::write(dir.join("refs.bib"), "@article{smith,}\n").unwrap();
        let m = build(&dir, &dir.join("main.typ"));
        assert!(m.typst);
        assert_eq!(m.headings.len(), 2);
        assert_eq!(m.headings[1].title, "Forward model");
        assert!(m
            .anchors
            .iter()
            .any(|a| a.name == "eq:forward" && a.kind == "equation"));
        assert!(m
            .anchors
            .iter()
            .any(|a| a.name == "fig:psnr" && a.detail == "PSNR against noise"));
        assert!(m
            .anchors
            .iter()
            .any(|a| a.name == "score" && a.kind == "macro"));
        assert_eq!(m.bibs, vec![("refs.bib".to_string(), 1)]);
        let _ = fs::remove_dir_all(&dir);
    }
}
