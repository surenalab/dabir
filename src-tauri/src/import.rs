//! Import: a Word document (.docx) becomes a LaTeX paper, through pandoc.
//!
//! A coauthor or a supervisor sends a .docx; the result is a folder a researcher would keep:
//! `main.tex` on the house article layout (the bundled `article` template) with only the packages the
//! text uses, the images under `figures/`, and `refs.bib` when the citations were inserted with
//! Zotero, Mendeley or EndNote.
//!
//! Pandoc reads the document once into its JSON tree (`docx+citations`, tracked changes accepted,
//! media extracted into `figures/`). The tree is then reshaped here: title, authors, date and a
//! leading "Abstract" paragraph become the front matter; equations become `$…$` and `equation*`s,
//! numbered only where the Word author numbered them by hand (`equation_marker`); tables become
//! booktabs `tabular`s (in a `table` float when Word had a caption);
//! images are sized as the share of the line they had on the Word page; "Figure 1:" is taken off
//! captions, since LaTeX numbers them; citations become `\cite` with readable keys. A second pandoc
//! run writes the LaTeX, and a last pass removes pandoc's scaffolding (`\tightlist`, default list
//! labels) so the source reads as if written by hand. Nothing is written outside the new folder:
//! pandoc runs inside it, in its sandbox (no network, no other files), and the tree goes through its
//! standard input and output.
//!
//! What does not come across: page layout, fonts, colours, headers and footers (the paper uses the
//! article class); comments (left out, counted in the report); tracked changes (accepted, counted);
//! citations typed as text (they stay text); images LaTeX cannot place (EMF, WMF, TIFF, SVG), which
//! get a framed note naming the file. Tables with cells merged down a column, or with several
//! paragraphs in a cell, keep pandoc's own `longtable` layout.
//!
//! `revisions` reads the tracked changes and comments instead of accepting them. It is the start of
//! the round trip (export to Word, a coauthor edits with Track Changes on, the edits come back as
//! suggestions in the review surface) and no command calls it yet.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const NO_PANDOC: &str =
    "pandoc is not installed. Install it from Help › Set Up Dabir (or from pandoc.org), then import again.";

/// Where the extracted images go, relative to the paper's folder.
const FIGURES: &str = "figures";
/// Image formats the bundled engine can place.
const PLACEABLE: &[&str] = &["png", "jpg", "jpeg", "pdf"];
/// Account names Word writes as the author when nobody set one.
const PLACEHOLDER_AUTHORS: &[&str] = &[
    "microsoft office user",
    "windows user",
    "user",
    "author",
    "unknown",
    "python-docx",
    "apache poi",
];

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The new paper's folder.
    pub path: String,
    pub main: String,
    /// The Word file's name.
    pub source: String,
    pub title: String,
    /// One sentence: what was converted.
    pub summary: String,
    pub sections: usize,
    pub figures: usize,
    pub tables: usize,
    pub equations: usize,
    pub inline_math: usize,
    pub citations: usize,
    pub references: usize,
    pub footnotes: usize,
    /// What to check against the Word file, most important first.
    pub notes: Vec<String>,
    /// `pandoc 3.x`, as it reported itself.
    pub pandoc: String,
}

/// What pandoc does with Word's revisions (`--track-changes`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrackChanges {
    /// Insertions kept, deletions dropped: Word's No Markup view.
    Accept,
    /// The document as it was before the changes.
    #[cfg_attr(not(test), allow(dead_code))]
    Reject,
    /// Both, marked as spans with the author and date, and comments too.
    All,
}

impl TrackChanges {
    fn flag(self) -> &'static str {
        match self {
            TrackChanges::Accept => "--track-changes=accept",
            TrackChanges::Reject => "--track-changes=reject",
            TrackChanges::All => "--track-changes=all",
        }
    }
}

/// What the .docx holds that pandoc will not carry into LaTeX, read from the package itself.
#[derive(Debug, Default, PartialEq)]
pub struct Inventory {
    pub comments: usize,
    pub revisions: usize,
    /// The reference manager whose fields the document carries.
    pub manager: Option<&'static str>,
    /// Width of the text block on the Word page, in inches.
    pub text_width: f64,
}

fn display_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.display().to_string())
}

fn read_part<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// The value of ` name="…"` inside one XML tag.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let key = format!(" {}=\"", name);
    let start = tag.find(&key)? + key.len();
    let end = tag[start..].find('"')? + start;
    Some(&tag[start..end])
}

/// The last `<name …>` tag in `xml`, attributes included.
fn last_tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{} ", name);
    let start = xml.rfind(&open)?;
    let end = xml[start..].find('>')? + start;
    Some(&xml[start..end])
}

/// The main part named by the package relationships; Office 365 sometimes writes `document2.xml`.
fn office_document(rels: &str) -> Option<String> {
    rels.split("<Relationship ")
        .skip(1)
        .map(|r| format!(" {}", r))
        .find(|r| {
            attr(r, "Type")
                .map(|t| t.ends_with("/officeDocument"))
                .unwrap_or(false)
        })
        .and_then(|r| attr(&r, "Target").map(|t| t.trim_start_matches('/').to_string()))
}

/// Page width less the side margins of the last section, in inches; 6.5 (Letter, 1 inch margins) when unset.
fn text_width(doc: &str) -> f64 {
    let twips = |tag: Option<&str>, names: &[&str]| -> Option<f64> {
        let tag = tag?;
        names
            .iter()
            .find_map(|n| attr(tag, n))
            .and_then(|v| v.parse::<f64>().ok())
    };
    let size = last_tag(doc, "w:pgSz");
    let margins = last_tag(doc, "w:pgMar");
    match (
        twips(size, &["w:w"]),
        twips(margins, &["w:left", "w:start"]),
        twips(margins, &["w:right", "w:end"]),
    ) {
        (Some(w), Some(l), Some(r)) if w - l - r > 1440.0 => (w - l - r) / 1440.0,
        (Some(w), None, None) if w > 2880.0 => (w - 2880.0) / 1440.0,
        _ => 6.5,
    }
}

/// Read the package without pandoc: is it a .docx, and what in it will not survive the conversion.
pub fn inspect(docx: &Path) -> Result<Inventory, String> {
    let name = display_name(docx);
    let bytes = fs::read(docx).map_err(|e| format!("Could not open {}: {}", name, e))?;
    if bytes.starts_with(&[0xD0, 0xCF, 0x11, 0xE0]) {
        return Err(format!(
            "{} is a Word 97–2004 document (.doc). Open it in Word, save it as .docx, then import again.",
            name
        ));
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| format!("{} is not a Word document (.docx).", name))?;
    let main = read_part(&mut zip, "_rels/.rels")
        .and_then(|r| office_document(&r))
        .unwrap_or_else(|| "word/document.xml".into());
    let doc = read_part(&mut zip, &main)
        .filter(|d| d.contains("<w:body"))
        .ok_or_else(|| format!("{} is not a Word document (.docx): it has no text.", name))?;
    let comments = read_part(&mut zip, "word/comments.xml")
        .map(|c| c.matches("<w:comment ").count())
        .unwrap_or(0);
    let revisions = ["<w:ins ", "<w:del ", "<w:moveFrom ", "<w:moveTo "]
        .iter()
        .map(|t| doc.matches(t).count())
        .sum();
    let manager = if doc.contains("ZOTERO_ITEM") {
        Some("Zotero")
    } else if doc.contains("ADDIN EN.CITE") {
        Some("EndNote")
    } else if doc.contains("CSL_CITATION") || doc.contains("ADDIN Mendeley") {
        Some("Mendeley")
    } else {
        None
    };
    Ok(Inventory {
        comments,
        revisions,
        manager,
        text_width: text_width(&doc),
    })
}

// ---------------------------------------------------------------- pandoc

fn version(pandoc: &Path) -> String {
    crate::spawn::tool(pandoc)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(|l| l.trim().to_string())
        })
        .unwrap_or_else(|| "pandoc".into())
}

fn first_lines(s: &str) -> String {
    s.lines()
        .filter(|l| !l.trim().is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run pandoc with `input` on its standard input; stdout and stderr on success, stderr on failure.
fn run(mut cmd: Command, input: Option<Vec<u8>>) -> Result<(String, String), String> {
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start pandoc: {}", e))?;
    let writer = match (input, child.stdin.take()) {
        (Some(bytes), Some(mut stdin)) => Some(std::thread::spawn(move || {
            let _ = stdin.write_all(&bytes);
        })),
        _ => None,
    };
    let out = child
        .wait_with_output()
        .map_err(|e| format!("pandoc did not finish: {}", e))?;
    if let Some(w) = writer {
        let _ = w.join();
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        return Err(if stderr.trim().is_empty() {
            format!("pandoc stopped ({})", out.status)
        } else {
            stderr
        });
    }
    Ok((String::from_utf8_lossy(&out.stdout).to_string(), stderr))
}

/// The document as pandoc's JSON tree, and pandoc's warnings. `media` extracts the images into that
/// folder, relative to `cwd`.
fn read_tree(
    pandoc: &Path,
    docx: &Path,
    cwd: &Path,
    media: Option<&str>,
    track: TrackChanges,
) -> Result<(Value, String), String> {
    let attempt = |citations: bool, sandbox: bool| {
        let mut cmd = crate::spawn::tool(pandoc);
        cmd.current_dir(cwd).arg(docx).args([
            "--from",
            if citations { "docx+citations" } else { "docx" },
            "--to",
            "json",
            track.flag(),
        ]);
        if sandbox {
            cmd.arg("--sandbox");
        }
        if let Some(m) = media {
            cmd.arg(format!("--extract-media={}", m));
        }
        run(cmd, None)
    };
    // The sandbox keeps pandoc from reading anything but the document or reaching the network (pandoc
    // 2.15 on); reference-manager citations need a recent pandoc. An older one refuses either, and the
    // read is tried again without it.
    let (mut citations, mut sandbox) = (true, true);
    let (out, warnings) = loop {
        match attempt(citations, sandbox) {
            Ok(r) => break r,
            Err(e) if sandbox && e.contains("--sandbox") => sandbox = false,
            Err(e)
                if citations
                    && e.contains("citations")
                    && e.to_lowercase().contains("extension") =>
            {
                citations = false
            }
            Err(e) => {
                return Err(format!(
                    "pandoc could not read the document: {}",
                    first_lines(&e)
                ))
            }
        }
    };
    let tree: Value = serde_json::from_str(&out)
        .map_err(|e| format!("pandoc gave an answer Dabir could not read: {}", e))?;
    if !tree.get("blocks").map(Value::is_array).unwrap_or(false) {
        return Err("pandoc gave an answer Dabir could not read: no blocks.".into());
    }
    Ok((tree, warnings))
}

fn write_with(
    pandoc: &Path,
    cwd: &Path,
    to: &str,
    doc: &Value,
) -> Result<(String, String), String> {
    let mut cmd = crate::spawn::tool(pandoc);
    cmd.current_dir(cwd)
        .args(["--from", "json", "--to", to, "--wrap=none"]);
    if to == "bibtex" {
        cmd.arg("--standalone");
    }
    run(cmd, Some(doc.to_string().into_bytes()))
}

// ---------------------------------------------------------------- the tree

fn kind(v: &Value) -> &str {
    v.get("t").and_then(Value::as_str).unwrap_or("")
}

fn raw(s: impl Into<String>) -> Value {
    json!({"t": "RawInline", "c": ["latex", s.into()]})
}

fn plain(inlines: Vec<Value>) -> Value {
    json!({"t": "Plain", "c": inlines})
}

/// Inlines that stand in for one node; spliced into the surrounding list after the walk, since
/// pandoc writes a plain span as a TeX group.
const SPLICE: &str = "dabir-splice";
const CITE: &str = "dabir-cite";

fn splice(inlines: Vec<Value>, class: &str) -> Value {
    json!({"t": "Span", "c": [["", [SPLICE, class], []], inlines]})
}

fn splice_class(v: &Value) -> Option<&str> {
    if kind(v) != "Span" {
        return None;
    }
    let classes = v["c"][0][1].as_array()?;
    if classes.first()?.as_str()? != SPLICE {
        return None;
    }
    classes.get(1)?.as_str()
}

/// Replace the marked spans in `items` with their contents; a citation takes the space before it as a tie.
fn splice_marked(items: &mut Vec<Value>) {
    if !items.iter().any(|i| splice_class(i).is_some()) {
        return;
    }
    let mut out: Vec<Value> = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        match splice_class(&item) {
            Some(class) => {
                if class == CITE && out.last().map(|l| kind(l) == "Space").unwrap_or(false) {
                    out.pop();
                    out.push(raw("~"));
                }
                if let Some(inner) = item["c"][1].as_array() {
                    out.extend(inner.iter().cloned());
                }
            }
            None => out.push(item),
        }
    }
    *items = out;
}

fn marker(name: &str) -> Value {
    json!({"t": "RawBlock", "c": ["latex", format!("%%DABIR:{}%%", name)]})
}

fn get_path_mut<'a>(v: &'a mut Value, path: &[usize]) -> Option<&'a mut Value> {
    path.iter()
        .try_fold(v, |v, &i| v.as_array_mut().and_then(|a| a.get_mut(i)))
}

