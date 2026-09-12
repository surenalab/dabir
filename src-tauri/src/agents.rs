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

/// Directories with tools the app ships or knows about (the bundled tectonic), put on every agent's PATH.
static TOOL_DIRS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

pub fn register_tool_dir(dir: PathBuf) {
    let mut g = TOOL_DIRS.lock().unwrap();
    if !g.contains(&dir) {
        g.push(dir);
    }
}

/// The PATH of the user's login shell. An app launched from the Finder inherits only the system
/// defaults, so `python3` from conda or `latexmk` from TeX Live would be invisible to agents otherwise.
fn login_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let out = Command::new(shell)
                    .args(["-lc", "printf %s \"$PATH\""])
                    .stdin(Stdio::null())
                    .output();
                let _ = tx.send(
                    out.ok()
                        .filter(|o| o.status.success())
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()),
                );
            });
            rx.recv_timeout(std::time::Duration::from_secs(4))
                .ok()
                .flatten()
                .filter(|p| !p.is_empty())
        })
        .clone()
}

/// PATH for a child agent: registered tool directories, the usual CLI install places, the login
/// shell's PATH, then whatever this process has. Duplicates dropped, order kept.
pub fn agent_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = TOOL_DIRS.lock().unwrap().clone();
    dirs.extend(candidates());
    if let Some(p) = login_shell_path() {
        dirs.extend(std::env::split_paths(&p));
    }
    let mut seen = std::collections::HashSet::new();
    let dirs: Vec<PathBuf> = dirs
        .into_iter()
        .filter(|d| seen.insert(d.clone()))
        .collect();
    std::env::join_paths(dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

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
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    dirs
}

