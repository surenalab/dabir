# Dabir plan

The full plan with the design brief and architecture is rendered at [docs/plan.html](docs/plan.html) and published at https://claude.ai/code/artifact/5c6592e1-1c27-46a5-8ff2-728e977bed72. This file is the working summary: what is done, what is next, and the decisions that were made along the way.

## Thesis

The paper is a Git repo that also holds the experiment code. The agent is a coauthor that can rerun a figure and edit the manuscript in one reviewed change. Collaboration rides on GitHub first and live editing second. The visual editor has to be the best-looking LaTeX surface that exists.

## Phases

| Phase | Goal | State |
|---|---|---|
| 0 | Foundation: Tauri shell, tokens, DESIGN.md, sample project, skills, first critique | Done |
| 1 | An editor you would use: source editing, compile, PDF, outline, citations, Overleaf import | Mostly done, see below |
| 2 | Git and agents: clone, commit, branch, PR; provider adapters; `.dabir` memory and provenance | Next |
| 3 | Collaboration: Yjs live sessions, comments, self-hostable relay, track changes for non-Git coauthors | Later |
| 4 | Ecosystem: Typst, Zotero, journal templates, plugin API, hosted relay as the optional paid service | Later |

## Progress log

**2026-09-07, phase 0.** Repo scaffolded with Tauri 2 and React 19. Design tokens for light and dark, three-pane macOS document layout, KaTeX math with preamble macros, sample paper with `.dabir` memory files. Impeccable and the Apple HIG skill installed in the repo.

**2026-09-07, critique.** Two isolated Impeccable agents plus a HIG agent scored the shell 15/40. Main findings: no reject path in the review moment, contradictory status, no menu bar, faint grey below contrast, diff clipping, raw LaTeX in the visual view, non-standard shortcuts, fixed panes. All fixed the same day. Snapshot in `.impeccable/critique/`.

**2026-09-07, phase 1.** Native menu bar owns every shortcut. CodeMirror 6 source editor with the LaTeX language, search and save. Tectonic compile from Rust with parsed diagnostics that jump to the line, a PDF view rendered with PDF.js, a log panel and an honest status bar. BibTeX-backed citation chips ("Ho et al. 2020"). Overleaf source-zip import from the File menu and the empty state. Sample sweep script really generates the figure and table. Rust unit tests for the log parser and the zip import.

## Phase 1, still open

- **SyncTeX click-through.** Tectonic already writes `main.synctex.gz`. Parse it in Rust, map PDF clicks to source lines and source lines to PDF positions.
- **Visual editing.** The visual view is read-only. Replace `src/lib/latex.ts` with a CodeMirror 6 decoration layer over the same document so visual and source are one buffer with two views. This is the biggest item left and the one that makes Overleaf users stay.
- **Figures inline.** Render the actual figure PDF or image in the visual view instead of the placeholder.
- **Compile on save** as an option, and incremental feedback while Tectonic runs.
- **Windows and Linux builds.** The shell is cross-platform, but only macOS has been run.

## Phase 2 design notes

- **Git** via `git2` in the Rust core. The navigator's Changes section becomes real status. Commit, branch, and a worktree per agent run. GitHub through the device OAuth flow.
- **Agent adapters** over one internal event protocol: prompt in, tool calls and file edits out, diff at the end. Target the Agent Client Protocol first, then native adapters for Claude Code, Codex, Cursor, Grok Build and OpenCode. Always keep the API-key path first-class.
- **Memory** lives in the repo: `.dabir/PROJECT.md`, `.dabir/memory/*.md`, `.dabir/provenance.json`, and a gitignored local index. Generated `AGENTS.md`, `CLAUDE.md` and `.cursor/rules` point into `PROJECT.md`. Memory updates ship in the same reviewed diff as the code change. The provenance graph is what lets agents mark results stale, refuse to hand-edit generated numbers, and rerun what feeds a figure.
- **The review moment** already has its shape: evidence first, commit message, Accept and Commit, Reject, Open Pull Request. Phase 2 makes it real and adds per-hunk accept.

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
