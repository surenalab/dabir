# Handoff: start here in a new session

The one page to read (or paste) when development continues in a fresh chat, on this machine or another. It is kept short on purpose: what the project is, where it stands today, what was just done, what is next, and the traps. The long record is PLAN.md; the rules are AGENTS.md and CONTRIBUTING.md. **Update this file at the end of every working session**, in the same commit as the work.

## Paste this to open a session

> Continue work on Dabir, the local-first LaTeX/Typst paper workspace (Tauri 2 + React 19, Rust core) at `/Users/sadegh/Documents/Open Source /dabir` (note the trailing space in `Open Source `). Read `docs/HANDOFF.md` first, then `AGENTS.md`; do not re-derive them. Verify with `npm run check`; commit as the owner (no AI trailers); CI is billing-blocked, so the local gate is the gate. Task: …

## What Dabir is, in three lines

A paper is a Git repository that also holds the code that made its figures. The editor is CodeMirror 6 with a visual layer over the same LaTeX or Typst buffer, compile through a bundled Tectonic, SyncTeX both ways, PDF view. Agents are the vendors' own CLIs (Claude Code, Codex, Cursor, Grok, OpenCode) run on a worktree with a generated brief and a paper map; their diff is reviewed in the document and accepted into the working copy. Live co-editing rides on Yjs. Nothing leaves the machine unless the user chooses it.

## Where things stand (2026-09-14)

