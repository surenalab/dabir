---
name: dabir-rerun-experiment
description: "Regenerate a figure or table by rerunning the command that produced it, then update every number in the text that came from it."
---

# rerun experiment

1. Find the artefact in `.dabir/PROJECT.md` → Generated artefacts, or `dabir.toml [provenance]`. Use the recorded command, prefixed with the env prefix from `dabir.toml [env]` if present.
2. Run it from the repo root. If it fails, fix the cause in the code, never by editing the output by hand.
3. Search the manuscript for numbers that came from this artefact (captions, `\input` tables, inline claims). Update each one from the new output.
4. Compile (see compile-and-fix). Report the old and new numbers in your final message.
5. Update `producedAt` and `commit` for the artefact in `.dabir/provenance.json`.
