# Dabir agent benchmark

Thirty-one LaTeX repair and revision tasks, one deliberately vague. Tasks 01–21 run on a fresh copy of `examples/score-anchor` (a 52-line single-file paper); tasks 22–31 run on `examples/anchor-journal`, a journal-length version of the same paper split over `main.tex`, `macros.tex`, eight section files, two appendices, six tables and a 62-entry bibliography, where finding the right file is part of the job. The runner reuses the same worktree + vendor CLI path as the app and sends the same prompt the app sends (the preamble with the brief, paper map, editor position, file map and context pack in front of the request), so it measures the prompt too.

`DABIR_BENCH_VERBOSE=1` prints every tool call and reply with its time. Each result records the number of tool calls and sorts them by what they did: `orient` (listing, searching, opening the brief or memory: the calls the preamble exists to remove), `read`, `edit`, `compile`, `run`. `DABIR_BENCH_BARE=1` leaves the paper map, the editor position and the memory blocks out of the preamble, to measure what they buy. `DABIR_BENCH_TASK` takes an id or a substring (`mf` runs the multi-file family).

## Run

One provider, all tasks (writes `bench/results/<provider>.json`):

```bash
cd src-tauri
env -u ANTHROPIC_BASE_URL DABIR_LIVE_PROVIDER=claude CARGO_TARGET_DIR=target/test \
  cargo test agent_bench -- --ignored --nocapture
```

