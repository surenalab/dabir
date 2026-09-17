//! Word documents (.docx) as papers.
//!
//! The Word view edits a .docx in the web view and hands back the bytes; this module puts them on disk in one
//! step and reads documents as text for everything that needs text: the agent's read-only copy, the History
//! diff of a Word step, Markdown export, and the project brief.
//!
//! The text is Markdown, read straight from the package (no pandoc): headings from Word's heading styles and
//! outline levels, lists from the numbering definitions, tables as pipe tables, footnotes and endnotes as
//! Markdown notes, links from the relationships, bold and italic set on the run, equations as their text
//! between `$`. Tracked changes read as Word's No Markup view: insertions kept, deletions left out. Comments
//! can be listed at the end, with the text they are anchored to. What does not come across: images (a
//! placeholder with their description), text boxes, headers and footers, and the layout of equations.

use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Where the read-only Markdown copies live inside an agent's worktree (kept out of Git by `info/exclude`).
pub const CONTEXT_DIR: &str = ".dabir/context";

/// A Word document Dabir opens in the Word view: `.docx`, and not Word's `~$` lock file.
pub fn is_docx(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    name.to_ascii_lowercase().ends_with(".docx") && !name.starts_with("~$")
}

/// A .docx is a zip: it starts with a local file header.
pub fn looks_like_docx(bytes: &[u8]) -> bool {
    bytes.len() > 22 && bytes.starts_with(b"PK\x03\x04")
}

/// Replace `path` with `bytes` in one step: a temporary file beside it, flushed to disk, then renamed over it,
/// so a crash or a full disk never leaves half a document. The file keeps its permissions, and a symbolic link
/// keeps pointing at the file it pointed at. Bytes that are not a Word document are refused for a .docx.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("{} is not a file path", path.display()))?;
    if is_docx(path) && !looks_like_docx(bytes) {
        return Err(format!(
            "Refused to save {}: what the editor produced is not a Word document. The file on disk is unchanged.",
            name
        ));
    }
    let target = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(path).map_err(|e| e.to_string())?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !dir.is_dir() {
        return Err(format!("Could not save {}: its folder is gone.", name));
    }
    let tmp = dir.join(format!(
        ".{}.{}.dabir-tmp",
        name,
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let written = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        fs::rename(&tmp, &target)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Could not save {}: {}", name, e));
    }
    Ok(())
}

/// `%`-escapes back to text (the Word view sends the path of a save in a header, which must be ASCII).
pub fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| format!("Malformed escape in {}", s))?;
            out.push(hex);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "The path is not UTF-8".to_string())
}

// ---------------------------------------------------------------- the package

struct Package {
    parts: HashMap<String, String>,
}

impl Package {
    fn read(bytes: &[u8]) -> Result<Package, String> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| {
            "This is not a Word document (.docx): it is not a zip package.".to_string()
        })?;
        let mut parts = HashMap::new();
        for i in 0..zip.len() {
            let Ok(mut f) = zip.by_index(i) else { continue };
            let name = f.name().to_string();
            if !(name.ends_with(".xml") || name.ends_with(".rels")) || f.size() > 64 * 1024 * 1024 {
                continue;
            }
            let mut s = String::new();
            if f.read_to_string(&mut s).is_ok() {
                parts.insert(name, s);
            }
        }
        Ok(Package { parts })
    }

    fn part(&self, name: &str) -> Option<&str> {
        self.parts.get(name).map(|s| s.as_str())
    }

    /// The main document part, from the package relationships (`word/document.xml` in practice).
    fn main_part(&self) -> String {
        self.part("_rels/.rels")
            .and_then(|rels| {
                relationships(rels)
                    .into_iter()
                    .find(|r| r.kind.ends_with("/officeDocument"))
                    .map(|r| r.target.trim_start_matches('/').to_string())
            })
            .unwrap_or_else(|| "word/document.xml".into())
    }

    fn rels_of(&self, part: &str) -> HashMap<String, Relationship> {
        let (dir, file) = part.rsplit_once('/').unwrap_or(("", part));
        let rels = format!(
            "{}{}_rels/{}.rels",
            dir,
            if dir.is_empty() { "" } else { "/" },
            file
        );
        self.part(&rels)
            .map(|x| {
                relationships(x)
                    .into_iter()
                    .map(|r| (r.id.clone(), r))
                    .collect()
            })
            .unwrap_or_default()
    }
}

struct Relationship {
    id: String,
    kind: String,
    target: String,
    external: bool,
}

