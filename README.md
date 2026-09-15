# Dabir

<img src="design/dabir-logo.svg" width="96" alt="Dabir mark: a line of ink with a madder proofreader's caret beneath it" align="right">

**A local-first workspace where a paper, its code, its Git history and its AI agents live in one window.**

Dabir (دبیر, Persian for *scribe*) opens a folder that holds your manuscript and the code that made its figures. It shows LaTeX like a document, compiles locally, and lets the agent you already pay for, whether Claude Code, Codex, Cursor, Grok or OpenCode, rerun an experiment, update the figure and the table, and open the pull request. Nothing is uploaded. Delete the app and your project is still a plain Git repo.

> Status: 0.1.5 released for macOS (signed and notarised), Windows 11 and Ubuntu 22.04. Open a folder, an Overleaf zip or a GitHub repo; edit the paper visually or as source in one buffer; compile with Tectonic; click the PDF to jump to the line; commit from the sidebar; ask Claude Code, Codex, Cursor, Grok or OpenCode (model and effort set from a slider in the composer) to change the paper on a worktree, then read and compile their version in the editor before it touches your checkout (verified live with Claude Code, Codex, Cursor and Grok); keep the project brief, facts and provenance in `.dabir/` so every agent shares them. Start a live session from Share and coauthors edit with you in real time, with presence and comments; pull and push to Overleaf's Git bridge; keep references in step with Zotero (a collection, synced now or while the paper is open, through Better BibTeX when it is there) or with the .bib Mendeley, Paperpile, JabRef or EndNote maintain, add entries by DOI or arXiv id, and have the agent check every entry online against Crossref, doi.org, arXiv and OpenAlex through the check-references skill; start new papers from the official kits of NeurIPS, ICML, ICLR, CVPR, ICCV, ECCV, ACL, TMLR, SIAM, Springer Nature, Nature Portfolio, BMC, PLOS and Frontiers, fetched from the venues themselves, or from starters for IEEE, ACM, SIGGRAPH, Elsevier, LNCS, AMS, APS, JMLR and the OUP journals, or in Typst, with a visual layer for both (Typst math renders through a translation to KaTeX); export the PDF, the sources arXiv needs, a zip for Overleaf or a submission system, or Word and HTML through pandoc. Compile problems are traceable to the line and fixable by the agent. Comments live with the paper and show as pins on the compiled PDF. Offline LaTeX-aware spelling, grammar and completion are built in, each with an off switch (⌘,). What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Why

Overleaf is where coauthors are, but it is paid, remote, and cannot run your code. VS Code plus LaTeX Workshop plus a coding agent can do everything, but writing a paper in it feels like editing config files. Dabir is the workspace in between: Overleaf-quality editing with the control of your own machine, and agents that treat the manuscript and the experiments as one change.

## Principles

- **Git is the truth.** No project format. A Dabir project is a folder with a `.tex` in it and optionally a `dabir.toml`.
- **Local by default, cloud by choice.** Compile, Git, search and agents work offline. Live sessions are opt-in and self-hostable.
- **Agents are coauthors, not chatbots.** They get the repo, a terminal and the compile log, run on a worktree, and produce diffs you review.
- **Memory lives in the repo.** `.dabir/` holds a project brief, one-fact memory files and a provenance graph, committed with the paper, so every coauthor's agent shares it whichever vendor they use.
- **Design is the product.** Every screen follows Apple's Human Interface Guidelines and is reviewed with Impeccable before merge.

## Writing tools

A formatting bar sits above the editor with the actions a Word or Gmail user expects: undo and redo, a style menu (section, subsection, run-in heading, plain), bold, italic, emphasis, code, bulleted and numbered lists, inline math, equation, figure and table skeletons, citation and cross-reference (which open completion inside the braces), link, footnote, find, and comment on the selection. Everything writes plain LaTeX, or plain Typst when the open file is `.typ` (`*bold*`, `= headings`, `#figure`, `@key`); the same actions live in the Format menu with shortcuts (⇧⌘B, ⇧⌘I, ⇧⌘E, ⇧⌘M, ⇧⌘C, ⇧⌘R, ⌘K). Completion opens as you type a backslash command, inside `\cite{`, `\ref{`, `\input{` and `\includegraphics{`, and on ⌃Space. It knows the whole paper, not just the open file: every label across `\input` files with its kind, section and caption; your own `\newcommand` macros with their bodies; symbol names with the glyph beside them (`\alpha` α); and skeletons for figures, tables, equations, lists, theorems and algorithms with tab stops, so Tab moves through the fields. Typing `$` pairs it like a bracket. ⌘-click or F12 on a `\ref`, `\cite`, `\input` or macro jumps to where it is defined, across files; the caret in a `\begin` or `\end` marks its partner; sections and environments fold from the gutter; the status bar counts the prose words rather than the lines, and in a multi-file paper the whole paper's words too; and in a paper split over files the outline in the sidebar covers all of them. The code that made the figures opens in the same editor with its own grammar (Python, Julia, R, MATLAB, JavaScript and TypeScript, C, C++ and CUDA, Rust, Fortran, Lua, SQL, shell, Markdown, YAML, JSON, TOML, CMake, Dockerfiles); the files opened in a session sit as tabs above the editor (⇧⌘] and ⇧⌘[ cycle, × closes, a dot marks unsaved edits); and Paper › Show Terminal (⌃`) opens a terminal panel below the editor with the same PATH the agents get, so a command that works for them works at the prompt: several shells as tabs, a drag handle for its height, and a shell on the remote host when `dabir.toml` names one. When a language server is installed (pyright for Python, tinymist for Typst, typescript-language-server, clangd, rust-analyzer, the Julia and R packages, the bash and YAML servers), code files also get its completion, errors, hover, go-to-definition, references and rename; Settings › Code files says which were found. The rest of what an IDE adds around code is there too: a code bar above every code file with the path, Run, Run Selection, a REPL button and Format, the language server in charge and the problem count, and the line and column; the sidebar outline lists the file's functions and classes; TODO and FIXME in comments are badged; a Run button (⌃⏎) types the recipe for the open file into the terminal, ⇧⏎ sends the selection or the current line (with a REPL open there, it runs, and the caret moves down a line) (`python3`, `julia`, `Rscript`, `node`, `cargo run`, compile-and-run for C, C++, CUDA and Fortran); Edit › Format Document (⇧⌥F, or on ⌘S with the setting) runs the project's formatter (ruff or black, prettier, rustfmt, clang-format, JuliaFormatter, styler, shfmt, stylua, taplo) as one undoable change; a change gutter marks lines added, changed and removed since the last commit, live as you type; diagnostics and compile errors are written at the end of their line; and code files show indentation guides. Find in Paper (⇧⌘F) searches every file at once and jumps to the line. Edit › Convert Unicode to LaTeX rewrites what a word processor leaves behind (curly quotes, dashes, ×, ≤, Greek letters, 10⁻³) as LaTeX, in or out of maths. Typst source has its own grammar (folding, list continuation, syntax errors, completion of functions and symbols), and the Typst visual view understands the paper's `#let` definitions and `#grid` layouts. Settings offer a Vim keymap and a focus mode (⌥⌘F) that inks only the paragraph you are in and folds the panels away. If the code runs on another machine, `[remote]` in `dabir.toml` names the host: recorded commands run there over ssh and their artefacts are copied back, the terminal pane offers a shell on that host, and the agents are told.

