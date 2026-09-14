# Dabir user guide

A step-by-step walk through writing a paper in Dabir, from the first launch to a submitted PDF. Each section is one thing to do, in the order you are likely to need it. The in-app tour (Help › Guided Tour, or *Take the tour* on the welcome screen) covers the first twelve of these on a sample paper in about three minutes; this guide goes deeper.

Keys are given for macOS. On Windows and Linux read ⌘ as Ctrl and ⌥ as Alt.

## 1. Install and open Dabir

1. Download the build for your machine from the [releases page](https://github.com/surenalab/dabir/releases), or build it yourself with `npm install && npm run tauri build` (Node 22 and Rust stable). Dabir checks for updates itself; Dabir › Check for Updates does it now.
2. Open Dabir. The first launch opens **Setup**, a one-page check of what this machine has, with the fix beside anything missing. Nothing is installed unless you choose it, and everything runs where you can see it:
   - **LaTeX** is built in (the Tectonic engine). Its packages download at the first compile, a minute or two; **Fetch packages** does that now so the wait never lands in the middle of writing.
   - **Typst** is only for Typst papers. **Download Typst** fetches the compiler (about 14 MB, from Typst's own release) into the app.
   - **Agents**: Dabir runs the vendor's own command-line tool on your own subscription. **Install** types the vendor's one-line installer into a shell that opens inside the sheet; **Sign in** runs the sign-in, which opens the browser and comes back. An installed tool that is not signed in is marked amber here and warned about in the Agent tab, and a run that fails for that reason says so with the exact command. Claude Code, Codex, Cursor, Grok and OpenCode are known.
   - **Code**: language servers for Python, Typst, Julia, R and the rest, each one command, optional.
   - **You**: the name that goes on your comments and suggested changes.
   **Continue** closes it; Help › Set Up Dabir (or Settings › This machine) brings it back any time. A Typst compile without Typst, or the Agent tab without an agent, offers the same fix in place.

The welcome screen then offers **Open Folder**, **New Paper**, **Import from Overleaf**, **Clone from GitHub**, **Join a Live Session**, and the tour.

## 2. Take the tour

Click **Take the tour**. Dabir copies a sample paper into `Documents/Dabir/score-anchor-sample` (a manuscript, a bibliography, a figure and a table, and `code/sweep.py`, the script that produced them) and walks through the window on it: files, views, compile, the formatting bar, the outline, the agent, its memory, code, the terminal, history, and sharing. Every step opens the real panel, so you can try each thing as it is explained. → and ← move between steps, Esc leaves; Help › Guided Tour starts it again. The sample stays in your Documents folder to experiment on. Dabir reopens the last paper when it starts; File › Close Paper (⇧⌘W) returns to the welcome screen.

## 3. Open your paper

A Dabir project is a folder with a `.tex` (or `.typ`) file in it. No import, no project file.

- **Open Folder…** (⌘O) opens any folder in place. Dabir finds the main file (the one with `\documentclass`), reads the bibliography and the figures, and shows the Git state if the folder is a repository. If it is not, the sidebar offers to initialise one.
- **New Paper…** (⌘N) starts from a venue's official kit, fetched from the venue itself: NeurIPS, ICML, ICLR, CVPR, ICCV and ECCV, ACL, TMLR, SIAM, Springer Nature, Nature Portfolio, BMC, PLOS, Frontiers; or from starters for IEEE, ACM, SIGGRAPH, Elsevier, LNCS, AMS, APS and JMLR; or in Typst. Choose the folder in the save panel that follows. Each new paper is a Git repository with its first commit made.
- **Import from Overleaf…** unpacks the zip Overleaf exports (Menu › Download › Source) into a folder. To keep working with Overleaf afterwards, see §12.
- **Clone from GitHub…** (⇧⌘O) clones a repository with a paper in it.

Dabir remembers the last paper and reopens it at launch. The sidebar lists the folder's files; click one to open it, and the files opened in a session become tabs above the editor (⇧⌘] and ⇧⌘[ cycle through them, × closes, a dot marks unsaved edits).

Optional: a `dabir.toml` at the root names the main file, the engine and the venue, records which command made each figure and table (§9), and can name a remote machine (§10). Every field is optional.

```toml
[paper]
main = "main.tex"
engine = "tectonic"     # typst for a .typ paper

[provenance]
"figures/psnr-vs-noise.pdf" = "python3 code/sweep.py --sigma 0.3"
"tables/psnr-sweep.tex"     = "python3 code/sweep.py --sigma 0.3"
```

## 4. Find your way around the window

From left to right: the **sidebar** (files, the outline of the whole paper, the Git changes and recent commits), the **document**, and the **inspector** (Agent, Memory, People, History). The **terminal** opens below the document (⌃`). ⌃⌘S and ⌥⌘I hide and show the side panels; drag their edges to resize. Focus mode (⌥⌘F) folds the panels away and inks only the paragraph you are in.

The segmented control in the title bar chooses how the document is shown:

| View | What it is | Key |
| --- | --- | --- |
| Visual | The LaTeX laid out as a page while you type. Equations, figures and tables render in place; the preamble folds into one row. Click anything to see and edit its source. | ⌘1 |
| Source | The raw file with highlighting, folding, bracket matching, completion and the change gutter. | ⌘2 |
| PDF | The compiled paper, with page navigation, zoom and find. | ⌘3 |
| Split | Source beside PDF with a draggable divider. The PDF follows the cursor; double-click the PDF to jump to the source line. | ⌘4 |

The status bar at the bottom shows the compile state, the word count (prose only: no preamble, comments or math), and the spelling, completion and prediction switches.

## 5. Write

Type LaTeX as usual; the editor helps without getting in the way.

- **The formatting bar** above the editor writes plain LaTeX for you: style (section, subsection, run-in heading, plain), bold, italic, emphasis, code, lists, inline math, equation, figure and table skeletons, citation, cross-reference, link, footnote. The same actions live in the Format menu: ⇧⌘B, ⇧⌘I, ⇧⌘E, ⇧⌘M, ⇧⌘C, ⇧⌘R, ⌘K. In a `.typ` file the bar writes Typst.
- **Completion** opens as you type a backslash command and inside `\cite{`, `\ref{`, `\input{` and `\includegraphics{`. It knows the whole paper: every label across `\input` files with its section and caption, your own `\newcommand` macros, symbol names with the glyph beside them, and skeletons with tab stops (Tab moves through the fields). ⌃Space opens it by hand.
- **Go to definition**: ⌘-click or F12 on a `\ref`, `\cite`, `\input` or macro jumps to where it is defined, across files. The caret inside `\begin` marks its `\end`.
- **Spelling and grammar**: misspellings are underlined offline with dictionaries for British and American English, German, Spanish, French, Italian and Portuguese; commands, math and citation keys are skipped. Right-click for suggestions or to add a word to the paper's dictionary (`.dabir/dictionary.txt`, shared with coauthors). Grammar (⇧⌘G) uses a LanguageTool server you name in Settings, since text leaves the machine for that.
- **Predictive text** finishes the word or phrase in grey, learned from the paper itself and never sent anywhere. Tab accepts, ⌘→ takes one word, Esc dismisses.
- **Continue with the agent** (⇧⌘Space): the chosen agent writes the next sentence as ghost text; Tab keeps it.
- **Find in Paper** (⇧⌘F) searches every file at once; ⌘F finds in the open file or the PDF.
- **Convert Unicode to LaTeX** (Edit menu) rewrites what a word processor leaves behind (curly quotes, dashes, ×, ≤, Greek letters, 10⁻³) as LaTeX.

Autosave is on by default (Settings ⌘,). ⌘S saves at once. Every save is a step in History (§11).

## 6. Compile and fix problems

⌘B compiles with Tectonic (Typst for a `.typ` paper); **Compile on save** in the status bar keeps the PDF current as you write. Progress and the log appear at the bottom (⇧⌘L shows the full log).

Errors and warnings are turned into plain sentences under **Problems**, each pointing at its file and line: click one to jump there. Undefined references, missing citations, overfull boxes and missing packages are recognised by name, and **Fix with the agent** hands the problem and the log to the agent (§8).

In Split and PDF views, a double-click on the PDF goes to the source line and ⇧⌘J shows the current line in the PDF (SyncTeX). Option-click on the PDF leaves a comment at that spot (§12).

## 7. References

References… (⌥⌘R) manages the bibliography:

- **Zotero**: choose a collection and sync it now, or keep it in step while the paper is open, through Better BibTeX. Mendeley, Paperpile, JabRef and EndNote work through the `.bib` they maintain.
- **Add by DOI or arXiv id**: the entry is fetched and appended to the `.bib` in the paper's style.
- **Check the references**: the agent follows the `check-references` skill, verifying every entry online against Crossref, doi.org, arXiv and OpenAlex, fixing fields from the records, adding missing DOIs, and listing mismatches for you to decide on. It never deletes or invents entries.

Citation keys complete inside `\cite{` with the title and authors shown; ⌘-click a key to open its entry.

## 8. Ask an agent

The **Agent** tab (⌘J) sends a request to the agent you choose: Claude Code, Codex, Cursor, Grok or OpenCode, whichever is installed. Pick the model and the effort in the two menus when the agent offers them.

What happens on a run:

1. Dabir builds a short **preamble** rather than sending the folder: the paper's identity, the paper map (files, headings, labels, citations), your **focus** (the selection or the section you are in), the memory of past runs and decisions, the relevant skills, and the compile log when there was an error. Runs cost a fraction of an agent left to search on its own.
2. The agent works on a **Git worktree** seeded from your working copy, so nothing needs committing first and nothing touches your files while it runs. It has a terminal in the worktree and can compile there.
3. When it finishes, the document shows **its version** with the changes marked, and the inspector shows its report. ⌘B compiles that version. **Accept** lands the changes in your files and takes a snapshot; **Accept and Commit** does that and commits; **Reject** discards them; or accept and reject hunk by hunk.

Good first requests on the sample: *"Tighten the abstract to 150 words"*, *"Rerun the sweep with a finer noise grid and update Table 1 and the abstract"*, *"Address reviewer 2's comment on the anchor ratio"*. The **compile-and-fix**, **address-reviewer**, **rerun-experiment**, **update-figure-and-text**, **tighten-prose** and **check-references** skills are recipes the agent follows for such requests.

**Memory** (the Memory tab) is plain Markdown in `.dabir/`, committed with the paper so every coauthor's agent shares it: `PROJECT.md` (the brief and how the code runs), `memory/` (one fact per file and a log of accepted runs), `skills/` (the recipes), and `provenance.json` (which command made which artefact, §9). *Set Up Memory* writes the scaffold; the agent keeps it current, and you can edit any of it. `AGENTS.md` and `CLAUDE.md` at the root point every CLI at these files.

## 9. Code, figures and provenance

The code that made the figures opens in the same editor with its own grammar (Python, Julia, R, MATLAB, JavaScript and TypeScript, C, C++ and CUDA, Rust, Fortran, Lua, SQL, shell, Markdown, YAML, JSON, TOML, CMake, Dockerfiles). A **code bar** above the file shows the path, **Run** (⌃⏎), **Run Selection** (⇧⏎), a **REPL** button and **Format** (⇧⌥F), the language server in charge and its problem count, and the line and column. The sidebar outline lists the file's functions and classes (from the language server when one is running, so methods nest under their classes; from the text otherwise); TODO and FIXME are badged; the gutter marks lines added, changed and removed since the last commit; diagnostics are written at the end of their line and listed in the Problems panel beside the compile's, with *Fix with agent*. Bracket pairs are coloured by depth, and the headers of the blocks you are inside (`def`, `class`, `for`) stay pinned at the top while you scroll; click one to go there.

A **Jupyter notebook** (`.ipynb`) opens as a page: text cells as text, code cells highlighted, and the outputs saved in the file (tables, images, errors). It is read-only in Dabir, edit it in Jupyter; ▶ on a cell types it into the terminal, and *Open REPL* starts the kernel's REPL there first. The outline lists the notebook's headings.

Install a **language server** for completion, errors, hover, go to definition (F12), references (⇧F12) and rename (F2); Settings › Code files shows which were found:

| Language | Server | Install |
| --- | --- | --- |
| Python | pyright (or basedpyright, pylsp, ruff) | `npm i -g pyright` |
| Typst | tinymist | `brew install tinymist` |
| Julia | LanguageServer.jl | `julia -e 'using Pkg; Pkg.add("LanguageServer")'` |
| R | languageserver | `R -e 'install.packages("languageserver")'` |
| JavaScript, TypeScript | typescript-language-server | `npm i -g typescript typescript-language-server` |
| C, C++, CUDA | clangd | `brew install llvm` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |
| Lua | lua-language-server | `brew install lua-language-server` |
| Shell | bash-language-server | `npm i -g bash-language-server` |
| YAML | yaml-language-server | `npm i -g yaml-language-server` |

**Format Document** runs the project's formatter (ruff or black, prettier, rustfmt, clang-format, JuliaFormatter, styler, shfmt, stylua, taplo) as one undoable change; *Format on save* is a setting.

**Provenance** ties artefacts to the commands that made them. Record it in `dabir.toml` (§3) or let the agent do so after a run; the Memory tab shows each figure and table with the command, the date and the commit, and whether it is fresh or stale. Agents rerun the script rather than editing the numbers, and refuse to hand-edit a generated file.

## 10. The terminal and remote machines

⌃` opens a real shell in the paper's folder, with the same PATH the agents get, so a command that works for them works for you. Several shells sit as tabs; drag the top edge to resize. Run (⌃⏎) types the recipe for the open file (`python3`, `julia`, `Rscript`, `node`, `cargo run`, compile-and-run for C, C++, CUDA and Fortran); ⇧⏎ sends the selection or the current line, and with a REPL open there it runs and the caret moves down.

If the experiments run elsewhere, name the machine:

```toml
[remote]
host = "gpu-box"          # an ssh alias from ~/.ssh/config
dir  = "~/papers/anchor"  # the paper's folder there
```

Recorded provenance commands then run there over ssh and their artefacts are copied back, the terminal's + menu offers a shell on that host, and the agents are told where the code runs.

## 11. History and Git

Dabir keeps three kinds of history, all in the repository:

- **Steps**: every save is a step in the History tab; click one to restore the file as it was, or undo the restore.
- **Snapshots**: every accepted agent run is a snapshot with its report.
- **Commits**: the sidebar's Changes section shows what changed since the last commit with a drafted message; **Commit** (⌥⌘C) commits under your name. Agents never commit as you; when they open a pull request the commit is theirs.

Nothing here is Dabir's own format: `git log` shows the same history, and any Git client or host works alongside.

## 12. Work with coauthors

**Share** (⇧⌘S) has everything for working together, none of it paid:

- **Live session**: start one and send the invite code. Coauthors join from their welcome screen and get a mirror of the whole folder before the first keystroke; edits, cursors and comments flow peer to peer over WebRTC. Direct connections need no server; a small relay on your machine or a one-command Cloudflare worker (`relay/signaling-worker.js`) helps peers find each other and never sees the text. Sessions resume after a dropped connection, and ending one drafts the commit.
- **Comments**: select text and comment (the People tab, or the bubble in the formatting bar); Option-click the PDF to comment on a spot. Comments carry replies, survive concurrent edits, are saved in `.dabir/comments.json` when you work alone, and show as numbered pins on the PDF.
- **Suggest changes** (the pen in the formatting bar): your edits become tracked suggestions, underlined and struck through in your colour; anyone accepts or rejects each from the People tab or by hovering the text.
- **Overleaf**: name the project's Git bridge once, then pull and push from Share while coauthors keep using Overleaf.
- **Export** (⌥⌘E): the PDF, the sources arXiv needs, a zip for Overleaf or a submission system, or Word and HTML through pandoc.

## 13. Settings and shortcuts

Settings (⌘,) hold every switch: autosave and format on save, compile on save, spelling language and the system checker, grammar server, completion and prediction, text sizes and wrapping, the Vim keymap, focus mode, suggesting mode, the agent's memory rules, and the code file servers found. ⌘/ lists every shortcut.

## 14. When something goes wrong

- **The compile fails at once**: Tectonic must be installed (`brew install tectonic`); `DABIR_TECTONIC` points Dabir at a binary elsewhere. The full log is under ⇧⌘L.
- **The agent is not listed**: its command-line tool must be on your PATH when Dabir starts; the Agent menu in the inspector shows what was found.
- **A language server is not used**: Settings › Code files lists the servers Dabir looked for and the install command of each.
- **Something looks wrong on screen**: script errors are written to `~/Library/Logs/com.surenalab.dabir/ui.log` (or the platform's log folder). Attach it to an issue.
- **Reporting**: open an issue with the log, the version (Dabir › About), and the smallest paper that shows the problem. [CONTRIBUTING.md](../CONTRIBUTING.md) describes how changes are reviewed.