fn relationships(xml: &str) -> Vec<Relationship> {
    let mut out = vec![];
    let mut r = Reader::from_str(xml);
    loop {
        match r.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) if local(&e) == "Relationship" => {
                out.push(Relationship {
                    id: attr(&e, "Id").unwrap_or_default(),
                    kind: attr(&e, "Type").unwrap_or_default(),
                    target: attr(&e, "Target").unwrap_or_default(),
                    external: attr(&e, "TargetMode").as_deref() == Some("External"),
                });
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

fn qname(e: &BytesStart) -> String {
    e.name().as_ref().to_string()
}

fn local(e: &BytesStart) -> String {
    e.local_name().as_ref().to_string()
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    let a = e.try_get_attribute(name).ok()??;
    let raw = a.value.to_string();
    Some(
        quick_xml::escape::unescape(&raw)
            .map(|c| c.into_owned())
            .unwrap_or(raw),
    )
}

/// `<w:b/>` is on; `<w:b w:val="0"/>` (or false, off) is off.
fn on(e: &BytesStart) -> bool {
    !matches!(
        attr(e, "w:val").as_deref(),
        Some("0" | "false" | "off" | "none")
    )
}

// ---------------------------------------------------------------- styles and numbering

#[derive(Default)]
struct Styles {
    by_id: HashMap<String, (String, Option<String>, Option<u8>)>,
}

impl Styles {
    fn read(xml: Option<&str>) -> Styles {
        let mut s = Styles::default();
        let Some(xml) = xml else { return s };
        let mut r = Reader::from_str(xml);
        let mut cur: Option<(String, String, Option<String>, Option<u8>)> = None;
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) if qname(&e) == "w:style" => {
                    cur = Some((
                        attr(&e, "w:styleId").unwrap_or_default(),
                        String::new(),
                        None,
                        None,
                    ));
                }
                Ok(Event::Empty(e)) => {
                    if let Some(c) = cur.as_mut() {
                        match qname(&e).as_str() {
                            "w:name" => c.1 = attr(&e, "w:val").unwrap_or_default(),
                            "w:basedOn" => c.2 = attr(&e, "w:val"),
                            "w:outlineLvl" => c.3 = attr(&e, "w:val").and_then(|v| v.parse().ok()),
                            _ => {}
                        }
                    }
                }
                Ok(Event::End(e)) if e.name().as_ref() == "w:style" => {
                    if let Some((id, name, based, outline)) = cur.take() {
                        s.by_id.insert(id, (name, based, outline));
                    }
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        s
    }

    fn name(&self, id: &str) -> String {
        self.by_id
            .get(id)
            .map(|x| x.0.clone())
            .unwrap_or_else(|| id.to_string())
    }

    /// 0 for the title, 1–9 for headings, None for body text; inherited through `basedOn`.
    fn level(&self, id: &str) -> Option<u8> {
        let mut cur = Some(id.to_string());
        for _ in 0..12 {
            let c = cur?;
            let (name, based, outline) =
                self.by_id
                    .get(&c)
                    .cloned()
                    .unwrap_or((c.clone(), None, None));
            let n = name.to_ascii_lowercase();
            if n == "title" || c == "Title" {
                return Some(0);
            }
            for s in [n.as_str(), c.to_ascii_lowercase().as_str()] {
                if let Some(d) = s.strip_prefix("heading").map(|d| d.trim()) {
                    if let Ok(k) = d.parse::<u8>() {
                        if (1..=9).contains(&k) {
                            return Some(k);
                        }
                    }
                }
            }
            if let Some(o) = outline {
                if o < 9 {
                    return Some(o + 1);
                }
            }
            cur = based;
        }
        None
    }
}

#[derive(Default)]
struct Numbering {
    num_to_abstract: HashMap<String, String>,
    formats: HashMap<(String, u8), String>,
}

impl Numbering {
    fn read(xml: Option<&str>) -> Numbering {
        let mut n = Numbering::default();
        let Some(xml) = xml else { return n };
        let mut r = Reader::from_str(xml);
        let mut abs: Option<String> = None;
        let mut lvl: Option<u8> = None;
        let mut num: Option<String> = None;
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) => match qname(&e).as_str() {
                    "w:abstractNum" => abs = attr(&e, "w:abstractNumId"),
                    "w:lvl" => lvl = attr(&e, "w:ilvl").and_then(|v| v.parse().ok()),
                    "w:num" => num = attr(&e, "w:numId"),
                    _ => {}
                },
                Ok(Event::Empty(e)) => match qname(&e).as_str() {
                    "w:numFmt" => {
                        if let (Some(a), Some(l)) = (&abs, lvl) {
                            n.formats
                                .insert((a.clone(), l), attr(&e, "w:val").unwrap_or_default());
                        }
                    }
                    "w:abstractNumId" => {
                        if let (Some(k), Some(v)) = (&num, attr(&e, "w:val")) {
                            n.num_to_abstract.insert(k.clone(), v);
                        }
                    }
                    _ => {}
                },
                Ok(Event::End(e)) => match e.name().as_ref() {
                    "w:abstractNum" => abs = None,
                    "w:lvl" => lvl = None,
                    "w:num" => num = None,
                    _ => {}
                },
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        n
    }

    /// True for a numbered level, false for bullets.
    fn ordered(&self, num: &str, level: u8) -> bool {
        self.num_to_abstract
            .get(num)
            .and_then(|a| self.formats.get(&(a.clone(), level)))
            .map(|f| f != "bullet" && f != "none")
            .unwrap_or(false)
    }
}

// ---------------------------------------------------------------- the walk

#[derive(Clone, Debug, PartialEq)]
enum Block {
    /// 0 = title, 1–9 = heading level.
    Heading(u8, String),
    Para {
        style: String,
        text: String,
    },
    Item {
        ordered: bool,
        level: u8,
        text: String,
    },
    Table(Vec<Vec<String>>),
}

#[derive(Clone, Default, PartialEq)]
struct Style {
    bold: bool,
    italic: bool,
    link: Option<String>,
    /// Already Markdown (a note marker, an image, an equation): not escaped, and not merged with text.
    markup: bool,
}

#[derive(Default)]
struct Para {
    style: Option<String>,
    outline: Option<u8>,
    num: Option<String>,
    ilvl: u8,
    segs: Vec<(String, Style)>,
}

struct Table {
    rows: Vec<Vec<String>>,
    row: Vec<String>,
    cell: Vec<String>,
}

struct Walk<'a> {
    styles: &'a Styles,
    numbering: &'a Numbering,
    rels: &'a HashMap<String, Relationship>,
    notes: &'a mut Vec<String>,
    blocks: Vec<Block>,
    para: Option<Para>,
    tables: Vec<Table>,
    run: Style,
    link: Option<String>,
    in_ppr: bool,
    in_rpr: bool,
    in_t: bool,
    deleted: usize,
    skip: usize,
    math: usize,
    math_text: String,
    image: Option<String>,
    /// Open comment ranges and the text read inside each.
    anchors: HashMap<String, String>,
    anchored: HashMap<String, String>,
}

const SKIPPED: &[&str] = &[
    "w:sectPr",
    "w:sdtPr",
    "mc:Fallback",
    "w:pict",
    "w:object",
    "w:instrText",
    "w:delInstrText",
    "w:rPrChange",
    "w:pPrChange",
    "w:footnoteRef",
    "w:endnoteRef",
    "w:tblPr",
    "w:trPr",
];

impl<'a> Walk<'a> {
    fn text(&mut self, s: &str) {
        if self.skip > 0 || self.deleted > 0 {
            return;
        }
        if self.math > 0 {
            self.math_text.push_str(s);
            return;
        }
        if !self.in_t {
            return;
        }
        self.push(s);
    }

    fn push(&mut self, s: &str) {
        self.push_as(s, false);
    }

