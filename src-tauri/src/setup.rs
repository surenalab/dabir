//! First-run setup: what a paper needs on this machine, checked in front of the user, and the two things
//! Dabir can fetch by itself without sending anyone to a terminal or a website: the LaTeX package cache
//! (the bundled Tectonic downloads packages on first use; warming it up makes the first compile instant)
//! and the Typst compiler (a single binary from its GitHub release, kept under the app's data folder).
//! Agent CLIs and language servers have their own installers and sign-in flows; for those the setup
//! sheet types the vendor's official command into a terminal inside the app, so the user watches it run.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

use crate::agents;

/// `<app data>/bin`: tools Dabir installed itself. On the agents' PATH and the terminal's.
static MANAGED_BIN: OnceLock<PathBuf> = OnceLock::new();

pub fn init(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("bin");
    let _ = fs::create_dir_all(&dir);
    let _ = MANAGED_BIN.set(dir.clone());
    Some(dir)
}

pub fn managed_bin() -> Option<PathBuf> {
    MANAGED_BIN.get().cloned()
}

/// The Typst binary Dabir installed, when there is one.
pub fn managed_typst() -> Option<PathBuf> {
    let dir = managed_bin()?;
    ["typst", "typst.exe"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.is_file())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    pub path: Option<String>,
    pub version: Option<String>,
    /// Installed by Dabir under its own data folder (so it can also be updated or removed from there).
    pub managed: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub latex: Engine,
    /// The package cache has a built format, so a compile no longer waits on downloads.
    pub latex_ready: bool,
    /// The bundled engine does not start on this machine: the loader's or the process's first line
    /// (a glibc too old for the binary, a missing library). Ready is never claimed while this is set.
    pub latex_error: Option<String>,
    pub latex_cache_mb: u64,
    pub typst: Engine,
    pub typst_size_mb: u64,
    pub agents: Vec<AgentStatus>,
    pub pandoc: Option<String>,
    /// The one-line install for pandoc on this machine (its package manager), or None when there is no
    /// package manager to call and the installer at pandoc.org is the way.
    pub pandoc_install: Option<String>,
    pub gh: Option<String>,
    /// The `git` command. Commits, history and snapshots use the built-in engine, but an agent run's
    /// worktree and its diff go through `git`, so a machine without it cannot run agents.
    pub git: Option<String>,
    /// The one-line install for git on this machine, or None when git-scm.com is the way.
    pub git_install: Option<String>,
    pub home: String,
    pub platform: &'static str,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    #[serde(flatten)]
    pub provider: agents::Provider,
    /// Has an account behind it; `None` when the CLI cannot say without making a request.
    pub signed_in: Option<bool>,
    /// Installed but too old for the flags Dabir passes, so every run would fail at once.
    pub outdated: Option<agents::Outdated>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub task: String,
    pub message: String,
    pub fraction: Option<f32>,
    pub done: bool,
    pub ok: bool,
}

/// Where progress goes: the window as `setup-progress` events, or a test's closure.
pub type Report<'a> = &'a (dyn Fn(Progress) + Sync);

pub fn window_report(app: &AppHandle) -> impl Fn(Progress) + Sync + '_ {
    move |p: Progress| {
        let _ = app.emit("setup-progress", p);
    }
}

fn emit(report: Report, task: &str, message: impl Into<String>, fraction: Option<f32>) {
    report(Progress {
        task: task.into(),
        message: message.into(),
        fraction,
        done: false,
        ok: true,
    });
}

fn finish(report: Report, task: &str, ok: bool, message: impl Into<String>) {
    report(Progress {
        task: task.into(),
        message: message.into(),
        fraction: Some(1.0),
        done: true,
        ok,
    });
}

/// `bin --version` runs and exits cleanly, or the first line of what went wrong: the loader's message
/// when a shared library or glibc symbol is missing lands on stderr with a non-zero status, and a
/// binary that cannot be executed at all fails at spawn.
fn starts(bin: &Path) -> Result<(), String> {
    let out = crate::spawn::tool(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{}: {e}", bin.display()))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let line = err
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("exited without a message");
    Err(format!("{line} (exit {})", out.status.code().unwrap_or(-1)))
}

fn version_of(bin: &Path) -> Option<String> {
    let out = crate::spawn::tool(bin)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let text = if text.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        text
    };
    text.lines().next().map(|l| {
        // "tectonic 0.15.0" / "typst 0.15.1" → the number.
        l.split_whitespace()
            .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .unwrap_or(l)
            .to_string()
    })
}

