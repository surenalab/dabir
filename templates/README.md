# Templates

Starter papers for File › New Paper…. `index.json` is the registry the chooser reads: groups, and for
each template its venue, engine, whether it is the venue's official kit, where it comes from, which
file is the sample, and the small adjustments Dabir makes so the kit compiles under the bundled
engine (each with its reason, shown in the chooser).

Three kinds of source:

- **bundled** — a folder here, copied whole. Starters Dabir wrote on classes the engine fetches from
  CTAN (IEEEtran, acmart in sigconf and acmtog for SIGGRAPH, elsarticle, amsart, revtex4-2, llncs,
  jmlr, oup-authoring-template for Bioinformatics and the other OUP journals, article), and the
  Typst Universe scaffolds below.
- **zip** — the venue's own author kit, fetched from its server on first use and cached under the
  app's data folder keyed by id and version (NeurIPS, ICML, ICLR, TMLR, CVPR, ICCV, ECCV, Springer
  Nature, Nature Portfolio, BMC, PLOS, Frontiers).
- **files** — a list of files from one base URL, for venues that publish them loose (SIAM, ACL).

After copying, Dabir drops documentation PDFs, flattens a `bst/` folder, renames the sample to
`main.tex`, transcodes Latin-1 text to UTF-8, and applies the registry's patches (`find`/`replace`,
first occurrence unless `"all": true`, or `prepend`). A patch that no longer matches fails the
creation with a message rather than producing a broken paper; that is the signal to refresh the
entry when a venue changes its kit.

Some venues have no kit Dabir can fetch: PNAS, eLife and Science publish theirs only inside Overleaf
or behind a bot wall, MDPI likewise. Those are left out rather than mirrored from a third party.

Every kit is fetched and compiled end to end by `cargo test -- --ignored kits_fetch` (network) and
the bundled starters by hand with the bundled Tectonic; all compiled on 2026-09-11.

Typst scaffolds come from `typst init` on Typst Universe packages, all MIT (or MIT-0) licensed:
charged-ieee 0.1.4, bloated-neurips 0.8.0, lucky-icml 0.7.0, clean-math-paper 0.2.8, arkheion 0.1.2.
The packages themselves are fetched by the Typst compiler on first compile.
