# Security

Dabir runs on your machine and keeps your paper there. Anything that makes it send text somewhere it did not say, run a command it was not asked to, or read outside the paper's folder is a security bug.

**Report privately** through [GitHub's advisory form](https://github.com/surenalab/dabir/security/advisories/new). Do not open a public issue. Include the version, the platform, the steps, and what an attacker could do with it. You will hear back within seven days, and the fix ships in the next release with credit to you unless you prefer none.

Things worth knowing when looking:

- Agents run inside a Git worktree with a scrubbed environment; the permission prompts of their CLIs are bypassed only there. Escaping the worktree, or reaching the user's checkout while a run is live, is in scope.
- Live sessions are peer to peer over WebRTC; the optional signalling worker never sees document text. Anything a peer can do to another peer's files beyond the shared paper is in scope.
- The updater verifies releases against the public key in `src-tauri/tauri.conf.json`.
- Language servers, formatters and run recipes execute tools found on the user's PATH, in the paper's folder.

Supported: the latest release. Older versions are not patched.
