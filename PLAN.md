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
| 3 | Collaboration: Yjs live sessions, comments, self-hostable relay, track changes for non-Git coauthors | Later |
| 4 | Ecosystem: Typst, Zotero, journal templates, plugin API, hosted relay as the optional paid service | Later |

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

## Still open

- **Real-world agent testing.** The Claude Code CLI is not installed on the development machine, so the Claude adapter's parser was written from the documented stream-json shape and verified only by the sample flow. Cursor and Grok are installed; their flags are set but a real end-to-end run against a paper still needs doing.
- **Per-hunk accept.** The review is whole-run today.
- **Compile on save**, incremental compile feedback, and cancelling a running compile.
- **Table environments** are shown as dimmed source in the visual view; a rendered table widget is the next visual-layer item.
- **Local index** for retrieval over long papers is not built yet; agents currently rely on the brief plus their own file reading.
- **Windows and Linux builds.** The shell is cross-platform, but only macOS has been run.
- **Phase 3.** Yjs live sessions, comments anchored to text, self-hostable relay, Overleaf Git-bridge sync.

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