    fn push_as(&mut self, s: &str, markup: bool) {
        if !markup {
            for t in self.anchors.values_mut() {
                t.push_str(s);
            }
        }
        if let Some(p) = self.para.as_mut() {
            let style = Style {
                link: self.link.clone(),
                markup,
                ..self.run.clone()
            };
            match p.segs.last_mut() {
                Some((t, st)) if *st == style => t.push_str(s),
                _ => p.segs.push((s.to_string(), style)),
            }
        }
    }

    fn start(&mut self, e: &BytesStart, empty: bool) {
        let name = qname(e);
        if self.skip > 0 {
            if !empty && SKIPPED.contains(&name.as_str()) || !empty && self.image.is_some() {
                self.skip += 1;
            }
            return;
        }
        match name.as_str() {
            n if SKIPPED.contains(&n) => {
                if !empty {
                    self.skip += 1;
                }
            }
            "w:p" => {
                if !empty {
                    self.para = Some(Para::default());
                }
            }
            "w:pPr" if !empty => self.in_ppr = true,
            "w:rPr" if !empty => self.in_rpr = true,
            "w:pStyle" if self.in_ppr && !self.in_rpr => {
                if let Some(p) = self.para.as_mut() {
                    p.style = attr(e, "w:val");
                }
            }
            "w:outlineLvl" if self.in_ppr && !self.in_rpr => {
                if let Some(p) = self.para.as_mut() {
                    p.outline = attr(e, "w:val").and_then(|v| v.parse().ok());
                }
            }
            "w:numId" if self.in_ppr => {
                if let Some(p) = self.para.as_mut() {
                    p.num = attr(e, "w:val").filter(|v| v != "0");
                }
            }
            "w:ilvl" if self.in_ppr => {
                if let Some(p) = self.para.as_mut() {
                    p.ilvl = attr(e, "w:val").and_then(|v| v.parse().ok()).unwrap_or(0);
                }
            }
            "w:r" if !empty => self.run = Style::default(),
            "w:b" if self.in_rpr && !self.in_ppr => self.run.bold = on(e),
            "w:i" if self.in_rpr && !self.in_ppr => self.run.italic = on(e),
            "w:t" if !empty => self.in_t = true,
            "w:tab" if !self.in_ppr => self.push_raw(" "),
            "w:br" | "w:cr" if !self.in_ppr => {
                if attr(e, "w:type").as_deref() != Some("page") {
                    self.push_raw("\n");
                }
            }
            "w:noBreakHyphen" => self.push_raw("-"),
            "w:del" | "w:moveFrom" if !empty => self.deleted += 1,
            "w:hyperlink" if !empty => {
                self.link = attr(e, "r:id")
                    .and_then(|id| self.rels.get(&id))
                    .filter(|r| r.external)
                    .map(|r| r.target.clone())
                    .or_else(|| attr(e, "w:anchor").map(|a| format!("#{}", a)));
            }
            "w:footnoteReference" | "w:endnoteReference" => {
                let kind = if name == "w:footnoteReference" {
                    "fn"
                } else {
                    "en"
                };
                if let Some(id) = attr(e, "w:id") {
                    self.notes.push(format!("{}:{}", kind, id));
                    let n = self.notes.len();
                    self.push_markup(&format!("[^{}]", n));
                }
            }
            "m:oMath" if !empty => {
                if self.math == 0 {
                    self.math_text.clear();
                }
                self.math += 1;
            }
            "w:drawing" if !empty => {
                self.image = Some(String::new());
                self.skip += 1;
            }
            "w:commentRangeStart" => {
                if let Some(id) = attr(e, "w:id") {
                    self.anchors.insert(id, String::new());
                }
            }
            "w:commentRangeEnd" => {
                if let Some(id) = attr(e, "w:id") {
                    if let Some(t) = self.anchors.remove(&id) {
                        self.anchored.insert(id, t);
                    }
                }
            }
            "w:tbl" if !empty => self.tables.push(Table {
                rows: vec![],
                row: vec![],
                cell: vec![],
            }),
            "w:tr" if !empty => {
                if let Some(t) = self.tables.last_mut() {
                    t.row.clear();
                }
            }
            "w:tc" if !empty => {
                if let Some(t) = self.tables.last_mut() {
                    t.cell.clear();
                }
            }
            "w:gridSpan" => {
                if let (Some(t), Some(n)) = (
                    self.tables.last_mut(),
                    attr(e, "w:val").and_then(|v| v.parse::<usize>().ok()),
                ) {
                    // A merged cell is one cell wide in Markdown; the columns it spans stay, empty.
                    for _ in 1..n.min(64) {
                        t.row.push(String::new());
                    }
                }
            }
            _ => {}
        }
    }

    /// Text that is not inside `<w:t>` (tabs, breaks, hyphens): kept only in live text.
    fn push_raw(&mut self, s: &str) {
        if self.skip > 0 || self.deleted > 0 || self.math > 0 || self.para.is_none() {
            return;
        }
        self.push(s);
    }

    /// Ready-made Markdown (a note marker, an image), kept only in live text.
    fn push_markup(&mut self, s: &str) {
        if self.skip > 0 || self.deleted > 0 || self.math > 0 || self.para.is_none() {
            return;
        }
        self.push_as(s, true);
    }

    fn end(&mut self, name: &str) {
        if self.skip > 0 {
            if name == "w:drawing" && self.image.is_some() && self.skip == 1 {
                self.skip = 0;
                let alt = self.image.take().unwrap_or_default();
                self.push_markup(&format!(
                    "![{}](image)",
                    if alt.trim().is_empty() {
                        "image"
                    } else {
                        alt.trim()
                    }
                ));
                return;
            }
            if SKIPPED.contains(&name) || self.image.is_some() {
                self.skip -= 1;
            }
            return;
        }
        match name {
            "w:pPr" => self.in_ppr = false,
            "w:rPr" => self.in_rpr = false,
            "w:t" => self.in_t = false,
            "w:del" | "w:moveFrom" => self.deleted = self.deleted.saturating_sub(1),
            "w:hyperlink" => self.link = None,
            "m:oMath" => {
                self.math = self.math.saturating_sub(1);
                if self.math == 0 && self.deleted == 0 {
                    let t = self.math_text.trim().to_string();
                    if !t.is_empty() {
                        self.push_as(&format!("${}$", t), true);
                    }
                }
            }
            "w:p" => self.end_paragraph(),
            "w:tc" => {
                if let Some(t) = self.tables.last_mut() {
                    let text = t.cell.join(" ");
                    t.row.push(text);
                }
            }
            "w:tr" => {
                if let Some(t) = self.tables.last_mut() {
                    let row = std::mem::take(&mut t.row);
                    t.rows.push(row);
                }
            }
            "w:tbl" => {
                if let Some(t) = self.tables.pop() {
                    match self.tables.last_mut() {
                        // A table inside a cell reads as its rows, one after another.
                        Some(outer) => outer.cell.push(
                            t.rows
                                .iter()
                                .map(|r| r.join(" · "))
                                .collect::<Vec<_>>()
                                .join("; "),
                        ),
                        None => self.blocks.push(Block::Table(t.rows)),
                    }
                }
            }
            _ => {}
        }
    }

