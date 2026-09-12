//! Language servers for the code beside the paper. Each server is a child process speaking the
//! Language Server Protocol over stdio; this module frames the messages and hands the JSON to the
//! editor as `lsp-message` events. Which server to run for which file is the editor's decision;
//! here a server is only a command found on the agents' PATH.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
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
    let mut child = Command::new(command)
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
}
