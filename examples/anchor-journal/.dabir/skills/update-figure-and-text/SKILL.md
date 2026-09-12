---
name: dabir-update-figure-and-text
description: "Change a figure's content or style and keep the caption, the reference in the text, and any claims consistent."
---

# update figure and text

1. Edit the plotting code, not the exported file. Keep the figure's file name so `\includegraphics` keeps working.
2. Regenerate through the recorded command (rerun-experiment).
3. Re-read the caption and every sentence that references the figure (`\ref{fig:…}`). Fix wording that no longer matches.
4. Keep the venue's rules: no colour-only encodings, fonts legible at column width.
5. Compile and check the figure placement in the PDF log for overfull boxes.
