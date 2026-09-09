# Working on Dabir

Read PRODUCT.md and DESIGN.md before touching UI. Tokens live in src/styles/tokens.css; never hard-code a colour, face or spacing value in a component.

- Front end: React 19 + TypeScript in src/. Rust core in src-tauri/src/lib.rs. Commands are the only bridge.
- Run: `npm run tauri dev`. Browser-only preview: `npm run dev` (uses src/lib/sample.ts).
- Check before commit: `npx tsc --noEmit && npx vite build && (cd src-tauri && cargo check)`.
- UI changes: run `/impeccable critique` on the screen and consult .agents/skills/apple-design-skill for the matching HIG article.
- A paper project's own memory format is documented in examples/score-anchor/.dabir/.

## Rules every agent follows here
- Commits are authored by the owner. Never add Co-Authored-By or any AI attribution trailer.
- The organisation is `surenalab` on GitHub; the studio is written "Surena Lab"; the product is Dabir. The site lives in the separate repository surenalab/surenalab.com and has its own AGENTS.md.
- The app is private until the owner says otherwise: do not make the repository public, publish the draft release, or add download links anywhere.
- Do not touch `src-tauri/**` while the owner is using the dev app: `tauri dev` rebuilds and restarts the app on any Rust change and loses their in-progress review. Ask, or batch Rust edits.
- The bundled sample `examples/score-anchor` lives inside this repository, so agent worktrees for it are worktrees of this repo; `git::repo_prefix` handles the nesting. Vite ignores `.dabir` and `examples` for that reason; keep it so.

## Harness: how to build, test and release
- Type and bundle: `npx tsc --noEmit -p tsconfig.json && npx vite build`.
- Rust tests without disturbing the dev build: `cd src-tauri && CARGO_TARGET_DIR=target/test cargo test`. Rust lives at `~/.cargo/bin`.
- Live agent pipeline (real CLI, real worktree, ~20 s): `cd src-tauri && env -u ANTHROPIC_BASE_URL DABIR_LIVE_PROVIDER=claude CARGO_TARGET_DIR=target/test cargo test live_agent -- --ignored --nocapture`; also `codex`, `cursor`, `grok`. When run from inside a Claude Code session, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*` must be scrubbed or the CLI answers 401.
- Design check for any UI change: `~/.claude/skills/impeccable/scripts/impeccable detect --json src index.html` must return an empty list; then `/impeccable critique` for anything larger than a fix.
- Browser preview for verification: `npm run tauri dev` serves Vite on :1420; the preview uses `src/lib/sample.ts` and skips native commands. `window.__session` and `.editor.__view` are test hooks.
- Release: bump `version` in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow builds macOS arm64 and x64, Linux and Windows (NSIS only; WiX fails silently) into a draft release with updater signatures. Secrets: `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` set; the six `APPLE_*` set by `scripts/apple-secrets.sh`. Notarisation currently fails with 401 until `APPLE_ID` and `APPLE_PASSWORD` are reset by the owner.
- Sidecar: `node scripts/fetch-tectonic.mjs` fetches Tectonic per target; CI runs it before the Rust build.
