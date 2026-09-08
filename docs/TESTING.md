# Testing Dabir on Windows and Linux

The release workflow builds four installers from a tag. Until the repository is public they sit on a
draft release at github.com/MohammadSadeghSalehi/dabir/releases; download the one for your machine.

| Machine | File | Notes |
|---|---|---|
| Windows 10/11 | `Dabir_0.1.0_x64-setup.exe` or `Dabir_0.1.0_x64_en-US.msi` | Unsigned. SmartScreen shows "Windows protected your PC": More info › Run anyway. WebView2 is downloaded on first launch if missing. |
| Linux x86_64 | `Dabir_0.1.0_amd64.AppImage` (any distro) or `dabir_0.1.0_amd64.deb` | `chmod +x` the AppImage. Needs `libwebkit2gtk-4.1`; the .deb pulls it in. |
| WSL | prefer the Windows build | WSLg can run the AppImage from inside WSL, but the app then compiles with the Linux Tectonic and reads files under `\\wsl$`; simpler to test the native Windows build on the same laptop and open a folder under `\\wsl$\Ubuntu\home\...` |
| macOS | `Dabir_0.1.0_aarch64.dmg` / `x64.dmg` | Unsigned until the Apple secrets exist: right-click › Open the first time. |

## What to check, in order

1. **Launch and the empty state.** Icon in the taskbar or Dock, window title, the four buttons. Press `Ctrl+/` (Windows, Linux) for the shortcut sheet: every chord shown should be Ctrl, not ⌘.
2. **Open the sample.** Open Folder › `examples/score-anchor` from a checkout, or New Paper. The visual view should render the title, abstract, equations and the figure. Preamble folds into one row.
3. **Compile.** `Ctrl+B`. The bundled Tectonic runs the first time it downloads the TeX packages (a minute or two, progress in the status bar). Then the PDF view, page navigation, zoom presets, find, text selection, double-click to jump to the line, and the Split view following the cursor.
4. **Editing.** The formatting bar, More menu when the window is narrow, completion after a backslash, predictive text after typing a few letters of a word from the paper, spelling underline, Settings (`Ctrl+,`).
5. **Git.** Commit from the sidebar; on Windows this uses the bundled libgit2, no Git install needed.
6. **Agents.** Ask the Agent (`Ctrl+J`) with whichever CLI is installed and signed in on that machine: `claude`, `codex`, `cursor-agent`, `grok` or `opencode` on `PATH`. The inspector says which are found.
7. **Live session across machines.** Host on the Mac (Share › Same network gives a `dabir://join?...` link; Tailscale makes the LAN address reachable from anywhere), join on the laptop with no paper open: the laptop should receive the whole folder under `Dabir Sessions` in your home directory, open it, and compile. Then try the direct mode: the host makes an invite code, the guest answers, the host pastes the answer.
8. **Update check.** App menu › Check for Updates. Until a newer tag exists this reports "up to date"; the endpoint is the latest release's `latest.json`.

## Known gaps to expect

- No window vibrancy on Windows and Linux; the sidebar and inspector are opaque, which is intended.
- The menu bar is native on all three; on Linux it follows the desktop theme.
- The `dabir://` link scheme is not registered on Windows and Linux yet; paste links into File › Share instead of clicking them.
- Fonts: the document face falls back to the system serif where STIX Two is absent; the app bundles it for the visual view, so this only affects the PDF if the paper asks for a font that is not installed.

Report what you find as an issue on the repository or in the chat; include the platform, the step number, and the compile log (Show log in the status bar) when it is a compile problem.