/// The words of a node, spaces collapsed; notes and raw TeX left out.
fn text_of(v: &Value) -> String {
    fn collect(v: &Value, out: &mut String) {
        match v {
            Value::Array(items) => items.iter().for_each(|i| collect(i, out)),
            Value::Object(map) => match kind(v) {
                "Str" | "MetaString" => out.push_str(map["c"].as_str().unwrap_or("")),
                "Space" | "SoftBreak" | "LineBreak" => out.push(' '),
                "Code" | "Math" => out.push_str(map["c"][1].as_str().unwrap_or("")),
                "Note" | "RawInline" | "RawBlock" => {}
                "Para" | "Plain" | "Header" => {
                    collect(&map["c"], out);
                    out.push(' ');
                }
                "MetaMap" => {
                    if let Some(m) = map["c"].as_object() {
                        for x in m.values() {
                            collect(x, out);
                            out.push(' ');
                        }
                    }
                }
                _ => {
                    if let Some(c) = map.get("c") {
                        collect(c, out)
                    }
                }
            },
            _ => {}
        }
    }
    let mut out = String::new();
    collect(v, &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Metadata as inlines: MetaInlines as they are, a string as one word, blocks as their first paragraph.
fn meta_inlines(v: &Value) -> Vec<Value> {
    match kind(v) {
        "MetaInlines" => v["c"].as_array().cloned().unwrap_or_default(),
        "MetaString" => vec![json!({"t": "Str", "c": v["c"].as_str().unwrap_or("")})],
        "MetaBlocks" => v["c"]
            .as_array()
            .and_then(|b| b.first())
            .and_then(|b| b["c"].as_array().cloned())
            .unwrap_or_default(),
        _ => vec![],
    }
}

fn is_placeholder_author(inlines: &[Value]) -> bool {
    let t = text_of(&Value::Array(inlines.to_vec())).to_lowercase();
    t.is_empty() || PLACEHOLDER_AUTHORS.contains(&t.as_str())
}

fn authors(meta: &Value) -> Vec<Vec<Value>> {
    let a = &meta["author"];
    let list: Vec<Vec<Value>> = if kind(a) == "MetaList" {
        a["c"]
            .as_array()
            .map(|l| l.iter().map(meta_inlines).collect())
            .unwrap_or_default()
    } else {
        vec![meta_inlines(a)]
    };
    list.into_iter()
        .filter(|i| !is_placeholder_author(i))
        .collect()
}

/// "Abstract", "Abstract:" or "ABSTRACT" on its own.
fn is_abstract_label(b: &Value) -> bool {
    matches!(kind(b), "Para" | "Plain" | "Header")
        && text_of(b)
            .trim_end_matches([':', '.', '—', '–', '-'])
            .trim()
            .eq_ignore_ascii_case("abstract")
}

/// A paragraph that opens with the label: "Abstract—We study…", "**Abstract:** We study…".
fn leads_with_abstract(b: &Value) -> bool {
    if !matches!(kind(b), "Para" | "Plain") {
        return false;
    }
    let t = text_of(b);
    let lower = t.to_lowercase();
    lower.starts_with("abstract")
        && t.len() > 12
        && t[8..]
            .chars()
            .next()
            .map(|c| ":.—–-".contains(c))
            .unwrap_or(false)
}

fn strip_abstract_label(b: &mut Value) {
    let Some(inl) = b.get_mut("c").and_then(Value::as_array_mut) else {
        return;
    };
    let punct = |s: &str| s.chars().all(|c| ":.—–- ".contains(c));
    if let Some(first) = inl.first_mut() {
        if kind(first) == "Str" {
            let s = first["c"].as_str().unwrap_or("").to_string();
            let rest = s
                .get(8..)
                .unwrap_or("")
                .trim_start_matches([':', '.', '—', '–', '-'])
                .to_string();
            if rest.is_empty() {
                inl.remove(0);
            } else {
                first["c"] = Value::String(rest);
            }
        } else if is_abstract_label(&json!({"t": "Plain", "c": [first.clone()]})) {
            inl.remove(0);
        }
    }
    while inl
        .first()
        .map(|x| {
            matches!(kind(x), "Space" | "SoftBreak")
                || (kind(x) == "Str" && punct(x["c"].as_str().unwrap_or("")))
        })
        .unwrap_or(false)
    {
        inl.remove(0);
    }
}

/// Take the abstract out of the text: the blocks after an "Abstract" label up to the next heading,
/// or the paragraph that opens with the label, when either comes before the first section.
fn take_abstract(blocks: &mut Vec<Value>) -> Vec<Value> {
    let limit = blocks
        .iter()
        .position(|b| kind(b) == "Header" && !is_abstract_label(b))
        .unwrap_or(blocks.len());
    let Some(at) = blocks[..limit]
        .iter()
        .position(|b| is_abstract_label(b) || leads_with_abstract(b))
    else {
        return vec![];
    };
    if is_abstract_label(&blocks[at]) {
        let end = blocks[at + 1..]
            .iter()
            .position(|b| kind(b) == "Header")
            .map(|i| at + 1 + i);
        // With no heading after it, only the next paragraph is taken rather than the whole document.
        let end = end.unwrap_or((at + 2).min(blocks.len()));
        return blocks.drain(at..end).skip(1).collect();
    }
    let mut b = blocks.remove(at);
    strip_abstract_label(&mut b);
    vec![b]
}

/// "Figure 1:", "Fig. 2.", "Table 3 –": the number Word typed, which LaTeX adds itself.
fn is_caption_label(s: &str) -> bool {
    let s = s.trim().to_lowercase();
    let Some(rest) = ["figure", "fig.", "fig", "table", "tab."]
        .iter()
        .find_map(|p| s.strip_prefix(p))
    else {
        return false;
    };
    let rest = rest.trim_start();
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let tail = rest[digits..].trim();
    tail.is_empty() || (tail.chars().count() == 1 && ".:–—-|".contains(tail))
}

fn strip_caption_label(inlines: &mut Vec<Value>) {
    let mut text = String::new();
    let mut cut = None;
    for (i, x) in inlines.iter().enumerate() {
        match kind(x) {
            "Str" => text.push_str(x["c"].as_str().unwrap_or("")),
            "Space" | "SoftBreak" => text.push(' '),
            _ => break,
        }
        if text.len() > 24 {
            break;
        }
        if is_caption_label(&text) {
            cut = Some(i);
        }
    }
    let Some(i) = cut else { return };
    let rest_has_words = inlines[i + 1..]
        .iter()
        .any(|x| !matches!(kind(x), "Space" | "SoftBreak"));
    if !rest_has_words {
        return;
    }
    inlines.drain(..=i);
    while inlines
        .first()
        .map(|x| matches!(kind(x), "Space" | "SoftBreak"))
        .unwrap_or(false)
    {
        inlines.remove(0);
    }
}

fn caption_inlines(blocks: &[Value]) -> Vec<Value> {
    let mut out = vec![];
    for b in blocks {
        if let Some(inl) = b["c"].as_array() {
            if matches!(kind(b), "Para" | "Plain") {
                if !out.is_empty() {
                    out.push(json!({"t": "Space"}));
                }
                out.extend(inl.iter().cloned());
            }
        }
    }
    strip_caption_label(&mut out);
    out
}

/// A length pandoc read from Word, in inches.
fn inches(s: &str) -> Option<f64> {
    let s = s.trim();
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    let n: f64 = s[..split].parse().ok()?;
    match &s[split..] {
        "in" | "" => Some(n),
        "cm" => Some(n / 2.54),
        "mm" => Some(n / 25.4),
        "pt" => Some(n / 72.0),
        "px" => Some(n / 96.0),
        _ => None,
    }
}

/// Characters the default font has no glyph for, commonly typed as text in Word.
fn is_symbol(c: char) -> bool {
    matches!(c as u32, 0x0370..=0x03FF | 0x2070..=0x209F | 0x2100..=0x214F | 0x2190..=0x22FF | 0x2300..=0x23FF | 0x25A0..=0x25FF)
}

fn fold_ascii(s: &str) -> String {
    const FOLD: &[(&str, &str)] = &[
        ("àáâãäåāăą", "a"),
        ("çćč", "c"),
        ("ďđ", "d"),
        ("èéêëēėęě", "e"),
        ("ğ", "g"),
        ("ìíîïīı", "i"),
        ("ł", "l"),
        ("ñńň", "n"),
        ("òóôõöøō", "o"),
        ("řŕ", "r"),
        ("śšş", "s"),
        ("ťţ", "t"),
        ("ùúûüūů", "u"),
        ("ýÿ", "y"),
        ("źżž", "z"),
        ("ß", "ss"),
        ("æ", "ae"),
        ("œ", "oe"),
    ];
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if let Some((_, to)) = FOLD.iter().find(|(from, _)| from.contains(c)) {
            out.push_str(to);
        }
    }
    out
}

/// `ho2020denoising`: first author's family name, year, first word of the title that says something.
fn base_key(m: &Map<String, Value>) -> String {
    const STOP: &[&str] = &[
        "a", "an", "the", "on", "of", "for", "and", "in", "with", "to", "from", "towards",
        "toward", "via", "using", "by", "at", "is", "are", "how", "what", "why", "when", "do",
        "does",
    ];
    let names = m.get("author").or_else(|| m.get("editor"));
    let first = names.and_then(|n| {
        if kind(n) == "MetaList" {
            n["c"].as_array().and_then(|l| l.first())
        } else {
            Some(n)
        }
    });
    let family = first
        .map(|f| {
            if kind(f) == "MetaMap" {
                let c = &f["c"];
                text_of(if c.get("family").is_some() {
                    &c["family"]
                } else {
                    &c["literal"]
                })
            } else {
                text_of(f)
                    .split_whitespace()
                    .last()
                    .unwrap_or("")
                    .to_string()
            }
        })
        .unwrap_or_default();
    let issued = m.get("issued").map(text_of).unwrap_or_default();
    let year = issued
        .as_bytes()
        .windows(4)
        .find(|w| w.iter().all(u8::is_ascii_digit))
        .map(|w| String::from_utf8_lossy(w).to_string())
        .unwrap_or_default();
    let title = m.get("title").map(text_of).unwrap_or_default();
    let word = title
        .split(|c: char| c.is_whitespace() || c == '-' || c == ':')
        .map(fold_ascii)
        .find(|w| w.len() >= 3 && !STOP.contains(&w.as_str()))
        .unwrap_or_default();
    let key = format!("{}{}{}", fold_ascii(&family), year, word);
    if key.is_empty() {
        "ref".into()
    } else {
        key
    }
}

/// Replace the reference manager's item ids with readable, unique keys; old id to key.
fn assign_keys(refs: &mut [Value]) -> HashMap<String, String> {
    let mut used = HashSet::new();
    let mut map = HashMap::new();
    for r in refs.iter_mut() {
        let Some(m) = r.get_mut("c").and_then(Value::as_object_mut) else {
            continue;
        };
        let old = m.get("id").map(text_of).unwrap_or_default();
        let base = base_key(m);
        let mut key = base.clone();
        let mut n = 0u32;
        while used.contains(&key) {
            n += 1;
            key = if n < 26 {
                format!("{}{}", base, (b'a' + n as u8) as char)
            } else {
                format!("{}{}", base, n)
            };
        }
        used.insert(key.clone());
        m.insert("id".into(), json!({"t": "MetaString", "c": key}));
        map.insert(old, key);
    }
    map
}

/// One of Word's tables as a booktabs `tabular`, or None when it needs pandoc's own layout (cells
/// merged down a column, several paragraphs or a list in a cell, a table shape from an older pandoc).
fn table_to_latex(table: &Value) -> Option<Value> {
    struct Cell {
        inlines: Vec<Value>,
        span: usize,
        align: Option<char>,
        len: usize,
    }
    fn align_of(a: &Value) -> Option<char> {
        match kind(a) {
            "AlignLeft" => Some('l'),
            "AlignRight" => Some('r'),
            "AlignCenter" => Some('c'),
            _ => None,
        }
    }
    fn cell_of(cell: &Value) -> Option<Cell> {
        let a = cell.as_array()?;
        if a.len() != 5 || a[2].as_u64()? != 1 {
            return None;
        }
        let blocks = a[4].as_array()?;
        let inlines: Vec<Value> = match blocks.as_slice() {
            [] => vec![],
            [b] if matches!(kind(b), "Plain" | "Para") => b["c"]
                .as_array()?
                .iter()
                .map(|x| {
                    if matches!(kind(x), "LineBreak" | "SoftBreak") {
                        json!({"t": "Space"})
                    } else {
                        x.clone()
                    }
                })
                .collect(),
            _ => return None,
        };
        let len = text_of(&Value::Array(inlines.clone())).chars().count();
        Some(Cell {
            inlines,
            span: a[3].as_u64()?.max(1) as usize,
            align: align_of(&a[1]),
            len,
        })
    }
    fn rows_of(rows: &Value, ncols: usize) -> Option<Vec<Vec<Cell>>> {
        let mut out = vec![];
        for row in rows.as_array()? {
            let cells: Vec<Cell> = row
                .get(1)?
                .as_array()?
                .iter()
                .map(cell_of)
                .collect::<Option<_>>()?;
            let width: usize = cells.iter().map(|c| c.span).sum();
            if cells.is_empty() {
                continue;
            }
            if width > ncols {
                return None;
            }
            let mut cells = cells;
            cells.extend((width..ncols).map(|_| Cell {
                inlines: vec![],
                span: 1,
                align: None,
                len: 0,
            }));
            out.push(cells);
        }
        Some(out)
    }

    let c = table.get("c")?.as_array()?;
    if c.len() != 6 {
        return None;
    }
    let specs = c[2].as_array()?;
    let ncols = specs.len();
    if ncols == 0 {
        return None;
    }
    let head = rows_of(c[3].get(1)?, ncols)?;
    let mut body = vec![];
    for b in c[4].as_array()? {
        body.extend(rows_of(b.get(2)?, ncols)?);
        body.extend(rows_of(b.get(3)?, ncols)?);
    }
    let foot = rows_of(c[5].get(1)?, ncols)?;
    let caption = caption_inlines(
        c[1].get(1)
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
    );
    let id = c[0].get(0).and_then(Value::as_str).unwrap_or("");

    // Per column: the alignment Word gave it (or its first cells), and whether its text needs wrapping.
    let mut align = vec![None; ncols];
    let mut longest = vec![0usize; ncols];
    for (i, s) in specs.iter().enumerate() {
        align[i] = s.get(0).and_then(align_of);
    }
    for row in body.iter().chain(head.iter()) {
        let mut col = 0;
        for cell in row {
            if cell.span == 1 && col < ncols {
                if align[col].is_none() {
                    align[col] = cell.align;
                }
                longest[col] = longest[col].max(cell.len);
            }
            col += cell.span;
        }
    }
    let mut spec = String::from("@{}");
    for col in 0..ncols {
        if longest[col] > 30 {
            let width = specs[col]
                .get(1)
                .filter(|w| kind(w) == "ColWidth")
                .and_then(|w| w["c"].as_f64())
                .map(|f| f * 0.95)
                .unwrap_or(0.9 / ncols as f64)
                .clamp(0.1, 0.9);
            spec.push_str(&format!(
                ">{{\\raggedright\\arraybackslash}}p{{{:.2}\\linewidth}}",
                width
            ));
        } else {
            spec.push(align[col].unwrap_or('l'));
        }
    }
    spec.push_str("@{}");

    let mut out = vec![];
    let row_out = |rows: &[Vec<Cell>], out: &mut Vec<Value>| {
        for row in rows {
            for (i, cell) in row.iter().enumerate() {
                if i > 0 {
                    out.push(raw(" & "));
                }
                if cell.span > 1 {
                    out.push(raw(format!(
                        "\\multicolumn{{{}}}{{{}}}{{",
                        cell.span,
                        cell.align.unwrap_or('c')
                    )));
                    out.extend(cell.inlines.iter().cloned());
                    out.push(raw("}"));
                } else {
                    out.extend(cell.inlines.iter().cloned());
                }
            }
            out.push(raw(" \\\\\n"));
        }
    };
    let floated = !caption.is_empty();
    if floated {
        out.push(raw("\\begin{table}[htbp]\n\\centering\n\\caption{"));
        out.extend(caption);
        out.push(raw("}"));
        if !id.is_empty() {
            out.push(raw(format!("\\label{{{}}}", id)));
        }
        out.push(raw("\n"));
    } else {
        out.push(raw("\\begin{center}\n"));
    }
    out.push(raw(format!("\\begin{{tabular}}{{{}}}\n\\toprule\n", spec)));
    row_out(&head, &mut out);
    if !head.is_empty() {
        out.push(raw("\\midrule\n"));
    }
    row_out(&body, &mut out);
    if !foot.is_empty() {
        out.push(raw("\\midrule\n"));
        row_out(&foot, &mut out);
    }
    out.push(raw("\\bottomrule\n\\end{tabular}\n"));
    out.push(raw(if floated {
        "\\end{table}"
    } else {
        "\\end{center}"
    }));
    Some(plain(out))
}

/// Math as the TeX a researcher writes: `$…$` in the text; on its own an unnumbered `equation*`, or a
/// numbered `equation` with `label` when the Word author numbered it by hand. Word does not number
/// equations, so a document that showed no number must not gain one.
fn math_to_latex(display: bool, tex: &str, label: Option<&str>) -> Value {
    let mut tex = tex.trim().to_string();
    // A comment on the last line would swallow the closing delimiter.
    let last = tex.lines().last().unwrap_or("");
    if last.contains('%') && !last.contains("\\%") {
        tex.push('\n');
    }
    if !display {
        return raw(format!("${}$", tex));
    }
    if tex.contains("\\\\") && !tex.contains("\\begin{") {
        let env = if tex.contains('&') {
            "aligned"
        } else {
            "gathered"
        };
        tex = format!("\\begin{{{env}}}\n{tex}\n\\end{{{env}}}");
    }
    match label {
        Some(l) => raw(format!(
            "\\begin{{equation}}\\label{{{}}}\n{}\n\\end{{equation}}",
            l, tex
        )),
        None => raw(format!("\\begin{{equation*}}\n{}\n\\end{{equation*}}", tex)),
    }
}

// ------------------------------------------------- equations the author numbered by hand

/// The number in a manual equation marker: `(3)` → `3`, `(3.2)` → `3.2`, `(A.1)` → `A.1`. Anything
/// else is None, so ordinary text beside an equation is never read as a number. Letters are allowed
/// for appendix and supplement numbering, but a marker always ends in a digit.
fn equation_marker(s: &str) -> Option<String> {
    let inner = s.trim().strip_prefix('(')?.strip_suffix(')')?.trim();
    let ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '–' | '—');
    if inner.is_empty()
        || !inner.chars().all(ok)
        || !inner.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !inner.ends_with(|c: char| c.is_ascii_digit())
    {
        return None;
    }
    Some(inner.to_string())
}