    fn docpr(&mut self, e: &BytesStart) {
        if let Some(img) = self.image.as_mut() {
            if img.is_empty() {
                *img = attr(e, "descr")
                    .filter(|d| !d.trim().is_empty())
                    .or_else(|| attr(e, "title"))
                    .or_else(|| attr(e, "name"))
                    .unwrap_or_default();
            }
        }
    }

    fn end_paragraph(&mut self) {
        let Some(p) = self.para.take() else { return };
        let heading = p
            .outline
            .filter(|o| *o < 9)
            .map(|o| o + 1)
            .or_else(|| p.style.as_deref().and_then(|s| self.styles.level(s)));
        let in_table = !self.tables.is_empty();
        let text = render(&p.segs, heading.is_none(), in_table);
        if in_table {
            if let Some(t) = self.tables.last_mut() {
                if !text.is_empty() {
                    t.cell.push(text);
                }
            }
            return;
        }
        if text.trim().is_empty() {
            return;
        }
        let block = match (heading, &p.num) {
            (Some(level), _) => Block::Heading(level, text.replace('\n', " ")),
            (None, Some(num)) => Block::Item {
                ordered: self.numbering.ordered(num, p.ilvl),
                level: p.ilvl,
                text,
            },
            (None, None) => Block::Para {
                style: p
                    .style
                    .as_deref()
                    .map(|s| self.styles.name(s))
                    .unwrap_or_default(),
                text,
            },
        };
        self.blocks.push(block);
    }
}

/// Characters Markdown would read as markup, escaped.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '>' | '#' | '|'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A paragraph's runs as Markdown: emphasis where the run sets it (not in headings), links, and breaks as
/// Markdown line breaks (a space inside a table cell).
fn render(segs: &[(String, Style)], emphasis: bool, in_table: bool) -> String {
    let mut out = String::new();
    for (text, st) in segs {
        let body = if st.markup {
            text.clone()
        } else {
            escape(text)
        };
        let body = if in_table {
            body.replace('\n', " ")
        } else {
            body.replace('\n', "  \n")
        };
        let mark = match (emphasis && st.bold, emphasis && st.italic) {
            (true, true) => "***",
            (true, false) => "**",
            (false, true) => "*",
            _ => "",
        };
        let trimmed = body.trim();
        let wrapped = if mark.is_empty() || trimmed.is_empty() {
            body.clone()
        } else {
            let lead = &body[..body.len() - body.trim_start().len()];
            let tail = &body[body.trim_end().len()..];
            format!("{}{}{}{}{}", lead, mark, trimmed, mark, tail)
        };
        match &st.link {
            Some(url) if !trimmed.is_empty() => out.push_str(&format!(
                "[{}]({})",
                wrapped.trim(),
                url.replace(' ', "%20")
            )),
            _ => out.push_str(&wrapped),
        }
    }
    out.trim().to_string()
}

fn walk(
    xml: &str,
    styles: &Styles,
    numbering: &Numbering,
    rels: &HashMap<String, Relationship>,
    notes: &mut Vec<String>,
) -> (Vec<Block>, HashMap<String, String>) {
    let mut w = Walk {
        styles,
        numbering,
        rels,
        notes,
        blocks: vec![],
        para: None,
        tables: vec![],
        run: Style::default(),
        link: None,
        in_ppr: false,
        in_rpr: false,
        in_t: false,
        deleted: 0,
        skip: 0,
        math: 0,
        math_text: String::new(),
        image: None,
        anchors: HashMap::new(),
        anchored: HashMap::new(),
    };
    let mut r = Reader::from_str(xml);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) => w.start(&e, false),
            Ok(Event::Empty(e)) => {
                if qname(&e) == "wp:docPr" {
                    w.docpr(&e);
                } else {
                    w.start(&e, true);
                }
            }
            Ok(Event::End(e)) => w.end(e.name().as_ref()),
            Ok(Event::Text(t)) => w.text(&t.xml10_content()),
            Ok(Event::CData(t)) => w.text(&t.xml10_content()),
            Ok(Event::GeneralRef(g)) => {
                let resolved = match g.resolve_char_ref() {
                    Ok(Some(c)) => Some(c.to_string()),
                    _ => resolve_predefined_entity(&g.xml10_content()).map(|s| s.to_string()),
                };
                if let Some(s) = resolved {
                    w.text(&s);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    let anchored = std::mem::take(&mut w.anchored);
    (w.blocks, anchored)
}

/// The text of each note (`w:footnote` or `w:endnote`) by id, separators left out.
fn notes_of(
    xml: Option<&str>,
    tag: &str,
    styles: &Styles,
    numbering: &Numbering,
    rels: &HashMap<String, Relationship>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(xml) = xml else { return out };
    for (id, body) in split_elements(xml, tag) {
        let mut ignored = vec![];
        let (blocks, _) = walk(&body, styles, numbering, rels, &mut ignored);
        let text = blocks.iter().map(block_text).collect::<Vec<_>>().join(" ");
        if !text.trim().is_empty() {
            out.insert(id, text);
        }
    }
    out
}

/// Each `<tag w:id="…">…</tag>` as (id, inner xml), skipping separator notes.
fn split_elements(xml: &str, tag: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i..];
        let Some(gt) = after.find('>') else { break };
        let head = &after[..gt];
        if head.ends_with('/') || after[open.len()..].starts_with(|c: char| c.is_alphanumeric()) {
            rest = &after[gt..];
            continue;
        }
        let Some(j) = after.find(&close) else { break };
        let id = head
            .split("w:id=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or("")
            .to_string();
        let separator = head.contains("w:type=\"separator\"")
            || head.contains("w:type=\"continuationSeparator\"")
            || head.contains("w:type=\"continuationNotice\"");
        if !separator {
            // Wrap in a root that declares nothing: quick-xml does not check namespaces.
            out.push((id, format!("<root>{}</root>", &after[gt + 1..j])));
        }
        rest = &after[j + close.len()..];
    }
    out
}

