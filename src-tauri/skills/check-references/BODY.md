Two halves: the manuscript's internal consistency, and whether each bibliography entry describes a real work accurately. Both matter. An entry that compiles can still be invented, misattributed, or carry the wrong DOI, and reviewers check.

## 1. Inside the manuscript

1. Every `\cite{key}` (also `\citep`, `\citet`, `\autocite`, `\parencite`; `@key` in Typst) must exist in the `.bib` files; every `\ref`, `\eqref`, `\autoref`, `\cref` must have a `\label`. List the misses with file and line.
2. After a compile, look for `??`, `[?]` and `Citation ... undefined` in `.dabir/build/*.log`.
3. Entries nothing cites may stay; say how many there are.

## 2. Online verification

Run the bundled script. It needs only Python 3 and network access; pass every `.bib` the paper uses:

    python3 .dabir/skills/check-references/scripts/verify_refs.py refs.bib

Options: `--json` for machine-readable output, `--only key1,key2` to recheck a few entries, `--offline` to parse without the network. Exit status 1 means at least one `mismatch` or `not found`.

The script looks each entry up by its DOI (Crossref, then doi.org content negotiation for DataCite and others), else by its arXiv id (the arXiv API), else by title search (Crossref, then OpenAlex). Verdicts:

- `verified`: a record with the same title (90% or closer after stripping TeX) was found. The line shows the canonical DOI and every field that differs: year, venue, volume, number, pages, authors missing from the record, or a DOI the entry lacks.
- `mismatch`: the entry's DOI or arXiv id resolves to a different work, or does not resolve at all. Either the identifier or the title is wrong. Serious.
- `not found`: no index has a work with this title; the closest candidate is shown when one is at least 75% similar. Possibly an invented reference, a renamed paper, or a workshop paper the indexes skipped.
- `unchecked`: nothing to look up (no title, DOI or arXiv id), a thesis or report the indexes rarely hold, a URL-only entry, or a network failure for that entry.

What to do with the report:

1. `mismatch` and `not found` go at the top of your final message, one line each: what the entry claims and what was found. Never delete, replace or rewrite these entries on your own; the author decides. Do not invent a replacement.
2. For `verified` entries with differing fields, fix the `.bib` from the record: year, journal or booktitle, volume, number, pages, DOI. Keep the citation key unchanged so every `\cite` still resolves. When an arXiv entry has a published version, say so and switch to it only if the paper cites published versions elsewhere.
3. Add `doi = {...}` where the record supplies one and the entry lacks it.
4. Authors: compare surnames only. The record's list wins when the entry's is truncated or misspelled; keep `and others` when the venue wants et al.
5. A one-year difference is usually online-first versus print; note it, and follow the venue's convention.

To fetch a clean record when rewriting an entry by hand:

    curl -sL -H "Accept: application/x-bibtex" https://doi.org/10.1000/xyz123
    curl -sL https://arxiv.org/bibtex/2301.00001

Endpoints the script uses, should you need to look further: `https://api.crossref.org/works/<doi>`, `https://api.crossref.org/works?query.bibliographic=<title>&rows=3`, `https://export.arxiv.org/api/query?id_list=<id>`, `https://api.openalex.org/works?search=<title>`. All are free and need no key; the script paces itself, do the same.

## 3. Report

Finish with the counts (verified, mismatch, not found, unchecked), the problem list, the fields you changed per key, and the internal misses from part 1. Normalise obvious BibTeX problems (missing year, journal capitalisation in braces) only when the source is unambiguous.