fn find_bin(bin: &str) -> Option<PathBuf> {
    if let Some(p) = candidates()
        .into_iter()
        .map(|d| d.join(bin))
        .find(|p| p.is_file())
    {
        return Some(p);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    match bin {
        // Claude Code ships inside the VS Code / desktop agent host when the standalone CLI is not installed.
        "claude" => {
            let base = PathBuf::from(format!(
                "{}/Library/Application Support/Code/agent-host/sdk-cache/claude",
                home
            ));
            let mut versions: Vec<PathBuf> = std::fs::read_dir(&base)
                .ok()?
                .flatten()
                .map(|e| e.path())
                .collect();
            versions.sort();
            versions.into_iter().rev().map(|v| v.join("darwin-arm64/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")).find(|p| p.is_file())
        }
        // The ChatGPT desktop app bundles the Codex CLI.
        "codex" => {
            let p = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
            if p.is_file() {
                Some(p)
            } else {
                None
            }
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
    defs()
        .into_iter()
        .map(|(id, label, hint, bin)| {
            let path = find_bin(bin);
            Provider {
                id: id.into(),
                label: label.into(),
                hint: hint.into(),
                bin: bin.into(),
                installed: path.is_some(),
                path: path.map(|p| p.to_string_lossy().to_string()),
            }
        })
        .collect()
}

/// How a run is steered: which model and how hard it should think. Empty strings mean the CLI's own default.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct Steer {
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Steer {
    fn model(&self) -> Option<&str> {
        self.model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
    fn effort(&self) -> Option<&str> {
        self.effort
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
}

/// What the user can choose for one provider: the models its CLI knows, the effort levels it accepts,
/// and what "default" currently means. `custom` says a model id may be typed in.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptions {
    pub models: Vec<ModelChoice>,
    pub efforts: Vec<&'static str>,
    pub default_model: Option<String>,
    pub custom: bool,
}

fn cli_lines(bin: &str, args: &[&str]) -> Vec<String> {
    let Some(path) = find_bin(bin) else {
        return vec![];
    };
    let mut cmd = Command::new(path);
    cmd.args(args).stdin(Stdio::null());
    for k in SCRUB_ENV {
        cmd.env_remove(k);
    }
    match cmd.output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.to_string())
            .collect(),
        _ => vec![],
    }
}

pub fn models(id: &str) -> ModelOptions {
    let choice = |id: &str, label: &str| ModelChoice {
        id: id.into(),
        label: label.into(),
    };
    match id {
        "claude" => ModelOptions {
            models: vec![
                choice("opus", "Opus"),
                choice("sonnet", "Sonnet"),
                choice("haiku", "Haiku"),
            ],
            efforts: vec!["low", "medium", "high", "xhigh", "max"],
            default_model: None,
            custom: true,
        },
        "codex" => {
            // Codex has no model listing; the default comes from its own config.
            let home = std::env::var("HOME").unwrap_or_default();
            let cfg =
                std::fs::read_to_string(format!("{}/.codex/config.toml", home)).unwrap_or_default();
            let default_model = cfg.lines().find_map(|l| {
                let l = l.trim();
                let rest = l.strip_prefix("model")?.trim_start().strip_prefix('=')?;
                Some(rest.trim().trim_matches('"').to_string())
            });
            ModelOptions {
                models: vec![],
                efforts: vec!["low", "medium", "high", "xhigh"],
                default_model,
                custom: true,
            }
        }
        "cursor" => {
            // `id - Label` lines; effort is part of the model id here, so no separate control.
            let models = cli_lines("cursor-agent", &["--list-models"])
                .into_iter()
                .filter_map(|l| {
                    let (id, label) = l.split_once(" - ")?;
                    let id = id.trim();
                    if id.is_empty() || id.contains(' ') || id == "auto" {
                        return None;
                    }
                    Some(choice(id, label.trim()))
                })
                .collect();
            ModelOptions {
                models,
                efforts: vec![],
                default_model: Some("auto".into()),
                custom: true,
            }
        }
        "grok" => {
            let mut default_model = None;
            let models = cli_lines("grok", &["models"])
                .into_iter()
                .filter_map(|l| {
                    let t = l.trim();
                    let (marker, rest) = t.split_once(' ')?;
                    if marker != "*" && marker != "-" {
                        return None;
                    }
                    let id = rest.split_whitespace().next()?;
                    if rest.contains("(default)") {
                        default_model = Some(id.to_string());
                    }
                    Some(choice(id, id))
                })
                .collect();
            ModelOptions {
                models,
                efforts: vec!["low", "medium", "high", "xhigh"],
                default_model,
                custom: true,
            }
        }
        _ => ModelOptions {
            models: vec![],
            efforts: vec![],
            default_model: None,
            custom: true,
        },
    }
}

/// Tools an agent does not need here: the preamble already carries the paper map, the file list
/// and the last steps, and Dabir owns the worktree, so inspecting Git or walking the tree is a
/// wasted call. `dabir.toml [agents] deny = [...]` replaces this list; an empty list denies nothing.
/// Rules use the Claude Code form (`Bash(git log*)`, `WebSearch`); Grok accepts the same rules.
pub const DEFAULT_DENY: &[&str] = &[
    "Bash(git log*)",
    "Bash(git status*)",
    "Bash(git diff*)",
    "Bash(git show*)",
    "Bash(git branch*)",
    "Bash(git stash*)",
    "Bash(git checkout*)",
    "Bash(git reset*)",
    "Bash(tree*)",
];

/// The deny rules for a run: the paper's own list when `dabir.toml [agents] deny` is set, else the default.
pub fn deny_rules(cwd: &Path) -> Vec<String> {
    let from_toml = std::fs::read_to_string(cwd.join("dabir.toml"))
        .ok()
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| {
            t.get("agents")?.get("deny")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
        });
    from_toml.unwrap_or_else(|| DEFAULT_DENY.iter().map(|s| s.to_string()).collect())
}

/// The CLI flags that carry the deny rules; CLIs without such a flag get none.
fn deny_args(id: &str, rules: &[String]) -> Vec<String> {
    if rules.is_empty() {
        return vec![];
    }
    match id {
        "claude" => vec!["--disallowedTools".into(), rules.join(",")],
        "grok" => rules
            .iter()
            .flat_map(|r| ["--deny".to_string(), r.clone()])
            .collect(),
        _ => vec![],
    }
}

fn args_for(id: &str, prompt: &str, cwd: &Path, steer: &Steer) -> Vec<String> {
    let cwd_s = cwd.to_string_lossy().to_string();
    let deny = deny_args(id, &deny_rules(cwd));
    let mut args: Vec<String> = match id {
        "claude" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(),
            "bypassPermissions".into(),
        ],
        "codex" => vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
            "--dangerously-bypass-approvals-and-sandbox".into(),
            "-C".into(),
            cwd_s,
        ],
        "cursor" => vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--force".into(),
            "--trust".into(),
            "--workspace".into(),
            cwd_s,
        ],
        "grok" => vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "streaming-messages-json".into(),
            "--permission-mode".into(),
            "bypassPermissions".into(),
            "--cwd".into(),
            cwd_s,
        ],
        _ => vec!["run".into(), "--format".into(), "json".into()],
    };
    // Steering flags go before the positional prompt where the CLI takes one.
    match id {
        "claude" => {
            if let Some(m) = steer.model() {
                args.extend(["--model".into(), m.into()]);
            }
            if let Some(e) = steer.effort() {
                args.extend(["--effort".into(), e.into()]);
            }
            args.extend(deny);
        }
        "codex" => {
            if let Some(m) = steer.model() {
                args.extend(["-m".into(), m.into()]);
            }
            if let Some(e) = steer.effort() {
                args.extend(["-c".into(), format!("model_reasoning_effort=\"{}\"", e)]);
            }
            args.push(prompt.into());
        }
        "cursor" => {
            if let Some(m) = steer.model() {
                args.extend(["--model".into(), m.into()]);
            }
            args.push(prompt.into());
        }
        "grok" => {
            if let Some(m) = steer.model() {
                args.extend(["--model".into(), m.into()]);
            }
            if let Some(e) = steer.effort() {
                args.extend(["--reasoning-effort".into(), e.into()]);
            }
            args.extend(deny);
        }
        _ => {
            if let Some(m) = steer.model() {
                args.extend(["--model".into(), m.into()]);
            }
            args.push(prompt.into());
        }
    }
    args
}

