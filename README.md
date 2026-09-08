# Dabir

<img src="design/dabir-logo.svg" width="96" alt="Dabir mark: a line of ink with a madder proofreader's caret beneath it" align="right">

**A local-first workspace where a paper, its code, its Git history and its AI agents live in one window.**

Dabir (دبیر, Persian for *scribe*) opens a folder that holds your manuscript and the code that made its figures. It shows LaTeX like a document, compiles locally, and lets the agent you already pay for, whether Claude Code, Codex, Cursor, Grok or OpenCode, rerun an experiment, update the figure and the table, and open the pull request. Nothing is uploaded. Delete the app and your project is still a plain Git repo.

> Status: phases 0 to 4 built, run on macOS; Windows and Linux build in CI but are untested. Open a folder, an Overleaf zip or a GitHub repo; edit the paper visually or as source in one buffer; compile with Tectonic; click the PDF to jump to the line; commit from the sidebar; ask Claude Code, Codex, Cursor, Grok or OpenCode to change the paper on a worktree and review the diff hunk by hunk before it touches your checkout (verified live with Claude Code, Codex, Cursor and Grok); keep the project brief, facts and provenance in `.dabir/` so every agent shares them. Start a live session from Share and coauthors edit with you in real time, with presence and comments; pull and push to Overleaf's Git bridge; import references from Zotero or a .bib file; start new papers from journal templates or in Typst. Compile problems are traceable to the line and fixable by the agent. Comments live with the paper and show as pins on the compiled PDF. Spelling, grammar and completion are built in, each with an off switch (⌘,). Progress and next steps are in [PLAN.md](PLAN.md).

## Why

Overleaf is where coauthors are, but it is paid, remote, and cannot run your code. VS Code plus LaTeX Workshop plus a coding agent can do everything, but writing a paper in it feels like editing config files. Dabir is the workspace in between: Overleaf-quality editing with the control of your own machine, and agents that treat the manuscript and the experiments as one change.

## Principles

- **Git is the truth.** No project format. A Dabir project is a folder with a `.tex` in it and optionally a `dabir.toml`.
- **Local by default, cloud by choice.** Compile, Git, search and agents work offline. Live sessions are opt-in and self-hostable.
- **Agents are coauthors, not chatbots.** They get the repo, a terminal and the compile log, run on a worktree, and produce diffs you review.
- **Memory lives in the repo.** `.dabir/` holds a project brief, one-fact memory files and a provenance graph, committed with the paper, so every coauthor's agent shares it whichever vendor they use.
- **Design is the product.** Every screen follows Apple's Human Interface Guidelines and is reviewed with Impeccable before merge.

## Writing tools

Settings (⌘,) hold every switch: system spelling, LanguageTool grammar on demand (⇧⌘G, off until you name a server, since text leaves the machine), LaTeX command and snippet completion, project completion for citation keys, labels and file paths, text sizes, wrapping, and compile on save.

## Working together without a server

Share (⇧⌘S) offers two ways: peer to peer over the internet, where the text travels directly between coauthors over WebRTC and a free public signalling server only introduces peers, or same-network, where Dabir hosts a small relay on your machine (Tailscale extends that across the internet at no cost). Comments are anchored to the text, survive concurrent edits, are saved in `.dabir/comments.json` when you work alone, and appear as numbered pins on the compiled PDF; Option-click a spot on the PDF to comment there.

## Agents, briefly

Set Up Memory (Memory tab) writes three small things into the paper's repo: `.dabir/PROJECT.md`, the paper's identity and how its code runs; `.dabir/skills/`, six playbooks every CLI discovers; and `.dabir/memory/`, one fact per file plus a log of accepted runs. Every run starts with a ten-line preamble built from them and the passages most relevant to your request. Runs happen on a Git worktree; you review the diff hunk by hunk.

## Run it

Prerequisites: Node 22, Rust stable (`rustup`), the Xcode command line tools, and Tectonic for compiling (`brew install tectonic`). Dabir looks for Tectonic in the usual Homebrew paths and on PATH, or at `DABIR_TECTONIC`.

```bash
npm install
npm run tauri dev
```

To preview the UI in a browser without Tauri (uses the bundled sample paper):

```bash
npm run dev
```

Open `examples/score-anchor` (File › Open Paper…) to see a real project with memory and provenance files. Run `python3 examples/score-anchor/code/sweep.py` to regenerate its figure and table, then ⌘B to compile.

## Layout

```
src/            React + TypeScript front end
  styles/       tokens.css is the design system; app.css the shell
  lib/latex.ts  LaTeX reader for the visual view (CodeMirror decorations replace it later)
  components/   Toolbar, Navigator, Document (visual, SourceEditor, PdfView), Inspector
src-tauri/      Rust core: project discovery, file access, Tectonic compile, native menu; later Git and agents
examples/       sample paper projects
.dabir/         (in a paper repo) PROJECT.md, memory/, provenance.json
```

## Design workflow

UI changes go through two agent skills that ship in this repo:

- **Impeccable** for direction and craft: `/impeccable critique`, `/audit` and `/polish` on every screen before merge. `DESIGN.md` is its source of truth.
- **Apple design skill** for platform correctness: sidebars, toolbars, inspectors, sheets, dark mode and accessibility as macOS expects them.

## Licence

AGPL-3.0. Editor packages that graduate into their own crates or npm modules will be MIT.
