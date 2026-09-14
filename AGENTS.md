# Working on Dabir

New session? Read docs/HANDOFF.md first: one page with the state, what was just done, what is next and the traps. Update it at the end of your session, in the same commit as the work.

Read PRODUCT.md and DESIGN.md before touching UI. Tokens live in src/styles/tokens.css; never hard-code a colour, face or spacing value in a component.

- Front end: React 19 + TypeScript in src/. Rust core in src-tauri/src/ (`lib.rs` holds the commands; logic lives in modules: `git`, `agents`, `memory`, `paper`, `lsp`, `terminal`, `templates`, `export`, `relay`). Commands are the only bridge, reached from `src/lib/backend.ts`.
- Run: `npm run tauri dev`. Browser-only preview: `npm run dev` (uses src/lib/sample.ts; native commands are stubbed).
- Check before commit: `npm run check` (scripts/check.sh: types, lint, build, fmt, clippy, Rust tests, script tests, design detector). `SKIP_RUST=1` for the front-end half.
- UI changes: run `/impeccable critique` on the screen and consult .agents/skills/apple-design-skill for the matching HIG article.
- A paper project's own memory format is documented in examples/score-anchor/.dabir/.
- Where things are written down: docs/HANDOFF.md (the one-page state for the next session), PLAN.md (state, log, decisions), CONTRIBUTING.md (the contract), docs/GUIDE.md (what the user sees), docs/REVIEW.md (review rubric), docs/TESTING.md (manual checks), CHANGELOG.md (one line per change under Unreleased). Update the one your change touches in the same pull request.

## Rules every agent follows here
- Commits are authored by the owner. Never add Co-Authored-By or any AI attribution trailer.
- The organisation is `surenalab` on GitHub; the studio is written "Surena Lab"; the product is Dabir. The site lives in the separate repository surenalab/surenalab.com and has its own AGENTS.md.
- The app is private until the owner says otherwise: do not make the repository public, publish the draft release, or add download links anywhere.
- Do not touch `src-tauri/**` while the owner is using the dev app: `tauri dev` rebuilds and restarts the app on any Rust change and loses their in-progress review. Ask, or batch Rust edits.
- The bundled sample `examples/score-anchor` lives inside this repository, so agent worktrees for it are worktrees of this repo; `git::repo_prefix` handles the nesting. Vite ignores `.dabir` and `examples` for that reason; keep it so. Users never open that folder: *Take the tour* (`open_sample`) copies it to `~/Documents/Dabir/score-anchor-sample`. Do not put caches or large files under `examples/score-anchor`; it ships in the app (`scripts/clean-sample.mjs` removes `.dabir/{build,worktrees,index}` before a build).
- Tauri resources: list directories (`"../templates": "templates/"`), never `dir/**/*` globs. A glob in the resources map is flattened to file names under the destination, which silently broke the bundled kits once.
- Licence and legal: AGPL-3.0-only. Keep the copyright and licence notice in the About panel and the welcome screen; third-party code needs an AGPL-compatible licence named in the pull request; contributions come under CLA.md; the name and mark are governed by TRADEMARK.md.

## Several agents at once
- Never share this checkout with another agent. Start from your own worktree on your own branch:
  `git worktree add "../dabir-<vendor>" -b agent/<vendor>/<topic>` then work there. Commits go to that branch; open a pull request; the owner merges.
- Before touching a file, `git status` and `git log -3`: if the tree has changes you did not make, you are in someone else's checkout. Stop and move to a worktree.
- Rust builds in a shared checkout fight over the target directory and restart the owner's dev app. In your worktree use `CARGO_TARGET_DIR=target/<vendor>`.

## Contract and review
- CONTRIBUTING.md is the contract: branch per change, `npm run check` green, pull request template filled, one or two reviews, squash-merge. docs/REVIEW.md is the rubric and the pipeline.
- `npm run review` is the review bot (scripts/review.mjs): codebase-aware, runs on the local agent subscriptions, posts with `--pr N --post`. Ask a different vendor than the author for the second review.
- Enable the pre-push hook once per clone: `git config core.hooksPath .githooks`.