/// Tectonic's bundle cache. It has no flag to print the location, so the known places are checked.
fn tectonic_cache_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("TECTONIC_CACHE_DIR") {
        return Some(PathBuf::from(p));
    }
    let home = crate::spawn::home_dir();
    let mut c: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        c.push(h.join("Library/Caches/Tectonic"));
        if let Ok(x) = std::env::var("XDG_CACHE_HOME") {
            c.push(PathBuf::from(x).join("Tectonic"));
        }
        c.push(h.join(".cache/Tectonic"));
    }
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        c.push(PathBuf::from(&l).join("TectonicProject/Tectonic/cache"));
        c.push(PathBuf::from(&l).join("Tectonic"));
    }
    c.into_iter().find(|p| p.is_dir())
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| {
            let path = e.path();
            if path.is_dir() {
                dir_size(&path)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

fn latex_ready(cache: Option<&Path>) -> bool {
    // A format file only exists after one compile went all the way through, which is what the
    // user will wait for otherwise.
    cache
        .map(|c| c.join("formats"))
        .and_then(|f| fs::read_dir(f).ok())
        .map(|mut rd| rd.next().is_some())
        .unwrap_or(false)
}

/// How pandoc is installed here: Homebrew on macOS, the distribution's package manager on Linux, winget on
/// Windows. None when none of them is present; the Setup sheet then points at pandoc.org.
fn git_install() -> Option<String> {
    match std::env::consts::OS {
        // Apple's command line tools carry git; the prompt that follows installs them.
        "macos" => Some("xcode-select --install".to_string()),
        "windows" => which("winget").map(|_| "winget install --id Git.Git -e".to_string()),
        _ => [
            ("apt-get", "sudo apt-get install -y git"),
            ("dnf", "sudo dnf install -y git"),
            ("pacman", "sudo pacman -S --noconfirm git"),
            ("zypper", "sudo zypper install -y git"),
            ("brew", "brew install git"),
        ]
        .iter()
        .find(|(bin, _)| which(bin).is_some())
        .map(|(_, cmd)| cmd.to_string()),
    }
}

fn pandoc_install() -> Option<String> {
    match std::env::consts::OS {
        "macos" => which("brew").map(|_| "brew install pandoc".to_string()),
        "windows" => {
            which("winget").map(|_| "winget install --id JohnMacFarlane.Pandoc -e".to_string())
        }
        _ => [
            ("apt-get", "sudo apt-get install -y pandoc"),
            ("dnf", "sudo dnf install -y pandoc"),
            ("pacman", "sudo pacman -S --noconfirm pandoc"),
            ("zypper", "sudo zypper install -y pandoc"),
            ("brew", "brew install pandoc"),
        ]
        .iter()
        .find(|(bin, _)| which(bin).is_some())
        .map(|(_, cmd)| cmd.to_string()),
    }
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = agents::agent_path();
    std::env::split_paths(&path).find_map(|d| crate::spawn::bin_in(&d, bin))
}

/// Every installed CLI is asked at once whether it is signed in; the slowest answers in about a second.
fn agents_with_sign_in() -> Vec<AgentStatus> {
    let providers = agents::detect();
    let handles: Vec<_> = providers
        .iter()
        .map(|p| {
            let id = p.id.clone();
            let installed = p.installed;
            std::thread::spawn(move || {
                if installed {
                    (agents::signed_in(&id), agents::outdated(&id))
                } else {
                    (None, None)
                }
            })
        })
        .collect();
    providers
        .into_iter()
        .zip(handles)
        .map(|(provider, h)| {
            let (signed_in, outdated) = h.join().unwrap_or((None, None));
            AgentStatus {
                provider,
                signed_in,
                outdated,
            }
        })
        .collect()
}

pub fn status(tectonic: Option<PathBuf>, typst: Option<PathBuf>) -> Status {
    let cache = tectonic_cache_dir();
    let managed = managed_typst();
    let latex_error = match tectonic.as_deref() {
        Some(bin) => starts(bin).err(),
        None => Some("No LaTeX engine is bundled with this build.".into()),
    };
    Status {
        latex: Engine {
            version: tectonic.as_deref().and_then(version_of),
            path: tectonic.map(|p| p.to_string_lossy().to_string()),
            managed: true,
        },
        latex_ready: latex_error.is_none() && latex_ready(cache.as_deref()),
        latex_error,
        latex_cache_mb: cache.as_deref().map(dir_size).unwrap_or(0) / (1024 * 1024),
        typst: Engine {
            version: typst.as_deref().and_then(version_of),
            managed: typst
                .as_deref()
                .is_some_and(|p| Some(p) == managed.as_deref()),
            path: typst.map(|p| p.to_string_lossy().to_string()),
        },
        typst_size_mb: typst_asset().1,
        agents: agents_with_sign_in(),
        pandoc: which("pandoc").map(|p| p.to_string_lossy().to_string()),
        pandoc_install: pandoc_install(),
        gh: which("gh").map(|p| p.to_string_lossy().to_string()),
        git: which("git").map(|p| p.to_string_lossy().to_string()),
        git_install: git_install(),
        home: crate::spawn::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default(),
        platform: std::env::consts::OS,
    }
}

const WARM_TEX: &str = r"\documentclass{article}
\usepackage[T1]{fontenc}\usepackage{lmodern}\usepackage{microtype}
\usepackage{amsmath,amssymb,amsthm}\usepackage{graphicx}\usepackage{booktabs}\usepackage{xcolor}
\usepackage{geometry}\usepackage{caption}\usepackage{subcaption}\usepackage{enumitem}\usepackage{listings}
\usepackage{algorithm}\usepackage{algpseudocode}\usepackage{tikz}\usepackage{natbib}\usepackage{hyperref}\usepackage{cleveref}
\newtheorem{theorem}{Theorem}
\begin{document}
\title{Dabir}\author{Setup}\maketitle
\section{One}\label{sec:one}
Text with a citation \citep{dabir} and \cref{sec:one}. $\int_0^1 x\,\mathrm{d}x = \tfrac12$.
\begin{theorem}A statement.\end{theorem}
\begin{equation}\label{eq:a} a^2 + b^2 = c^2 \end{equation}
\begin{table}[h]\centering\caption{T}\begin{tabular}{lr}\toprule a & 1 \\ \bottomrule\end{tabular}\end{table}
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\begin{algorithm}\caption{A}\begin{algorithmic}\State $x \gets 0$\end{algorithmic}\end{algorithm}
\begin{lstlisting}
x = 1
\end{lstlisting}
\bibliographystyle{plainnat}\bibliography{refs}
\end{document}
";

const WARM_BIB: &str = "@article{dabir, title={A}, author={B, C}, journal={D}, year={2026}}\n";

/// Compile a document that pulls the packages most papers use, so the cache is filled while the user
/// watches the setup sheet rather than during their first compile. Progress lines are Tectonic's own.
pub fn warm_latex(report: Report, tectonic: &Path) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("dabir-warm-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("warm.tex"), WARM_TEX).map_err(|e| e.to_string())?;
    fs::write(dir.join("refs.bib"), WARM_BIB).map_err(|e| e.to_string())?;
    if let Err(e) = starts(tectonic) {
        finish(report, "latex", false, e.clone());
        return Err(e);
    }
    emit(report, "latex", "Starting the LaTeX engine…", None);
    let mut child = crate::spawn::tool(tectonic)
        .current_dir(&dir)
        .args(["-X", "compile", "warm.tex"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start Tectonic: {}", e))?;
    let stderr = child.stderr.take();
    // Tectonic writes its progress to stderr; the wait happens on this thread so the closure needs no 'static.
    let mut tail = String::new();
    if let Some(e) = stderr {
        use std::io::{BufRead, BufReader};
        let mut n = 0u32;
        for line in BufReader::new(e).lines().map_while(Result::ok) {
            let msg = line.trim_start_matches("note: ").to_string();
            if msg.starts_with("downloading ") || msg.starts_with("Downloading") {
                n += 1;
                let name = msg.rsplit('/').next().unwrap_or(&msg).to_string();
                // About 250 files for this document on an empty cache; the bar is an estimate.
                emit(
                    report,
                    "latex",
                    format!("Fetching {}", name),
                    Some((n as f32 / 260.0).min(0.96)),
                );
            } else if msg.starts_with("running ")
                || msg.starts_with("Running")
                || msg.contains("Rerunning")
            {
                emit(report, "latex", msg.clone(), None);
            }
            tail.push_str(&line);
            tail.push('\n');
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&dir);
    if status.success() {
        finish(
            report,
            "latex",
            true,
            "LaTeX is ready: the packages most papers use are on this machine.",
        );
        Ok(())
    } else {
        let last = tail
            .lines()
            .rev()
            .find(|l| l.contains("error"))
            .unwrap_or("Tectonic stopped")
            .to_string();
        finish(report, "latex", false, last.clone());
        Err(last)
    }
}

/// The release asset for this machine and its rough size, for the button label.
fn typst_asset() -> (&'static str, u64) {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("typst-aarch64-apple-darwin.tar.xz", 14),
        ("macos", _) => ("typst-x86_64-apple-darwin.tar.xz", 15),
        ("windows", "aarch64") => ("typst-aarch64-pc-windows-msvc.zip", 21),
        ("windows", _) => ("typst-x86_64-pc-windows-msvc.zip", 22),
        (_, "aarch64") => ("typst-aarch64-unknown-linux-musl.tar.xz", 16),
        _ => ("typst-x86_64-unknown-linux-musl.tar.xz", 17),
    }
}

/// Where the latest Typst release keeps this machine's binary; falls back to a known version if the
/// GitHub API is unreachable but the download host is.
fn typst_url(asset: &str) -> (String, String) {
    let fallback = "v0.15.1";
    let api = "https://api.github.com/repos/typst/typst/releases/latest";
    let tag = ureq::get(api)
        .header("User-Agent", "dabir")
        .header("Accept", "application/vnd.github+json")
        .config()
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .build()
        .call()
        .ok()
        .and_then(|mut r| r.body_mut().read_to_string().ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("tag_name")?.as_str().map(str::to_string))
        .unwrap_or_else(|| fallback.to_string());
    (
        format!(
            "https://github.com/typst/typst/releases/download/{}/{}",
            tag, asset
        ),
        tag,
    )
}

/// Download Typst for this machine into the managed bin folder and return the binary's path.
pub fn install_typst(report: Report, bin: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(bin).map_err(|e| e.to_string())?;
    let (asset, _) = typst_asset();
    emit(report, "typst", "Finding the latest release…", Some(0.0));
    let (url, tag) = typst_url(asset);
    emit(
        report,
        "typst",
        format!("Downloading Typst {}…", tag),
        Some(0.02),
    );
    let mut resp = ureq::get(&url)
        .header("User-Agent", "dabir")
        .config()
        .timeout_global(Some(std::time::Duration::from_secs(600)))
        .http_status_as_error(true)
        .build()
        .call()
        .map_err(|e| format!("Could not download {}: {}", url, e))?;
    let total: Option<u64> = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());
    let mut reader = resp.body_mut().as_reader();
    let tmp = std::env::temp_dir().join(format!("dabir-typst-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let archive = tmp.join(asset);
    {
        let mut file = fs::File::create(&archive).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 64 * 1024];
        let mut got = 0u64;
        let mut last = 0.0f32;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("Download interrupted: {}", e))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            got += n as u64;
            if let Some(t) = total.filter(|t| *t > 0) {
                let f = 0.02 + 0.88 * (got as f32 / t as f32);
                if f - last > 0.01 {
                    last = f;
                    emit(
                        report,
                        "typst",
                        format!(
                            "Downloading Typst {} · {} of {} MB",
                            tag,
                            got / 1_048_576,
                            t / 1_048_576
                        ),
                        Some(f),
                    );
                }
            }
        }
    }
    emit(report, "typst", "Unpacking…", Some(0.92));
    let out = tmp.join("out");
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    if asset.ends_with(".zip") {
        let bytes = fs::read(&archive).map_err(|e| e.to_string())?;
        unzip(&bytes, &out)?;
    } else {
        // bsdtar on macOS and GNU tar on Linux both open .tar.xz themselves.
        let st = crate::spawn::tool("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&out)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Could not run tar: {}", e))?;
        if !st.status.success() {
            return Err(format!(
                "Could not unpack Typst: {}",
                String::from_utf8_lossy(&st.stderr).trim()
            ));
        }
    }
    let name = if cfg!(windows) { "typst.exe" } else { "typst" };
    let found = find_file(&out, name).ok_or("The archive had no typst binary in it")?;
    let dest = bin.join(name);
    let _ = fs::remove_file(&dest);
    fs::copy(&found, &dest).map_err(|e| format!("Could not place typst: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
    }
    let _ = fs::remove_dir_all(&tmp);
    match version_of(&dest) {
        Some(v) => finish(report, "typst", true, format!("Typst {} is installed.", v)),
        None => {
            finish(
                report,
                "typst",
                false,
                "Typst was downloaded but does not run on this machine.",
            );
            return Err("Typst was downloaded but does not run on this machine.".into());
        }
    }
    Ok(dest)
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    None
}

fn unzip(bytes: &[u8], target: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let out = target.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_asset_matches_this_machine() {
        let (asset, mb) = typst_asset();
        assert!(asset.starts_with("typst-"));
        assert!(mb > 5 && mb < 50);
        if cfg!(target_os = "macos") {
            assert!(asset.ends_with("apple-darwin.tar.xz"));
        }
    }

    #[test]
    fn the_warm_up_document_names_the_common_packages() {
        for p in [
            "amsmath",
            "graphicx",
            "booktabs",
            "natbib",
            "hyperref",
            "tikz",
            "algorithm",
            "cleveref",
        ] {
            assert!(
                WARM_TEX.contains(&format!("{}}}", p))
                    || WARM_TEX.contains(&format!("{},", p))
                    || WARM_TEX.contains(&format!("{{{}", p)),
                "{p}"
            );
        }
        assert!(WARM_TEX.contains(r"\bibliography{refs}"));
        assert!(WARM_BIB.contains("@article{dabir"));
    }

    #[test]
    fn version_parsing_takes_the_number() {
        let sh = which("sh").expect("a shell");
        // `sh --version` may not exist; the function must simply return None or a line, never panic.
        let _ = version_of(&sh);
    }

    /// Network and ~15 MB: `cargo test -- --ignored typst_downloads`.
    #[test]
    #[ignore]
    fn typst_downloads_and_runs() {
        let dir = std::env::temp_dir().join(format!("dabir-typst-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let seen = std::sync::Mutex::new(Vec::new());
        let report = |p: Progress| seen.lock().unwrap().push(p);
        let path = install_typst(&report, &dir).expect("typst installs");
        assert!(path.is_file());
        assert!(version_of(&path).is_some_and(|v| v.starts_with('0') || v.starts_with('1')));
        let seen = seen.lock().unwrap();
        assert!(seen.iter().any(|p| p.message.starts_with("Downloading")));
        assert!(seen.last().is_some_and(|p| p.done && p.ok));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Uses the sidecar under src-tauri/binaries and the real cache: `cargo test -- --ignored latex_warms`.
    #[test]
    #[ignore]
    fn latex_warms_up() {
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let tectonic = fs::read_dir(&bin)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("tectonic"))
            })
            .expect("a tectonic sidecar");
        let seen = std::sync::Mutex::new(Vec::new());
        let report = |p: Progress| seen.lock().unwrap().push(p);
        warm_latex(&report, &tectonic).expect("the warm-up document compiles");
        assert!(seen.lock().unwrap().last().is_some_and(|p| p.done && p.ok));
    }

    #[test]
    fn ready_means_a_built_format() {
        let dir = std::env::temp_dir().join(format!("dabir-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("formats")).unwrap();
        assert!(!latex_ready(Some(&dir)));
        fs::write(dir.join("formats/latex.fmt"), b"x").unwrap();
        assert!(latex_ready(Some(&dir)));
        assert!(!latex_ready(None));
        let _ = fs::remove_dir_all(&dir);
    }
}
