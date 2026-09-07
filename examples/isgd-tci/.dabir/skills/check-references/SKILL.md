---
name: dabir-check-references
description: "Verify citations, cross-references and bibliography entries are consistent and complete."
---

# check references

1. Every `\cite{key}` must exist in the `.bib` files; every `\ref`/`\eqref` must have a `\label`. List the misses.
2. Look for `??` and `[?]` in the compile log and the PDF text.
3. Do not invent bibliography entries. If a reference is missing, say so and stop; the author adds it.
4. Normalise obvious BibTeX problems (missing year, journal capitalisation in braces) only when the source is unambiguous.
