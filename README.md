# Dabir

**A local-first workspace where a paper, its code, its Git history and its AI agents live in one window.**

Dabir (دبیر, Persian for *scribe*) opens a folder that holds your manuscript and the code that made its figures. It shows LaTeX like a document, compiles locally, and lets the agent you already pay for, whether Claude Code, Codex, Cursor, Grok or OpenCode, rerun an experiment, update the figure and the table, and open the pull request. Nothing is uploaded. Delete the app and your project is still a plain Git repo.

> Status: phase 0. The shell runs, opens a real folder, renders a paper in visual and source views, and shows where agents, memory and collaboration go. Compile, Git and agents land in phases 1 and 2. See [PLAN.md](PLAN.md).

## Why

Overleaf is where coauthors are, but it is paid, remote, and cannot run your code. VS Code plus LaTeX Workshop plus a coding agent can do everything, but writing a paper in it feels like editing config files. Dabir is the workspace in between: Overleaf-quality editing with the control of your own machine, and agents that treat the manuscript and the experiments as one change.

## Principles

- **Git is the truth.** No project format. A Dabir project is a folder with a `.tex` in it and optionally a `dabir.toml`.
- **Local by default, cloud by choice.** Compile, Git, search and agents work offline. Live sessions are opt-in and self-hostable.
- **Agents are coauthors, not chatbots.** They get the repo, a terminal and the compile log, run on a worktree, and produce diffs you review.
- **Memory lives in the repo.** `.dabir/` holds a project brief, one-fact memory files and a provenance graph, committed with the paper, so every coauthor's agent shares it whichever vendor they use.
- **Design is the product.** Every screen follows Apple's Human Interface Guidelines and is reviewed with Impeccable before merge.

## Run it

Prerequisites: Node 22, Rust stable (`rustup`), and on macOS the Xcode command line tools.

```bash
npm install
npm run tauri dev
```

To preview the UI in a browser without Tauri (uses the bundled sample paper):

```bash
npm run dev
```

Open `examples/isgd-tci` from the toolbar to see a real project with memory and provenance files.

## Layout

```
src/            React + TypeScript front end
  styles/       tokens.css is the design system; app.css the shell
  lib/latex.ts  phase-0 LaTeX reader for the visual view
src-tauri/      Rust core: project discovery, file access, later Git, compile and agents
examples/       sample paper projects
.dabir/         (in a paper repo) PROJECT.md, memory/, provenance.json
```

## Design workflow

UI changes go through two agent skills that ship in this repo:

- **Impeccable** for direction and craft: `/impeccable critique`, `/audit` and `/polish` on every screen before merge. `DESIGN.md` is its source of truth.
- **Apple design skill** for platform correctness: sidebars, toolbars, inspectors, sheets, dark mode and accessibility as macOS expects them.

## Licence

AGPL-3.0. Editor packages that graduate into their own crates or npm modules will be MIT.
