# Dabir plan

The full plan with the design brief and architecture is rendered at [docs/plan.html](docs/plan.html) and published at https://claude.ai/code/artifact/5c6592e1-1c27-46a5-8ff2-728e977bed72. This file is the working summary: what is done, what is next, and the decisions that were made along the way.

## Thesis

The paper is a Git repo that also holds the experiment code. The agent is a coauthor that can rerun a figure and edit the manuscript in one reviewed change. Collaboration rides on GitHub first and live editing second. The visual editor has to be the best-looking LaTeX surface that exists.

## Phases

| Phase | Goal | State |
|---|---|---|
| 0 | Foundation: Tauri shell, tokens, DESIGN.md, sample project, skills, first critique | Done |
| 1 | An editor you would use: source editing, compile, PDF, outline, citations, Overleaf import | Done |
| 2 | Git and agents: clone, commit, branch, PR; provider adapters; `.dabir` memory and provenance | Done, needs real-world testing |
| 3 | Collaboration: Yjs live sessions, comments, self-hostable relay, Overleaf sync | Built, tested with two clients |
| 4 | Ecosystem: Typst, Zotero, journal templates, plugin API, hosted relay as the optional paid service | Templates, Typst, Zotero done; plugin API and hosted relay later |

## Progress log

**2026-09-07, phase 0.** Repo scaffolded with Tauri 2 and React 19. Design tokens for light and dark, three-pane macOS document layout, KaTeX math with preamble macros, sample paper with `.dabir` memory files. Impeccable and the Apple HIG skill installed in the repo.

**2026-09-07, critique.** Two isolated Impeccable agents plus a HIG agent scored the shell 15/40. Main findings: no reject path in the review moment, contradictory status, no menu bar, faint grey below contrast, diff clipping, raw LaTeX in the visual view, non-standard shortcuts, fixed panes. All fixed the same day. Snapshot in `.impeccable/critique/`.

**2026-09-07, phase 1.** Native menu bar owns every shortcut. CodeMirror 6 source editor with the LaTeX language, search and save. Tectonic compile from Rust with parsed diagnostics that jump to the line, a PDF view rendered with PDF.js, a log panel and an honest status bar. BibTeX-backed citation chips ("Ho et al. 2020"). Overleaf source-zip import from the File menu and the empty state. Sample sweep script really generates the figure and table. Rust unit tests for the log parser and the zip import.

**2026-09-07, phase 1 finished and phase 2 built.** Visual editing is a CodeMirror decoration layer over the same buffer (`src/lib/visual.ts`): markup hides, math and figures render as widgets from the real files, citations and refs become chips, and whatever sits under the cursor reveals its source. SyncTeX works both ways. Git runs through libgit2 with real status, commit, init, clone, and a worktree per agent run. Agent adapters launch the vendor CLIs as sidecars and stream one event protocol; the review shows the real diff with Accept and Commit, Reject, and Open Pull Request through gh. Memory setup drafts `.dabir/PROJECT.md` from the manuscript, provenance shows stale and missing artefacts with one-click rerun, and pointer files keep every vendor on the same brief. Six Rust tests cover the core.

## How the pieces work

- **Visual editing.** One CodeMirror buffer, two views. A state field rebuilds decorations on every document or selection change: line classes for headings, abstract and preamble; replace-decorations that hide `\section{`, `\emph{`, labels and scaffolding lines; KaTeX widgets for `$…$` and equation environments; figure widgets that render the first page of the figure PDF; chips for `\cite`, `\ref` and `\input`. Any construct that intersects the selection is left as source, so clicking a widget places the cursor inside and reveals it.
- **SyncTeX.** Rust parses `main.synctex.gz` into (page, x, y, file, line) records. Clicking a PDF page finds the nearest record and jumps the editor. Show Line in PDF finds the record for the cursor line and draws a marker on the page.
- **Agent runs.** `agent_run` creates `.dabir/worktrees/<id>` on branch `dabir/<id>`, prepends a pointer to the project brief, and spawns the vendor CLI there with permission prompts bypassed. stdout lines are parsed per vendor (Claude and Cursor stream-json, Codex exec json, a generic fallback for Grok and OpenCode) into text, tool, log and done events. On done the front end asks for the worktree diff. Accept applies the patch to the checkout with `git apply --3way --index`, commits, and removes the worktree. Reject removes it. Open Pull Request commits on the branch, pushes, and runs `gh pr create --web`.
- **Memory.** `memory_setup` writes a deterministic brief (title, class, sections, figure files, provenance commands), an empty provenance file, `AGENTS.md`, `CLAUDE.md` and a Cursor rule, all pointing at the brief. `memory_read` merges provenance from `provenance.json` and `dabir.toml`, and marks an artefact stale when any input is newer than it. Rerun executes the recorded command and stamps the date and commit.

