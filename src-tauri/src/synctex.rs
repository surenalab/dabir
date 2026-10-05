//! SyncTeX: map between source lines and PDF positions.
//!
//! Tectonic writes `main.synctex.gz` next to the PDF. The format is a plain
//! text stream: a header, `Input:<n>:<path>` lines, page blocks `{<page>` …
//! `}<page>`, and records like `h<file>,<line>:<x>,<y>:<w>,<h>,<d>`.
//! Coordinates are in scaled points (65536 per TeX point) unless `Unit` says otherwise.

use flate2::read::GzDecoder;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
struct Rec {
    page: u32,
    file: u32,
    line: u32,
    x: f64, // pt from left
    y: f64, // pt from top
}

pub struct SyncTex {
    files: HashMap<u32, String>,
    recs: Vec<Rec>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PdfPos {
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SrcPos {
    pub file: String,
    pub line: u32,
}

pub fn synctex_path(main_tex: &Path) -> PathBuf {
    let root = main_tex.parent().unwrap_or(Path::new("."));
    let stem = main_tex
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or("main".into());
    crate::single::build_dir(root).join(format!("{}.synctex.gz", stem))
}

pub fn load(path: &Path) -> Result<SyncTex, String> {
    let raw = fs::read(path).map_err(|e| format!("No SyncTeX file yet ({}). Compile first.", e))?;
    let mut text = String::new();
    if raw.starts_with(&[0x1f, 0x8b]) {
        GzDecoder::new(&raw[..])
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
    } else {
        text = String::from_utf8_lossy(&raw).to_string();
    }
    let mut files = HashMap::new();
    let mut recs = vec![];
    let mut unit = 1.0f64;
    let mut page = 0u32;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Input:") {
            let mut it = rest.splitn(2, ':');
            if let (Some(n), Some(p)) = (it.next(), it.next()) {
                if let Ok(n) = n.parse::<u32>() {
                    files.insert(n, p.trim().to_string());
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("Unit:") {
            unit = rest.trim().parse().unwrap_or(1.0);
            continue;
        }
        if let Some(rest) = line.strip_prefix('{') {
            page = rest.trim().parse().unwrap_or(page);
            continue;
        }
        if line.starts_with('}') {
            continue;
        }
        let bytes = line.as_bytes();
        if bytes.is_empty() {
            continue;
        }
        let body = match bytes[0] {
            b'h' | b'v' | b'x' | b'k' | b'g' | b'$' | b'r' | b'[' | b'(' => &line[1..],
            _ => continue,
        };
        // file,line:x,y[:...]
        let mut head = body.splitn(2, ':');
        let (Some(fl), Some(coords)) = (head.next(), head.next()) else {
            continue;
        };
        let mut fl = fl.split(',');
        let (Some(f), Some(l)) = (fl.next(), fl.next()) else {
            continue;
        };
        let coords: Vec<&str> = coords.split(':').next().unwrap_or("").split(',').collect();
        if coords.len() < 2 {
            continue;
        }
        let (Ok(file), Ok(lineno), Ok(x), Ok(y)) = (
            f.parse::<u32>(),
            l.parse::<u32>(),
            coords[0].parse::<f64>(),
            coords[1].parse::<f64>(),
        ) else {
            continue;
        };
        let to_pt = unit / 65536.0;
        recs.push(Rec {
            page,
            file,
            line: lineno,
            x: x * to_pt,
            y: y * to_pt,
        });
    }
    Ok(SyncTex { files, recs })
}

impl SyncTex {
    fn file_id(&self, path: &Path) -> Option<u32> {
        let want = path.file_name()?.to_string_lossy().to_string();
        self.files
            .iter()
            .find(|(_, p)| {
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy() == want)
                    .unwrap_or(false)
            })
            .map(|(k, _)| *k)
    }

    pub fn forward(&self, file: &Path, line: u32) -> Option<PdfPos> {
        let id = self.file_id(file)?;
        // Nearest line at or after the requested one, in the same file.
        let best = self
            .recs
            .iter()
            .filter(|r| r.file == id && r.line >= line)
            .min_by_key(|r| (r.line - line, (r.y * 10.0) as i64))?;
        Some(PdfPos {
            page: best.page,
            x: best.x,
            y: best.y,
        })
    }

    pub fn inverse(&self, page: u32, x: f64, y: f64) -> Option<SrcPos> {
        let best = self.recs.iter().filter(|r| r.page == page).min_by(|a, b| {
            let da = (a.y - y).abs() * 4.0 + (a.x - x).abs();
            let db = (b.y - y).abs() * 4.0 + (b.x - x).abs();
            da.partial_cmp(&db).unwrap()
        })?;
        Some(SrcPos {
            file: self.files.get(&best.file).cloned().unwrap_or_default(),
            line: best.line,
        })
    }
}
