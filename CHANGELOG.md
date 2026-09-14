# Changelog

Newest first. Every merged pull request adds a line under Unreleased; a release moves the block under its version.

## Unreleased

- Fixed, Windows: a shell that exited left its terminal pane looking alive. ConPTY keeps the output pipe open until the pseudo-console is closed, so the end of the shell never reached the reader; a watcher now polls the child and closes the console when it is gone, and the pane shows `[shell exited]` as on the Mac.
- Fixed, Linux: the bundled Tectonic was the glibc build (needs 2.39), so no LaTeX paper compiled on Ubuntu 22.04 or any distribution from before 2024 although the app itself ran; `fetch-tectonic.mjs` takes Tectonic's static musl build for the Linux targets. Setup no longer calls the engine Ready when it cannot start: the row goes amber with the loader's message (`setup_status.latexError`) and *Fetch packages* fails at once instead of after a download.
- Fixed, Windows and Linux: every shortcut shown in the app said ⌘. `keys.ts` `chord()` writes a chord in the platform's words (Ctrl, Alt, Shift, Enter) and the shortcut sheet, the tour stops, the format bar, the toolbar and code bar tooltips, the Agent composer hint, Settings and the status notes go through it.
- Fixed: the middle column of the window grid was `1fr`, whose floor is its content's minimum width, so on the first launch the title bar and the inspector could be pushed past the right edge and the Setup sheet's buttons clipped; `minmax(0, 1fr)`. The "No manuscript in …" heading wraps long folder names instead of printing over them.
- The app writes a `launch: Dabir <version> on <os> <arch>` line to `ui.log` at every start, so the log file exists from the first run and a tester can tail it.
- Tests pass on a Windows checkout: repositories the tests create set `core.autocrlf=false`, paths are compared as paths, the skill link assertion accepts the pointer file Windows writes instead of a symlink, and the terminal test answers PowerShell's cursor-position query.
- Fixed, Windows: every tool Dabir ran (the Setup checks, `--version` probes, sign-in probes, Tectonic, Typst, pandoc, git) flashed a console window, at launch, when the window regained focus and each time Setup opened; the shared `spawn::tool` now starts them with `CREATE_NO_WINDOW`. And agents were never found there: the home directory came from `$HOME`, unset on Windows, so `~/.local/bin` and `~/.grok/bin` were looked up under the drive root, and `claude.exe` was not matched by a lookup for `claude`; `spawn::home_dir` reads `%USERPROFILE%` and `spawn::bin_in` also accepts `.exe` and `.cmd`.

## 0.1.2