fn block_text(b: &Block) -> String {
    match b {
        Block::Heading(_, t) | Block::Para { text: t, .. } | Block::Item { text: t, .. } => {
            t.clone()
        }
        Block::Table(rows) => rows
            .iter()
            .map(|r| r.join(" "))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

struct Comment {
    id: String,
    author: String,
    text: String,
}

fn comments_of(
    xml: Option<&str>,
    styles: &Styles,
    numbering: &Numbering,
    rels: &HashMap<String, Relationship>,
) -> Vec<Comment> {
    let Some(xml) = xml else { return vec![] };
    let mut authors = HashMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if qname(&e) == "w:comment" => {
                if let Some(id) = attr(&e, "w:id") {
                    authors.insert(id, attr(&e, "w:author").unwrap_or_default());
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    split_elements(xml, "w:comment")
        .into_iter()
        .map(|(id, body)| {
            let mut ignored = vec![];
            let (blocks, _) = walk(&body, styles, numbering, rels, &mut ignored);
            Comment {
                author: authors.get(&id).cloned().unwrap_or_default(),
                text: blocks.iter().map(block_text).collect::<Vec<_>>().join(" "),
                id,
            }
        })
        .collect()
}

/// What `to_markdown` includes besides the body.
#[derive(Clone, Copy, Default)]
pub struct Options {
    /// List the comments at the end, each with the text it is anchored to.
    pub comments: bool,
}

struct Parsed {
    blocks: Vec<Block>,
    notes: Vec<String>,
    note_text: HashMap<String, String>,
    comments: Vec<Comment>,
    anchored: HashMap<String, String>,
}

fn read(bytes: &[u8]) -> Result<Parsed, String> {
    let pkg = Package::read(bytes)?;
    let main = pkg.main_part();
    let doc = pkg
        .part(&main)
        .ok_or_else(|| format!("The document has no {}", main))?;
    let dir = main.rsplit_once('/').map(|(d, _)| d).unwrap_or("word");
    let styles = Styles::read(pkg.part(&format!("{}/styles.xml", dir)));
    let numbering = Numbering::read(pkg.part(&format!("{}/numbering.xml", dir)));
    let rels = pkg.rels_of(&main);
    let mut notes = vec![];
    let (blocks, anchored) = walk(doc, &styles, &numbering, &rels, &mut notes);
    let mut note_text = HashMap::new();
    for (tag, kind, file) in [
        ("w:footnote", "fn", "footnotes.xml"),
        ("w:endnote", "en", "endnotes.xml"),
    ] {
        let part = format!("{}/{}", dir, file);
        let part_rels = pkg.rels_of(&part);
        for (id, text) in notes_of(pkg.part(&part), tag, &styles, &numbering, &part_rels) {
            note_text.insert(format!("{}:{}", kind, id), text);
        }
    }
    let comments = comments_of(
        pkg.part(&format!("{}/comments.xml", dir)),
        &styles,
        &numbering,
        &rels,
    );
    Ok(Parsed {
        blocks,
        notes,
        note_text,
        comments,
        anchored,
    })
}

/// The document as Markdown. The title (Word's Title style) goes in a front-matter block; Heading 1 is `#`.
pub fn to_markdown(bytes: &[u8], opts: Options) -> Result<String, String> {
    let r = read(bytes)?;
    let mut out = String::new();
    let titles: Vec<&String> = r
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Heading(0, t) => Some(t),
            _ => None,
        })
        .collect();
    if !titles.is_empty() {
        let joined = titles
            .iter()
            .map(|t| t.replace('\\', ""))
            .collect::<Vec<_>>()
            .join(" ");
        out.push_str(&format!(
            "---\ntitle: \"{}\"\n---\n\n",
            joined.replace('"', "\\\"")
        ));
    }
    let mut prev_item = false;
    for b in &r.blocks {
        match b {
            Block::Heading(0, _) => continue,
            Block::Heading(level, t) => {
                out.push_str(&format!(
                    "{} {}\n\n",
                    "#".repeat((*level).min(6) as usize),
                    t
                ));
                prev_item = false;
            }
            Block::Para { text, .. } => {
                out.push_str(text);
                out.push_str("\n\n");
                prev_item = false;
            }
            Block::Item {
                ordered,
                level,
                text,
            } => {
                if prev_item && out.ends_with("\n\n") {
                    out.pop();
                }
                let indent = "   ".repeat(*level as usize);
                let marker = if *ordered { "1." } else { "-" };
                out.push_str(&format!(
                    "{}{} {}\n\n",
                    indent,
                    marker,
                    text.replace("  \n", &format!("  \n{}   ", indent))
                ));
                prev_item = true;
            }
            Block::Table(rows) => {
                let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
                if cols == 0 {
                    continue;
                }
                for (i, row) in rows.iter().enumerate() {
                    let cells: Vec<String> = (0..cols)
                        .map(|c| row.get(c).cloned().unwrap_or_default())
                        .collect();
                    out.push_str(&format!("| {} |\n", cells.join(" | ")));
                    if i == 0 {
                        out.push_str(&format!("|{}\n", " --- |".repeat(cols)));
                    }
                }
                out.push('\n');
                prev_item = false;
            }
        }
    }
    for (i, key) in r.notes.iter().enumerate() {
        if let Some(t) = r.note_text.get(key) {
            out.push_str(&format!("[^{}]: {}\n", i + 1, t));
        }
    }
    if !r.notes.is_empty() {
        out.push('\n');
    }
    if opts.comments && !r.comments.is_empty() {
        out.push_str("---\n\nComments in the document:\n\n");
        for c in &r.comments {
            let anchor = r
                .anchored
                .get(&c.id)
                .map(|a| a.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|a| !a.is_empty())
                .map(|a| {
                    let cut: String = a.chars().take(120).collect();
                    format!(
                        " on “{}{}”",
                        cut,
                        if a.chars().count() > 120 { "…" } else { "" }
                    )
                })
                .unwrap_or_default();
            out.push_str(&format!(
                "- {}{}: {}\n",
                if c.author.is_empty() {
                    "Someone"
                } else {
                    &c.author
                },
                anchor,
                c.text
            ));
        }
        out.push('\n');
    }
    Ok(out.trim_end().to_string() + "\n")
}

/// Markdown of the document at `path`.
pub fn markdown_file(path: &Path, opts: Options) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Could not read {}: {}", path.display(), e))?;
    to_markdown(&bytes, opts)
}

/// What the project brief and the agent's outline take from a Word manuscript.
#[derive(Default, Debug)]
pub struct Summary {
    pub title: Option<String>,
    pub abstract_: Option<String>,
    /// (level, text) for headings 1–3.
    pub headings: Vec<(u8, String)>,
}

pub fn summary(path: &Path) -> Summary {
    let Ok(bytes) = fs::read(path) else {
        return Summary::default();
    };
    let Ok(r) = read(&bytes) else {
        return Summary::default();
    };
    let plain = |t: &str| t.replace('\\', "");
    let mut s = Summary::default();
    let mut after_label = false;
    for b in &r.blocks {
        match b {
            Block::Heading(0, t) if s.title.is_none() => s.title = Some(plain(t)),
            Block::Heading(l, t) if *l <= 3 => {
                after_label = t.trim().eq_ignore_ascii_case("abstract");
                if !after_label {
                    s.headings.push((*l, plain(t)));
                }
            }
            Block::Para { style, text } => {
                let t = plain(text);
                let label = t
                    .trim()
                    .trim_end_matches(':')
                    .eq_ignore_ascii_case("abstract");
                // The abstract follows an "Abstract" label, carries an abstract style, or starts with the word.
                let styled = style.to_ascii_lowercase().contains("abstract");
                if s.abstract_.is_none() {
                    if (after_label || styled) && !label {
                        s.abstract_ = Some(t.clone());
                    } else if let Some(rest) = t
                        .strip_prefix("Abstract")
                        .map(|r| r.trim_start_matches([':', '.', ' ', '—', '-']))
                    {
                        if rest.len() > 40 {
                            s.abstract_ = Some(rest.to_string());
                        }
                    }
                }
                after_label = label;
            }
            _ => after_label = false,
        }
    }
    s
}

// ---------------------------------------------------------------- papers

/// `dabir.toml [paper] main`, when it names a Word document that exists.
pub fn declared_main(root: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(root.join("dabir.toml")).ok()?;
    let value: toml::Table = text.parse().ok()?;
    let main = value.get("paper")?.get("main")?.as_str()?;
    let path = root.join(main);
    (is_docx(&path) && path.is_file()).then_some(path)
}

/// The Word manuscript of a folder with no LaTeX or Typst one: `main.docx`, `manuscript.docx` or `paper.docx`,
/// else the most recently changed .docx in the folder itself.
pub fn find_main(root: &Path) -> Option<PathBuf> {
    for name in ["main.docx", "manuscript.docx", "paper.docx"] {
        let p = root.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut docs: Vec<(std::time::SystemTime, PathBuf)> = fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_docx(p))
        .filter(|p| {
            !p.file_name()
                .map(|n| n.to_string_lossy().starts_with('.'))
                .unwrap_or(true)
        })
        .map(|p| {
            (
                fs::metadata(&p)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH),
                p,
            )
        })
        .collect();
    docs.sort();
    docs.pop().map(|(_, p)| p)
}

