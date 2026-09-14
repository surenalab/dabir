# Working on Dabir

Read AGENTS.md first: it is the operating manual for every agent here (Claude Code, Codex, Cursor, Grok, OpenCode) and the only copy of these rules, so it does not drift from this file. CONTRIBUTING.md is the contract; PRODUCT.md and DESIGN.md come before any UI change.

The three rules most often broken, repeated here so they are not missed:

- Commits are authored by the owner. No `Co-Authored-By` or any AI attribution trailer.
- `npm run check` green before a pull request; one line in CHANGELOG.md under Unreleased.
- Work in your own worktree on your own branch; never in a checkout someone else is using, never on `main`.
