# Dabir

## What it is
A native, local-first desktop app for writing scientific papers in LaTeX (Typst later), with the experiment code, Git history and AI agents in the same window.

## Who it is for
Researchers who write papers with code behind the figures: ML, imaging, physics, computational biology. They already use Overleaf with coauthors and a coding agent in a terminal, and they resent the seam between the two.

## The job
Open a paper repo, write and edit it like a document, compile it, and ask an agent to change both the experiment and the manuscript in one reviewed diff. Keep coauthors in the loop through Git and, later, live sessions.

## What it is not
Not a chat app with a LaTeX viewer. Not a hosted service. Not a replacement for the coauthor's Overleaf account on day one; it imports and syncs instead.

## Platforms
macOS first (Tauri 2, system WebView), then Windows and Linux with the same structure and platform-appropriate chrome.

## Mode
Operate. The visitor completes a task: write, compile, review, commit. Scanability, consistency and native expectations outrank expression. Brand lives in precise details: the paper-and-ink palette, the serif document view, one proofreader's-red accent.

## Constraints
- Every colour, face and spacing value comes from `src/styles/tokens.css`.
- Chrome uses the platform UI face. The document uses a serif that resembles the compiled paper.
- One accent (proofreader's red). Semantic green and amber only for status.
- No side-tab borders, no gradients, no glass as decoration, no emoji as icons. Icons are Lucide, one stroke weight.
- Motion only where it explains state. Respect reduced motion.
- Reading measure stays near 65 characters in the document view.