/// The `\label` a manual number gets: `3` → `eq:3`, `3.2` → `eq:3-2`.
fn equation_label(number: &str) -> String {
    format!("eq:{}", number.replace(['.', '-', '–', '—'], "-"))
}

/// A Space, a line break, or a Str of nothing but spaces: what separates an equation from its number.
fn is_blank_inline(v: &Value) -> bool {
    match kind(v) {
        "Space" | "SoftBreak" | "LineBreak" => true,
        "Str" => v["c"].as_str().unwrap_or("x").trim().is_empty(),
        _ => false,
    }
}

/// Does this paragraph hold one displayed equation and nothing else?
fn is_lone_display_math(v: &Value) -> bool {
    if !matches!(kind(v), "Para" | "Plain") {
        return false;
    }
    let Some(items) = v["c"].as_array() else {
        return false;
    };
    let mut math = 0;
    for i in items {
        if is_blank_inline(i) {
            continue;
        }
        if kind(i) == "Math" && i["c"][0]["t"] == "DisplayMath" {
            math += 1;
            continue;
        }
        return false;
    }
    math == 1
}

/// The number of a paragraph that holds nothing but a manual equation marker.
fn lone_equation_marker(v: &Value) -> Option<String> {
    if !matches!(kind(v), "Para" | "Plain") {
        return None;
    }
    let mut number = None;
    for i in v["c"].as_array()? {
        if is_blank_inline(i) {
            continue;
        }
        if kind(i) == "Str" && number.is_none() {
            number = equation_marker(i["c"].as_str()?);
            if number.is_some() {
                continue;
            }
        }
        return None;
    }
    number
}

/// Word's other way of numbering an equation: a one-row invisible table with the equation in one cell
/// and its number in another (journal templates ship this layout). It becomes the paragraph the author
/// meant, so the one rule below numbers it. A table with a caption, or with anything else in it, stays
/// a table.
fn equation_number_table(v: &Value) -> Option<Value> {
    if kind(v) != "Table" {
        return None;
    }
    let c = v.get("c")?.as_array()?;
    if c.len() != 6 || !text_of(&c[1]).trim().is_empty() {
        return None;
    }
    let mut rows: Vec<&Value> = c[3].get(1)?.as_array()?.iter().collect();
    for b in c[4].as_array()? {
        rows.extend(b.get(2)?.as_array()?);
        rows.extend(b.get(3)?.as_array()?);
    }
    rows.extend(c[5].get(1)?.as_array()?);
    let [row] = rows.as_slice() else {
        return None;
    };
    let mut math: Option<Value> = None;
    let mut number: Option<String> = None;
    for cell in row.get(1)?.as_array()? {
        let cell = cell.as_array().filter(|a| a.len() == 5)?;
        for b in cell[4].as_array()? {
            if !matches!(kind(b), "Plain" | "Para") {
                return None;
            }
            for i in b["c"].as_array()? {
                if is_blank_inline(i) {
                    continue;
                }
                if kind(i) == "Math" && i["c"][0]["t"] == "DisplayMath" && math.is_none() {
                    math = Some(i.clone());
                    continue;
                }
                if kind(i) == "Str" && number.is_none() {
                    number = equation_marker(i["c"].as_str()?);
                    if number.is_some() {
                        continue;
                    }
                }
                return None;
            }
        }
    }
    Some(
        json!({"t": "Para", "c": [math?, {"t": "Space"}, {"t": "Str", "c": format!("({})", number?)}]}),
    )
}

/// The manual number of a paragraph whose displayed equation is followed by one, taking the marker off
/// so it is not printed twice. `(3)` after the equation is what a Word author types where LaTeX would
/// number the line itself.
fn take_equation_marker(items: &mut Vec<Value>) -> Option<String> {
    let math = items
        .iter()
        .position(|i| kind(i) == "Math" && i["c"][0]["t"] == "DisplayMath")?;
    if items[..math].iter().any(|i| !is_blank_inline(i)) {
        return None;
    }
    let mut number = None;
    for i in &items[math + 1..] {
        if is_blank_inline(i) {
            continue;
        }
        if kind(i) == "Str" && number.is_none() {
            number = equation_marker(i["c"].as_str()?);
            if number.is_some() {
                continue;
            }
        }
        return None;
    }
    let number = number?;
    items.truncate(math + 1);
    Some(number)
}

/// Fold the two block-level ways of numbering an equation into the equation's own paragraph, before the
/// walk reaches it: a one-row table, and the number right-aligned on the line under the equation (pandoc
/// drops the alignment, so it arrives as a paragraph holding nothing but the marker).
fn fold_equation_numbers(blocks: &mut Vec<Value>) {
    for b in blocks.iter_mut() {
        if let Some(para) = equation_number_table(b) {
            *b = para;
        }
    }
    let mut i = 1;
    while i < blocks.len() {
        if is_lone_display_math(&blocks[i - 1]) && lone_equation_marker(&blocks[i]).is_some() {
            let number = blocks.remove(i);
            if let Some(items) = blocks[i - 1].get_mut("c").and_then(Value::as_array_mut) {
                items.push(json!({"t": "Space"}));
                items.extend(number["c"].as_array().cloned().unwrap_or_default());
            }
            continue;
        }
        i += 1;
    }
}

/// The walk over the tree: counts what is there and reshapes it on the way.
#[derive(Default)]
struct Walk {
    text_width: f64,
    /// Where pandoc put each image, and where it is now.
    media: HashMap<String, String>,
    keys: HashMap<String, String>,
    sections: usize,
    figures: usize,
    tables: usize,
    long_tables: usize,
    equations: usize,
    inline_math: usize,
    citations: usize,
    cited: usize,
    footnotes: usize,
    unplaceable: Vec<String>,
    symbols: BTreeSet<char>,
    /// Text that looks like a hand-typed citation: "[3]", "et al.".
    typed_citations: bool,
    /// The manual number of the paragraph being visited, waiting for its displayed equation.
    number: Option<String>,
    /// Every manual equation number and the label it was given: "3" → "eq:3". A later pass could turn
    /// an in-text "(3)" into `\ref{eq:3}`; that reference rewriting is not built yet, and until it is,
    /// a reference to a numbered equation stays the literal "(3)" the Word author typed.
    numbered: HashMap<String, String>,
}