**2026-09-07, live agent runs.** The full worktree pipeline was run against real CLIs with the ignored test `live_agent_run`: Grok finished the edit in 11 s and Codex in 30 s, both diffs applied and committed cleanly. Discoveries folded back into the adapter: Claude Code ships inside the VS Code agent-host cache and Codex inside ChatGPT.app when no standalone CLI is on PATH; Codex's current exec flags are `--json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox`; Grok's `streaming-messages-json` is the Claude stream format; a child CLI must not inherit the parent session's `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_*` variables; `.dabir/worktrees` has to be excluded through `.git/info/exclude` or the accept commit tries to add it. Then: per-file accept in the review, compile on save, booktabs tables in the visual view.

## Agent CLI status on the development Mac

| Provider | Binary | State |
|---|---|---|
| Grok | `~/.grok/bin/grok` | Signed in, live test passes |
| Codex | `/Applications/ChatGPT.app/Contents/Resources/codex` | Signed in, live test passes |
| Claude Code | VS Code agent-host cache, 2.1.220 | Signed in, live test passes (13 s) |
| Cursor | `~/.local/bin/cursor-agent` | Signed in, live test passes (13 s) |
| OpenCode | not installed | |

Run the live test for any provider with:

```
DABIR_LIVE_PROVIDER=codex cargo test live_agent -- --ignored --nocapture
```

**2026-09-07, all four providers live.** After sign-in, Claude Code and Cursor also pass `live_agent_run` in 13 s each, so every adapter has done a real edit-review-commit cycle. Cursor reports tools as `tool_call` events keyed by tool kind (`shellToolCall`, `readToolCall`, …), now parsed. Per-hunk accept: the review shows a checkbox per file and, for multi-hunk files, per hunk; Rust filters the unified diff to the selection before applying, binary files stay all-or-nothing. Compile can be stopped from the toolbar.

**2026-09-07, agent context, packaging, phase 3.** Agents now start every run with a minimal identity preamble (paper identity line, pointer to `.dabir/PROJECT.md`, environment prefix, skill names, and a BM25 context pack of the passages most relevant to the request); six starter skills live in `.dabir/skills` and are linked into `.agents/skills` and `.claude/skills`; `dabir.toml [env] prefix` is shared by provenance reruns and agents; accepted runs append to `.dabir/memory/runs.md`. Packaging: Tectonic ships as a sidecar, the updater is wired with a minisign key and GitHub releases, macOS-only window options moved to `tauri.macos.conf.json`, accelerators use CmdOrCtrl, and GitHub Actions builds macOS arm64/x64, Windows and Linux with signing and notarisation from secrets. Compile progress streams into the status bar and can be cancelled. Phase 3: Yjs live sessions over a bundled relay, presence, anchored comments, Overleaf Git bridge pull and push; verified with two browser clients editing and commenting on the same file.

## Agent context design

Minimal on purpose. Three files an agent reads, in this order, all committed with the paper:

1. **`.dabir/PROJECT.md`, the identity.** Under 80 lines: Identity (abstract-sized), Claims and key numbers, Conventions (macros not to redefine), Repo map (one line per code file with its docstring), How to run (detected from environment.yml, pyproject, requirements, Makefile; the `[env] prefix` every command gets), Generated artefacts (artefact → command), Working rules. Drafted deterministically from the manuscript by Set Up Memory; humans and agents both edit it.
2. **`.dabir/skills/<job>/SKILL.md`, the know-how.** Six playbooks for the recurring jobs: rerun-experiment, update-figure-and-text, address-reviewer, tighten-prose, check-references, compile-and-fix. Standard Agent Skills format with `name` and `description` frontmatter, so Claude Code, Codex and Cursor discover them through `.claude/skills` and `.agents/skills` symlinks without any vendor-specific glue.
3. **`.dabir/memory/`, what was learned.** One fact per file with frontmatter, plus `runs.md`, appended on every accepted run (date, provider, request, files).

At run time Dabir prepends a preamble of about ten lines: the identity sentence, the pointer, the env prefix, the skill names, and the context pack (top passages by BM25 over `.tex`, `.bib`, code, the brief and the facts, capped at about 2 KB). In the live tests every provider's first action became reading the brief or jumping straight to the right line.

## Release checklist

- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets from `~/.tauri/dabir.key` (never commit the key). The public key is in `tauri.conf.json`.
- Apple: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`. `scripts/apple-secrets.sh` sets all six from the keychain and prompts, so no secret passes through anyone but you. Needs the paid Developer Program and a "Developer ID Application" certificate (the free account only issues "Apple Development", which Gatekeeper does not trust for distribution). Without them the workflow still produces an unsigned DMG.
- The updater endpoint points at `github.com/surenalab/dabir`; change it if the repo lives elsewhere.
- Tag `v0.1.0` to run the release workflow. It fetches Tectonic per target and builds the relay.

**2026-09-08.** Native relay in Rust (axum + yrs) replaces the Node process for hosting; two-client sync is a unit test. Tectonic sidecar 0.17. Problems panel: the TeX log is parsed into traceable diagnostics with file, line, category and excerpt; each can be jumped to, is marked in the editor, and can be handed to the agent under the compile-and-fix skill, singly or all at once. Phase 4: New Paper from five templates with Git and memory set up, Typst compile for `main.typ` projects, Zotero local-API and .bib import merged without duplicates.

**2026-09-08, editor and collaboration.** Settings sheet with system spelling, LanguageTool grammar on demand (matches underline, hover offers replacements, off by default), LaTeX and project completions, sizes, wrapping, reveal-on-click, compile on save. Comments work without a session (quote-anchored in `.dabir/comments.json`) and show as numbered pins on the compiled PDF through SyncTeX; Option-click on the PDF comments at that spot. Live sessions gain a direct mode: WebRTC with the offer and answer exchanged as two pasted codes, so no server exists at all; the public y-webrtc signalling servers turned out to be dead in 2026, so the signalling mode now needs a URL you set, with a one-file Cloudflare Worker provided. New sample paper (Score Anchoring, diffusion posterior sampling, imaginary authors). New mark: the proofreader's caret.

## Site and identity

`site/` is a static site for Cloudflare Pages: the Surenalab studio page at the root and the product page at `/dabir/`, both in the paper-and-ink world with the lajvard mark, no build step. In Cloudflare Pages, create a project from the repository with build command empty and output directory `site`, then attach `surenalab.com`. The download buttons ask the GitHub API for the latest release once the repository is public and fall back to the releases page. The bundle identifier is `com.surenalab.dabir`. Holding identity: `dev@surenalab.com` owns the Apple Developer account and the `surenalab` GitHub organisation; `hello@surenalab.com` is support.

## Why no server is needed for live sessions

Three free options in the Share sheet. Direct: the host makes an invite code, the guest answers with a code, and WebRTC connects the two machines with only public STUN for address discovery; nothing is hosted. Same network: the built-in Rust relay on the host's machine, which Tailscale stretches across the internet with no port forwarding. Signalling server: a one-file Cloudflare Worker (`relay/signaling-worker.js`) on the free tier introduces peers and never sees the text; its URL goes in Settings. A hosted relay remains the optional paid service for teams who want a fixed address with no setup. Networks that block all peer traffic (some university firewalls) need the relay or Tailscale.

**2026-09-08, PDF and names.** PDF view gains zoom (toolbar, ⌘= ⌘− ⌘0, ⌘-wheel and pinch) and a real text layer, so text can be selected and copied; clicks on selected text no longer jump. Sample authors and references renamed to unmistakably invented names. A writing-aids pill in the status bar shows which of spelling, grammar and completion are on and opens Settings.

**2026-09-08, editing surface.** Formatting bar with Word-style actions driven by an imperative editor API (wrap, block, list, heading, complete, undo, redo); Format menu with shortcuts; Both view (⌘4) with editor and PDF side by side and a draggable divider, the PDF following the cursor through SyncTeX; PDF toolbar with page navigation, zoom presets, fit modes and find; double-click to jump to source, Option-click to comment, plain click to select. Icon redrawn as a dimensional macOS app icon (graphite squircle, paper line, madder caret) and the full icon set regenerated.

**2026-09-08, second editing pass.** Predictive text (`src/lib/predict.ts`): a per-paper word and phrase model (frequency, bigram, trigram over the prose only) that shows ghost text after the cursor; Tab, ⌘→ and Escape; off switch in Settings. Formatting bar measures its groups and moves them into a More menu by priority as the window narrows; the status bar drops its hints, line count and pills through container queries. Split view is Source beside PDF (Visual stays its own mode). Visual view: preamble folds into a labelled row, live rendered preview under an equation while its source is open, align and gather render through their inner forms, footnotes become hover markers, links, small caps, super and subscripts, curly quotes, escaped symbols and ellipses render.

## Live co-working, second pass (2026-09-08)

Built once the Windows and Linux builds started running. Every joiner rebuilds the host's whole working tree in `~/Dabir Sessions/<room>` before editing: the host publishes a snapshot inside the shared document (text as text, other files as 96 KB base64 chunks, one transaction each so every transport copes; files over 12 MB or beyond 80 MB in total stay behind and are named), the joiner waits for the manifest and every chunk, materialises the folder and opens it, so figures, tables and the `.bib` match and the joiner can compile. After each compile the host republishes only the files whose bytes changed. Every client writes shared texts it does not have open to its own disk, so the host's checkout and every mirror stay complete for files somebody else is editing; the host seeds any file a joiner opens that nobody has opened yet. Session state persists in IndexedDB per room, so a dropped connection or a restart resumes with the same edits. The host marks itself in awareness; joiners see a banner when the host leaves. Ending a session as the host drafts the commit message ("Live session with A, B") into the sidebar, since the host's checkout is the record of the session. Joining needs no open paper: the empty state has Join a Live Session…. Repository: github.com/surenalab/dabir (private until the first builds are tested; flip to public in Settings › General › Danger zone). First tag v0.1.0; the Windows job needed the system bsdtar for the Tectonic zip and a copy instead of a rename across drives; the macOS jobs needed the Apple secrets left unset rather than empty; releases need `contents: write`. Agent runs on a paper that sits inside a larger repository (the bundled sample inside Dabir's own checkout, or a monorepo) now work: the worktree is the whole repository, the agent's working directory is the paper's folder inside it, diffs and picks are paper-relative, apply runs from the repository root, and commit-all stages only the paper. In development, Vite now ignores `.dabir` and `examples`, because a worktree appearing there used to trigger a full page reload that threw the dev app back to the empty state (the "agent restarts the app" report). Windows ships the NSIS installer only; WiX fails silently on the template resources. Comments now carry threads: Reply under any comment, in the session document or in `.dabir/comments.json`.

## Still open

- **Two-machine run of the live session pass.** The mirror flow is exercised only in the browser preview (where materialising is skipped); run it host-on-Mac, joiner-on-Windows once the Windows build installs.
- **Direct sessions need a real-world run.** The invite and answer exchange works end to end (660-character codes, deflate-compressed SDP), but the preview browser used for automated tests blocks local WebRTC candidates, so the final data-channel connection could only be exercised as far as ICE checking. Test between two machines in the app; if it fails behind a strict NAT, the relay with Tailscale is the fallback.
- **Windows and Linux have not been run.** The CI matrix builds them; the visual layer, vibrancy fallbacks and menu chords need a pass on a real machine.
- **Remote cursors** render in Source mode; in Visual mode the widgets hide them.
- **Plugin API** and a hosted relay as the optional paid service.
- **Offline spell dictionary for LaTeX-aware checking** (today the system checker also underlines command names inside the editor when it feels like it).
- **Visual layer for Typst.** Typst projects edit in Source mode only.
- **Track changes** for coauthors who will not use Git.
- **Local index** for retrieval over long papers; agents currently rely on the brief plus their own file reading.
- **Apple signing and notarisation** need a paid Apple Developer account; see the release checklist. Unsigned builds run after a right-click › Open.
- **Prediction from a model.** Today's prediction is statistical and local; an agent-backed continuation (a sentence from the assistant, on demand) is a natural next step once the agent runs are cheap enough to call per keystroke.

## Decisions

- **Name:** Dabir (دبیر), Persian for scribe. Alternatives were Resaleh and Daftar.
- **Licence:** AGPL-3.0 for the app, MIT for packages that graduate.
- **Tauri over Electron** for native chrome, small binaries, and Rust for Git and process control. Electron stays the fallback if WebView rendering bites.
- **Tectonic** as the compile engine, looked up in Homebrew paths, PATH, or `DABIR_TECTONIC`. Bundling as a sidecar comes with packaging.
- **No model proxying.** Each vendor's own CLI runs locally with the user's subscription. Dabir is the control plane.
- **Design process.** Impeccable for direction and craft, the Apple HIG skill for platform correctness. Every UI change runs `/impeccable critique` before merge. Sample data is always tagged as sample in the UI.
- **Sample script is dependency-free** so the example runs anywhere, even though real projects will use matplotlib or whatever the paper's code uses.

## Known quirks

- The working folder is literally named `Open Source ` with a trailing space. It works, but some tools may trip on it.
- The `.dabir/build` output folder must exist before Tectonic runs; the compile command creates it.
- In the browser preview (`npm run dev`) compile and PDF are mocked because there is no TeX engine in the browser.
