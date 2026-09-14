# Handoff: start here in a new session

The one page to read (or paste) when development continues in a fresh chat, on this machine or another. It is kept short on purpose: what the project is, where it stands today, what was just done, what is next, and the traps. The long record is PLAN.md; the rules are AGENTS.md and CONTRIBUTING.md. **Update this file at the end of every working session**, in the same commit as the work.

## Paste this to open a session

> Continue work on Dabir, the local-first LaTeX/Typst paper workspace (Tauri 2 + React 19, Rust core) at `/Users/sadegh/Documents/Open Source /dabir` (note the trailing space in `Open Source `). Read `docs/HANDOFF.md` first, then `AGENTS.md`; do not re-derive them. Verify with `npm run check`; commit as the owner (no AI trailers); CI is billing-blocked, so the local gate is the gate. Task: …

## What Dabir is, in three lines

A paper is a Git repository that also holds the code that made its figures. The editor is CodeMirror 6 with a visual layer over the same LaTeX or Typst buffer, compile through a bundled Tectonic, SyncTeX both ways, PDF view. Agents are the vendors' own CLIs (Claude Code, Codex, Cursor, Grok, OpenCode) run on a worktree with a generated brief and a paper map; their diff is reviewed in the document and accepted into the working copy. Live co-editing rides on Yjs. Nothing leaves the machine unless the user chooses it.

## Where things stand (2026-09-14)

- **Shipping state:** v0.1.1 draft release exists (Windows, Linux; macOS unsigned pending Apple secrets). The installed build on this Mac is the current `main`, installed by hand from `src-tauri/target/release/bundle/macos/Dabir.app`.
- **Repository:** github.com/surenalab/dabir, private. **GitHub Actions is blocked on billing** for the organisation since 2026-09-13; every run fails in seconds with a billing annotation. Nothing in `.github/workflows/` has executed since the CI split. Owner's call: pay or make the repository public.
- **Gate:** `npm run check` (types, lint, build, fmt, clippy, 53 Rust tests, script tests, design detector). Green on `main` at `11ba888`.
- **Docs:** README, docs/GUIDE.md (user guide), docs/TESTING.md (manual checks), docs/REVIEW.md (review rubric), PLAN.md (log, decisions, quirks), CHANGELOG.md (Unreleased block is long; the next tag moves it).

## The last three sessions, briefly

1. **2026-09-13, sweep.py corruption → tour → plumbing.** The sample's `code/sweep.py` had become `main.tex`: undo after a file switch restored the old text into the new file and autosave wrote it. Fixed in `SourceEditor` (swap in a layout effect, history compartment reset, `addToHistory: false`) and `App` (save/flush read synchronous refs). Then: the welcome screen's *Take the tour* (twelve spotlight stops on a copy of the sample under `~/Documents/Dabir`), `docs/GUIDE.md`, CI split by path, contribution scheme (issue templates, Dependabot, SECURITY, CoC, CLA, TRADEMARK), licence review (AGPL kept, notice in About).
2. **2026-09-14, early.** Found that Tauri flattens glob resources: the installed app's `templates/` and the sample were flat folders. Both are now directory resources; `scripts/clean-sample.mjs` runs before a build.
3. **2026-09-14, later.** Dependabot's thirteen PRs taken as one branch (`82c809c`): React 19.3, git2 0.21 (Result accessors), zip 4, toml 1, action bumps incl. tauri-action v1; `window-vibrancy` and `@types/diff` removed; `yrs` and TypeScript 7 held with reasons in `dependabot.yml`. AGENTS.md refreshed, CLAUDE.md made a pointer, CONTRIBUTING.md gained "Dependency updates". Then File › Close Paper (⇧⌘W) and `scripts/first-run.sh`, because the app reopens the last paper and the owner could not reach the welcome screen to test the tour.

## Open, in order

**Owner only**
1. GitHub Actions billing or public repository (unblocks CI, Gate, releases, CLA check).
2. Apple: reset `APPLE_ID` and `APPLE_PASSWORD`, re-run the tag for signed DMGs.
3. Test the tour on a first launch: `scripts/first-run.sh --install`, then *Take the tour*; report anything that felt wrong by stop number.
4. Windows and Linux installers against docs/TESTING.md; a two-machine live session.

**Engineering, by value**
1. LSP document symbols for the code outline (regex outline is the fallback).
2. Problems list fed by language-server diagnostics.
3. `.ipynb` viewing; bracket-pair colours; sticky scroll.
4. Typst visual gaps: `#stack`, `#columns`, `#bibliography` styles, `lr` with mismatched delimiters.
5. Deferred by decision: SSH level two, plugin API, hosted relay, continuation latency.

## Traps that have already cost time

- Tauri `bundle.resources`: directories, never `**/*` globs (flattened). tauri-build copies resources on every `cargo build`, so a missing path breaks `cargo test`.
- Editor document swaps must not be undoable; see the invariants in AGENTS.md before touching `SourceEditor.tsx` or `save`/`flush`.
- `yrs` must stay on the version yrs-axum uses. TypeScript must stay inside typescript-eslint's peer range.
- git2 ≥ 0.21: `summary()`, `message()`, `shorthand()`, `url()` return `Result`.
- A child agent CLI must not inherit `ANTHROPIC_BASE_URL` or `CLAUDE_CODE_*` from a Claude Code session (401).
- The dev app restarts on any Rust change; do not touch `src-tauri/**` while the owner is using `tauri dev`.
- The local build ends with "A public key has been found, but no private key": expected without `TAURI_SIGNING_PRIVATE_KEY`; the `.app` is fine.
- Screenshots from a script need Screen Recording permission for the terminal; `screencapture` fails silently without it.

## Verify a change end to end on this Mac

```sh
npm run check                                   # the gate
npm run tauri build -- --bundles app            # ≈4 min
scripts/first-run.sh --install                  # reinstall, reset to first launch, open
tail -f ~/Library/Logs/Dabir/ui.log             # web-view errors from the release build
```