impl Walk {
    fn visit(&mut self, v: &mut Value, in_table: bool) {
        if let Some(items) = v.as_array_mut() {
            fold_equation_numbers(items);
            for it in items.iter_mut() {
                self.visit(it, in_table);
            }
            splice_marked(items);
            return;
        }
        let t = kind(v).to_string();
        match t.as_str() {
            "" => {
                if let Some(map) = v.as_object_mut() {
                    for c in map.values_mut() {
                        self.visit(c, in_table);
                    }
                }
                return;
            }
            "Str" => {
                let s = v["c"].as_str().unwrap_or("");
                self.symbols.extend(s.chars().filter(|c| is_symbol(*c)));
                if s == "al."
                    || (s.starts_with('[')
                        && s.chars().nth(1).is_some_and(|c| c.is_ascii_digit())
                        && s.trim_end_matches([',', '.', ';']).ends_with(']'))
                {
                    self.typed_citations = true;
                }
                return;
            }
            "Para" | "Plain" => {
                // The paragraph's own manual number, if it carries one, belongs to the equation inside it.
                let number = v
                    .get_mut("c")
                    .and_then(Value::as_array_mut)
                    .and_then(take_equation_marker);
                let outer = std::mem::replace(&mut self.number, number);
                if let Some(c) = v.get_mut("c") {
                    self.visit(c, in_table);
                }
                self.number = outer;
                return;
            }
            "Math" => {
                let display = v["c"][0]["t"] == "DisplayMath";
                let mut label = None;
                if display {
                    self.equations += 1;
                    if let Some(number) = self.number.take() {
                        let l = equation_label(&number);
                        self.numbered.insert(number, l.clone());
                        label = Some(l);
                    }
                } else {
                    self.inline_math += 1;
                }
                *v = math_to_latex(display, v["c"][1].as_str().unwrap_or(""), label.as_deref());
                return;
            }
            "Cite" => {
                self.citations += 1;
                if let Some(new) = self.cite(v) {
                    self.cited += 1;
                    *v = new;
                    return;
                }
            }
            "Header" => self.sections += 1,
            "Note" => self.footnotes += 1,
            "Image" => {
                self.figures += 1;
                if let Some(new) = self.image(v, in_table) {
                    *v = new;
                    return;
                }
            }
            "Figure" => {
                let caption = match v.get_mut("c").and_then(|c| get_path_mut(c, &[1, 1])) {
                    Some(blocks) => {
                        if let Some(inl) = blocks
                            .as_array_mut()
                            .and_then(|b| b.first_mut())
                            .and_then(|b| b.get_mut("c"))
                            .and_then(Value::as_array_mut)
                        {
                            strip_caption_label(inl);
                        }
                        text_of(blocks)
                    }
                    None => String::new(),
                };
                if let Some(content) = v.get_mut("c").and_then(|c| c.get_mut(2)) {
                    clear_alt(content, &caption);
                }
            }
            _ => {}
        }
        let inner = in_table || t == "Table";
        if let Some(c) = v.get_mut("c") {
            self.visit(c, inner);
        }
        if t == "Table" {
            self.tables += 1;
            match table_to_latex(v) {
                Some(raw) => *v = raw,
                None => self.long_tables += 1,
            }
        }
    }

    /// `\cite{…}` for a citation whose items all have a key; the Word-rendered text goes.
    fn cite(&self, v: &Value) -> Option<Value> {
        let items = v["c"][0].as_array()?;
        let mut keys: Vec<&str> = vec![];
        for item in items {
            let key = self.keys.get(item["citationId"].as_str()?)?;
            if !keys.contains(&key.as_str()) {
                keys.push(key);
            }
        }
        if keys.is_empty() {
            return None;
        }
        let mut out = vec![];
        let prefix = items[0]["citationPrefix"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !text_of(&Value::Array(prefix.clone())).is_empty() {
            out.extend(prefix);
            out.push(json!({"t": "Space"}));
        }
        let mut suffix = items[items.len() - 1]["citationSuffix"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        while suffix
            .first()
            .map(|x| {
                matches!(kind(x), "Space" | "SoftBreak") || (kind(x) == "Str" && x["c"] == ",")
            })
            .unwrap_or(false)
        {
            suffix.remove(0);
        }
        if let Some(first) = suffix.first_mut() {
            if kind(first) == "Str" {
                if let Some(s) = first["c"].as_str().and_then(|s| s.strip_prefix(',')) {
                    first["c"] = Value::String(s.to_string());
                }
            }
        }
        let note = text_of(&Value::Array(suffix.clone()));
        if note.is_empty() {
            out.push(raw(format!("\\cite{{{}}}", keys.join(","))));
        } else {
            let brace = note.contains(']');
            out.push(raw(if brace { "\\cite[{" } else { "\\cite[" }));
            out.extend(suffix);
            out.push(raw(format!(
                "{}]{{{}}}",
                if brace { "}" } else { "" },
                keys.join(",")
            )));
        }
        Some(splice(out, CITE))
    }

    /// Point the image at `figures/`, size it as a share of the line, or replace it with a framed
    /// note when LaTeX cannot place its format.
    fn image(&mut self, v: &mut Value, in_table: bool) -> Option<Value> {
        let c = v.get_mut("c")?.as_array_mut()?;
        if c.len() != 3 {
            return None;
        }
        let src = c[2][0].as_str().unwrap_or("").replace('\\', "/");
        let src = src.trim_start_matches("./").to_string();
        let src = self.media.get(&src).cloned().unwrap_or(src);
        if let Some(target) = c[2].get_mut(0) {
            *target = Value::String(src.clone());
        }
        let ext = Path::new(&src)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        // LaTeX includes local files only, and in these formats only.
        if src.contains("://") || !PLACEABLE.contains(&ext.as_str()) {
            self.unplaceable.push(src.clone());
            return Some(splice(
                vec![
                    raw("\\fbox{\\parbox{0.8\\linewidth}{\\centering "),
                    json!({"t": "Code", "c": [["", [], []], src]}),
                    json!({"t": "Str", "c": ": save it in figures/ as PDF or PNG and include that file here."}),
                    raw("}}"),
                ],
                "figure",
            ));
        }
        if text_of(&c[1]).ends_with("automatically generated") {
            c[1] = json!([]);
        }
        if in_table {
            return None;
        }
        let attrs = c[0].get_mut(2)?.as_array_mut()?;
        let value = |attrs: &Vec<Value>, k: &str| {
            attrs
                .iter()
                .find(|kv| kv[0] == k)
                .and_then(|kv| kv[1].as_str().map(str::to_string))
        };
        let width = value(attrs, "width");
        let has_height = value(attrs, "height").is_some();
        match width.as_deref().and_then(inches) {
            Some(w) => {
                let share = (w / self.text_width * 100.0).round().clamp(5.0, 100.0);
                attrs.retain(|kv| kv[0] != "width" && kv[0] != "height");
                attrs.push(json!(["width", format!("{}%", share)]));
            }
            None if width.is_none() && !has_height => attrs.push(json!(["width", "100%"])),
            None => {}
        }
        None
    }
}

/// Alt text that only repeats the caption, or that Word wrote itself, adds nothing to the source.
fn clear_alt(v: &mut Value, caption: &str) {
    match v {
        Value::Array(items) => items.iter_mut().for_each(|i| clear_alt(i, caption)),
        Value::Object(_) => {
            if kind(v) == "Image" {
                if let Some(alt) = v.get_mut("c").and_then(|c| get_path_mut(c, &[1])) {
                    if text_of(alt) == caption {
                        *alt = json!([]);
                    }
                }
            } else if let Some(c) = v.get_mut("c") {
                clear_alt(c, caption);
            }
        }
        _ => {}
    }
}

/// Split pandoc's output at the `%%DABIR:name%%` lines placed in the tree.
fn split_marked(latex: &str) -> Vec<(String, String)> {
    let mut parts = vec![];
    let mut name = String::new();
    let mut buf = String::new();
    for line in latex.lines() {
        if let Some(n) = line
            .trim()
            .strip_prefix("%%DABIR:")
            .and_then(|r| r.strip_suffix("%%"))
        {
            parts.push((std::mem::take(&mut name), std::mem::take(&mut buf)));
            name = n.to_string();
            continue;
        }
        buf.push_str(line);
        buf.push('\n');
    }
    parts.push((name, buf));
    parts
        .into_iter()
        .map(|(n, b)| (n, b.trim().to_string()))
        .collect()
}

/// `\pandocbounded{X}` → `X`.
fn unwrap_bounded(s: &str) -> String {
    const OPEN: &str = "\\pandocbounded{";
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i]);
        let inner = &rest[i + OPEN.len()..];
        let mut depth = 1;
        let mut end = None;
        for (j, ch) in inner.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(j) => {
                out.push_str(&inner[..j]);
                rest = &inner[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Take pandoc's scaffolding out of the body so it reads as if written by hand.
fn tidy(body: &str) -> String {
    let body = unwrap_bounded(body).replace(",height=\\textheight,keepaspectratio", "");
    let lines: Vec<&str> = body.lines().collect();
    let mut out: Vec<String> = vec![];
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if t == "\\tightlist" || t == "\\def\\labelenumi{\\arabic{enumi}.}" {
            i += 1;
            continue;
        }
        // "\item\n  text" → "\item text"
        if t == "\\item" {
            if let Some(next) = lines.get(i + 1) {
                let nt = next.trim_start();
                if next.starts_with("  ") && !nt.is_empty() && !nt.starts_with("\\begin{") {
                    let indent = &line[..line.len() - line.trim_start().len()];
                    out.push(format!("{}\\item {}", indent, nt));
                    i += 2;
                    continue;
                }
            }
        }
        out.push(line.to_string());
        i += 1;
    }
    // A display belongs to its paragraph: no blank line before an equation that follows text, and none
    // after one when the sentence goes on ("where …").
    let mut res: Vec<String> = vec![];
    for (idx, line) in out.iter().enumerate() {
        if line.trim().is_empty() {
            let next = out[idx + 1..].iter().find(|l| !l.trim().is_empty());
            let prev = res.iter().rev().find(|l| !l.trim().is_empty());
            let before_eq = next.is_some_and(|n| n.starts_with("\\begin{equation"))
                && prev.is_some_and(|p| !p.starts_with('\\'));
            let after_eq = prev
                .is_some_and(|p| matches!(p.trim(), "\\end{equation}" | "\\end{equation*}"))
                && next.is_some_and(|n| n.chars().next().is_some_and(char::is_lowercase));
            if before_eq || after_eq {
                continue;
            }
            if res.last().is_some_and(|l| l.trim().is_empty()) {
                continue;
            }
        }
        res.push(line.clone());
    }
    res.join("\n").trim().to_string()
}

/// The packages the text uses, in the house template's order, hyperref last.
fn packages(text: &str, math: bool) -> Vec<&'static str> {
    let has = |s: &str| text.contains(s);
    let mut p = vec![];
    // `equation*` is amsmath's, so a displayed equation always needs it.
    if math || has("\\begin{equation") {
        p.extend(["amsmath", "amssymb"]);
    }
    if has("\\includegraphics") {
        p.push("graphicx");
    }
    if has("\\toprule") {
        p.push("booktabs");
    }
    if has("\\arraybackslash") {
        p.push("array");
    }
    if has("\\begin{longtable}") {
        p.push("longtable");
    }
    if has("\\real{") {
        p.push("calc");
    }
    if has("\\multirow") {
        p.push("multirow");
    }
    if has("\\cancel") || has("\\bcancel") || has("\\xcancel") {
        p.push("cancel");
    }
    if has("\\st{") || has("\\ul{") || has("\\hl{") {
        p.push("soul");
    }
    if has("\\hl{") || has("\\textcolor") || has("\\colorbox") {
        p.push("xcolor");
    }
    p.push("hyperref");
    p
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{} {}", n, if n == 1 { one } else { many })
}

fn join_words(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {}", init.join(", "), last),
    }
}

/// Move the extracted images from `figures/media/…` to `figures/`; pandoc's path to the new one.
fn gather_media(dest: &Path) -> Result<HashMap<String, String>, String> {
    fn files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                files(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    let figures = dest.join(FIGURES);
    let media = figures.join("media");
    let mut map = HashMap::new();
    if !media.is_dir() {
        return Ok(map);
    }
    let mut found = vec![];
    files(&media, &mut found);
    found.sort();
    for f in found {
        let rel = f
            .strip_prefix(dest)
            .unwrap_or(&f)
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        let stem = f
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".into());
        let ext = f
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut target = figures.join(format!("{}{}", stem, ext));
        let mut n = 2;
        while target.exists() {
            target = figures.join(format!("{}-{}{}", stem, n, ext));
            n += 1;
        }
        fs::rename(&f, &target).map_err(|e| format!("Could not move {}: {}", rel, e))?;
        let name = target
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        map.insert(rel, format!("{}/{}", FIGURES, name));
    }
    fs::remove_dir_all(&media).map_err(|e| e.to_string())?;
    Ok(map)
}

/// What a file manager leaves in a folder the author thinks is empty, on each platform.
const CLUTTER: &[&str] = &[".DS_Store", "desktop.ini", "Thumbs.db"];

/// The folder must be new or empty (a file manager's own leavings aside); true when it was created here.
fn claim(dest: &Path) -> Result<bool, String> {
    if dest.exists() {
        if !dest.is_dir() {
            return Err(format!(
                "{} is a file. Choose another name for the paper's folder.",
                dest.display()
            ));
        }
        let empty = fs::read_dir(dest)
            .map(|rd| {
                rd.flatten()
                    .all(|e| CLUTTER.contains(&e.file_name().to_string_lossy().as_ref()))
            })
            .unwrap_or(false);
        if !empty {
            return Err(format!(
                "{} already exists and is not empty. Choose another name for the paper's folder.",
                dest.display()
            ));
        }
        return Ok(false);
    }
    fs::create_dir_all(dest).map_err(|e| format!("Could not create {}: {}", dest.display(), e))?;
    Ok(true)
}

/// Undo a failed import: the folder goes if it was made here, otherwise it is emptied again.
fn release(dest: &Path, created: bool) {
    if created {
        let _ = fs::remove_dir_all(dest);
        return;
    }
    if let Ok(rd) = fs::read_dir(dest) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let _ = fs::remove_dir_all(&p);
            } else if !CLUTTER.contains(&e.file_name().to_string_lossy().as_ref()) {
                let _ = fs::remove_file(&p);
            }
        }
    }
}