Predictive text finishes the word or phrase you are typing in grey, learned only from the paper itself, so it picks up your own terms and never sends text anywhere; Tab accepts it, ⌘→ takes one word, Escape dismisses. The formatting bar and the status bar fold their least-used parts into a More menu as the window narrows instead of clipping.

Four views: Visual, Source, PDF, and Split (⌘4), which puts the source next to the PDF with a draggable divider, Overleaf style. Visual folds the preamble into one row that opens on click, renders equations, figures and tables in place, and while you edit an equation's source it shows the rendered result underneath it. In Split, the PDF follows the cursor line; in every view a double-click on the PDF goes to the source line and Option-click leaves a comment there, while a plain click selects text. The PDF toolbar has page navigation, zoom presets, fit to width or page, and find (⌘F when the PDF has focus).

Settings (⌘,) hold every switch: spelling with bundled dictionaries for British and American English, German, Spanish, French, Italian and Portuguese (Portugal and Brazil) that skip commands, math and citation keys and run off the main thread (or the system checker), LanguageTool grammar on demand (⇧⌘G, off until you name a server, since text leaves the machine), LaTeX command and snippet completion, project completion for citation keys, labels and file paths, text sizes, wrapping, and compile on save.

## Working together, from anywhere

Share (⇧⌘S) offers three ways, none of which cost anything: *Anywhere*, one link for everyone, sent from your own Mail, Messages, WhatsApp or Telegram with the invitation written; the machines meet through Dabir's meeting point (a Cloudflare Worker on the free tier, `relay/signaling-worker.js`, which introduces peers and hands out TURN for strict networks without ever seeing the text; a lab can run its own and name it in Settings) and the paper travels between them, encrypted with the key in the link. *Same network*, where Dabir hosts a small relay on your machine (Tailscale extends that across the internet for free). *Direct*, where machines connect straight to each other after you swap two short codes with each coauthor, with no server at all. A joiner does not need the paper: they get a local mirror of the host's whole folder (figures, tables, the .bib) before the first keystroke, compile against it, and the host's checkout stays the record; edits to files nobody has open are written to disk on every side, sessions resume after a dropped connection, and ending a session drafts the commit. Comments carry replies, are anchored to the text, survive concurrent edits, are saved in `.dabir/comments.json` when you work alone, and appear as numbered pins on the compiled PDF; Option-click a spot on the PDF to comment there. Suggest changes (the pen in the formatting bar, or Settings) turns edits into tracked suggestions for coauthors who will not use Git: your insertions are underlined and your deletions struck through in your colour, anyone accepts or rejects each one from the People tab or by hovering the text, undo puts the marks back, and the suggestions travel in the live session or wait in `.dabir/changes.json`.

## Agents, briefly

Set Up Memory (Memory tab) writes three small things into the paper's repo: `.dabir/PROJECT.md`, the paper's identity and how its code runs; `.dabir/skills/`, ten playbooks every CLI discovers (six for the paper, four for the code); and `.dabir/memory/`, one fact per file plus a log of accepted runs. Every run starts with a ten-line preamble built from them and the passages most relevant to your request. Runs happen on a Git worktree seeded from your working copy, so nothing needs committing first; afterwards the editor shows the agent's version with the changes marked, ⌘B compiles it, and you accept into your files, accept and commit, or reject, hunk by hunk if you like.

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

**Take the tour** on the welcome screen (or Help › Guided Tour) copies the bundled sample paper, `examples/score-anchor`, into your Documents folder and walks through the window on it in twelve steps: files, views, compile, writing help, the agent and its memory, code, the terminal, history and sharing. The step-by-step [user guide](docs/GUIDE.md) goes deeper. In a source checkout, `python3 examples/score-anchor/code/sweep.py` regenerates the sample's figure and table.

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