/// Where the Markdown copy of `rel` goes, relative to the paper's folder. Keep in step with `wordContextPath`
/// in src/lib/word.ts.
pub fn context_rel(rel: &str) -> String {
    let flat = rel.replace('\\', "/");
    let flat = flat.trim_start_matches("./");
    let stem = if flat.to_ascii_lowercase().ends_with(".docx") {
        &flat[..flat.len() - 5]
    } else {
        flat
    };
    format!("{}/{}.md", CONTEXT_DIR, stem.replace('/', "__"))
}

/// Write the read-only Markdown copy of the Word document `rel` (relative to `folder`, the paper's folder in an
/// agent's worktree) and return its relative path. Comments are included: they are often what a request is about.
pub fn write_context(folder: &Path, rel: &str) -> Result<String, String> {
    let md = markdown_file(&folder.join(rel), Options { comments: true })?;
    let out_rel = context_rel(rel);
    let out = folder.join(&out_rel);
    if let Some(dir) = out.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let header = format!(
        "<!-- A read-only Markdown copy of {rel}, made by Dabir for this run. Edits here are not saved anywhere. -->\n\n"
    );
    fs::write(&out, header + &md).map_err(|e| e.to_string())?;
    Ok(out_rel)
}

/// Word packages built in memory, for tests here and in lib.rs.
#[cfg(test)]
pub mod fixture {
    use std::io::Write as _;

    pub const NS: &str = r#"xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing""#;

