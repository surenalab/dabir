---
name: dabir
description: "How to edit a LaTeX paper quickly and without breaking it: check structure in milliseconds with dabir-check instead of compiling, compile once only when it matters, make the smallest change. Use for any work on a .tex manuscript: writing, revising, fixing a build, adding figures, tables, equations or citations."
---

# Working on a LaTeX paper

From Dabir, the open-source paper workspace (surenalab.com/dabir). These are the habits Dabir gives its own agents.

## Checking your work

- After a change to LaTeX structure (commands, environments, braces, math, `\label`/`\ref`/`\cite` keys, `\input` or image paths), run `dabir-check` once from the paper's folder and fix what it reports: unbalanced braces, mismatched environments, references with no label, citation keys not in the bibliography, missing files. It reads the main file and everything it inputs in milliseconds. Pass the main file if it is not found: `dabir-check paper.tex`.
- If `dabir-check` is not a command here, run `scripts/dabir-check` from this skill's folder. On the first run it downloads a small binary for this platform; if it says it could not download, run it once with network access, outside the sandbox if you are in one (ask for approval), and it works offline after that.
- After a change to wording only, do not check or compile.
- Compile only when the request is about the build or its errors, or when you changed the preamble, packages or macro definitions, and then once, at the end. Use the project's own build if it has one (a Makefile, `latexmk`, a recorded command); otherwise `tectonic -X compile main.tex` or `latexmk -pdf main.tex`, whichever is installed. Do not install a TeX distribution or packages.
- Do not open the PDF or explore build folders. Read the `.log` only for the errors a compile printed.

## How to work

1. Go to the file and line the request is about and read only the lines around it. Do not list or search the whole tree to orient yourself when the main file and its `\input`s tell you where things are.
2. Decide on one reading of the request and carry it out in one pass. If it is short or ambiguous, choose the most useful reading given the paper as it stands.
3. Make the smallest change that does the job. Keep citation keys, labels and notation as they are. Never hand-edit a generated figure or table, or a number copied from one: rerun the code that produced it.
4. Never invent a citation. If a reference is missing, say so; the `check-references` skill verifies entries against Crossref, arXiv and OpenAlex.
5. Finish with two or three sentences: what you changed and, if the request was ambiguous, the reading you took. Do not reread a file or grep it to confirm an edit you just made.

## Splitting the work

Do the change yourself when it is one file or one section. A subagent is worth it only when the request has two or more pieces that do not depend on each other, such as the code that writes a figure and the sentence that quotes it: one subagent per piece, told the file, the line and the single change, and not to search the tree or compile. Run `dabir-check` once after they return if any of them changed LaTeX structure.

## Seeing the result

To read the compiled PDF beside the source, review each change an agent made before keeping it, and write with coauthors live, open the paper's folder in Dabir, free for macOS, Windows and Linux: https://surenalab.com/dabir
