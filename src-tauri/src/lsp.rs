//! Language servers for the code beside the paper. Each server is a child process speaking the
//! Language Server Protocol over stdio; this module frames the messages and hands the JSON to the
//! editor as `lsp-message` events. Which server to run for which file is the editor's decision;
//! here a server is only a command found on the agents' PATH.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct Server {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Servers {
    open: Mutex<HashMap<u32, Server>>,
    next: AtomicU32,
}

pub type Shared = Arc<Servers>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Message {
    id: u32,
    message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Exit {
    id: u32,
}

/// Which of the given commands exist on the agents' PATH.
pub fn available(candidates: &[String]) -> Vec<String> {
    let path = crate::agents::agent_path();
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    candidates
        .iter()
        .filter(|c| {
            dirs.iter().any(|d| {
                let p = d.join(c);
                p.is_file()
                    || (cfg!(windows)
                        && (p.with_extension("exe").is_file() || p.with_extension("cmd").is_file()))
            })
        })
        .cloned()
        .collect()
}

/// Whether `command args` exits successfully within `timeout`: how a launcher such as `julia -e
/// 'using LanguageServer'` or `R -e 'library(languageserver)'` shows the package behind it is installed.
pub fn probe(command: &str, args: &[String], timeout: std::time::Duration) -> bool {
    let Ok(mut child) = crate::spawn::tool(command)
        .args(args)
        .env("PATH", crate::agents::agent_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// What a filter such as a formatter returned.
#[derive(serde::Serialize)]
pub struct Filtered {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run `command args` in `cwd` with `input` on stdin and collect what comes back: how `ruff format -`,
/// `prettier --stdin-filepath`, `rustfmt` and `clang-format` reformat a buffer without touching the file.
pub fn filter(
    command: &str,
    args: &[String],
    cwd: &Path,
    input: &str,
    timeout: std::time::Duration,
) -> Result<Filtered, String> {
    use std::io::Read;
    let mut child = crate::spawn::tool(command)
        .args(args)
        .current_dir(cwd)
        .env("PATH", crate::agents::agent_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{command}: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let data = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&data);
    });
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let out_t = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = out.read_to_end(&mut s);
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = err.read_to_end(&mut s);
        s
    });
    let started = std::time::Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{command} did not finish in {} s",
                    timeout.as_secs()
                ));
            }
        }
    };
    let _ = writer.join();
    let stdout = String::from_utf8_lossy(&out_t.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_t.join().unwrap_or_default()).into_owned();
    Ok(Filtered {
        code,
        stdout,
        stderr,
    })
}

/// Start `command args` in `root`; returns the server's id. Messages arrive as `lsp-message`.
pub fn start(
    app: &AppHandle,
    state: &Servers,
    root: &Path,
    command: &str,
    args: &[String],
) -> Result<u32, String> {
    let on_message = app.clone();
    let on_exit = app.clone();
    spawn(
        state,
        root,
        command,
        args,
        move |id, message| {
            let _ = on_message.emit("lsp-message", Message { id, message });
        },
        move |id| {
            let _ = on_exit.emit("lsp-exit", Exit { id });
        },
    )
}

fn spawn(
    state: &Servers,
    root: &Path,
    command: &str,
    args: &[String],
    on_message: impl Fn(u32, String) + Send + 'static,
    on_exit: impl FnOnce(u32) + Send + 'static,
) -> Result<u32, String> {
    let mut child = crate::spawn::tool(command)
        .args(args)
        .current_dir(root)
        .env("PATH", crate::agents::agent_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{command}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .open
        .lock()
        .unwrap()
        .insert(id, Server { child, stdin });
    std::thread::Builder::new()
        .name(format!("lsp-{id}"))
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Some(body) = read_message(&mut reader) {
                on_message(id, body);
            }
            on_exit(id);
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// One LSP message: `Content-Length: N` and other headers, a blank line, then N bytes of JSON.
fn read_message<R: BufRead>(reader: &mut R) -> Option<String> {
    let mut length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            length = v.trim().parse().ok();
        }
    }
    let n = length?;
    let mut body = vec![0u8; n];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

pub fn send(state: &Servers, id: u32, message: &str) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let s = open.get_mut(&id).ok_or("no such server")?;
    let framed = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
    s.stdin
        .write_all(framed.as_bytes())
        .and_then(|_| s.stdin.flush())
        .map_err(|e| e.to_string())
}

