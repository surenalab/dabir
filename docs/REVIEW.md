# Code review: the pipeline and the rubric

Every change to Dabir is reviewed before it merges. Reviews are done by people and by agents; the pipeline below makes both produce the same kind of result, so a review from Codex on a Claude change is as usable as the reverse.

## Pipeline

```
branch  ->  npm run check (local gate)  ->  pull request  ->  CI gate  ->  review 1 (+ review 2)  ->  squash-merge
```

1. **Local gate.** `npm run check` must pass before a pull request is opened. It is the same as CI, so a red CI means the author skipped it.
2. **Pull request.** The template (`.github/PULL_REQUEST_TEMPLATE.md`) is filled in completely. A pull request without a "How I verified it" section is sent back without review.
3. **CI gate.** `.github/workflows/ci.yml` runs type check, lint, build, fmt, clippy, Rust tests. It must be green before anyone spends time reviewing.
4. **Review.** One reviewer for docs, tests, and front-end refinements; two for anything under `src-tauri/`, `src/lib/`, the agent panel, or the collaboration layer. When agents review, the second reviewer must be a different vendor than the author (Claude reviews Codex, Codex reviews Claude, and so on). Reviews follow the rubric below and end with one of three verdicts.
5. **Merge.** Squash, pull request title as subject, branch deleted, CHANGELOG line present.

## The review bot: `npm run review`

`scripts/review.mjs` is Dabir's own codebase-aware reviewer, the open alternative to hosted services such as Greptile. It runs on the coding-agent subscriptions already on the machine instead of a hosted review service; the diff and the changed files go to the model vendor of the provider you choose, and nowhere else. Do not run it on a repository whose contents may not leave the machine.

```bash
npm run review                          # this branch against main, with Claude Code
npm run review -- --provider codex      # second opinion from another vendor (also cursor, grok)
npm run review -- --pr 12 --post        # review pull request 12 and post it as a PR review through gh
```

It gives the reviewer this rubric and CONTRIBUTING.md, the diff, the full text of every changed file, and every place in the repository that uses a symbol the change touched, then lets Claude Code or Codex read any other file read-only. The answer is strict JSON, rendered to Markdown with findings ordered by severity; the exit code is 3 whenever a blocking finding exists, whatever the verdict says, so it can gate a merge. A pull request is fetched into `refs/dabir/review/pr-N`; your branch and working tree are never moved. In CI the same review runs through `.github/workflows/agent-review.yml` once the owner stores a Claude Code OAuth token as a secret.

## How an agent runs a review by hand

Claude Code: `/code-review` on the branch, then the rubric pass below. Codex: `codex review --base main` (or the equivalent in your version) followed by the rubric pass. Cursor and Grok: check out the branch and work the rubric directly. Post the result as a pull request review, not as a comment, so it counts.

Write the review as findings, most severe first, each with a file and line, a one-sentence claim, and a concrete failure scenario ("with an empty `.bib`, `citeLabel` throws"). Do not restate the diff. Do not praise. Finish with the verdict.

## Verdicts

- **Approve.** Nothing blocking; nits are marked "nit:" and the author may merge without another round.
- **Request changes.** At least one blocking finding: a correctness bug, a broken rule from CONTRIBUTING.md, missing tests for new logic, a design-rule violation, or a privacy regression.
- **Comment.** You could not verify something and need an answer before deciding. Say exactly what you need.

## Rubric

Work through every section. Skipping one silently is the most common review failure.

**1. Correctness**
- Does the change do what the pull request says, and only that?
- Edge cases: empty input, missing file, non-Git folder, nested repository (the sample lives inside this repo), Windows paths, a file that is open in the editor while the agent changes it.
- Concurrency: autosave, snapshots, live sessions and agent runs can all write; is any write racing another?
- Error paths: every `Result` handled, every `catch` doing something a user can see.

**2. Tests**
- New logic has tests in the same change. Parsers, Git operations, diff filtering and memory code are not accepted without them.
- A bug fix carries the test that reproduces the bug.
- Tests run in `CARGO_TARGET_DIR=target/test` and do not depend on the dev app, the network, or a signed-in CLI (the live agent test is `#[ignore]` for that reason).

**3. Design and interface**
- Tokens only; no literal colours, sizes or faces. Check `app.css` additions against `tokens.css`.
- HIG: platform menu item with accelerator for any new action; segmented controls, sheets and popovers used as the platform does.
- Impeccable detector at zero findings; no side-tab borders, gradients as decoration, glows, eyebrows, or cards as structure.
- Reduced motion, focus visibility, labels for icon-only controls, live region for status.
- Copy in the product's voice: names the action, names the recovery, no exclamation marks.

**4. Privacy and safety**
- Nothing new leaves the machine without an explicit user choice and a default-off setting.
- Agent runs stay inside the worktree; no command gains access to the user's checkout without going through accept or apply.
- No secrets, tokens or paths of the owner's machine in code, tests, fixtures or docs.
- Git: no implicit commits, no branch moves, no index changes outside the user's own commit action and the checkpoint ref.

**5. Performance**
- Editor extensions: no work on every keystroke that scans the whole document without a debounce or a cache (see `predict.ts` for the pattern).
- Rust: no blocking of the Tauri main thread; long work is spawned and reports through events.
- Bundle: a new dependency justified in the pull request; the production build size compared before and after when a library is added.

**6. Documentation and state**
- README for user-visible behaviour; PLAN.md state and next steps; AGENTS.md for harness changes; TESTING.md for manual steps; CHANGELOG.md line.
- Comments explain why, at the top of a module or a non-obvious block, in full sentences.

**7. Process**
- Branch named per CONTRIBUTING.md; no attribution trailers; no unrelated files; lockfiles updated when dependencies change; screenshots attached for visible changes.

## When the reviewer is wrong

Authors may push back once with evidence (a test, a measurement, a screenshot). A second disagreement goes to the owner, who decides. Do not merge over an unresolved "Request changes".

## Automated review in CI

`.github/workflows/agent-review.yml` runs Claude Code on every pull request with this rubric, on the owner's subscription: run `claude setup-token` once, store the token as the repository secret `CLAUDE_CODE_OAUTH_TOKEN`, set the repository variable `AGENT_REVIEW` to `on`. Codex reviews on GitHub are available by connecting the repository in the Codex web app under the ChatGPT subscription; that gives the second vendor without any key.
