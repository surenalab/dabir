# Dabir design system

Derived from `src/styles/tokens.css` and `src/styles/app.css`. Change the tokens, not the components.

## World
A manuscript editor for researchers. Paper, ink, proof marks, journal typography. Quiet, dense, precise: Pages meets Xcode with the calm of a printed page.

## Colour
| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | #fbfaf7 | #1a1b1e | Document ground |
| `--paper-2` | #f3f1ec | #202125 | Navigator, inspector, quiet fills |
| `--raised` | #ffffff | #26272c | Composer, diff, popovers |
| `--line` | #ddd9d0 | #34363c | Hairlines |
| `--ink` / `-2` / `-3` / `-4` | #1d1f24 → #7a7c84 | #ebe9e2 → #8a8c94 | Text hierarchy; every step meets 4.5:1 on its ground |
| `--accent` | #a8322d | #e06a63 | Proofreader's red: primary action, current selection, citations |
| `--diff-del` | #c8102e | #ff6b6b | Deleted lines and Reject. Never the accent |
| `--focus` | system focus ring | system focus ring | Keyboard focus, 3 px, never the accent |
| `--ok` / `--warn` | #2f6b3a / #8a6414 | #7dc48a / #d9b35a | Status only, never decoration |

## Type
- **Chrome:** platform UI face (SF Pro on macOS) at 11, 12, 13, 15 px.
- **Document:** STIX Two Text, 16.5 px / 1.6, 68ch measure, justified with hyphenation. Headings 600 weight, section numbers in ink-3.
- **Code, logs, diffs:** IBM Plex Mono 12–13 px with a real italic. Tabular numerals wherever digits align.

## Layout
Three-pane macOS document window: navigator (232 px, 180–340), document, inspector (380 px, 280–480). Dividers drag; the inspector auto-hides under 1100 px. Unified title bar with traffic lights overlaid, sidebar toggle leading, true-centred document title and path, trailing segmented view switch, borderless Compile, a fixed spacer, Share and the inspector toggle. Sidebar and inspector are transparent over macOS vibrancy. Window inactive state greys the selection and primary button. Status bar sits at the bottom of the document with a live region.

## Components
- **Segmented control** for Visual / Source / PDF and for inspector panes; radio semantics, arrow keys.
- **Tree rows** 26 px, current row in accent wash.
- **Citation chips** in accent wash inside the document; cross-reference chips in paper-2.
- **Composer** is a raised card with a round accent send button.
- **Diff** is a bordered card with add/del washes and wrapped lines with a hanging indent; per-hunk accept comes in phase 2.
- **Review** shows evidence first (figure card, table diff, text diff), then a commit message, then Accept and Commit, Reject, Open Pull Request…. Actions stay disabled until the run is terminal.
- **Sample tag**: an amber outline chip marks any data that is not yet real.
- **Buttons:** `.btn` bordered on raised; `.btn.primary` filled accent; toolbar buttons are borderless per HIG.

## Motion
Pane collapse, spinner on a running step or compile, smooth scroll on outline jump. Nothing else. `prefers-reduced-motion` disables all three and adds a text “(running)” marker so state is never colour- or motion-only.

## Do not
Side-tab borders, gradients, glass as decoration, emoji icons, section-number eyebrows, hero metrics, nested cards.

## Keyboard
Owned by the native menu bar; the browser preview mirrors it. ⌘O open, ⌘S save, ⌘B compile, ⇧⌘L log, ⌘1/2/3 views, ⌃⌘S sidebar, ⌥⌘I inspector, ⌘K ask the agent, ⌘↩ send, ⌘F find, ⌘/ shortcut sheet. Trees take ↑↓ and ←→; segmented controls take ←→.

## Visual editing layer
Classes prefixed `vz-` in `app.css` style the decoration layer: `vz-title`, `vz-section`, `vz-abstract`, `vz-preamble`, `vz-eq`, `vz-math`, `vz-chip` (cite in accent wash, ref in paper-2, input dashed), `vz-figure`. Hover on a widget shows a wash; click reveals its source. Preamble and tables stay in mono at 12 px so the reader always knows what is source.

## Review and memory
Provenance badges: fresh in ok green, stale in warn amber, missing in deletion red. Sample data carries the amber `sample` tag. Agent log lines fold into a details element; tool steps use a check, failures an X, running a spinner with a text fallback under reduced motion.

## Mark
`design/dabir-logo.svg`: a line of manuscript in ink and, beneath it, the proofreader's caret in madder, the oldest editing mark there is and the one thing a coauthor does to a page. Two flat colours (#1D1F24, #A8322D) on paper (#FBFAF7), no gradients, no letters, drawn on a 24-unit grid inside the macOS rounded-square silhouette. It reads at 16 px because it is two shapes. Principles: one metaphor, two colours, geometry over illustration. The other candidates are kept in `design/` for the record; the caret came from a Grok concept and was redrawn to the grid.