    /// A package with the given body, styles, numbering and notes.
    pub fn docx(body: &str, extra: &[(&str, String)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let opt = zip::write::SimpleFileOptions::default();
            let mut put = |name: &str, text: &str| {
                z.start_file(name, opt).unwrap();
                z.write_all(text.as_bytes()).unwrap();
            };
            put("[Content_Types].xml", "<Types/>");
            put(
                "_rels/.rels",
                r#"<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            );
            put(
                "word/_rels/document.xml.rels",
                r#"<Relationships><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org/a b" TargetMode="External"/></Relationships>"#,
            );
            put(
                "word/document.xml",
                &format!(
                    r#"<?xml version="1.0"?><w:document {NS}><w:body>{body}<w:sectPr><w:pgSz w:w="11906"/></w:sectPr></w:body></w:document>"#
                ),
            );
            put(
                "word/styles.xml",
                &format!(
                    r#"<w:styles {NS}>
                <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
                <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
                <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
                <w:style w:type="paragraph" w:styleId="Kop2"><w:name w:val="heading 2"/></w:style>
                <w:style w:type="paragraph" w:styleId="SectionTitle"><w:name w:val="Section Title"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
                <w:style w:type="paragraph" w:styleId="Abstract"><w:name w:val="Abstract"/></w:style>
                </w:styles>"#
                ),
            );
            put(
                "word/numbering.xml",
                &format!(
                    r#"<w:numbering {NS}>
                <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
                <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
                <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
                <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
                </w:numbering>"#
                ),
            );
            for (name, text) in extra {
                put(name, text);
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    pub fn p(style: &str, runs: &str) -> String {
        let ppr = if style.is_empty() {
            String::new()
        } else {
            format!(r#"<w:pPr><w:pStyle w:val="{style}"/></w:pPr>"#)
        };
        format!("<w:p>{ppr}{runs}</w:p>")
    }
    pub fn r(text: &str) -> String {
        format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }

    /// A document of (style, text) paragraphs.
    pub fn document(paras: &[(&str, &str)]) -> Vec<u8> {
        let body: String = paras.iter().map(|(st, t)| p(st, &r(t))).collect();
        docx(&body, &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dabir-word-{}-{}", tag, uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    use super::fixture::{docx, p, r, NS};

    #[test]
    fn headings_come_from_names_ids_and_outline_levels() {
        let body = [
            p("Title", &r("Willow buffers")),
            p("Heading1", &r("Introduction")),
            p("Kop2", &r("Sites")),
            p("SectionTitle", &r("Methods")),
            format!(
                r#"<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr>{}</w:p>"#,
                r("Direct level")
            ),
            p("", &r("Body &amp; more &#8212; text")),
        ]
        .concat();
        let md = to_markdown(&docx(&body, &[]), Options::default()).unwrap();
        assert_eq!(
            md,
            "---\ntitle: \"Willow buffers\"\n---\n\n# Introduction\n\n## Sites\n\n# Methods\n\n### Direct level\n\nBody & more — text\n"
        );
    }

    #[test]
    fn deletions_are_left_out_and_insertions_kept() {
        let body = p(
            "",
            &format!(
                r#"{}<w:del w:id="1" w:author="M"><w:r><w:delText>can be</w:delText></w:r></w:del><w:ins w:id="2" w:author="M">{}</w:ins>{}"#,
                r("where a buffer "),
                r("is"),
                r(" wider")
            ),
        );
        let md = to_markdown(&docx(&body, &[]), Options::default()).unwrap();
        assert_eq!(md, "where a buffer is wider\n");
    }

    #[test]
    fn emphasis_links_breaks_and_escapes() {
        let body = p(
            "",
            &format!(
                r#"<w:r><w:rPr><w:b/></w:rPr><w:t>Bold </w:t></w:r><w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t>italic</w:t></w:r>{}<w:hyperlink r:id="rLink">{}</w:hyperlink><w:r><w:br/><w:t>2*3 [x]</w:t><w:tab/><w:t>end</w:t></w:r>"#,
                r(" and "),
                r("a link")
            ),
        );
        let md = to_markdown(&docx(&body, &[]), Options::default()).unwrap();
        assert_eq!(
            md,
            "**Bold** *italic* and [a link](https://example.org/a%20b)  \n2\\*3 \\[x\\] end\n"
        );
    }

    #[test]
    fn lists_follow_the_numbering_definitions() {
        let item = |num: &str, lvl: &str, text: &str| {
            format!(
                r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="{lvl}"/><w:numId w:val="{num}"/></w:numPr></w:pPr>{}</w:p>"#,
                r(text)
            )
        };
        let body = [
            item("1", "0", "bullet"),
            item("1", "1", "nested number"),
            item("2", "0", "numbered"),
            p("", &r("after")),
        ]
        .concat();
        let md = to_markdown(&docx(&body, &[]), Options::default()).unwrap();
        assert_eq!(md, "- bullet\n   1. nested number\n1. numbered\n\nafter\n");
    }

    #[test]
    fn tables_become_pipe_tables() {
        let cell = |t: &str| format!("<w:tc><w:tcPr/>{}</w:tc>", p("", &r(t)));
        let body = format!(
            r#"<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/></w:tblPr><w:tr>{}{}</w:tr><w:tr>{}<w:tc><w:tcPr><w:gridSpan w:val="1"/></w:tcPr>{}{}</w:tc></w:tr></w:tbl>"#,
            cell("Buffer"),
            cell("Removal | %"),
            cell("Willow"),
            p("", &r("58")),
            p("", &r("(n=12)"))
        );
        let md = to_markdown(&docx(&body, &[]), Options::default()).unwrap();
        assert_eq!(
            md,
            "| Buffer | Removal \\| % |\n| --- | --- |\n| Willow | 58 (n=12) |\n"
        );
    }

    #[test]
    fn notes_comments_equations_and_images() {
        let body = p(
            "",
            &format!(
                r#"<w:commentRangeStart w:id="0"/>{}<w:commentRangeEnd w:id="0"/><w:r><w:footnoteReference w:id="2"/></w:r><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="PSNR plot"/></wp:inline></w:drawing></w:r><w:r><w:instrText> CITATION x </w:instrText></w:r>"#,
                r("Removal was 58 %")
            ),
        );
        let footnotes = format!(
            r#"<w:footnotes {NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Base flow only.</w:t></w:r></w:p></w:footnote></w:footnotes>"#
        );
        let comments = format!(
            r#"<w:comments {NS}><w:comment w:id="0" w:author="Maryam &amp; Co" w:date="2026-09-11T14:02:00Z"><w:p><w:r><w:t>Give the interval.</w:t></w:r></w:p></w:comment></w:comments>"#
        );
        let bytes = docx(
            &body,
            &[
                ("word/footnotes.xml", footnotes),
                ("word/comments.xml", comments),
            ],
        );
        let plain = to_markdown(&bytes, Options::default()).unwrap();
        assert_eq!(
            plain,
            "Removal was 58 %[^1]$x=1$![PSNR plot](image)\n\n[^1]: Base flow only.\n"
        );
        let with = to_markdown(&bytes, Options { comments: true }).unwrap();
        assert!(with.ends_with("Comments in the document:\n\n- Maryam & Co on “Removal was 58 %”: Give the interval.\n"), "{}", with);
    }

    #[test]
    fn not_a_package_is_an_error() {
        assert!(to_markdown(b"plain text", Options::default()).is_err());
    }

    #[test]
    fn summary_finds_title_abstract_and_headings() {
        let body = [
            p("Title", &r("Willow buffers")),
            p("", &r("Abstract")),
            p("", &r("Riparian buffers are common.")),
            p("Heading1", &r("Introduction")),
            p("Kop2", &r("Sites")),
        ]
        .concat();
        let dir = scratch("summary");
        let path = dir.join("m.docx");
        fs::write(&path, docx(&body, &[])).unwrap();
        let s = summary(&path);
        assert_eq!(s.title.as_deref(), Some("Willow buffers"));
        assert_eq!(s.abstract_.as_deref(), Some("Riparian buffers are common."));
        assert_eq!(
            s.headings,
            vec![(1, "Introduction".to_string()), (2, "Sites".to_string())]
        );
        let styled = [
            p("Abstract", &r("A styled abstract.")),
            p("Heading1", &r("One")),
        ]
        .concat();
        fs::write(&path, docx(&styled, &[])).unwrap();
        assert_eq!(
            summary(&path).abstract_.as_deref(),
            Some("A styled abstract.")
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_write_replaces_in_place_and_refuses_non_documents() {
        let dir = scratch("write");
        let path = dir.join("paper.docx");
        let first = docx(&p("", &r("one")), &[]);
        write_atomic(&path, &first).unwrap();
        assert_eq!(fs::read(&path).unwrap(), first);
        let err = write_atomic(&path, b"<html>not a document</html>").unwrap_err();
        assert!(err.contains("not a Word document"), "{}", err);
        assert_eq!(
            fs::read(&path).unwrap(),
            first,
            "a refused save leaves the file alone"
        );
        let second = docx(&p("", &r("two")), &[]);
        write_atomic(&path, &second).unwrap();
        assert_eq!(fs::read(&path).unwrap(), second);
        // No temporary files are left beside it.
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["paper.docx".to_string()]);
        // Other files are written as they are.
        write_atomic(&dir.join("notes.bin"), b"raw").unwrap();
        assert_eq!(fs::read(dir.join("notes.bin")).unwrap(), b"raw");
        assert!(write_atomic(&dir.join("missing").join("x.docx"), &second).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_permissions_and_follows_links() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perm");
        let real = dir.join("real.docx");
        let doc = docx(&p("", &r("one")), &[]);
        fs::write(&real, &doc).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link.docx");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let next = docx(&p("", &r("two")), &[]);
        write_atomic(&link, &next).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), next);
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn paths_and_names() {
        assert_eq!(
            percent_decode("%2FUsers%2Fada%2FOpen%20Source%20%2Fpaper%C3%A9.docx").unwrap(),
            "/Users/ada/Open Source /paperé.docx"
        );
        assert!(percent_decode("%zz").is_err());
        assert!(is_docx(Path::new("/a/Paper.DOCX")));
        assert!(!is_docx(Path::new("/a/~$Paper.docx")));
        assert!(!is_docx(Path::new("/a/paper.doc")));
        assert!(looks_like_docx(&docx("", &[])));
        assert_eq!(
            context_rel("manuscript.docx"),
            ".dabir/context/manuscript.md"
        );
        assert_eq!(
            context_rel("drafts/v2 final.docx"),
            ".dabir/context/drafts__v2 final.md"
        );
    }

    #[test]
    fn the_main_document_is_declared_named_or_newest() {
        let dir = scratch("main");
        assert!(find_main(&dir).is_none());
        fs::write(dir.join("old.docx"), b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("newer.docx"), b"x").unwrap();
        fs::write(dir.join("~$newer.docx"), b"x").unwrap();
        assert_eq!(find_main(&dir).unwrap().file_name().unwrap(), "newer.docx");
        fs::write(dir.join("manuscript.docx"), b"x").unwrap();
        assert_eq!(
            find_main(&dir).unwrap().file_name().unwrap(),
            "manuscript.docx"
        );
        assert!(declared_main(&dir).is_none());
        fs::write(
            dir.join("dabir.toml"),
            "[paper]\nmain = \"old.docx\"\nengine = \"word\"\n",
        )
        .unwrap();
        assert_eq!(
            declared_main(&dir).unwrap().file_name().unwrap(),
            "old.docx"
        );
        fs::write(dir.join("dabir.toml"), "[paper]\nmain = \"main.tex\"\n").unwrap();
        assert!(declared_main(&dir).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_context_copy_is_written_beside_the_paper() {
        let dir = scratch("context");
        fs::create_dir_all(dir.join("drafts")).unwrap();
        fs::write(
            dir.join("drafts/m.docx"),
            docx(&p("Heading1", &r("Results")), &[]),
        )
        .unwrap();
        let rel = write_context(&dir, "drafts/m.docx").unwrap();
        assert_eq!(rel, ".dabir/context/drafts__m.md");
        let text = fs::read_to_string(dir.join(&rel)).unwrap();
        assert!(text.starts_with("<!-- A read-only Markdown copy of drafts/m.docx"));
        assert!(text.ends_with("# Results\n"));
        let _ = fs::remove_dir_all(dir);
    }

    /// The template New Paper copies reads as the manuscript it is meant to be.
    #[test]
    fn the_bundled_template_reads_as_a_manuscript() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../templates/word-manuscript/manuscript.docx");
        let md = markdown_file(&path, Options::default()).unwrap();
        assert!(
            md.starts_with("---\ntitle: \"Title of the paper\"\n---\n"),
            "{}",
            md
        );
        for h in [
            "# Introduction",
            "# Materials and methods",
            "## Study design",
            "### Statistical analysis",
            "# References",
        ] {
            assert!(
                md.contains(&format!("\n{}\n", h)),
                "missing {} in\n{}",
                h,
                md
            );
        }
        let s = summary(&path);
        assert_eq!(s.title.as_deref(), Some("Title of the paper"));
        assert!(s
            .abstract_
            .unwrap_or_default()
            .starts_with("State the question"));
    }
}
