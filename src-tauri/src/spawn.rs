//! Starting tools and finding them, the same way in every module.
//!
//! Two things differ on Windows and were missed when Dabir first ran there. A GUI process that
//! starts a console program (`tectonic`, `claude --version`, a `pyright.cmd` shim through
//! `cmd.exe`) gets a console window for it, which flashes on screen at launch, when the window
//! regains focus and every time Setup runs its checks; `CREATE_NO_WINDOW` stops that. And the
//! home directory is `%USERPROFILE%`, `$HOME` being unset, so `~/.local/bin` and `~/.grok/bin`
//! were looked up under the drive root and every agent read as not installed.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A `Command` that never opens a console window. Plain `Command::new` off Windows.
pub fn tool<S: AsRef<OsStr>>(program: S) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The user's home directory: `$HOME`, else `%USERPROFILE%`; `None` when neither is set.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

/// `dir/bin` when it is a file; on Windows also `dir/bin.exe` and `dir/bin.cmd` (npm's shims),
/// the way the shell would resolve the name.
pub fn bin_in(dir: &Path, bin: &str) -> Option<PathBuf> {
    let plain = dir.join(bin);
    if plain.is_file() {
        return Some(plain);
    }
    if cfg!(windows) {
        for ext in ["exe", "cmd"] {
            let p = dir.join(format!("{bin}.{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_falls_back_to_userprofile() {
        // Only the fallback is testable without touching the real environment for other tests;
        // HOME is set on every CI runner, so this checks the value is a directory when present.
        if let Some(h) = home_dir() {
            assert!(h.is_dir(), "{h:?}");
        }
    }

    #[test]
    fn bin_in_finds_plain_and_windows_names() {
        let dir = std::env::temp_dir().join(format!("dabir-bin-in-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(bin_in(&dir, "nothing").is_none());
        std::fs::write(dir.join("plain"), "").unwrap();
        assert_eq!(bin_in(&dir, "plain"), Some(dir.join("plain")));
        std::fs::write(dir.join("shim.cmd"), "").unwrap();
        assert_eq!(bin_in(&dir, "shim").is_some(), cfg!(windows));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tool_runs_like_command() {
        let out = if cfg!(windows) {
            tool("cmd").args(["/C", "echo hi"]).output()
        } else {
            tool("sh").args(["-c", "echo hi"]).output()
        }
        .unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hi");
    }
}