/// Convert `docx` into a new paper at `dest` with the pandoc Dabir finds on the agents' PATH.
pub fn docx_to_latex(docx: &Path, dest: &Path) -> Result<Report, String> {
    let pandoc = crate::export::pandoc().ok_or(NO_PANDOC)?;
    convert(&pandoc, docx, dest)
}

/// Convert `docx` into `dest` (new or empty): `main.tex`, `figures/`, and `refs.bib` when there are
/// citations from a reference manager. On failure nothing is left behind.
pub fn convert(pandoc: &Path, docx: &Path, dest: &Path) -> Result<Report, String> {
    let inventory = inspect(docx)?;
    let created = claim(dest)?;
    let result = write_paper(pandoc, docx, dest, &inventory);
    if result.is_err() {
        release(dest, created);
    }
    result
}

fn write_paper(pandoc: &Path, docx: &Path, dest: &Path, inv: &Inventory) -> Result<Report, String> {
    let source = std::path::absolute(docx).map_err(|e| e.to_string())?;
    let source_name = display_name(docx);
    let (mut tree, read_warnings) =
        read_tree(pandoc, &source, dest, Some(FIGURES), TrackChanges::Accept)?;
    let media = gather_media(dest)?;
    let api = tree["pandoc-api-version"].clone();
    let mut meta = tree["meta"].take();
    let mut blocks = match tree["blocks"].take() {
        Value::Array(b) => b,
        _ => vec![],
    };

    // Citations: readable keys, then refs.bib through pandoc's BibTeX writer. If that fails the
    // citations stay as the text Word showed.
    let mut notes = vec![];
    let mut keys = HashMap::new();
    let mut bib = None;
    let mut references = 0;
    if let Some(refs) = meta
        .get_mut("references")
        .and_then(|r| r.get_mut("c"))
        .and_then(Value::as_array_mut)
    {
        references = refs.len();
        keys = assign_keys(refs);
    }
    if !keys.is_empty() {
        let doc = json!({"pandoc-api-version": api, "meta": {"references": meta["references"].clone()}, "blocks": []});
        match write_with(pandoc, dest, "bibtex", &doc) {
            Ok((text, _)) if text.contains('@') => bib = Some(text),
            Ok(_) | Err(_) => {
                notes.push("The references could not be written to refs.bib, so citations stay as the text Word showed.".to_string());
                keys.clear();
                references = 0;
            }
        }
    }

    // Front matter.
    let stem = docx
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Untitled".into());
    let mut title = meta_inlines(&meta["title"]);
    let untitled = text_of(&Value::Array(title.clone())).is_empty();
    if untitled {
        title = vec![json!({"t": "Str", "c": stem})];
    }
    let subtitle = meta_inlines(&meta["subtitle"]);
    if !text_of(&Value::Array(subtitle.clone())).is_empty() {
        title.push(json!({"t": "Str", "c": ":"}));
        title.push(json!({"t": "Space"}));
        title.extend(subtitle);
    }
    let title_text = text_of(&Value::Array(title.clone()));
    let authors = authors(&meta);
    let date = meta_inlines(&meta["date"]);
    let abstract_blocks = take_abstract(&mut blocks);

    let mut all = vec![marker("title"), plain(title)];
    for a in authors {
        all.push(marker("author"));
        all.push(plain(a));
    }
    if !text_of(&Value::Array(date.clone())).is_empty() {
        all.push(marker("date"));
        all.push(plain(date));
    }
    let has_abstract = !abstract_blocks.is_empty();
    if has_abstract {
        all.push(marker("abstract"));
        all.extend(abstract_blocks);
    }
    all.push(marker("body"));
    all.extend(blocks);

    let mut walk = Walk {
        text_width: inv.text_width,
        media,
        keys,
        ..Default::default()
    };
    // The document's own block list is walked block by block, so the folds that need two neighbouring
    // blocks are done here; every nested block list goes through `visit`'s array arm.
    fold_equation_numbers(&mut all);
    for b in all.iter_mut() {
        walk.visit(b, false);
    }
    let doc = json!({"pandoc-api-version": api, "meta": {}, "blocks": all});
    let (latex, write_warnings) = write_with(pandoc, dest, "latex", &doc)
        .map_err(|e| format!("pandoc could not write the LaTeX: {}", first_lines(&e)))?;

    let mut title_tex = String::new();
    let mut author_tex = vec![];
    let mut date_tex = None;
    let mut abstract_tex = None;
    let mut body = String::new();
    for (name, text) in split_marked(&latex) {
        match name.as_str() {
            "title" => title_tex = text,
            "author" => author_tex.push(text),
            "date" => date_tex = Some(text),
            "abstract" => abstract_tex = Some(tidy(&text)),
            "body" => body = tidy(&text),
            _ => {}
        }
    }
    let front = format!(
        "{}{}{}",
        title_tex,
        author_tex.join(""),
        abstract_tex.as_deref().unwrap_or("")
    );
    let pkgs = packages(
        &format!("{}{}", front, body),
        walk.equations + walk.inline_math > 0,
    );
    let pandoc_version = version(pandoc);
    let safe_name: String = source_name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();

    let mut tex = String::new();
    tex.push_str(&format!(
        "% Converted from {} by Dabir with {}.\n% Check figures, tables, equations and citations against the Word file.\n",
        safe_name, pandoc_version
    ));
    tex.push_str("\\documentclass[11pt]{article}\n\\usepackage[margin=1in]{geometry}\n");
    tex.push_str(&format!("\\usepackage{{{}}}\n", pkgs.join(",")));
    if body.contains("\\LTcaptype{none}") {
        tex.push_str("\\newcounter{none}\n");
    }
    tex.push_str(&format!("\\title{{{}}}\n", title_tex));
    tex.push_str(&format!("\\author{{{}}}\n", author_tex.join(" \\and ")));
    tex.push_str(&format!(
        "\\date{{{}}}\n",
        date_tex.as_deref().unwrap_or("\\today")
    ));
    tex.push_str("\\begin{document}\n\\maketitle\n");
    if let Some(a) = abstract_tex.as_deref().filter(|a| !a.is_empty()) {
        tex.push_str(&format!("\\begin{{abstract}}\n{}\n\\end{{abstract}}\n", a));
    }
    tex.push('\n');
    tex.push_str(&body);
    tex.push('\n');
    if bib.is_some() {
        tex.push_str("\n\\bibliographystyle{plain}\n\\bibliography{refs}\n");
    }
    tex.push_str("\\end{document}\n");

    let main = dest.join("main.tex");
    fs::write(&main, &tex).map_err(|e| format!("Could not write main.tex: {}", e))?;
    if let Some(b) = &bib {
        fs::write(dest.join("refs.bib"), b)
            .map_err(|e| format!("Could not write refs.bib: {}", e))?;
    }
    // The Word file itself stays beside the paper, under its own name: it is where the paper came from
    // and the basis of the round trip back to a coauthor who writes in Word. It is written before the
    // scaffold's first commit, so it is committed with the paper, and it is not in .gitignore.
    fs::copy(&source, dest.join(&source_name))
        .map_err(|e| format!("Could not keep {} beside the paper: {}", source_name, e))?;

    // What to check, most important first; the Word file is first because it is what to check against.
    // The name is left out of the sentence: a .docx from a coauthor usually has spaces in it, and the
    // sheet sets file names in code by a pattern that stops at the first space.
    notes.push(
        "The Word file is kept beside main.tex under its own name; open it in Dabir to compare the two side by side.".to_string(),
    );
    if untitled {
        notes.push("Word had no Title paragraph, so the title is the file name; change \\title in main.tex.".into());
    }
    if inv.revisions > 0 {
        notes.push(format!(
            "{} accepted, as in Word's No Markup view; the .docx still has {}.",
            plural(inv.revisions, "tracked change was", "tracked changes were"),
            if inv.revisions == 1 { "it" } else { "them" }
        ));
    }
    if inv.comments > 0 {
        notes.push(format!(
            "{} left out; {} in the .docx.",
            plural(inv.comments, "comment was", "comments were"),
            if inv.comments == 1 {
                "it stays"
            } else {
                "they stay"
            }
        ));
    }
    if walk.cited > 0 {
        notes.push(format!(
            "{} from {} became {}, with {} in refs.bib listed by \\bibliographystyle{{plain}}.",
            plural(walk.cited, "citation", "citations"),
            inv.manager.unwrap_or("the reference manager"),
            if walk.cited == 1 {
                "a \\cite command"
            } else {
                "\\cite commands"
            },
            plural(references, "entry", "entries")
        ));
    } else if let Some(m) = inv.manager {
        notes.push(format!(
            "Citations inserted with {} came through as plain text because this pandoc cannot read them. Update pandoc and import again, or add the references with References… (⌥⌘R).",
            m
        ));
    } else if walk.typed_citations {
        notes.push("Citations typed as text stay as text; add the references with References… (⌥⌘R) and cite them with ⇧⌘C.".into());
    }
    if !walk.unplaceable.is_empty() {
        let mut files = walk.unplaceable.clone();
        files.dedup();
        notes.push(format!(
            "LaTeX cannot place {}; save {} as PDF or PNG and replace the framed {} in main.tex.",
            join_words(&files),
            if files.len() == 1 { "it" } else { "them" },
            if files.len() == 1 { "note" } else { "notes" }
        ));
    }
    if walk.figures > walk.unplaceable.len() {
        notes.push("Figures are in figures/ at the width they had on the Word page; LaTeX places captioned ones where they fit.".into());
    }
    if walk.equations + walk.inline_math > 0 {
        notes.push("Compare the equations with the Word file; displayed ones are equation*, since Word numbers none of its own. Change one to equation where you want LaTeX to number it.".into());
    }
    if !walk.numbered.is_empty() {
        let mut labels: Vec<String> = walk
            .numbered
            .values()
            .map(|l| format!("\\label{{{}}}", l))
            .collect();
        labels.sort();
        if labels.len() > 3 {
            labels.truncate(3);
            labels.push("…".into());
        }
        notes.push(format!(
            "{} numbered by hand in Word kept {} ({}); the typed number is gone, and a sentence that referred to it still names the number rather than \\ref.",
            plural(walk.numbered.len(), "equation", "equations"),
            if walk.numbered.len() == 1 {
                "its number"
            } else {
                "their numbers"
            },
            join_words(&labels)
        ));
    }
    if walk.long_tables > 0 {
        notes.push(format!(
            "{} with merged rows or several paragraphs in a cell kept pandoc's longtable layout.",
            plural(walk.long_tables, "table", "tables")
        ));
    }
    if !walk.symbols.is_empty() {
        let shown: String = walk
            .symbols
            .iter()
            .take(6)
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        notes.push(format!(
            "Symbols typed as text ({}) are missing from the paper's font; Edit › Convert Unicode to LaTeX rewrites them.",
            shown
        ));
    }
    let warned = read_warnings
        .lines()
        .chain(write_warnings.lines())
        .filter(|l| l.starts_with("[WARNING]"))
        .count();
    if warned > 0 {
        notes.push(format!(
            "pandoc noted {} it could not carry over exactly.",
            plural(warned, "thing", "things")
        ));
    }

    let mut parts = vec![];
    if walk.sections > 0 {
        parts.push(plural(walk.sections, "section", "sections"));
    }
    if walk.figures > 0 {
        parts.push(plural(walk.figures, "figure", "figures"));
    }
    if walk.tables > 0 {
        parts.push(plural(walk.tables, "table", "tables"));
    }
    if walk.equations > 0 {
        parts.push(plural(walk.equations, "equation", "equations"));
    }
    if walk.inline_math > 0 {
        parts.push(plural(
            walk.inline_math,
            "inline formula",
            "inline formulas",
        ));
    }
    if walk.cited > 0 {
        parts.push(plural(walk.cited, "citation", "citations"));
    }
    if walk.footnotes > 0 {
        parts.push(plural(walk.footnotes, "footnote", "footnotes"));
    }
    let summary = if parts.is_empty() {
        format!("Converted the text of {}.", source_name)
    } else {
        format!("Converted {} from {}.", join_words(&parts), source_name)
    };

    Ok(Report {
        path: dest.to_string_lossy().to_string(),
        main: main.to_string_lossy().to_string(),
        source: source_name,
        title: title_text,
        summary,
        sections: walk.sections,
        figures: walk.figures,
        tables: walk.tables,
        equations: walk.equations,
        inline_math: walk.inline_math,
        citations: walk.cited,
        references: if bib.is_some() { references } else { 0 },
        footnotes: walk.footnotes,
        notes,
        pandoc: pandoc_version,
    })
}

