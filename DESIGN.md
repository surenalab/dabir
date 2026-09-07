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
| `--ink` / `-2` / `-3` / `-4` | #1d1f24 → #9a9ca4 | #ebe9e2 → #6a6c74 | Text hierarchy; ink-3 is the floor for body-size text |
| `--accent` | #a8322d | #e06a63 | Proofreader's red: primary action, current selection, citations, deletions |
| `--ok` / `--warn` | #2f6b3a / #8a6414 | #7dc48a / #d9b35a | Status only, never decoration |

## Type
- **Chrome:** platform UI face (SF Pro on macOS) at 11, 12, 13, 15 px.
- **Document:** STIX Two Text, 16.5 px / 1.6, 68ch measure, justified with hyphenation. Headings 600 weight, section numbers in ink-3.
- **Code, logs, diffs:** IBM Plex Mono 12–13 px with a real italic. Tabular numerals wherever digits align.

## Layout
Three-pane macOS document window: navigator (232 px), document, inspector (348 px). Unified title bar with traffic lights overlaid, leading pane toggles, centred document title and path, trailing view switch, Compile, Share and inspector toggle. Panes collapse with a 220 ms ease-out. Status bar is sticky at the bottom of the document.

## Components
- **Segmented control** for Visual / Source.
- **Tree rows** 26 px, current row in accent wash.
- **Citation chips** in accent wash inside the document; cross-reference chips in paper-2.
- **Composer** is a raised card with a round accent send button.
- **Diff** is a bordered card with add/del washes; per-hunk accept comes in phase 2.
- **Buttons:** `.btn` bordered on raised; `.btn.primary` filled accent; toolbar buttons are borderless per HIG.

## Motion
Pane collapse, spinner on a running step, smooth scroll on outline jump. Nothing else. `prefers-reduced-motion` disables all three.

## Do not
Side-tab borders, gradients, glass as decoration, emoji icons, section-number eyebrows, hero metrics, nested cards.
