# Changelog

Newest first. Every merged pull request adds a line under Unreleased; a release moves the block under its version.

## Unreleased

- Fixed: switching files then pressing Undo brought the previous file's text into the new one, and autosave wrote it to disk (the sample's `code/sweep.py` had become a copy of `main.tex`). The editor now drops the old undo history, completion state and diagnostics when a file is swapped in, swaps the text before any keystroke can reach the old one, and every write pairs the path and the text of the same moment.
- Guided tour: *Take the tour* on the welcome screen (and Help › Guided Tour) copies the sample paper into Documents/Dabir and walks through twelve stops with a spotlight, each opening the real panel. The venue chips and the `examples/` hint left the welcome screen; templates stay under New Paper.
- docs/GUIDE.md: the step-by-step user guide, linked from the tour's last stop, the release notes and the issue templates.
- Motion: the welcome card rises in, the spotlight and its veil move between stops, all off under reduced motion.
- CI: jobs split by path (Web on Linux, Rust on macOS), cancelled on a newer push, Rust and Tectonic caches, one required Gate check; the release workflow gates on the checks, caches Rust per target, checks the three version fields agree with the tag, and writes the release body from CHANGELOG.md.
- Contributing: issue templates, Dependabot (grouped, weekly), SECURITY.md, CODE_OF_CONDUCT.md, TRADEMARK.md, an opt-in CLA check with CLA.md, and a "where to start" section.
- Legal notice: About Dabir shows the copyright, the AGPL and the source, as the licence asks of interactive programs; the welcome screen names the licence.
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
