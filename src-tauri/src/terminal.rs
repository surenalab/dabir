//! A shell in the paper's folder. The pane in the app talks to a pseudo-terminal running the user's
//! login shell with the same PATH the agents get (bundled tectonic, CLI install places, the login
//! shell's own), so what works for an agent works at the prompt and the other way round.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    open: Mutex<HashMap<u32, Term>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Data {
    id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Exit {
    id: u32,
    code: Option<u32>,
}

/// The user's shell: $SHELL, else zsh on macOS and bash elsewhere.
fn shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".into()
            } else if cfg!(windows) {
                "powershell.exe".into()
            } else {
                "/bin/bash".into()
            }
        })
}

/// Start a shell in `cwd` and stream its output as `term-data` events; returns the terminal's id.
pub fn open(
    app: &AppHandle,
    state: &Shared,
    cwd: &Path,
    cols: u16,
    rows: u16,
    remote: Option<&crate::memory::Remote>,
) -> Result<u32, String> {
    let data = app.clone();
    let exit = app.clone();
    spawn(
        state,
        cwd,
        cols,
        rows,
        remote,
        move |id, text| {
            let _ = data.emit("term-data", Data { id, data: text });
        },
        move |id| {
            let _ = exit.emit("term-exit", Exit { id, code: None });
        },
    )
}

/// The shell without the app: `on_data` gets each chunk of output as text, `on_exit` fires once.
pub fn spawn(
    state: &Shared,
    cwd: &Path,
    cols: u16,
    rows: u16,
    remote: Option<&crate::memory::Remote>,
    on_data: impl Fn(u32, String) + Send + 'static,
    on_exit: impl FnOnce(u32) + Send + 'static,
) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    // A remote terminal is `ssh -t host` landing in the repository there, in that host's login shell.
    let mut cmd = match remote {
        Some(r) => {
            let mut c = CommandBuilder::new("ssh");
            c.args(["-t", "-o", "ConnectTimeout=15", &r.host]);
            c.arg(format!(
                "cd {} && exec \"${{SHELL:-/bin/sh}}\" -l",
                crate::memory::remote_dir_quoted(r)
            ));
            c
        }
        None => {
            let mut c = CommandBuilder::new(shell());
            if !cfg!(windows) {
                c.arg("-l");
            }
            c
        }
    };
    cmd.cwd(cwd);
    cmd.env("PATH", crate::agents::agent_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env(
        "LANG",
        std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into()),
    );
    cmd.env("DABIR", "1");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.open.lock().unwrap().insert(
        id,
        Term {
            master: pair.master,
            writer,
            child,
        },
    );
    // Reader thread: bytes to text, keeping a split multi-byte character for the next read.
    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let text = match std::str::from_utf8(&pending) {
                            Ok(s) => {
                                let s = s.to_string();
                                pending.clear();
                                s
                            }
                            Err(e) => {
                                let ok = e.valid_up_to();
                                // A hard error mid-buffer (not just a truncated tail): decode lossily and move on.
                                if e.error_len().is_some() || pending.len() - ok > 4 {
                                    let s = String::from_utf8_lossy(&pending).into_owned();
                                    pending.clear();
                                    s
                                } else {
                                    let s = String::from_utf8_lossy(&pending[..ok]).into_owned();
                                    pending.drain(..ok);
                                    s
                                }
                            }
                        };
                        if !text.is_empty() {
                            on_data(id, text);
                        }
                    }
                }
            }
            on_exit(id);
        })
        .map_err(|e| e.to_string())?;
    // On Windows the read above does not return when the shell exits: ConPTY keeps the output pipe
    // open until the pseudo-console itself is closed, so a shell that typed `exit` would leave a pane
    // that looks alive. A watcher polls the child and drops the terminal when it is gone, which closes
    // the console and ends the reader, and the exit reaches the window the same way as elsewhere.
    #[cfg(windows)]
    {
        let state = Arc::clone(state);
        std::thread::Builder::new()
            .name(format!("pty-watch-{id}"))
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(250));
                let mut open = state.open.lock().unwrap();
                match open.get_mut(&id) {
                    None => break,
                    Some(t) => {
                        if !matches!(t.child.try_wait(), Ok(None)) {
                            open.remove(&id);
                            break;
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

pub fn write(state: &Terminals, id: u32, data: &str) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let t = open.get_mut(&id).ok_or("no such terminal")?;
    t.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    t.writer.flush().map_err(|e| e.to_string())
}

pub fn resize(state: &Terminals, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let open = state.open.lock().unwrap();
    let t = open.get(&id).ok_or("no such terminal")?;
    t.master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub fn close(state: &Terminals, id: u32) {
    if let Some(mut t) = state.open.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
        let _ = t.child.wait();
    }
}

/// Every shell is stopped when the window closes, so no orphan keeps the paper's folder busy.
pub fn close_all(state: &Terminals) {
    let ids: Vec<u32> = state.open.lock().unwrap().keys().copied().collect();
    for id in ids {
        close(state, id);
    }
}

pub type Shared = Arc<Terminals>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn shell_runs_in_the_folder_and_streams_output() {
        let state = Shared::default();
        let (tx, rx) = mpsc::channel::<String>();
        let (etx, erx) = mpsc::channel::<u32>();
        let cwd = std::env::temp_dir();
        let id = spawn(
            &state,
            &cwd,
            80,
            24,
            None,
            move |_, text| {
                let _ = tx.send(text);
            },
            move |id| {
                let _ = etx.send(id);
            },
        )
        .expect("a shell starts");
        // `$((20+22))` is arithmetic in every POSIX shell and a subexpression in PowerShell, so the
        // line proves a real shell evaluated it wherever the test runs.
        write(&state, id, "echo dabir-$((20+22)); exit\n").unwrap();
        let mut seen = String::new();
        let mut answered = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while std::time::Instant::now() < deadline && !seen.contains("dabir-42") {
            if let Ok(t) = rx.recv_timeout(Duration::from_millis(200)) {
                seen.push_str(&t);
            }
            // PowerShell asks the terminal where the cursor is (CSI 6 n) before it reads input; a real
            // terminal answers, so the test does too.
            if !answered && seen.contains("\x1b[6n") {
                answered = true;
                write(&state, id, "\x1b[24;1R").unwrap();
            }
        }
        assert!(seen.contains("dabir-42"), "output: {seen}");
        assert_eq!(
            erx.recv_timeout(Duration::from_secs(20)),
            Ok(id),
            "exit is reported"
        );
        close(&state, id);
        assert!(state.open.lock().unwrap().is_empty());
    }
}