One task (writes `bench/results/<provider>-<task>.json`, leaving the suite's file alone):

```bash
DABIR_BENCH_TASK=01-strong-baselines DABIR_LIVE_PROVIDER=codex \
  cargo test agent_bench -- --ignored --nocapture
```

Or from the repo root:

```bash
./bench/run.sh claude
./bench/run.sh codex 07-unclosed-equation
```

Pass rates per vendor are the artifact that matters; publish them with a release note when the numbers stabilize.

Running several providers at once is fine (each task works in its own temp copy), but build the test binary once first (`cargo test --no-run`) and start the runs from that binary, or the second `cargo test` will wait on the build lock and may rewrite the binary under the first.

## Results, 2026-10-05: dabir-check instead of compiling

Agents were told to compile before finishing; now they run `dabir-check` (a few milliseconds: braces, environments, refs, cite keys, missing files) after a structural LaTeX change, skip it after wording, and compile only for build requests, while the app compiles their version when the run ends. Grok 1.0.41 and Claude Code 2.1.267, full suite, one run before (main at 0.2.2) and two after (v1 checked after every edit; v2, shipped, only after structural edits). `check` is a new tool-call kind.

| Run | Passed | Median per task | Mean, the 10 tasks that compiled before | Compiles in the suite | Checks |
|---|---|---|---|---|---|
| Grok, before | 30/31 | 20.7 s | 28.3 s | 10 | 0 |
| Grok, after v1 (check after every edit) | 30/31 | 17.2 s | 24.7 s | 2 | 29 |
| Grok, after v2 (check after structural edits) | 31/31 | 19.4 s | 24.7 s | 4 | 13 |
| Claude Code, before (2026-10-06) | 31/31 | 17.6 s | | 12 | 0 |
| Claude Code, after, with the stable preamble as a cached system prompt | 31/31 | 15.3 s | | 3 | 4 |

Claude Code also made fewer calls per task (2.90 → 2.32) and fewer orientation calls in the suite (22 → 7); 19 of 31 tasks were faster, and the time to the first tool call did not change (median 6.3 s → 6.5 s). Its means are not comparable: two tasks in the after run waited 124 s and 162 s for the model's first word and then finished in under 20 s, as one task in the before run waited 88 s.

Where the compile was most of the work the time halves (10-broken-ref 24 s → 12 s, 24-mf-broken-cref 34 s → 18–20 s); the vague task, which timed out before, passes. Elsewhere the paired median difference is under a second either way: v1's check after a wording edit cost an extra model turn, which is why v2 skips it. Means are not a fair summary of a single run: each run had one to three 100 s+ tasks from the model's response time (19-stale-claim-note took 39 s, 51 s and 159 s with no check in it). 

## Results, 2026-09-12, evening: files by role and deny rules

The preamble's file list is grouped by role (manuscript with main first, bibliography, generated artefacts with their command, code, figures, data, other), and Claude and Grok runs carry a deny list for the tools the prompt makes redundant (`git log/status/diff/show/branch/stash/checkout/reset`, `tree`; Claude `--disallowedTools`, Grok `--deny`). Full suites, one CLI at a time:

| CLI | Passed | Single file (01–21) | Multi-file (22–31) | Vague task | Orientation calls (suite) |
|---|---|---|---|---|---|
| Claude Code | 31/31 | 14.5 s, 2.8 calls (20 tasks; see below for 11) | 19.3 s, 2.6 calls | 38 s, 3 calls | 16 |
| Grok | 31/31 | 20.6 s, 2.7 calls | 21.1 s, 2.9 calls | 112 s, 7 calls | 3 |

Grok made no orientation call at all on the multi-file paper and three in the whole suite; its `--deny` was checked live before the run (a denied `git log` comes back refused and the agent goes on without it). Claude's orientation calls are `git diff --stat` after an edit and the odd `ls`; the deny list turned its `git checkout` attempts into `git restore`, which is not on the list, so the list is a nudge rather than a wall.

Task 11 (append two words to the caption of `tables/psnr-sweep.tex`, a file the sweep script writes) exposed two things. The role map said "generated (rerun the command, never edit)", and the sample's script seeded its toy numbers with Python's salted string hash, so every rerun changed the table; Claude reran, saw the numbers move, reverted, and spent 150 s on a script that searched for a seed reproducing the committed table before editing the caption (230 s, 11 calls; it passed). Two fixes: the sweep seeds with a CRC of the key and its outputs are regenerated from it, and the map and the artefact heading now say what to do ("change the code that writes it and rerun; hand-edit only when asked") rather than only what not to. On rerun Claude edits the caption string in `code/sweep.py`, reruns the sweep, and confirms the table: 44 s, 8 calls. Grok edited the caption where the request pointed.

## Results, 2026-09-12, paper map and editor position in the preamble

The preamble now carries a paper map (every section, label, figure, table, equation and macro with its file and line, built by following `\input`), the author's editor position and selection when the request comes from the app, the decisions on record and the artefact commands, and a context pack that chunks along paragraphs and floats, drops LaTeX command names from its tokens and labels each hit with its section. Claude Code, full suite:

| Tasks | Passed | Mean per task | Tool calls per task | Orientation calls (suite) |
|---|---|---|---|---|
| 01–21 single file, before (2026-09-10) | 21/21 | 16 s | 3.0 | not measured |
| 01–21 single file, now | 21/21 | 14.7 s | 2.8 | 8 |
| 22–31 multi-file, `DABIR_BENCH_BARE=1` | 9/10 | 16.7 s | 2.8 | 5 |
| 22–31 multi-file, full preamble | 10/10 | 21.1 s (this run; 16 s in the earlier one) | 2.6 | 4 |

Grok and Cursor on the same day, full suite: Grok 31/31 (single-file mean 15 s, 2.4 calls, one orientation call in the whole suite; vague task 94 s and 11 calls, down from 128 s and 8 on 2026-09-10 in time though not in calls; multi-file mean 18.5 s, 3.0 calls); Cursor 31/31 (single-file mean 24 s, 2.3 calls, two orientation calls; vague 56 s; multi-file mean 21.6 s, 2.8 calls, no orientation call at all on the multi-file paper). Codex was not installed on the machine and is not in this run.

The vague task fell from 49 s to 37 s for Claude. On the multi-file paper the map turns "change a word in the kappa sweep caption" from read → edit → verify (3 calls) into a single edit at `sections/ablations.tex:10`; the bare preamble fails the one task that says "add a sentence here", because without the editor position "here" has no referent, and passes it with the position in the prompt. Claude in `-p` mode does everything through Bash, so the remaining reads are `sed -n` of the lines the map named rather than searches.

## Results, 2026-09-10, third run (preamble in the loop)

The vague task `21-add-a-figure-vague` (prompt: "add a figure") was added after a real run in the app took over six minutes and added nothing: the agent read Dabir's own CLAUDE.md and bench folder above the paper, ran `which tectonic`, and edited and reran code. With the raw request as prompt, Grok took 432 s and 36 tool calls and moved the existing figure instead of adding one. With the preamble (boundary, brief and file map inline, numbered procedure, tectonic on PATH) it took 138 s and 8 tool calls and added a TikZ schematic with a caption and a reference. Full suites with the preamble, three providers in parallel from one binary (Codex was at its usage limit and is not in this run):

| Provider | Passed | Mean per scripted task | Tool calls per task | Vague task | Suite |
|---|---|---|---|---|---|
| Claude Code | 21/21 | 16 s (35 s in the second run) | 3.0 | 49 s, 3 calls | 6.3 min |
| Grok | 21/21 | 20 s (24 s) | 2.5 | 128 s, 8 calls | 8.9 min |
| Cursor | 21/21 | 29 s (44 s) | 2.6 | 49 s, 4 calls | 10.6 min |

The mean per task fell for every provider with the brief and file map in the prompt, since the first turn no longer spends calls on orientation.

## Results, 2026-09-10, second run

After the run path changed (worktrees seeded from the working copy; Accept applies to the working tree with a plain `git apply`, three-way as a fallback), all four providers ran in parallel from one test binary. Every task passed on the first attempt; no reruns.

| Provider | Passed | Mean per task | Slowest | Suite |
|---|---|---|---|---|
| Grok | 20/20 | 24 s | 79 s (05-cite-add) | 7.9 min |
| Codex | 20/20 | 33 s | 41 s | 11.1 min |
| Claude Code | 20/20 | 35 s | 159 s (20-compile-and-fix-skill) | 11.6 min |
| Cursor | 20/20 | 44 s | 101 s | 14.6 min |

## Results, 2026-09-10, first run

| Provider | Passed | Mean per task | Notes |
|---|---|---|---|
| Grok | 20/20 | 20 s | |
| Claude Code | 19/20 | 34 s | 13 wrote `$A$` where the check wanted `A`; check loosened, passes on rerun |
| Cursor | 18/20 | 52 s | 13 as above; 11 reran the sweep and regenerated the figure PDF, and the apply step corrupted non-UTF-8 bytes in that diff (fixed: patches are now byte-exact; passes on rerun in 146 s) |
| Codex | 19/20 | 40 s | First attempt found the account at its usage limit and every task failed in 3 s; the CLI's error was swallowed as a bare failure (fixed: the message now reaches the transcript). Rerun after the window reset: 10 hung past the 180 s cap once and passed in 36 s on rerun |

With the two fixes above, every vendor passes every task on rerun; the cap of 180 s is generous for all of them (Grok 8–40 s, Codex 16–38 s, Claude and Cursor up to ~2 min on the compile-and-fix task).

## Task shape

Each `tasks/<id>.json`:

| Field | Meaning |
|---|---|
| `id` | Stable slug |
| `kind` | `revision`, `repair` or `vague` |
| `fixture` | Folder under `examples/` to copy (default `score-anchor`) |
| `focus` | Optional `{file, line, endLine?, selection?}`: the editor position the app would send |
| `prompt` | Exact agent request |
| `mutate` | Optional `{file, find, replace}` applied before the run (for repair) |
| `expect_files` | Paths that must appear in the worktree diff |
| `expect_contains` | Substrings that must appear in the named file after accept |
| `expect_absent` | Substrings that must not remain |
| `expect_count` | `{file, text, min}`: the substring must occur at least `min` times |
| `timeout_secs` | Cap (default 180) |

## Rules

- Tasks stay small: one concern, one or two files.
- Never ask the agent to invent numbers that are not in the paper; repair tasks break syntax or refs that compile would catch.
- The user's branch is never the fixture; each run uses a temp copy.