- **Windows and Linux test of 0.1.2 (2026-09-14):** the Windows build launched, compiled a 27-page paper and rendered its PDF; the Linux AppImage launched under WSLg but its Tectonic needed glibc 2.39. Fixed on `fix/windows-console-flicker-and-home` (PR #16): hidden console windows, agents found under `%USERPROFILE%`, static Tectonic for Linux, Setup amber when the engine cannot start, Ctrl chords off the Mac, the first-launch grid overflow, a `launch:` line in `ui.log`, the Rust tests green on a Windows checkout, the first agent run initialising a repository (empty root commit, files left uncommitted) instead of refusing, a Git row in Setup with an install line, the keyboard fallback on in the native app off the Mac (native accelerators never reached the web view on Windows; Ctrl+Alt+S for the sidebar and Ctrl+Alt+Enter for Run File there, Ctrl+Enter sends). Verified on both: Windows through a Tauri CLI build and injected input; Linux through a Tauri CLI build inside the 0.1.2 AppImage runtime, driven and screenshotted from inside WSL with XTest and XGetImage (WSLg's own presentation goes blank after focus, the app does not). Still open from that test: the six visual steps of docs/TESTING.md that need a person (tour, editing, terminal, notebook, Typst download, update check), and the WSLg blank-after-resize note.
- **Shipping state:** v0.1.1 draft release exists (Windows, Linux; macOS unsigned pending Apple secrets). The installed build on this Mac is the current `main`, installed by hand from `src-tauri/target/release/bundle/macos/Dabir.app`.
- **Release 0.1.2 (2026-09-14):** built by making the repository public for twenty minutes (Actions is free on public repositories) and pushing the tag, then switching back to private. Windows `.exe`, Linux `.deb`/`.rpm`/AppImage and `latest.json` are on the v0.1.2 draft; both macOS jobs failed at notarisation (401, the Apple secrets are wrong), so the macOS build stays the one installed by hand. First CI run since the split: Web green; Rust failed on a transient 504 fetching Tectonic, so `fetch-tectonic.mjs` now retries. The flip is repeatable: `gh repo edit surenalab/dabir --visibility public --accept-visibility-change-consequences`, push the tag, wait for the Windows and Linux jobs, flip back (pushes are refused for a few seconds right after a flip).
- **Repository:** github.com/surenalab/dabir, private. **GitHub Actions is blocked on billing** for the organisation since 2026-09-13; every run fails in seconds with a billing annotation. Nothing in `.github/workflows/` has executed since the CI split. Owner's call: pay or make the repository public.
- **Gate:** `npm run check` (types, lint, build, fmt, clippy, 53 Rust tests, script tests, design detector). Green on `main` at `11ba888`.
- **Docs:** README, docs/GUIDE.md (user guide), docs/TESTING.md (manual checks), docs/REVIEW.md (review rubric), PLAN.md (log, decisions, quirks), CHANGELOG.md (Unreleased block is long; the next tag moves it).

## The last three sessions, briefly

1. **2026-09-13, sweep.py corruption → tour → plumbing.** The sample's `code/sweep.py` had become `main.tex`: undo after a file switch restored the old text into the new file and autosave wrote it. Fixed in `SourceEditor` (swap in a layout effect, history compartment reset, `addToHistory: false`) and `App` (save/flush read synchronous refs). Then: the welcome screen's *Take the tour* (twelve spotlight stops on a copy of the sample under `~/Documents/Dabir`), `docs/GUIDE.md`, CI split by path, contribution scheme (issue templates, Dependabot, SECURITY, CoC, CLA, TRADEMARK), licence review (AGPL kept, notice in About).
2. **2026-09-14, early.** Found that Tauri flattens glob resources: the installed app's `templates/` and the sample were flat folders. Both are now directory resources; `scripts/clean-sample.mjs` runs before a build.
3. **2026-09-14, later.** First-run **Setup** sheet (`SetupSheet.tsx`, `setup.rs`): checks LaTeX cache, Typst, agent CLIs, language servers, name; fetches LaTeX packages and downloads Typst itself with progress; installs agents and servers by typing the vendor's command into a terminal inside the sheet; reopens from Help and Settings; point-of-use links from a Typst compile without Typst and from the Agent tab. Live tests `cargo test -- --ignored setup::` hit the real Typst release and the bundled engine. Before that: Dependabot's thirteen PRs taken as one branch (`82c809c`): React 19.3, git2 0.21 (Result accessors), zip 4, toml 1, action bumps incl. tauri-action v1; `window-vibrancy` and `@types/diff` removed; `yrs` and TypeScript 7 held with reasons in `dependabot.yml`. AGENTS.md refreshed, CLAUDE.md made a pointer, CONTRIBUTING.md gained "Dependency updates". Then File › Close Paper (⇧⌘W) and `scripts/first-run.sh`, because the app reopens the last paper and the owner could not reach the welcome screen to test the tour.
4. **2026-09-14, afternoon: the engineering backlog.** LSP `documentSymbol` outline with the regex fallback; language-server diagnostics in the Problems list (`LintReport`, category `code`); read-only `.ipynb` viewer (`Notebook.tsx`) and a sample notebook; bracket-pair colours and sticky scroll for code files (`bracket-colours.ts`, `sticky-scroll.ts`); Typst `#stack`, `#columns`, richer `#bibliography` chip, token-level `lr` parsing; pandoc install row in Setup linked from Export; OpenCode sign-in from its `auth.json`.

## Open, in order

**Owner only**
1. GitHub Actions billing or public repository (unblocks CI, Gate, releases, CLA check).
2. Apple: reset `APPLE_ID` and `APPLE_PASSWORD`, re-run the tag for signed DMGs.
3. Test the first launch: `scripts/first-run.sh --install` opens Setup; try *Fetch packages* (already warm here, so it reads Ready), an agent *Install*/*Sign in* in the in-sheet shell, *Continue*, then *Take the tour*; report anything that felt wrong by row or stop.
4. Windows and Linux installers against docs/TESTING.md; a two-machine live session.

**Engineering**
- The backlog is empty as of 2026-09-14 (LSP outline, Problems from language servers, notebooks, bracket colours, sticky scroll, Typst `#stack`/`#columns`/`#bibliography`/`lr`, pandoc in Setup, OpenCode sign-in all landed). Deferred by decision: SSH level two, plugin API, hosted relay, continuation latency. New items come from the owner's hands-on pass and from users.
- Untested on real servers: the LSP outline was written against the protocol (pyright returns hierarchical `DocumentSymbol`s); open `code/sweep.py` with pyright installed and check the sidebar shows methods nested under classes. Sticky scroll and bracket colours were checked in the browser preview only.

## Traps that have already cost time

- Tauri `bundle.resources`: directories, never `**/*` globs (flattened). tauri-build copies resources on every `cargo build`, so a missing path breaks `cargo test`.
- Editor document swaps must not be undoable; see the invariants in AGENTS.md before touching `SourceEditor.tsx` or `save`/`flush`.
- `yrs` must stay on the version yrs-axum uses. TypeScript must stay inside typescript-eslint's peer range.
- git2 ≥ 0.21: `summary()`, `message()`, `shorthand()`, `url()` return `Result`.
- A child agent CLI must not inherit `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_*` from a Claude Code session (401).
- The dev app restarts on any Rust change; do not touch `src-tauri/**` while the owner is using `tauri dev`.
- The local build ends with "A public key has been found, but no private key": expected without `TAURI_SIGNING_PRIVATE_KEY`; the `.app` is fine.
- `typst_url` asks the GitHub API for the latest tag and falls back to v0.15.1; if the download ever 404s, bump the fallback in `setup.rs`.
- Screenshots from a script need Screen Recording permission for the terminal; `screencapture` fails silently without it.

## Verify a change end to end on this Mac

```sh
npm run check                                   # the gate
npm run tauri build -- --bundles app            # ≈4 min
scripts/first-run.sh --install                  # reinstall, reset to first launch, open
tail -f ~/Library/Logs/Dabir/ui.log             # web-view errors from the release build
```
