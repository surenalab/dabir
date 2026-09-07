---
name: dabir-compile-and-fix
description: "Compile the paper with Tectonic and fix errors at their source."
---

# compile and fix

1. Compile: `tectonic -X compile --keep-logs --synctex --outdir .dabir/build main.tex` (or the main file named in PROJECT.md).
2. Read `.dabir/build/*.log` for `!` errors first, then warnings. Fix the first error, recompile, repeat.
3. Undefined citations or references are usually a missing `\label` or a typo in the key; do not silence them.
4. Overfull boxes in the log point at line numbers; fix wording or table widths rather than adding `\sloppy`.
5. Finish with a clean compile and report the remaining warnings.