## Harness: how to build, test and release
- Type and bundle: `npx tsc --noEmit -p tsconfig.json && npx vite build`.
- Rust tests without disturbing the dev build: `cd src-tauri && CARGO_TARGET_DIR=target/test cargo test`. Rust lives at `~/.cargo/bin`.
- Live agent pipeline (real CLI, real worktree, ~20 s): `cd src-tauri && env -u ANTHROPIC_BASE_URL DABIR_LIVE_PROVIDER=claude CARGO_TARGET_DIR=target/test cargo test live_agent -- --ignored --nocapture`; also `codex`, `cursor`, `grok`. When run from inside a Claude Code session, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*` must be scrubbed or the CLI answers 401.
- Agent benchmark (20 tasks): `./bench/run.sh <provider>` or `./bench/run.sh <provider> <task-id>`; results land in `bench/results/<provider>.json`.
- Design check for any UI change: `~/.claude/skills/impeccable/scripts/impeccable detect --json src index.html` must return an empty list; then `/impeccable critique` for anything larger than a fix.
- Browser preview for verification: `npm run tauri dev` serves Vite on :1420; the preview uses `src/lib/sample.ts` and skips native commands. `window.__session` and `.editor.__view` are test hooks.
- CI (`.github/workflows/ci.yml`): `changes` filters by path, then Web (Linux) and Rust (macOS, 10× the minutes) run only when their files changed; both on `main`; `Gate` is the one required check. Local `npm run check` is the same list, so a green local gate is a green CI. While the repository is private the organisation pays for minutes; a run that fails in seconds with a billing annotation is not a code failure. Do not open pull requests one per dependency (each costs a macOS job): see "Dependency updates" in CONTRIBUTING.md.
- Release (`.github/workflows/release.yml`): bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml` (the workflow refuses when they disagree with the tag), a block in CHANGELOG.md under the version (`scripts/release-notes.mjs` turns it into the release body), commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow builds macOS arm64 and x64, Linux and Windows (NSIS only; WiX fails silently) into a draft release with updater signatures; tauri-action v1 fails if the release already exists and is not a draft. Secrets: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` set; the six `APPLE_*` set by `scripts/apple-secrets.sh`. Notarisation currently fails with 401 until `APPLE_ID` and `APPLE_PASSWORD` are reset by the owner.
- Local build for a real-app check: `npm run tauri build -- --bundles app` (≈3½ min; the updater-key error at the end is expected without `TAURI_SIGNING_PRIVATE_KEY`), then `rm -rf /Applications/Dabir.app && cp -R src-tauri/target/release/bundle/macos/Dabir.app /Applications/`. Check `Contents/Resources/{templates,examples}` keep their folders.
- Dependencies pinned on purpose: `yrs` 0.18 (yrs-axum 0.8 is built on it; upgrade both together), TypeScript 6.x (typescript-eslint's peer range). `window-vibrancy` was removed in favour of `tauri::window::EffectsBuilder`; do not add it back. git2 ≥ 0.21 returns `Result` from `summary()`, `message()`, `shorthand()`, `url()`: use `.ok()` / `.ok().flatten()`.
- Editor invariants (`src/components/SourceEditor.tsx`, `src/App.tsx`), learned from a file that got overwritten with another file's text: a document swap from outside (file switch, agent's version, restore) runs in a layout effect, is annotated `addToHistory: false`, and resets the `history()` compartment, completion and diagnostics, so ⌘Z cannot bring the previous file back; `save` and `flush` read path and text from refs updated synchronously in `onSourceChange`, never from render-time closures; switching files flushes a pending autosave first. Any change to these paths needs the headless CDP race check described in the 2026-09-13 entry of PLAN.md (type, switch, undo, count the writes).
- Saving model: autosave (settings, default on) writes after a 900 ms pause; snapshots are commits on `refs/dabir/checkpoints` made by `git::checkpoint`, never on the user's branch; agent Accept = `agent_apply` (apply + snapshot), Accept and Commit = `agent_accept`.
- Agent events: kinds are text, tool, thinking, log, done, error; the parser in `agents.rs` maps each vendor's stream to these. Add a vendor by extending `args_for` and `parse_line` and the test `cursor_tool_call_names`.
- Sidecar: `node scripts/fetch-tectonic.mjs` fetches Tectonic per target; CI runs it before the Rust build.
