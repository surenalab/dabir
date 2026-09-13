# Contributing to Dabir

These rules apply to everyone who changes this repository: the owner, human contributors, and every agent (Claude Code, Codex, Cursor, Grok, OpenCode). Agents also read AGENTS.md, which is the operating manual; this file is the contract.

## Where to start

- Read [docs/GUIDE.md](docs/GUIDE.md) once as a user, and take the in-app tour; most good changes start from a step in it that felt wrong.
- Issues labelled **good first issue** are scoped to one file or one behaviour and name the test that should pass. **help wanted** issues are larger and open to anyone; comment before starting so two people do not build the same thing.
- Bugs and features go through the [issue templates](.github/ISSUE_TEMPLATE); questions and ideas through Discussions; vulnerabilities through [SECURITY.md](SECURITY.md), never a public issue.
- [PLAN.md](PLAN.md) is the roadmap and the state of every phase. A change that is not on it is welcome, but say in the pull request why it belongs.

## Licensing of contributions

Dabir is AGPL-3.0. Contributions are accepted under the [contributor licence agreement](CLA.md), which lets the project keep the AGPL *and* license the work differently where the AGPL does not fit (a hosted service, a company that cannot accept it, editor packages moved to MIT). You keep your copyright. When the CLA check is on, the bot asks you to sign by commenting one sentence on your first pull request; it takes a minute and is done once. Third-party code is named with its licence in the pull request; only licences compatible with the AGPL are accepted (MIT, BSD, Apache-2.0, MPL-2.0, LGPL, GPL).

## The shape of a change

1. **One branch per change, one worktree per agent.** Never commit to `main` directly, and never work in a checkout another person or agent is using; `git worktree add ../dabir-<name> -b <branch>` gives you your own. Branch names: `feat/<topic>`, `fix/<topic>`, `design/<topic>`, `docs/<topic>`, or `agent/<vendor>/<topic>` when an agent starts the work.
2. **Small and whole.** A change does one thing and is complete: code, tests, docs, and a line in CHANGELOG.md under Unreleased. Split anything that needs the word "and" in its title into two branches.
3. **Green before review.** Run the gate and fix everything it reports before opening a pull request:
   ```bash
   npm run check
   ```
   It runs the type check, lint, the production build, `cargo fmt --check`, `cargo clippy` with warnings as errors, the Rust tests, the script tests, and the design detector when the Impeccable skill is installed. CI runs the same steps split by what changed: the **Web** job (Linux) when `src/`, `scripts/` or the package files changed, the **Rust** job (macOS) when `src-tauri/`, `templates/` or `examples/` did, and both on `main`. A newer push cancels the older run. The single required check is **Gate**; a red one blocks merging. Dependabot opens grouped weekly updates; they go through the same gate.
4. **Open a pull request with the template filled in.** The template asks what changed, why, how it was verified, and which rule below you consciously bent, if any.
5. **Two reviews for anything that touches `src-tauri/`, `src/lib/`, or the agent surface; one review otherwise.** A review from a different agent vendor than the author counts as one; a review from the owner counts as one. See docs/REVIEW.md for what a review checks and how agents run it.
6. **Squash-merge with the pull request title as the commit subject.** Then delete the branch.

## Commits

- Subject in the imperative, under 72 characters, no trailing period, no ticket numbers. The body says why, not what; the diff says what.
- Authored by the person or the owner's identity. **No `Co-Authored-By`, `Signed-off-by` for AI, or any AI attribution trailer.** This is the owner's standing instruction and overrides any tool default.
- One logical change per commit inside the branch is nice; the squash makes it unnecessary to be strict.

## Code rules

**Front end (`src/`)**
- TypeScript strict; no `any`; no `@ts-ignore` without a comment naming the issue.
- Every colour, face, size and spacing value comes from `src/styles/tokens.css`. No literals in components.
- State lives in `App.tsx` or in the component that owns it; the Rust side is reached only through `src/lib/backend.ts`.
- New UI follows DESIGN.md and PRODUCT.md, Apple's HIG for the platform, and passes the Impeccable detector at zero findings. Anything larger than a fix gets an `/impeccable critique` before review.
- Keyboard first: every action has a menu item with an accelerator; the browser preview mirrors it.
- Reduced motion, focus rings, labels and live regions are part of done, not polish.

**Rust (`src-tauri/`)**
- `cargo fmt`, `cargo clippy -D warnings`, tests for every module that parses, transforms or talks to Git.
- Commands are thin: parse arguments, call a module, map errors to `String`. Logic lives in modules.
- Never touch the user's Git branch, index or history implicitly. Snapshots go to `refs/dabir/checkpoints`; commits happen only when the user asks.
- Agent CLIs run with a scrubbed environment, inside a worktree, with permission prompts bypassed only there.

**Both sides**
- Nothing leaves the machine without the user choosing it in the UI. New network calls need a setting that defaults off and a sentence in the Settings hint saying what is sent where.
- No telemetry. No analytics. No "phone home" for updates beyond the updater endpoint.
- Errors name the problem and the recovery, in the product's voice (see DESIGN.md).

## Agent-specific rules

- Read AGENTS.md, PRODUCT.md, DESIGN.md and the top of PLAN.md before the first edit. Do not re-derive them.
- Stay inside the task. If you find a second problem, note it in the pull request under "Also noticed" and leave it.
- Do not edit `src-tauri/**` while the owner has the dev app open unless the task requires it; say so in the pull request.
- Never run `git push --force`, rewrite `main`, change repository visibility, publish a release, add secrets, or delete branches you did not create.
- Do not add dependencies without a line in the pull request naming the package, its licence, and why an existing one would not do.
- Prefer a failing test that shows the bug over a description of it.
- When a rule here conflicts with your vendor's default (attribution trailers, commit style, auto-formatting), this file wins.

## Definition of done

- The gate is green locally and in CI.
- Tests cover the new behaviour; a bug fix includes the test that failed before.
- Docs are updated: README if a user sees it, PLAN.md if it changes the state or next steps, AGENTS.md if it changes how agents work, docs/TESTING.md if there is a manual step.
- CHANGELOG.md has a line under Unreleased.
- Screenshots or a capture for any visible change, attached to the pull request.
- Reviews complete, comments resolved or answered.