#[cfg(test)]
pub fn args_for_test(id: &str, prompt: &str, cwd: &Path, steer: &Steer) -> Vec<String> {
    args_for(id, prompt, cwd, steer)
}

fn short(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.chars().count() > 160 {
        format!("{}…", s.chars().take(160).collect::<String>())
    } else {
        s
    }
}

#[cfg(test)]
pub fn parse_line_for_test(
    id: &str,
    line: &str,
) -> Vec<(String, String, Option<String>, Option<bool>)> {
    parse_line(id, line)
}

/// Turn one JSON line from a vendor CLI into zero or more events.
fn parse_line(id: &str, line: &str) -> Vec<(String, String, Option<String>, Option<bool>)> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return if line.trim().is_empty() {
            vec![]
        } else {
            vec![("log".into(), line.into(), None, None)]
        };
    };
    let mut out = vec![];
    match id {
        "claude" | "cursor" | "grok" => {
            match v["type"].as_str() {
                Some("thinking") => {
                    // Cursor streams reasoning as deltas; show it as a quiet running line.
                    if v["subtype"] == "delta" {
                        if let Some(t) = v["text"].as_str() {
                            if !t.trim().is_empty() {
                                out.push(("thinking".into(), t.into(), None, None));
                            }
                        }
                    }
                }
                Some("assistant") => {
                    if let Some(items) = v["message"]["content"].as_array() {
                        for it in items {
                            match it["type"].as_str() {
                                Some("thinking") => {
                                    if let Some(t) = it["thinking"].as_str() {
                                        if !t.trim().is_empty() {
                                            out.push(("thinking".into(), t.into(), None, None));
                                        }
                                    }
                                }
                                Some("text") => out.push((
                                    "text".into(),
                                    it["text"].as_str().unwrap_or("").into(),
                                    None,
                                    None,
                                )),
                                Some("tool_use") => {
                                    let name = it["name"].as_str().unwrap_or("tool").to_string();
                                    let inp = &it["input"];
                                    let detail = inp
                                        .get("command")
                                        .or(inp.get("file_path"))
                                        .or(inp.get("target_file"))
                                        .or(inp.get("path"))
                                        .or(inp.get("target_directory"))
                                        .or(inp.get("pattern"))
                                        .or(inp.get("query"))
                                        .or(inp.get("url"))
                                        .map(short)
                                        .unwrap_or_else(|| short(inp));
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
                    // The object also carries hookAdditionalContexts, toolCallId and timestamps; only the
                    // key ending in ToolCall names the tool (serde's map is sorted, so "first key" was wrong).
                    if let Some(obj) = v["tool_call"].as_object() {
                        if let Some((k, val)) = obj.iter().find(|(k, _)| k.ends_with("ToolCall")) {
                            let name = k.trim_end_matches("ToolCall");
                            let name = format!("{}{}", name[..1].to_uppercase(), &name[1..]);
                            let args = &val["args"];
                            let detail = args
                                .get("command")
                                .or(args.get("path"))
                                .or(args.get("file_path"))
                                .or(args.get("pattern"))
                                .or(args.get("query"))
                                .map(short)
                                .unwrap_or_else(|| short(args));
                            out.push(("tool".into(), detail, Some(name), None));
                        }
                    }
                }
                Some("system") if v["subtype"] == "api_retry" => {
                    let e = v["error"].as_str().unwrap_or("");
                    if e == "authentication_failed" {
                        out.push((
                            "log".into(),
                            "authentication failed (401). Sign in to the CLI and try again.".into(),
                            None,
                            None,
                        ));
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
                        Some("agent_message") if v["type"] == "item.completed" => out.push((
                            "text".into(),
                            item["text"].as_str().unwrap_or("").into(),
                            None,
                            None,
                        )),
                        Some("reasoning") if v["type"] == "item.completed" => out.push((
                            "thinking".into(),
                            item["text"].as_str().unwrap_or("").into(),
                            None,
                            None,
                        )),
                        Some("command_execution") if v["type"] == "item.started" => out.push((
                            "tool".into(),
                            short(&item["command"]),
                            Some("Bash".into()),
                            None,
                        )),
                        Some("file_change") if v["type"] == "item.completed" => {
                            let files = item["changes"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .map(|c| c["path"].as_str().unwrap_or("").to_string())
                                        .collect::<Vec<_>>()
                                        .join(", ")
                                })
                                .unwrap_or_default();
                            out.push(("tool".into(), files, Some("Edit".into()), None));
                        }
                        _ => {}
                    }
                }
                Some("turn.completed") => {
                    out.push(("done".into(), String::new(), None, Some(true)))
                }
                // {"type":"error","message":"…"} and {"type":"turn.failed","error":{"message":"…"}}: surface the reason
                // (usage limit, sign-in) instead of a bare failure.
                Some("turn.failed") | Some("error") => {
                    let msg = v["message"]
                        .as_str()
                        .or(v["error"]["message"].as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| short(&v["error"]));
                    out.push(("done".into(), msg, None, Some(false)));
                }
                _ => {}
            }
        }
        _ => {
            // Grok, OpenCode and anything else: best effort over common shapes.
            let role = v["role"].as_str().or(v["type"].as_str()).unwrap_or("");
            if let Some(items) = v["content"]
                .as_array()
                .or(v["message"]["content"].as_array())
            {
                for it in items {
                    match it["type"].as_str() {
                        Some("text") if role.contains("assistant") => out.push((
                            "text".into(),
                            it["text"].as_str().unwrap_or("").into(),
                            None,
                            None,
                        )),
                        Some("tool_use") | Some("tool_call") => out.push((
                            "tool".into(),
                            short(&it["input"]),
                            it["name"].as_str().map(|s| s.to_string()),
                            None,
                        )),
                        _ => {}
                    }
                }
            } else if let Some(t) = v["text"].as_str().or(v["content"].as_str()) {
                if role.contains("assistant") || role == "text" {
                    out.push(("text".into(), t.into(), None, None));
                }
            }
            if matches!(
                v["type"].as_str(),
                Some("result") | Some("done") | Some("turn.completed") | Some("session.end")
            ) {
                out.push((
                    "done".into(),
                    v["result"].as_str().unwrap_or("").into(),
                    None,
                    Some(!v["is_error"].as_bool().unwrap_or(false)),
                ));
            }
        }
    }
    out
}

pub fn run(
    app: AppHandle,
    provider: String,
    prompt: String,
    cwd: PathBuf,
    run_id: String,
    steer: Steer,
) -> Result<(), String> {
    let rid = run_id.clone();
    run_with(provider, prompt, cwd, run_id, steer, move |ev| {
        let _ = app.emit(
            "agent-event",
            AgentEvent {
                run_id: rid.clone(),
                ..ev
            },
        );
    })
}

/// Environment variables that would point a child CLI at this process's own session
/// (for example when Dabir is launched from inside another agent's terminal).
const SCRUB_ENV: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_PID",
    "CODEX_SANDBOX",
    "CODEX_THREAD_ID",
];

pub fn run_with<F>(
    provider: String,
    prompt: String,
    cwd: PathBuf,
    run_id: String,
    steer: Steer,
    emit_raw: F,
) -> Result<(), String>
where
    F: Fn(AgentEvent) + Send + Clone + 'static,
{
    let p = detect()
        .into_iter()
        .find(|p| p.id == provider)
        .ok_or("Unknown provider")?;
    let Some(bin) = p.path.clone() else {
        return Err(format!(
            "{} is not installed. Install the {} CLI and sign in, then try again.",
            p.label, p.bin
        ));
    };
    let args = args_for(&provider, &prompt, &cwd, &steer);
    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&cwd)
        .env("DABIR", "1")
        .env("PATH", agent_path());
    for k in SCRUB_ENV {
        cmd.env_remove(k);
    }
    for (k, _) in std::env::vars() {
        if k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(&k);
        }
    }
    let mut child: Child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", p.label, e))?;
    {
        let mut g = RUNNING.lock().unwrap();
        g.get_or_insert_with(HashMap::new)
            .insert(run_id.clone(), child.id());
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let emit = {
        let run_id = run_id.clone();
        // Tool lines name files relative to the paper, not by their long worktree path.
        let cwd_prefix = format!("{}/", cwd.to_string_lossy());
        let cwd_private = format!("/private{}", cwd_prefix);
        move |kind: &str, text: String, tool: Option<String>, ok: Option<bool>| {
            let text = if kind == "tool" {
                text.replace(&cwd_private, "").replace(&cwd_prefix, "")
            } else {
                text
            };
            emit_raw(AgentEvent {
                run_id: run_id.clone(),
                kind: kind.into(),
                text,
                tool,
                ok,
            });
        }
    };
    let emit_err = emit.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() && !line.starts_with("Reading additional input from stdin") {
                emit_err("log", line, None, None);
            }
        }
    });
    let pid_id = run_id.clone();
    std::thread::spawn(move || {
        let mut saw_done = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            for (kind, text, tool, ok) in parse_line(&provider, &line) {
                if kind == "done" {
                    saw_done = true;
                }
                emit(&kind, text, tool, ok);
            }
        }
        let status = child.wait().ok();
        let ok = status.map(|s| s.success()).unwrap_or(false);
        if !saw_done {
            emit(
                "done",
                if ok {
                    String::new()
                } else {
                    "The agent exited without a result.".into()
                },
                None,
                Some(ok),
            );
        }
        if let Ok(mut g) = RUNNING.lock() {
            if let Some(m) = g.as_mut() {
                m.remove(&pid_id);
            }
        }
    });
    Ok(())
}

pub fn cancel(run_id: &str) -> bool {
    let pid = RUNNING
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(run_id).copied()));
    match pid {
        Some(pid) => {
            let _ = Command::new("kill").arg(pid.to_string()).output();
            true
        }
        None => false,
    }
}