- Fixed: switching files then pressing Undo brought the previous file's text into the new one, and autosave wrote it to disk (the sample's `code/sweep.py` had become a copy of `main.tex`). The editor now drops the old undo history, completion state and diagnostics when a file is swapped in, swaps the text before any keystroke can reach the old one, and every write pairs the path and the text of the same moment.
- Guided tour: *Take the tour* on the welcome screen (and Help › Guided Tour) copies the sample paper into Documents/Dabir and walks through twelve stops with a spotlight, each opening the real panel. The venue chips and the `examples/` hint left the welcome screen; templates stay under New Paper.
- docs/GUIDE.md: the step-by-step user guide, linked from the tour's last stop, the release notes and the issue templates.
- Motion: the welcome card rises in, the spotlight and its veil move between stops, all off under reduced motion.
- CI: jobs split by path (Web on Linux, Rust on macOS), cancelled on a newer push, Rust and Tectonic caches, one required Gate check; the release workflow gates on the checks, caches Rust per target, checks the three version fields agree with the tag, and writes the release body from CHANGELOG.md.
- Contributing: issue templates, Dependabot (grouped, weekly), SECURITY.md, CODE_OF_CONDUCT.md, TRADEMARK.md, an opt-in CLA check with CLA.md, and a "where to start" section.
- Legal notice: About Dabir shows the copyright, the AGPL and the source, as the licence asks of interactive programs; the welcome screen names the licence.
- Setup: the first launch opens a one-page check of the machine (LaTeX engine and its package cache, Typst, the five agent CLIs, language servers, your name) with the fix beside each gap. Dabir fetches the LaTeX packages and downloads Typst itself, with progress; agent and server installs run the vendor's own command in a shell inside the sheet, and Sign in runs the sign-in there. Help › Set Up Dabir and Settings › This machine reopen it; a Typst compile without Typst and the Agent tab without an agent link to it in place. `setup_status`, `setup_warm_latex`, `setup_install_typst` commands; the downloaded Typst lives under the app's data folder and is on the agents' and the terminal's PATH.
- Signed-out agents are caught before and after the fact: Setup asks each installed CLI whether it is signed in (`claude auth status`, `codex login status`, `cursor-agent status`, Grok's `auth.json`, `opencode auth list`) and marks a signed-out one amber with Sign in as the primary action; the Agent tab shows the same warning with a Sign in… link when that agent is chosen, rechecked when the window regains focus. A run that stops without a result is explained in the user's terms (`agents::explain_failure`): signed out with the exact login command, rate or usage limit, network, or the CLI's own last line with the exit code; never just "exited without a result". The welcome screen no longer carries the licence line.
- Code files: the sidebar outline comes from the language server when one is running (methods nested under classes, names the patterns miss), with the text-based outline as the instant fallback; the server's diagnostics join the Problems panel under a `code` label, with a code-aware *Fix with agent*; bracket pairs are coloured by depth (three tones, strings and comments skipped, an unmatched closer underlined); the enclosing block headers stay pinned at the top of the editor while their bodies scroll, and click to jump.
- Notebooks: `.ipynb` files open read-only as a page of cells with their saved outputs (text, images, errors), the kernel's language highlighted, ▶ to type a cell into the terminal and *Open REPL*. The sample paper gains `code/analysis.ipynb`.
- Typst visual view: `#stack` shows its children down or across, `#columns(n)[…]` flows the body through n columns, the `#bibliography` chip names the title, style and files, and `lr(...)` in math sizes mismatched delimiters (`lr(] a, b ])`, `lr(( a, b ])`) instead of failing.
- Setup: a Word and HTML export row installs pandoc with the machine's package manager (Homebrew, apt, dnf, pacman, zypper, winget); the Export sheet links to it. OpenCode's sign-in state is read from its credentials file, so it no longer shows as unknown.
- File › Close Paper (⇧⌘W) returns to the welcome screen and forgets the paper as the one to reopen at launch, so the tour offer and the other first-run paths can be reached again. `scripts/first-run.sh` resets the installed app to a first launch on the Mac for testing.
- Dependencies, from Dependabot's first pass taken as one change: React 19.3, Vite 8.3 and the other minor npm bumps; `git2` 0.21 (its text accessors now return `Result`), `zip` 4, `toml` 1; `actions/setup-node` v7, `actions/cache` v6, `paths-filter` v4, `tauri-action` v1. The `window-vibrancy` crate is gone (Tauri's own `set_effects` draws the sidebar material) and so is `@types/diff` (jsdiff ships its types). Held back with the reason in `dependabot.yml`: `yrs` (yrs-axum is built on 0.18) and TypeScript 7 (typescript-eslint's peer range).
- Fixed: the bundled templates and the sample paper were flattened into one folder inside the app (Tauri puts glob matches under the destination by file name), so New Paper from a bundled kit could not find its files in an installed build. Both are now bundled as directories, and `scripts/clean-sample.mjs` removes the sample's caches before a build so they never ship.

- Development harness: CONTRIBUTING.md, docs/REVIEW.md, the `npm run check` gate, ESLint, clippy and fmt in CI, pull request template, pre-push hook, optional Claude review workflow on the owner's subscription.
- Review bot `npm run review`: codebase-aware pull request reviews on the local agent subscriptions, any vendor, posted with gh; its first run reviewed itself and its findings were applied.
- Agent transcript: reasoning folded, tool rows with verbs and times, result card; Accept without a commit.
- Autosave with a Saved / Saving indicator; snapshots every five minutes and after accepted agent changes; Versions in the sidebar with restore.
- Preview hooks for documentation screenshots (`?open=sample&view=…`), browser preview only.

## 0.1.1

- Signed and notarised macOS builds (pending secrets), new identifier `com.surenalab.dabir`, updater endpoint on the organisation.

## 0.1.0

- First builds for macOS, Windows and Linux.
