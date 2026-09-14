# Testing Dabir on Windows and Linux

The release workflow builds four installers from a tag. Until the repository is public they sit on a
draft release at github.com/surenalab/dabir/releases; download the one for your machine.

| Machine | File | Notes |
|---|---|---|
| Windows 10/11 | `Dabir_0.1.2_x64-setup.exe` | Unsigned. SmartScreen shows "Windows protected your PC": More info › Run anyway. WebView2 is downloaded on first launch if missing. |
| Linux x86_64 | `Dabir_0.1.2_amd64.AppImage` (any distro), `Dabir_0.1.2_amd64.deb` or `Dabir-0.1.2-1.x86_64.rpm` | `chmod +x` the AppImage. Needs `libwebkit2gtk-4.1`; the .deb pulls it in. |
| WSL | prefer the Windows build | WSLg can run the AppImage from inside WSL, but the app then compiles with the Linux Tectonic and reads files under `\\wsl$`; simpler to test the native Windows build on the same laptop and open a folder under `\\wsl$\Ubuntu\home\...` |
| macOS | no 0.1.2 build (notarisation fails until the Apple secrets are reset); install from a local `npm run tauri build` | Unsigned until the Apple secrets exist: right-click › Open the first time. |

## What to check, in order

1. **Launch, Setup and the empty state.** Icon in the taskbar or Dock, window title. The first launch opens Setup: LaTeX should read as built in (and *Fetch packages* should run to a green check within a few minutes on a fresh machine), *Download Typst* should install and flip to Ready, an agent's *Install* should open the shell inside the sheet and type the vendor's command (on Windows the PowerShell form), *Sign in* should open the browser. *Continue* lands on the welcome screen with the four buttons. Press `Ctrl+/` (Windows, Linux) for the shortcut sheet: every chord shown should be Ctrl, not ⌘.
2. **The tour.** *Take the tour* on the welcome screen copies the sample to `Documents/Dabir/score-anchor-sample` and opens it; twelve stops follow, each spotlighting a real panel (→ next, ← back, Esc leaves). Open `code/sweep.py`, press Undo: the file must not change. Help › Guided Tour restarts it; Help › User Guide opens docs/GUIDE.md in the browser. The app reopens the last paper at launch, so the welcome screen is reached with File › Close Paper (⇧⌘W); for a true first launch on the Mac, `scripts/first-run.sh` clears the app's data and the sample copy (`--install` replaces /Applications/Dabir.app with the last local build first).
3. **Open the sample.** Open Folder › `examples/score-anchor` from a checkout, or New Paper. The visual view should render the title, abstract, equations and the figure. Preamble folds into one row.
4. **Compile.** `Ctrl+B`. The bundled Tectonic runs the first time it downloads the TeX packages (a minute or two, progress in the status bar). Then the PDF view, page navigation, zoom presets, find, text selection, double-click to jump to the line, and the Split view following the cursor.
5. **Editing.** The formatting bar, More menu when the window is narrow, completion after a backslash, predictive text after typing a few letters of a word from the paper, spelling underline, Settings (`Ctrl+,`).
6. **Git.** Commit from the sidebar; on Windows this uses the bundled libgit2, no Git install needed.
7. **Agents.** Ask the Agent (`Ctrl+J`) with whichever CLI is installed and signed in on that machine: `claude`, `codex`, `cursor-agent`, `grok` or `opencode` on `PATH`. The inspector says which are found.
8. **Live session across machines.** Host on the Mac (Share › Same network gives a `dabir://join?...` link; Tailscale makes the LAN address reachable from anywhere), join on the laptop with no paper open: the laptop should receive the whole folder under `Dabir Sessions` in your home directory, open it, and compile. Then try the direct mode: the host makes an invite code, the guest answers, the host pastes the answer.
9. **Update check.** App menu › Check for Updates. Until a newer tag exists this reports "up to date"; the endpoint is the latest release's `latest.json`.

## New in 0.1.2, never seen off the Mac