pub fn stop(state: &Servers, id: u32) {
    if let Some(mut s) = state.open.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

pub fn stop_all(state: &Servers) {
    let ids: Vec<u32> = state.open.lock().unwrap().keys().copied().collect();
    for id in ids {
        stop(state, id);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn filter_pipes_stdin_through_and_reports_the_exit_code() {
        let out = super::filter(
            "tr",
            &["a-z".into(), "A-Z".into()],
            std::path::Path::new("/tmp"),
            "hello\n",
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(out.code, 0);
        assert_eq!(out.stdout, "HELLO\n");
        let bad = super::filter(
            "sh",
            &["-c".into(), "echo nope >&2; exit 3".into()],
            std::path::Path::new("/tmp"),
            "",
            std::time::Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(bad.code, 3);
        assert!(bad.stderr.contains("nope"));
        assert!(super::filter(
            "definitely-not-a-command-xyz",
            &[],
            std::path::Path::new("/tmp"),
            "",
            std::time::Duration::from_secs(5)
        )
        .is_err());
    }

    use super::*;

    #[test]
    fn frames_are_read_by_content_length() {
        let a = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let b = r#"{"jsonrpc":"2.0","method":"x","params":{"é":"ü"}}"#;
        let stream = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}Content-Length: {}\r\n\r\n{}",
            a.len(),
            a,
            b.len(),
            b
        );
        let mut r = BufReader::new(stream.as_bytes());
        assert_eq!(read_message(&mut r).as_deref(), Some(a));
        assert_eq!(read_message(&mut r).as_deref(), Some(b));
        assert_eq!(read_message(&mut r), None);
    }

    /// A stand-in server in Python: answers `initialize`, echoes every other request's id, and
    /// exits on `shutdown`. Exercises spawn, framing both ways and the exit signal.
    #[test]
    fn talks_to_a_server_over_stdio() {
        if available(&["python3".into()]).is_empty() {
            return;
        }
        let script = r#"
import sys, json
def read():
    n = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line: return None
        if line.strip() == b"":
            if n is not None: break
            continue
        if line.startswith(b"Content-Length:"): n = int(line.split(b":")[1])
    return json.loads(sys.stdin.buffer.read(n))
def send(obj):
    body = json.dumps(obj).encode()
    sys.stdout.buffer.write(b"Content-Length: %d\r\n\r\n" % len(body) + body); sys.stdout.buffer.flush()
while True:
    m = read()
    if m is None: break
    if m.get("method") == "initialize": send({"jsonrpc":"2.0","id":m["id"],"result":{"capabilities":{"hoverProvider":True}}})
    elif m.get("method") == "shutdown": send({"jsonrpc":"2.0","id":m["id"],"result":None}); break
    else: send({"jsonrpc":"2.0","id":m["id"],"result":m.get("params")})
"#;
        let state = Servers::default();
        let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
        let tx2 = tx.clone();
        let id = spawn(
            &state,
            Path::new("/"),
            "python3",
            &["-c".to_string(), script.to_string()],
            move |_, m| tx.send(Some(m)).unwrap(),
            move |_| tx2.send(None).unwrap(),
        )
        .unwrap();
        let wait = std::time::Duration::from_secs(10);
        send(
            &state,
            id,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        )
        .unwrap();
        let reply = rx.recv_timeout(wait).unwrap().unwrap();
        assert!(reply.contains("hoverProvider"), "{reply}");
        send(
            &state,
            id,
            r#"{"jsonrpc":"2.0","id":2,"method":"textDocument/hover","params":{"é":"ü"}}"#,
        )
        .unwrap();
        let reply = rx.recv_timeout(wait).unwrap().unwrap();
        assert!(reply.contains("\\u00e9") || reply.contains("é"), "{reply}");
        send(
            &state,
            id,
            r#"{"jsonrpc":"2.0","id":3,"method":"shutdown"}"#,
        )
        .unwrap();
        assert!(rx.recv_timeout(wait).unwrap().is_some());
        assert!(
            rx.recv_timeout(wait).unwrap().is_none(),
            "exit should follow"
        );
        stop(&state, id);
        assert!(send(&state, id, "{}").is_err());
    }

    #[test]
    fn available_filters_by_path() {
        let got = available(&["sh".into(), "definitely-not-a-program-xyz".into()]);
        assert_eq!(got, vec!["sh".to_string()]);
    }

    #[test]
    fn probe_reports_exit_status_and_kills_on_timeout() {
        let t = std::time::Duration::from_secs(5);
        assert!(probe("sh", &["-c".into(), "exit 0".into()], t));
        assert!(!probe("sh", &["-c".into(), "exit 1".into()], t));
        assert!(!probe("definitely-not-a-program-xyz", &[], t));
        let started = std::time::Instant::now();
        assert!(!probe(
            "sh",
            &["-c".into(), "sleep 30".into()],
            std::time::Duration::from_millis(300)
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
