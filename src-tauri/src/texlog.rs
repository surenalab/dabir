//! TeX log reader. Turns the `.log` Tectonic leaves behind into diagnostics with a file,
//! a line and the surrounding excerpt, so every problem can be traced and handed to an agent.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: String, // error | warning | info
    pub category: String, // syntax | citation | reference | rerun | box | font | package | other
    pub file: Option<String>,
    pub line: Option<u32>,
    pub message: String,
    pub context: Option<String>,
}

fn is_tex_path(tok: &str) -> bool {
    let t = tok.trim_end_matches(')');
    t.ends_with(".tex")
        || t.ends_with(".sty")
        || t.ends_with(".cls")
        || t.ends_with(".bbl")
        || t.ends_with(".aux")
}

/// Track which file TeX is reading from the `(path` / `)` markers in the log.
fn update_stack(stack: &mut Vec<String>, line: &str) {
    let mut i = 0;
    let b = line.as_bytes();
    while i < b.len() {
        match b[i] {
            b'(' => {
                let rest = &line[i + 1..];
                let end = rest.find([' ', ')', '(']).unwrap_or(rest.len());
                let tok = &rest[..end];
                if is_tex_path(tok) {
                    stack.push(tok.trim_start_matches("./").to_string());
                }
                i += 1;
            }
            b')' => {
                if stack.len() > 1 {
                    stack.pop();
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
}

fn line_no(s: &str) -> Option<u32> {
    let i = s.find("on input line ")?;
    s[i + 14..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()
}

pub fn parse(log: &str, main_name: &str) -> Vec<Diagnostic> {
    let lines: Vec<&str> = log.lines().collect();
    let mut out = vec![];
    let mut stack: Vec<String> = vec![main_name.to_string()];
    let mut i = 0;
    let current = |stack: &Vec<String>| stack.last().cloned();
    while i < lines.len() {
        let l = lines[i];
        // Errors: "! message" followed by "l.N source"
        if let Some(msg) = l.strip_prefix("! ") {
            let mut j = i + 1;
            let mut line = None;
            while j < lines.len() && j < i + 12 {
                if let Some(rest) = lines[j].strip_prefix("l.") {
                    line = rest
                        .split_whitespace()
                        .next()
                        .and_then(|n| n.parse::<u32>().ok());
                    break;
                }
                j += 1;
            }
            let end = (j + 3).min(lines.len());
            let context = lines[i..end].join("\n");
            let category = if msg.starts_with("Undefined control sequence")
                || msg.starts_with("Missing")
                || msg.starts_with("Extra")
                || msg.contains("Emergency stop")
            {
                "syntax"
            } else if msg.contains("File") && msg.contains("not found") {
                "file"
            } else if msg.starts_with("Package") {
                "package"
            } else {
                "other"
            };
            out.push(Diagnostic {
                severity: "error".into(),
                category: category.into(),
                file: current(&stack),
                line,
                message: msg.trim_end_matches('.').to_string(),
                context: Some(context),
            });
            i = end;
            continue;
        }
        // Warnings that may wrap onto following lines
        if l.starts_with("LaTeX Warning:")
            || l.starts_with("LaTeX Font Warning:")
            || l.starts_with("Package ") && l.contains("Warning:")
            || l.starts_with("Class ") && l.contains("Warning:")
        {
            let mut text = l.to_string();
            let mut j = i + 1;
            while j < lines.len()
                && !lines[j].trim().is_empty()
                && !lines[j].starts_with("LaTeX")
                && !lines[j].starts_with('!')
                && !lines[j].starts_with("Package")
                && j < i + 4
            {
                let cont = lines[j]
                    .trim_start_matches(|c: char| c == '(' || c.is_alphanumeric() || c == ')')
                    .trim();
                text.push(' ');
                text.push_str(if cont.is_empty() {
                    lines[j].trim()
                } else {
                    cont
                });
                j += 1;
            }
            let line = line_no(&text);
            let msg = text
                .replace("LaTeX Font Warning: ", "")
                .replace("LaTeX Warning: ", "")
                .split(" on input line")
                .next()
                .unwrap_or("")
                .trim()
                .trim_end_matches('.')
                .to_string();
            let (severity, category) = if msg.starts_with("Citation") {
                ("warning", "citation")
            } else if msg.starts_with("Reference") {
                ("warning", "reference")
            } else if msg.contains("Label(s) may have changed") || msg.contains("Rerun") {
                ("info", "rerun")
            } else if msg.contains("Font") {
                ("info", "font")
            } else if text.starts_with("Package") {
                ("warning", "package")
            } else {
                ("warning", "other")
            };
            let is_font = l.starts_with("LaTeX Font Warning");
            if !is_font {
                out.push(Diagnostic {
                    severity: severity.into(),
                    category: category.into(),
                    file: current(&stack),
                    line,
                    message: msg,
                    context: Some(lines[i..j].join("\n")),
                });
            } else {
                out.push(Diagnostic {
                    severity: "info".into(),
                    category: "font".into(),
                    file: current(&stack),
                    line,
                    message: msg,
                    context: Some(lines[i..j].join("\n")),
                });
            }
            i = j.max(i + 1);
            continue;
        }
        if l.starts_with("Overfull") || l.starts_with("Underfull") {
            let line = l
                .find("at lines ")
                .and_then(|k| {
                    l[k + 9..]
                        .split(|c: char| !c.is_ascii_digit())
                        .next()
                        .and_then(|n| n.parse().ok())
                })
                .or_else(|| {
                    l.find("at line ").and_then(|k| {
                        l[k + 8..]
                            .split(|c: char| !c.is_ascii_digit())
                            .next()
                            .and_then(|n| n.parse().ok())
                    })
                });
            let end = (i + 3).min(lines.len());
            out.push(Diagnostic {
                severity: "info".into(),
                category: "box".into(),
                file: current(&stack),
                line,
                message: l.split(" in paragraph").next().unwrap_or(l).to_string(),
                context: Some(lines[i..end].join("\n")),
            });
            i = end;
            continue;
        }
        update_stack(&mut stack, l);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_errors_warnings_and_boxes() {
        let log = "(./main.tex\nLaTeX Warning: Citation `candes2006' on page 1 undefined on input line 16.\n\nLaTeX Warning: Reference `fig:psnr' on page 1 undefined on input line 32.\n\nOverfull \\hbox (12.3pt too wide) in paragraph at lines 40--41\n[]\\TU/lmr/m/n/10 text\n\n! Undefined control sequence.\nl.41 \\section{Results}\\undefinedmacro\n                                     {x}\nNo pages of output.\nLaTeX Font Warning: Font shape `TU/ptm/m/n' undefined\n(Font)              using `TU/lmr/m/n' instead on input line 503.\n)";
        let d = parse(log, "main.tex");
        let err = d.iter().find(|x| x.severity == "error").unwrap();
        assert_eq!(err.line, Some(41));
        assert_eq!(err.category, "syntax");
        assert!(err.context.as_ref().unwrap().contains("l.41"));
        assert_eq!(err.file.as_deref(), Some("main.tex"));
        let cite = d.iter().find(|x| x.category == "citation").unwrap();
        assert_eq!(cite.line, Some(16));
        assert!(cite.message.contains("candes2006"));
        let refd = d.iter().find(|x| x.category == "reference").unwrap();
        assert_eq!(refd.line, Some(32));
        let bx = d.iter().find(|x| x.category == "box").unwrap();
        assert_eq!(bx.severity, "info");
        assert_eq!(bx.line, Some(40));
        assert!(d
            .iter()
            .any(|x| x.category == "font" && x.severity == "info"));
    }
}
