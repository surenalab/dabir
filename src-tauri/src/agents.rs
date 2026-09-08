//! Agent adapters. Each vendor's own CLI runs as a child process inside a Git
//! worktree, signed in with the user's subscription. Dabir never proxies model
//! calls. Output lines are parsed into a small common event stream.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub hint: String,
    pub bin: String,
    pub installed: bool,
    pub path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub run_id: String,
    pub kind: String, // text | tool | log | done | error
    pub text: String,
    pub tool: Option<String>,
    pub ok: Option<bool>,
}

static RUNNING: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn candidates() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = vec![
        format!("{}/.local/bin", home).into(),
        format!("{}/.claude/local", home).into(),
        format!("{}/.claude/local/bin", home).into(),
        format!("{}/.cursor/bin", home).into(),
        format!("{}/.grok/bin", home).into(),
        format!("{}/.opencode/bin", home).into(),
        format!("{}/.npm-global/bin", home).into(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    if let Some(p) = std::env::var_os("PATH") { dirs.extend(std::env::split_paths(&p)); }
    dirs
}

fn find_bin(bin: &str) -> Option<PathBuf> {
    if let Some(p) = candidates().into_iter().map(|d| d.join(bin)).find(|p| p.is_file()) { return Some(p); }
    let home = std::env::var("HOME").unwrap_or_default();
    match bin {
        // Claude Code ships inside the VS Code / desktop agent host when the standalone CLI is not installed.
        "claude" => {
            let base = PathBuf::from(format!("{}/Library/Application Support/Code/agent-host/sdk-cache/claude", home));
            let mut versions: Vec<PathBuf> = std::fs::read_dir(&base).ok()?.flatten().map(|e| e.path()).collect();
            versions.sort();
            versions.into_iter().rev().map(|v| v.join("darwin-arm64/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).find(|p| p.is_file())
        }
        // The ChatGPT desktop app bundles the Codex CLI.
        "codex" => {
            let p = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
            if p.is_file() { Some(p) } else { None }
        }
        _ => None,
    }
}

fn defs() -> Vec<(&'static str, &'static str, &'static str, &'static str)> {
    vec![
        ("claude", "Claude Code", "", "claude"),
        ("codex", "Codex", "", "codex"),
        ("cursor", "Cursor", "", "cursor-agent"),
        ("grok", "Grok", "", "grok"),
        ("opencode", "OpenCode", "", "opencode"),
    ]
}

pub fn detect() -> Vec<Provider> {
    defs().into_iter().map(|(id, label, hint, bin)| {
        let path = find_bin(bin);
        Provider { id: id.into(), label: label.into(), hint: hint.into(), bin: bin.into(), installed: path.is_some(), path: path.map(|p| p.to_string_lossy().to_string()) }
    }).collect()
}

fn args_for(id: &str, prompt: &str, cwd: &Path) -> Vec<String> {
    let cwd_s = cwd.to_string_lossy().to_string();
    match id {
        "claude" => vec!["-p".into(), prompt.into(), "--output-format".into(), "stream-json".into(), "--verbose".into(), "--permission-mode".into(), "bypassPermissions".into()],
        "codex" => vec!["exec".into(), "--json".into(), "--skip-git-repo-check".into(), "--dangerously-bypass-approvals-and-sandbox".into(), "-C".into(), cwd_s, prompt.into()],
        "cursor" => vec!["-p".into(), "--output-format".into(), "stream-json".into(), "--force".into(), "--trust".into(), "--workspace".into(), cwd_s, prompt.into()],
        "grok" => vec!["-p".into(), prompt.into(), "--output-format".into(), "streaming-messages-json".into(), "--permission-mode".into(), "bypassPermissions".into(), "--cwd".into(), cwd_s],
        _ => vec!["run".into(), "--format".into(), "json".into(), prompt.into()],
    }
}

fn short(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.chars().count() > 160 { format!("{}…", s.chars().take(160).collect::<String>()) } else { s }
}

/// Turn one JSON line from a vendor CLI into zero or more events.
fn parse_line(id: &str, line: &str) -> Vec<(String, String, Option<String>, Option<bool>)> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return if line.trim().is_empty() { vec![] } else { vec![("log".into(), line.into(), None, None)] };
    };
    let mut out = vec![];
    match id {
        "claude" | "cursor" | "grok" => {
            match v["type"].as_str() {
                Some("assistant") => {
                    if let Some(items) = v["message"]["content"].as_array() {
                        for it in items {
                            match it["type"].as_str() {
                                Some("text") => out.push(("text".into(), it["text"].as_str().unwrap_or("").into(), None, None)),
                                Some("tool_use") => {
                                    let name = it["name"].as_str().unwrap_or("tool").to_string();
                                    let inp = &it["input"];
                                    let detail = inp.get("command").or(inp.get("file_path")).or(inp.get("path")).or(inp.get("pattern")).map(short).unwrap_or_else(|| short(inp));
                                    out.push(("tool".into(), detail, Some(name), None));
                                }
                                _ => {}
                            }
                        }
                    }
                }
                Some("result") => {
                    let err = v["is_error"].as_bool().unwrap_or(false);
                    let mut text = v["result"].as_str().unwrap_or("").to_string();
                    if err && text.is_empty() {
                        text = match v["subtype"].as_str() {
                            Some(s) if s.contains("auth") => "Authentication failed. Sign in to the CLI (for Claude Code run `claude` once and log in), then try again.".into(),
                            Some(s) => format!("The agent stopped: {}", s.replace('_', " ")),
                            None => "The agent stopped with an error.".into(),
                        };
                    }
                    out.push(("done".into(), text, None, Some(!err)));
                }
                Some("tool_call") if v["subtype"] == "started" => {
                    // Cursor: {"tool_call": {"shellToolCall": {"args": {...}}}}
                    if let Some(obj) = v["tool_call"].as_object() {
                        if let Some((k, val)) = obj.iter().next() {
                            let name = k.trim_end_matches("ToolCall");
                            let name = format!("{}{}", name[..1].to_uppercase(), &name[1..]);
                            let args = &val["args"];
                            let detail = args.get("command").or(args.get("path")).or(args.get("file_path")).or(args.get("pattern")).or(args.get("query")).map(short).unwrap_or_else(|| short(args));
                            out.push(("tool".into(), detail, Some(name), None));
                        }
                    }
                }
                Some("system") => {
                    if v["subtype"] == "api_retry" {
                        let e = v["error"].as_str().unwrap_or("");
                        if e == "authentication_failed" { out.push(("log".into(), "authentication failed (401). Sign in to the CLI and try again.".into(), None, None)); }
                    }
                }
                _ => {}
            }
        }
        "codex" => {
            match v["type"].as_str() {
                Some("item.completed") | Some("item.started") => {
                    let item = &v["item"];
                    match item["type"].as_str() {
                        Some("agent_message") if v["type"] == "item.completed" => out.push(("text".into(), item["text"].as_str().unwrap_or("").into(), None, None)),
                        Some("command_execution") if v["type"] == "item.started" => out.push(("tool".into(), short(&item["command"]), Some("Bash".into()), None)),
                        Some("file_change") if v["type"] == "item.completed" => {
                            let files = item["changes"].as_array().map(|a| a.iter().map(|c| c["path"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                            out.push(("tool".into(), files, Some("Edit".into()), None));
                        }
                        _ => {}
                    }
                }
                Some("turn.completed") => out.push(("done".into(), String::new(), None, Some(true))),
                Some("turn.failed") | Some("error") => out.push(("done".into(), short(&v["error"]), None, Some(false))),
                _ => {}
            }
        }
        _ => {
            // Grok, OpenCode and anything else: best effort over common shapes.
            let role = v["role"].as_str().or(v["type"].as_str()).unwrap_or("");
            if let Some(items) = v["content"].as_array().or(v["message"]["content"].as_array()) {
                for it in items {
                    match it["type"].as_str() {
                        Some("text") if role.contains("assistant") => out.push(("text".into(), it["text"].as_str().unwrap_or("").into(), None, None)),
                        Some("tool_use") | Some("tool_call") => out.push(("tool".into(), short(&it["input"]), it["name"].as_str().map(|s| s.to_string()), None)),
                        _ => {}
                    }
                }
            } else if let Some(t) = v["text"].as_str().or(v["content"].as_str()) {
                if role.contains("assistant") || role == "text" { out.push(("text".into(), t.into(), None, None)); }
            }
            if matches!(v["type"].as_str(), Some("result") | Some("done") | Some("turn.completed") | Some("session.end")) {
                out.push(("done".into(), v["result"].as_str().unwrap_or("").into(), None, Some(!v["is_error"].as_bool().unwrap_or(false))));
            }
        }
    }
    out
}

pub fn run(app: AppHandle, provider: String, prompt: String, cwd: PathBuf, run_id: String) -> Result<(), String> {
    let rid = run_id.clone();
    run_with(provider, prompt, cwd, run_id, move |ev| { let _ = app.emit("agent-event", AgentEvent { run_id: rid.clone(), ..ev }); })
}

/// Environment variables that would point a child CLI at this process's own session
/// (for example when Dabir is launched from inside another agent's terminal).
const SCRUB_ENV: &[&str] = &["ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_PID", "CODEX_SANDBOX", "CODEX_THREAD_ID"];

pub fn run_with<F>(provider: String, prompt: String, cwd: PathBuf, run_id: String, emit_raw: F) -> Result<(), String>
where F: Fn(AgentEvent) + Send + Clone + 'static {
    let p = detect().into_iter().find(|p| p.id == provider).ok_or("Unknown provider")?;
    let Some(bin) = p.path.clone() else {
        return Err(format!("{} is not installed. Install the {} CLI and sign in, then try again.", p.label, p.bin));
    };
    let args = args_for(&provider, &prompt, &cwd);
    let mut cmd = Command::new(&bin);
    cmd.args(&args).current_dir(&cwd).env("DABIR", "1");
    for k in SCRUB_ENV { cmd.env_remove(k); }
    for (k, _) in std::env::vars() { if k.starts_with("CLAUDE_CODE_") { cmd.env_remove(&k); } }
    let mut child: Child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", p.label, e))?;
    {
        let mut g = RUNNING.lock().unwrap();
        g.get_or_insert_with(HashMap::new).insert(run_id.clone(), child.id());
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let emit = {
        let run_id = run_id.clone();
        move |kind: &str, text: String, tool: Option<String>, ok: Option<bool>| {
            emit_raw(AgentEvent { run_id: run_id.clone(), kind: kind.into(), text, tool, ok });
        }
    };
    let emit_err = emit.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().flatten() {
            if !line.trim().is_empty() && !line.starts_with("Reading additional input from stdin") { emit_err("log", line, None, None); }
        }
    });
    let pid_id = run_id.clone();
    std::thread::spawn(move || {
        let mut saw_done = false;
        for line in BufReader::new(stdout).lines().flatten() {
            for (kind, text, tool, ok) in parse_line(&provider, &line) {
                if kind == "done" { saw_done = true; }
                emit(&kind, text, tool, ok);
            }
        }
        let status = child.wait().ok();
        let ok = status.map(|s| s.success()).unwrap_or(false);
        if !saw_done { emit("done", if ok { String::new() } else { "The agent exited without a result.".into() }, None, Some(ok)); }
        if let Ok(mut g) = RUNNING.lock() { if let Some(m) = g.as_mut() { m.remove(&pid_id); } }
    });
    Ok(())
}

pub fn cancel(run_id: &str) -> bool {
    let pid = RUNNING.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(run_id).copied()));
    match pid {
        Some(pid) => { let _ = Command::new("kill").arg(pid.to_string()).output(); true }
        None => false,
    }
}