// ---------------------------------------------------------------- tracked changes, for later

/// One of Word's tracked changes or comments.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    /// `insertion`, `deletion` or `comment`.
    pub kind: String,
    pub author: String,
    pub date: String,
    /// The inserted or deleted words, or the comment itself.
    pub text: String,
}

/// Word's tracked changes and comments in document order, read instead of accepted. The round trip
/// back from Word into the review surface will build on this; no command calls it yet. Nothing is
/// written: no media are extracted.
#[cfg_attr(not(test), allow(dead_code))]
pub fn revisions(pandoc: &Path, docx: &Path) -> Result<Vec<Revision>, String> {
    inspect(docx)?;
    let source = std::path::absolute(docx).map_err(|e| e.to_string())?;
    let (tree, _) = read_tree(
        pandoc,
        &source,
        &std::env::temp_dir(),
        None,
        TrackChanges::All,
    )?;
    fn collect(v: &Value, out: &mut Vec<Revision>) {
        match v {
            Value::Array(items) => items.iter().for_each(|i| collect(i, out)),
            Value::Object(map) => {
                if kind(v) == "Span" {
                    let attr = &map["c"][0];
                    let classes: Vec<&str> = attr[1]
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    let found = ["insertion", "deletion", "comment-start"]
                        .into_iter()
                        .find(|k| classes.contains(k));
                    if let Some(k) = found {
                        let get = |name: &str| {
                            attr[2]
                                .as_array()
                                .and_then(|kv| kv.iter().find(|p| p[0] == name))
                                .and_then(|p| p[1].as_str())
                                .unwrap_or("")
                                .to_string()
                        };
                        out.push(Revision {
                            kind: k.trim_end_matches("-start").to_string(),
                            author: get("author"),
                            date: get("date"),
                            text: text_of(&map["c"][1]),
                        });
                    }
                }
                if let Some(c) = map.get("c") {
                    collect(c, out);
                }
            }
            _ => {}
        }
    }
    let mut out = vec![];
    collect(&tree["blocks"], &mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const W: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture""#;

    /// A 1×1 PNG.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dabir-docx-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn para(style: Option<&str>, runs: &str) -> String {
        let ppr = style
            .map(|s| format!(r#"<w:pPr><w:pStyle w:val="{}"/></w:pPr>"#, s))
            .unwrap_or_default();
        format!("<w:p>{}{}</w:p>", ppr, runs)
    }

    fn run(text: &str, props: &str) -> String {
        format!(
            r#"<w:r>{}<w:t xml:space="preserve">{}</w:t></w:r>"#,
            if props.is_empty() {
                String::new()
            } else {
                format!("<w:rPr>{}</w:rPr>", props)
            },
            text
        )
    }

    fn cell(text: &str, jc: &str) -> String {
        format!(
            r#"<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="{}"/></w:pPr>{}</w:p></w:tc>"#,
            jc,
            run(text, "")
        )
    }

    /// A small document the way Word writes one: title and author paragraphs, an abstract, a heading,
    /// bold and italic, a tracked insertion and deletion, a comment, a Zotero citation, a displayed
    /// equation, one the author numbered "(3)" by hand, an inline equation, a captioned table, a
    /// captioned picture, and an A4 page.
    fn fixture(path: &Path) {
        let zotero = r#"{"citationID":"a1","properties":{"formattedCitation":"(Ho et al., 2020)","plainCitation":"(Ho et al., 2020)","noteIndex":0},"citationItems":[{"id":12,"uris":["http://zotero.org/users/1/items/ABCD"],"itemData":{"id":12,"type":"paper-conference","title":"Denoising diffusion probabilistic models","container-title":"Advances in Neural Information Processing Systems","author":[{"family":"Ho","given":"Jonathan"},{"family":"Jain","given":"Ajay"}],"issued":{"date-parts":[["2020"]]}}}],"schema":"https://github.com/citation-style-language/schema/raw/master/csl-citation.json"}"#;
        let body = [
            para(Some("Title"), &run("Score Anchors for Low-Dose CT", "")),
            para(Some("Author"), &run("Maryam Rahimi", "")),
            para(None, &run("Abstract", "<w:b/>")),
            para(None, &run("We study denoising with score anchors.", "")),
            para(Some("Heading1"), &run("Introduction", "")),
            para(
                None,
                &[
                    run("Plain, ", ""),
                    run("bold", "<w:b/>"),
                    run(" and ", ""),
                    run("italic", "<w:i/>"),
                    run(" text is", ""),
                    r#"<w:ins w:id="101" w:author="Supervisor" w:date="2026-09-10T10:00:00Z">"#.into(),
                    run(" remarkably", ""),
                    "</w:ins>".into(),
                    r#"<w:del w:id="102" w:author="Supervisor" w:date="2026-09-10T10:01:00Z"><w:r><w:delText xml:space="preserve"> quite</w:delText></w:r></w:del>"#.into(),
                    run(" clear ", ""),
                    r#"<w:commentRangeStart w:id="0"/>"#.into(),
                    run("here", ""),
                    r#"<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>"#.into(),
                    run(" ", ""),
                    r#"<w:r><w:fldChar w:fldCharType="begin"/></w:r>"#.into(),
                    format!(r#"<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {} </w:instrText></w:r>"#, zotero),
                    r#"<w:r><w:fldChar w:fldCharType="separate"/></w:r>"#.into(),
                    run("(Ho et al., 2020)", ""),
                    r#"<w:r><w:fldChar w:fldCharType="end"/></w:r>"#.into(),
                    run(".", ""),
                ]
                .concat(),
            ),
            para(
                None,
                r#"<m:oMathPara><m:oMath><m:r><m:t>E=m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara>"#,
            ),
            // The same equation numbered by hand, as a Word author numbers one: a tab and "(3)".
            para(
                None,
                &format!(
                    "{}{}{}",
                    r#"<m:oMathPara><m:oMath><m:r><m:t>a=b</m:t></m:r></m:oMath></m:oMathPara>"#,
                    "<w:r><w:tab/></w:r>",
                    run("(3)", "")
                ),
            ),
            para(
                None,
                &format!(
                    "{}{}{}",
                    run("Inline ", ""),
                    r#"<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>"#,
                    run(" math.", "")
                ),
            ),
            para(Some("Caption"), &run("Table 1: Reconstruction quality.", "")),
            format!(
                r#"<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>"#,
                cell("Method", "left"),
                cell("PSNR &amp; dB", "right"),
                cell("Ours", "left"),
                cell("32.4", "right"),
            ),
            para(
                None,
                r#"<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="2743200" cy="1828800"/><wp:docPr id="1" name="Picture 1" descr="A plot of noise. Description automatically generated"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#,
            ),
            para(Some("Caption"), &run("Figure 1: Noise sweep.", "")),
            r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>"#.into(),
        ]
        .concat();
        let document = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {}><w:body>{}</w:body></w:document>"#,
            W, body
        );
        let style = |id: &str, name: &str| {
            format!(
                r#"<w:style w:type="paragraph" w:styleId="{}"><w:name w:val="{}"/></w:style>"#,
                id, name
            )
        };
        let styles = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles {}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>{}{}{}{}</w:styles>"#,
            W,
            style("Title", "Title"),
            style("Author", "Author"),
            style("Heading1", "heading 1").replace(
                "</w:style>",
                r#"<w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>"#
            ),
            style("Caption", "caption"),
        );
        let comments = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments {}><w:comment w:id="0" w:author="Supervisor" w:date="2026-09-10T10:02:00Z" w:initials="S"><w:p><w:r><w:t>Cite the original paper here.</w:t></w:r></w:p></w:comment></w:comments>"#,
            W
        );
        let parts: Vec<(&str, Vec<u8>)> = vec![
            ("[Content_Types].xml", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#.to_vec()),
            ("_rels/.rels", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#.to_vec()),
            ("word/_rels/document.xml.rels", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>"#.to_vec()),
            ("docProps/core.xml", br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Microsoft Office User</dc:creator></cp:coreProperties>"#.to_vec()),
            ("word/document.xml", document.into_bytes()),
            ("word/styles.xml", styles.into_bytes()),
            ("word/comments.xml", comments.into_bytes()),
            ("word/media/image1.png", PNG.to_vec()),
        ];
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in parts {
            zip.start_file(name, opts).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// pandoc where Dabir would find it; tests that need it say so and pass when it is missing.
    fn pandoc_or_skip(test: &str) -> Option<PathBuf> {
        let p = crate::export::pandoc();
        if p.is_none() {
            eprintln!("{}: pandoc is not installed, skipped", test);
        }
        p
    }

    #[test]
    fn inspect_counts_what_pandoc_will_not_carry() {
        let dir = scratch("inspect");
        let docx = dir.join("Draft v3.docx");
        fixture(&docx);
        let inv = inspect(&docx).unwrap();
        assert_eq!(inv.comments, 1);
        assert_eq!(inv.revisions, 2);
        assert_eq!(inv.manager, Some("Zotero"));
        // A4 (11906 twips) less two one-inch margins.
        assert!((inv.text_width - 6.268).abs() < 0.01, "{}", inv.text_width);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn inspect_names_old_word_files_and_other_files() {
        let dir = scratch("notdocx");
        let doc = dir.join("old.doc");
        fs::write(&doc, [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).unwrap();
        let e = inspect(&doc).unwrap_err();
        assert!(
            e.contains("Word 97–2004") && e.contains("save it as .docx"),
            "{e}"
        );
        let txt = dir.join("notes.docx");
        fs::write(&txt, "hello").unwrap();
        assert!(inspect(&txt)
            .unwrap_err()
            .contains("is not a Word document"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_width_and_main_part_are_read_from_the_package() {
        assert_eq!(text_width("<w:body></w:body>"), 6.5);
        let letter = r#"<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1800" w:left="1800"/></w:sectPr>"#;
        assert!((text_width(letter) - 6.0).abs() < 1e-9);
        let rels = r#"<Relationships><Relationship Id="rId3" Type="http://x/extended-properties" Target="docProps/app.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document2.xml" Id="rId1"/></Relationships>"#;
        assert_eq!(office_document(rels).as_deref(), Some("word/document2.xml"));
    }

    #[test]
    fn a_non_empty_folder_is_refused_and_left_alone() {
        let dir = scratch("claim");
        let docx = dir.join("paper.docx");
        fixture(&docx);
        let dest = dir.join("paper");
        fs::create_dir_all(&dest).unwrap();
        fs::write(dest.join("notes.txt"), "mine").unwrap();
        // The refusal comes before pandoc is needed, so any path will do.
        let e = convert(Path::new("/nonexistent/pandoc"), &docx, &dest).unwrap_err();
        assert!(e.contains("already exists and is not empty"), "{e}");
        assert_eq!(fs::read_to_string(dest.join("notes.txt")).unwrap(), "mine");
        // An empty folder is taken; when pandoc cannot start, it is left empty again, not removed.
        let empty = dir.join("empty");
        fs::create_dir_all(&empty).unwrap();
        let e = convert(Path::new("/nonexistent/pandoc"), &docx, &empty).unwrap_err();
        assert!(e.contains("pandoc"), "{e}");
        assert!(empty.is_dir() && fs::read_dir(&empty).unwrap().next().is_none());
        // A folder made here goes again.
        let fresh = dir.join("fresh");
        assert!(convert(Path::new("/nonexistent/pandoc"), &docx, &fresh).is_err());
        assert!(!fresh.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// An older pandoc: no `--sandbox` (before 2.15) and no citations in docx. The read still works.
    #[cfg(unix)]
    #[test]
    fn an_older_pandoc_is_asked_again_without_what_it_lacks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("oldpandoc");
        let fake = dir.join("pandoc");
        let log = dir.join("calls.txt");
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$*\" in\n  *--sandbox*) echo \"pandoc: unrecognized option \\`--sandbox'\" >&2; exit 2;;\n  *docx+citations*) echo 'The extension citations is not supported for docx' >&2; exit 23;;\nesac\necho '{{\"pandoc-api-version\":[1,20],\"meta\":{{}},\"blocks\":[]}}'\n",
                log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let docx = dir.join("a.docx");
        fixture(&docx);
        let (tree, _) = read_tree(&fake, &docx, &dir, None, TrackChanges::Accept).unwrap();
        assert_eq!(tree["blocks"], json!([]));
        let calls = fs::read_to_string(&log).unwrap();
        let calls: Vec<&str> = calls.lines().collect();
        assert_eq!(calls.len(), 3, "{calls:?}");
        assert!(calls[1].contains("docx+citations") && !calls[1].contains("--sandbox"));
        assert!(calls[2].contains("--from docx --to json") && !calls[2].contains("--sandbox"));
        // Any other failure is reported with pandoc's words.
        fs::write(
            &fake,
            "#!/bin/sh\necho 'couldn'\\''t parse docx file: DocxError' >&2\nexit 64\n",
        )
        .unwrap();
        let e = read_tree(&fake, &docx, &dir, None, TrackChanges::Accept).unwrap_err();
        assert_eq!(
            e,
            "pandoc could not read the document: couldn't parse docx file: DocxError"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_pandoc_points_at_setup() {
        assert!(NO_PANDOC.contains("Set Up Dabir") && NO_PANDOC.contains("import again"));
        assert_eq!(TrackChanges::Accept.flag(), "--track-changes=accept");
        assert_eq!(TrackChanges::Reject.flag(), "--track-changes=reject");
        assert_eq!(TrackChanges::All.flag(), "--track-changes=all");
    }

    fn s(t: &str) -> Value {
        json!({"t": "Str", "c": t})
    }
    fn sp() -> Value {
        json!({"t": "Space"})
    }
    fn para_of(inl: Vec<Value>) -> Value {
        json!({"t": "Para", "c": inl})
    }
    fn header(t: &str) -> Value {
        json!({"t": "Header", "c": [1, [t.to_lowercase(), [], []], [s(t)]]})
    }

    #[test]
    fn the_abstract_is_found_after_its_label_or_inside_its_paragraph() {
        let mut blocks = vec![
            para_of(vec![json!({"t": "Strong", "c": [s("Abstract")]})]),
            para_of(vec![s("We"), sp(), s("study.")]),
            para_of(vec![s("Second"), sp(), s("paragraph.")]),
            header("Introduction"),
            para_of(vec![s("Body.")]),
        ];
        let a = take_abstract(&mut blocks);
        assert_eq!(a.len(), 2);
        assert_eq!(text_of(&a[0]), "We study.");
        assert_eq!(blocks.len(), 2);

        let mut ieee = vec![
            para_of(vec![
                s("Abstract—We"),
                sp(),
                s("study"),
                sp(),
                s("anchors."),
            ]),
            header("Introduction"),
        ];
        let a = take_abstract(&mut ieee);
        assert_eq!(text_of(&a[0]), "We study anchors.");
        assert_eq!(ieee.len(), 1);

        let mut bold = vec![para_of(vec![
            json!({"t": "Strong", "c": [s("Abstract:")]}),
            sp(),
            s("Short"),
            sp(),
            s("summary."),
        ])];
        let a = take_abstract(&mut bold);
        assert_eq!(text_of(&a[0]), "Short summary.");

        // A heading called Abstract, and no abstract after the first section.
        let mut headed = vec![
            header("Abstract"),
            para_of(vec![s("Text.")]),
            header("Methods"),
        ];
        assert_eq!(text_of(&take_abstract(&mut headed)[0]), "Text.");
        assert_eq!(headed.len(), 1);
        let mut late = vec![
            header("Intro"),
            para_of(vec![s("Abstract")]),
            para_of(vec![s("x")]),
        ];
        assert!(take_abstract(&mut late).is_empty());
        assert_eq!(late.len(), 3);
    }

    #[test]
    fn caption_numbers_typed_in_word_are_dropped() {
        let mut inl = vec![
            s("Figure"),
            sp(),
            s("1:"),
            sp(),
            s("Noise"),
            sp(),
            s("sweep."),
        ];
        strip_caption_label(&mut inl);
        assert_eq!(text_of(&Value::Array(inl)), "Noise sweep.");
        let mut dash = vec![s("Table"), sp(), s("2"), sp(), s("–"), sp(), s("Results")];
        strip_caption_label(&mut dash);
        assert_eq!(text_of(&Value::Array(dash)), "Results");
        let mut only = vec![s("Figure"), sp(), s("3.")];
        strip_caption_label(&mut only);
        assert_eq!(
            text_of(&Value::Array(only)),
            "Figure 3.",
            "a bare label is kept"
        );
        let mut words = vec![s("Figures"), sp(), s("of"), sp(), s("merit")];
        strip_caption_label(&mut words);
        assert_eq!(text_of(&Value::Array(words)), "Figures of merit");
    }

    #[test]
    fn citation_keys_are_readable_and_unique() {
        let reference = |id: &str, family: &str, year: &str, title: &str| {
            json!({"t": "MetaMap", "c": {
                "id": {"t": "MetaString", "c": id},
                "author": {"t": "MetaList", "c": [{"t": "MetaMap", "c": {"family": {"t": "MetaString", "c": family}}}]},
                "issued": {"t": "MetaString", "c": year},
                "title": {"t": "MetaInlines", "c": [s(title)]},
            }})
        };
        let mut refs = vec![
            reference("12", "Ho", "2020", "Denoising"),
            reference("15", "Ho", "2020", "Denoising"),
            reference("20", "Müller-Łukasz", "2019-05", "On the theory"),
            json!({"t": "MetaMap", "c": {"id": {"t": "MetaString", "c": "30"}}}),
        ];
        let keys = assign_keys(&mut refs);
        assert_eq!(keys["12"], "ho2020denoising");
        assert_eq!(keys["15"], "ho2020denoisingb");
        assert_eq!(keys["20"], "mullerlukasz2019theory");
        assert_eq!(keys["30"], "ref");
        assert_eq!(refs[1]["c"]["id"]["c"], "ho2020denoisingb");
    }

    #[test]
    fn tables_become_booktabs_tabulars() {
        let c = |t: &str, align: &str, span: u64| json!([["", [], []], {"t": align}, 1, span, [{"t": "Plain", "c": [s(t)]}]]);
        let row = |cells: Vec<Value>| json!([["", [], []], cells]);
        let table = json!({"t": "Table", "c": [
            ["tbl-results", [], []],
            [null, [{"t": "Para", "c": [s("Table"), sp(), s("1:"), sp(), s("Results.")]}]],
            [[{"t": "AlignDefault"}, {"t": "ColWidthDefault"}], [{"t": "AlignDefault"}, {"t": "ColWidth", "c": 0.5}], [{"t": "AlignCenter"}, {"t": "ColWidthDefault"}]],
            [["", [], []], [row(vec![c("Method", "AlignLeft", 1), c("Scores", "AlignCenter", 2)])]],
            [[["", [], []], 0, [], [
                row(vec![c("Ours", "AlignLeft", 1), c("32.4", "AlignRight", 1), c("0.9", "AlignDefault", 1)]),
                row(vec![c("A method whose name is far longer than a column", "AlignLeft", 1), c("31.0", "AlignRight", 1)]),
            ]]],
            [["", [], []], []]
        ]});
        let out = table_to_latex(&table).expect("converted");
        let rendered: String = out["c"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| match kind(x) {
                "RawInline" => x["c"][1].as_str().unwrap().to_string(),
                "Space" => " ".into(),
                _ => x["c"].as_str().unwrap_or("").to_string(),
            })
            .collect();
        assert_eq!(
            rendered,
            "\\begin{table}[htbp]\n\\centering\n\\caption{Results.}\\label{tbl-results}\n\\begin{tabular}{@{}>{\\raggedright\\arraybackslash}p{0.30\\linewidth}rc@{}}\n\\toprule\nMethod & \\multicolumn{2}{c}{Scores} \\\\\n\\midrule\nOurs & 32.4 & 0.9 \\\\\nA method whose name is far longer than a column & 31.0 &  \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}"
        );

        // A cell merged down a column is left to pandoc.
        let mut merged = table.clone();
        merged["c"][4][0][3][0][1][0][2] = json!(2);
        assert!(table_to_latex(&merged).is_none());
        // No caption: it stays where it is.
        let mut bare = table.clone();
        bare["c"][1] = json!([null, []]);
        let out = table_to_latex(&bare).unwrap();
        assert_eq!(out["c"][0]["c"][1], "\\begin{center}\n");
    }

    #[test]
    fn citations_and_unplaceable_images_are_spliced_into_the_text() {
        let citation = |id: &str, suffix: Vec<Value>| json!({"citationId": id, "citationPrefix": [], "citationSuffix": suffix, "citationMode": {"t": "NormalCitation"}, "citationNoteNum": 0, "citationHash": 0});
        let mut walk = Walk {
            text_width: 6.5,
            keys: HashMap::from([
                ("12".to_string(), "ho2020denoising".to_string()),
                ("15".to_string(), "song2019generative".to_string()),
            ]),
            ..Default::default()
        };
        let mut para = json!({"t": "Para", "c": [
            s("shown"), sp(),
            {"t": "Cite", "c": [[citation("12", vec![]), citation("15", vec![s(","), sp(), s("p."), sp(), s("5")])], [s("(Ho, 2020)")]]},
            s("."), sp(),
            {"t": "Cite", "c": [[citation("99", vec![])], [s("[7]")]]},
            sp(),
            {"t": "Image", "c": [["", [], [["width", "13cm"]]], [], ["figures/media/image2.emf", ""]]},
        ]});
        walk.visit(&mut para, false);
        let rendered: String = para["c"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| match kind(x) {
                "RawInline" => x["c"][1].as_str().unwrap().to_string(),
                "Space" => " ".into(),
                "Code" => x["c"][1].as_str().unwrap().to_string(),
                "Cite" => format!("<cite {}>", text_of(&x["c"][1])),
                _ => x["c"].as_str().unwrap_or("").to_string(),
            })
            .collect();
        assert_eq!(
            rendered,
            "shown~\\cite[p. 5]{ho2020denoising,song2019generative}. <cite [7]> \\fbox{\\parbox{0.8\\linewidth}{\\centering figures/media/image2.emf: save it in figures/ as PDF or PNG and include that file here.}}"
        );
        assert_eq!((walk.citations, walk.cited, walk.figures), (2, 1, 1));
        assert_eq!(walk.unplaceable, vec!["figures/media/image2.emf"]);
        assert!(walk.typed_citations, "[7] reads as a typed citation");

        // A placeable image is sized as its share of the Word line, height dropped.
        let mut img = json!({"t": "Image", "c": [["", [], [["width", "3.25in"], ["height", "2in"]]], [s("Plot")], ["figures/media/a.png", ""]]});
        walk.media
            .insert("figures/media/a.png".into(), "figures/a.png".into());
        walk.visit(&mut img, false);
        assert_eq!(img["c"][0][2], json!([["width", "50%"]]));
        assert_eq!(img["c"][2][0], "figures/a.png");
        assert_eq!(
            img["c"][1],
            json!([s("Plot")]),
            "alt text of its own is kept"
        );
    }

    #[test]
    fn math_is_written_the_way_people_write_it() {
        assert_eq!(math_to_latex(false, " x^{2} ", None)["c"][1], "$x^{2}$");
        // Word numbers no equation of its own, so an unmarked display must not gain a number.
        assert_eq!(
            math_to_latex(true, "E = mc^{2}", None)["c"][1],
            "\\begin{equation*}\nE = mc^{2}\n\\end{equation*}"
        );
        assert_eq!(
            math_to_latex(true, "E = mc^{2}", Some("eq:3"))["c"][1],
            "\\begin{equation}\\label{eq:3}\nE = mc^{2}\n\\end{equation}"
        );
        assert_eq!(
            math_to_latex(true, "a &= b \\\\ c &= d", None)["c"][1],
            "\\begin{equation*}\n\\begin{aligned}\na &= b \\\\ c &= d\n\\end{aligned}\n\\end{equation*}"
        );
        assert_eq!(
            math_to_latex(false, "x % note", None)["c"][1],
            "$x % note\n$"
        );
    }

    #[test]
    fn only_a_number_the_author_typed_is_read_as_one() {
        for (text, want) in [
            ("(3)", Some("3")),
            (" (3) ", Some("3")),
            ("(3.2)", Some("3.2")),
            ("(A.1)", Some("A.1")),
            ("(S3)", Some("S3")),
        ] {
            assert_eq!(equation_marker(text).as_deref(), want, "{text}");
        }
        // Not numbers: text beside an equation, a citation, an unclosed marker, a bare number.
        for text in ["(where x is)", "[3]", "(3", "3", "()", "(3.)", "(i)"] {
            assert_eq!(equation_marker(text), None, "{text}");
        }
        assert_eq!(equation_label("3"), "eq:3");
        assert_eq!(equation_label("3.2"), "eq:3-2");
        assert_eq!(equation_label("A.1"), "eq:A-1");
    }

    /// The three places a Word author puts an equation's number: after it in the same paragraph, on the
    /// line under it, and in the second cell of a one-row invisible table. All three end as one
    /// paragraph whose marker the walk takes off.
    #[test]
    fn a_hand_numbered_equation_keeps_its_number() {
        let math = |d: &str| json!({"t": "Math", "c": [{"t": d}, "E = mc^{2}"]});
        let para = |c: Value| json!({"t": "Para", "c": c});

        // In the same paragraph.
        let mut items = vec![math("DisplayMath"), json!({"t": "Space"}), s("(3)")];
        assert_eq!(take_equation_marker(&mut items).as_deref(), Some("3"));
        assert_eq!(items, vec![math("DisplayMath")], "the marker is taken off");

        // No marker, and a paragraph that only looks like one.
        let mut plain = vec![math("DisplayMath")];
        assert_eq!(take_equation_marker(&mut plain), None);
        let mut prose = vec![math("DisplayMath"), sp(), s("where"), sp(), s("(3)")];
        assert_eq!(take_equation_marker(&mut prose), None);
        assert_eq!(prose.len(), 5, "a paragraph with words keeps them");
        // Inline math is never numbered.
        let mut inline = vec![math("InlineMath"), sp(), s("(4)")];
        assert_eq!(take_equation_marker(&mut inline), None);

        // On the line under it.
        let mut blocks = vec![
            para(json!([math("DisplayMath")])),
            para(json!([s("(3.2)")])),
        ];
        fold_equation_numbers(&mut blocks);
        assert_eq!(blocks.len(), 1);
        assert_eq!(
            take_equation_marker(blocks[0]["c"].as_array_mut().unwrap()).as_deref(),
            Some("3.2")
        );
        // A paragraph of prose under an equation is left alone.
        let mut kept = vec![
            para(json!([math("DisplayMath")])),
            para(json!([s("where"), sp(), s("x")])),
        ];
        fold_equation_numbers(&mut kept);
        assert_eq!(kept.len(), 2);

        // In a one-row table, and a captioned table of two cells that is a table.
        let cell = |blocks: Value| json!([["", [], []], {"t": "AlignDefault"}, 1, 1, blocks]);
        let table = |caption: Value, cells: Value| {
            json!({"t": "Table", "c": [
                ["", [], []], [null, caption],
                [[{"t": "AlignDefault"}, {"t": "ColWidthDefault"}], [{"t": "AlignDefault"}, {"t": "ColWidthDefault"}]],
                [["", [], []], []],
                [[["", [], []], 0, [], [[["", [], []], cells]]]],
                [["", [], []], []],
            ]})
        };
        let eq_table = table(
            json!([]),
            json!([
                cell(json!([{"t": "Plain", "c": [math("DisplayMath")]}])),
                cell(json!([{"t": "Plain", "c": [s("(5)")]}])),
            ]),
        );
        let mut blocks = vec![eq_table.clone()];
        fold_equation_numbers(&mut blocks);
        assert_eq!(kind(&blocks[0]), "Para", "the table became the paragraph");
        assert_eq!(
            take_equation_marker(blocks[0]["c"].as_array_mut().unwrap()).as_deref(),
            Some("5")
        );
        let captioned = table(
            json!([{"t": "Plain", "c": [s("Results.")]}]),
            json!([
                cell(json!([{"t": "Plain", "c": [math("DisplayMath")]}])),
                cell(json!([{"t": "Plain", "c": [s("(5)")]}])),
            ]),
        );
        let mut blocks = vec![captioned];
        fold_equation_numbers(&mut blocks);
        assert_eq!(kind(&blocks[0]), "Table", "a captioned table stays a table");
    }

    #[test]
    fn tidy_removes_pandoc_scaffolding() {
        let body = "Text before\n\n\\begin{equation}\nx\n\\end{equation}\n\nwhere x is here.\n\n\\begin{itemize}\n\\tightlist\n\\item\n  first\n\\item\n  \\begin{itemize}\n  \\item\n    nested\n  \\end{itemize}\n\\end{itemize}\n\n\n\\begin{enumerate}\n\\def\\labelenumi{\\arabic{enumi}.}\n\\item\n  one\n\\end{enumerate}\n\n\\end{equation}\n\nNext.\n\n\\pandocbounded{\\includegraphics[keepaspectratio]{figures/a.png}}\n\\includegraphics[width=0.5\\linewidth,height=\\textheight,keepaspectratio]{figures/b.png}";
        assert_eq!(
            tidy(body),
            "Text before\n\\begin{equation}\nx\n\\end{equation}\nwhere x is here.\n\n\\begin{itemize}\n\\item first\n\\item\n  \\begin{itemize}\n  \\item nested\n  \\end{itemize}\n\\end{itemize}\n\n\\begin{enumerate}\n\\item one\n\\end{enumerate}\n\n\\end{equation}\n\nNext.\n\n\\includegraphics[keepaspectratio]{figures/a.png}\n\\includegraphics[width=0.5\\linewidth]{figures/b.png}"
        );
    }

    #[test]
    fn only_the_packages_the_text_uses_are_loaded() {
        assert_eq!(packages("Plain text.", false), vec!["hyperref"]);
        assert_eq!(
            packages("\\includegraphics{x} \\toprule \\st{y}", true),
            vec!["amsmath", "amssymb", "graphicx", "booktabs", "soul", "hyperref"]
        );
        assert_eq!(
            packages("\\begin{longtable}[]{@{}>{\\raggedright\\arraybackslash}p{(\\linewidth) * \\real{0.5}}@{}}", false),
            vec!["array", "longtable", "calc", "hyperref"]
        );
    }

    #[test]
    fn placeholder_authors_are_dropped() {
        let meta = json!({"author": {"t": "MetaList", "c": [
            {"t": "MetaInlines", "c": [s("Microsoft"), sp(), s("Office"), sp(), s("User")]},
            {"t": "MetaInlines", "c": [s("Maryam"), sp(), s("Rahimi")]},
        ]}});
        let a = authors(&meta);
        assert_eq!(a.len(), 1);
        assert_eq!(text_of(&Value::Array(a[0].clone())), "Maryam Rahimi");
        assert!(authors(&json!({"author": {"t": "MetaString", "c": "Windows User"}})).is_empty());
    }

    #[test]
    fn a_word_document_becomes_a_paper() {
        let Some(pandoc) = pandoc_or_skip("a_word_document_becomes_a_paper") else {
            return;
        };
        let dir = scratch("convert");
        let docx = dir.join("Draft v3.docx");
        fixture(&docx);
        let parent = dir.join("Papers");
        fs::create_dir_all(&parent).unwrap();
        let dest = parent.join("draft");
        let r = convert(&pandoc, &docx, &dest).unwrap();
        let tex = fs::read_to_string(dest.join("main.tex")).unwrap();
        eprintln!("{}\n{:#?}", tex, r);

        // Front matter from the Title and Author paragraphs and the abstract; Word's account name is not an author.
        assert!(
            tex.contains("\\title{Score Anchors for Low-Dose CT}"),
            "{tex}"
        );
        assert!(tex.contains("\\author{Maryam Rahimi}"), "{tex}");
        assert!(!tex.contains("Microsoft Office User"));
        assert!(tex.contains("\\date{\\today}"));
        assert!(
            tex.contains(
                "\\begin{abstract}\nWe study denoising with score anchors.\n\\end{abstract}"
            ),
            "{tex}"
        );
        // Headings, emphasis, and the tracked changes accepted.
        assert!(tex.contains("\\section{Introduction}"), "{tex}");
        assert!(
            tex.contains("\\textbf{bold}") && tex.contains("\\emph{italic}"),
            "{tex}"
        );
        assert!(
            tex.contains("remarkably") && !tex.contains("quite"),
            "{tex}"
        );
        assert!(
            !tex.contains("Cite the original paper"),
            "comments are left out"
        );
        // Equations: unnumbered unless Word showed a number, and the one that did keeps it with a label.
        assert!(
            tex.contains("\\begin{equation*}\nE = mc^{2}\n\\end{equation*}"),
            "{tex}"
        );
        assert!(
            tex.contains("\\begin{equation}\\label{eq:3}\na = b\n\\end{equation}"),
            "{tex}"
        );
        assert!(!tex.contains("(3)"), "the typed number is gone: {tex}");
        assert!(tex.contains("Inline $x^{2}$ math."), "{tex}");
        // The table, with Word's number taken off the caption.
        assert!(tex.contains("\\caption{Reconstruction quality.}"), "{tex}");
        assert!(tex.contains("\\begin{tabular}{@{}lr@{}}\n\\toprule\nMethod & PSNR \\& dB \\\\\n\\midrule\nOurs & 32.4 \\\\\n\\bottomrule\n\\end{tabular}"), "{tex}");
        // The picture: moved to figures/, sized as on the A4 page (3 in of 6.27 in), relative path.
        assert!(dest.join("figures/image1.png").is_file());
        assert!(!dest.join("figures/media").exists());
        assert!(
            tex.contains("\\includegraphics[width=0.48\\linewidth]{figures/image1.png}"),
            "{tex}"
        );
        assert!(tex.contains("\\caption{Noise sweep.}"), "{tex}");
        assert!(!tex.contains("automatically generated"));
        // The Zotero citation, with its entry in refs.bib.
        assert!(tex.contains("clear here~\\cite{ho2020denoising}."), "{tex}");
        assert!(!tex.contains("(Ho et al., 2020)"));
        assert!(tex.contains("\\bibliography{refs}"));
        let bib = fs::read_to_string(dest.join("refs.bib")).unwrap();
        assert!(bib.contains("@inproceedings{ho2020denoising,"), "{bib}");
        // Only the packages in use.
        assert!(
            tex.contains("\\usepackage{amsmath,amssymb,graphicx,booktabs,hyperref}"),
            "{tex}"
        );
        assert!(!tex.contains("\\tightlist") && !tex.contains("longtable"));

        assert_eq!(
            (
                r.sections,
                r.figures,
                r.tables,
                r.equations,
                r.inline_math,
                r.citations,
                r.references
            ),
            (1, 1, 1, 2, 1, 1, 1)
        );
        assert!(
            r.summary
                .starts_with("Converted 1 section, 1 figure, 1 table"),
            "{}",
            r.summary
        );
        assert!(
            r.notes
                .iter()
                .any(|n| n.contains("2 tracked changes were accepted")),
            "{:?}",
            r.notes
        );
        assert!(
            r.notes.iter().any(|n| n.contains("1 comment was left out")),
            "{:?}",
            r.notes
        );
        assert!(
            r.notes
                .iter()
                .any(|n| n.contains("1 citation from Zotero became a \\cite command")),
            "{:?}",
            r.notes
        );
        assert!(
            r.notes.iter().any(|n| n
                .contains("1 equation numbered by hand in Word kept its number")
                && n.contains("\\label{eq:3}")),
            "the numbering rule is named only when it applied: {:?}",
            r.notes
        );
        assert_eq!(r.title, "Score Anchors for Low-Dose CT");

        // The Word file is kept beside main.tex, under its own name, byte for byte.
        let kept = dest.join("Draft v3.docx");
        assert!(kept.is_file(), "the .docx is kept beside the paper");
        assert_eq!(fs::read(&kept).unwrap(), fs::read(&docx).unwrap());
        assert!(
            r.notes
                .iter()
                .any(|n| n.contains("The Word file is kept beside main.tex")),
            "{:?}",
            r.notes
        );

        // Nothing outside the folder, and the folder is not taken twice.
        let beside: Vec<_> = fs::read_dir(&parent)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(beside, vec![std::ffi::OsString::from("draft")]);
        let e = convert(&pandoc, &docx, &dest).unwrap_err();
        assert!(e.contains("already exists and is not empty"), "{e}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn revisions_are_read_with_author_and_date() {
        let Some(pandoc) = pandoc_or_skip("revisions_are_read_with_author_and_date") else {
            return;
        };
        let dir = scratch("revisions");
        let docx = dir.join("reviewed.docx");
        fixture(&docx);
        let revs = revisions(&pandoc, &docx).unwrap();
        let find = |k: &str| {
            revs.iter()
                .find(|r| r.kind == k)
                .unwrap_or_else(|| panic!("{k} in {revs:?}"))
        };
        assert_eq!(find("insertion").text, "remarkably");
        assert_eq!(find("insertion").author, "Supervisor");
        assert_eq!(find("deletion").text, "quite");
        assert_eq!(find("deletion").date, "2026-09-10T10:01:00Z");
        assert_eq!(find("comment").text, "Cite the original paper here.");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "nothing written beside the document"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A real document end to end, compiled with Tectonic. By hand:
    /// `DABIR_DOCX=paper.docx DABIR_DOCX_OUT=/tmp/out cargo test word_import_live -- --ignored --nocapture`
    /// (`DABIR_TECTONIC` names the engine when `tectonic` is not on the PATH).
    #[test]
    #[ignore]
    fn word_import_live() {
        let docx = PathBuf::from(std::env::var("DABIR_DOCX").expect("DABIR_DOCX"));
        let dest = std::env::var("DABIR_DOCX_OUT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| scratch("live").join("paper"));
        let pandoc = crate::export::pandoc().expect("pandoc");
        let r = convert(&pandoc, &docx, &dest).unwrap();
        eprintln!("{:#?}", r);
        eprintln!("{}", fs::read_to_string(dest.join("main.tex")).unwrap());
        let tectonic = std::env::var("DABIR_TECTONIC").unwrap_or_else(|_| "tectonic".into());
        let out = std::process::Command::new(&tectonic)
            .current_dir(&dest)
            .args(["--keep-logs", "main.tex"])
            .output()
            .expect("tectonic");
        eprintln!("{}", String::from_utf8_lossy(&out.stderr));
        assert!(out.status.success(), "main.tex did not compile");
        assert!(dest.join("main.pdf").is_file());
        eprintln!("compiled: {}", dest.join("main.pdf").display());
    }
}