10. **Setup's Typst download.** *Download Typst* fetches `typst-x86_64-pc-windows-msvc.zip` (unzipped in-process) or `typst-x86_64-unknown-linux-musl.tar.xz` (needs the system `tar` to read xz; on a minimal distro install `xz-utils`). Afterwards `bin/typst` sits under the app data folder (`%APPDATA%\com.surenalab.dabir\bin` or `~/.local/share/com.surenalab.dabir/bin`) and a `.typ` file compiles.
11. **Setup's shell.** *Install* on an agent row runs the vendor's command in a terminal inside the sheet: PowerShell on Windows (`irm … | iex` forms), the login shell on Linux. Check the terminal renders, the command runs to the end, *Check again* then reads the tool as installed, and *Sign in* opens the browser and returns.
12. **Setup's pandoc row.** With `winget` (Windows) or `apt-get`/`dnf`/`pacman`/`zypper` (Linux) present, the row offers *Install pandoc*; after it, File › Export offers Word and HTML.
13. **The tour** with `Ctrl` chords: every stop's shortcut text should say Ctrl, not ⌘.
14. **Code files.** Open `code/sweep.py`: bracket colours, pinned block headers when scrolled into `write_pdf`, TODO badges. With pyright installed (`npm i -g pyright`), the sidebar outline should switch to the server's symbols and an introduced error should appear both at the end of its line and in the Problems panel under `code`.
15. **The notebook.** `code/analysis.ipynb` opens as cells with the saved outputs, including the image and the red traceback; *Open REPL* starts `python3` in the terminal (Windows: whichever `python3` is on PATH; `py` is not tried), ▶ on a cell types it in.
16. **Terminal.** Ctrl+` opens the pane: PowerShell on Windows, the login shell on Linux; resizing, colours, Ctrl+C to a running command.
17. **Close Paper** (Ctrl+Shift+W) returns to the welcome screen; relaunch must not reopen the paper.

## Hand this to an agent on the test machine

The agent can do the mechanical part; a person has to look at the window. Paste this, then answer its questions:

> Install Dabir 0.1.2 from the file I downloaded and help me test it. Do not build anything from source.
> 1. Install it (Windows: run the setup .exe, accept the SmartScreen prompt; Linux: `sudo apt install ./Dabir_0.1.2_amd64.deb` or `chmod +x` the AppImage) and launch it.
> 2. Tell me where the log is (`%LOCALAPPDATA%\com.surenalab.dabir\logs\ui.log` on Windows, `~/.local/share/com.surenalab.dabir/logs/ui.log` on Linux) and tail it while I click through; report any line as it appears.
> 3. Before I start, check and tell me which of these are on PATH: `tar` (and whether it reads .xz), `git`, `python3`, `node`, `pyright`, `pandoc`, `claude`, `codex`, `cursor-agent`, `grok`, `opencode`, `winget`/`apt-get`/`dnf`. Install pyright (`npm i -g pyright`) if node is there, so the language-server checks are possible.
> 4. Walk me through docs/TESTING.md from github.com/surenalab/dabir (steps 1 to 17), one step at a time; I will describe what I see. For each step record pass, fail or skipped, with my words for anything that looked wrong.
> 5. After the Setup sheet finishes, verify on disk: the app data folder holds `bin/typst` (if I downloaded Typst) and the Tectonic cache has a built format (`~/.cache/Tectonic` on Linux, `%LOCALAPPDATA%\TectonicProject\Tectonic` on Windows).
> 6. Write the results as a Markdown table (step, result, notes) plus the relevant log lines, ready to paste as a GitHub issue titled "0.1.2 on <Windows 11 | Ubuntu 24.04 | …>".

## Known gaps to expect

- No window vibrancy on Windows and Linux; the sidebar and inspector are opaque, which is intended.
- The menu bar is native on all three; on Linux it follows the desktop theme.
- The `dabir://` link scheme is not registered on Windows and Linux yet; paste links into File › Share instead of clicking them.
- Fonts: the document face falls back to the system serif where STIX Two is absent; the app bundles it for the visual view, so this only affects the PDF if the paper asks for a font that is not installed.

Report what you find as an issue on the repository or in the chat; include the platform, the step number, and the compile log (Show log in the status bar) when it is a compile problem.
