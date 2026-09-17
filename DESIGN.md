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
| `--page` / `--page-ink` | #ffffff / #000000 | same | A document page (Word view, print): white paper and black type in both themes |
| `--hsl-*` | channels of raised, paper-2, ink, ink-3, line, accent | dark values | The same colours as bare HSL channels, for the Word engine's controls; never used elsewhere |
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
- **History rail** (`.rail`): one 2 px dash per step on a 7 px pitch down the left edge of the History pane, newest at the top, sticky as tall as the pane. Your saves ink-4 at 45 % width, agent steps accent at 65 %, system steps line-strong at 28 %; the dash under the pointer full width in ink, its neighbours 88 % in ink-3 and 75 %, the open step full width in accent. Growth is `transform: scaleX` from the left edge, never `width`. The card beside the pointer (`.rail-card`): raised, popover shadow, glyph + message in 600 clamped to two lines, time in ink-4, files in mono with +/−; it moves by transform and enters with a 4 px slide. A new step slides the column down by one pitch (Web Animations) and draws in from the left. The rail is one `slider`: ↑ ↓ Home End Enter. Along the bottom of the sidebar (`.rail.horizontal`, under the History button) the same rail lies on its side: 2 × 16 px dashes scaled by `scaleY` from the foot, oldest at the left, newest at the right edge, a hairline under them, the card opening above at the sidebar's width.
- **Effort control** (`.effort`): a pill in the composer's bar (bolt, `Model · Level` or *Select effort*, chevron) that opens a 264 px popover above it (below when the composer is near the top of the pane): bolt, the level in accent 13 px 600 with the model in ink-3 under it, a reset; a 26 px track in paper-2 with a 4 px dot per effort level, the travelled part in `--effort-fill` (accent at 55 % over paper-2) moving by `scaleX`, a 20 px knob in `--effort-knob` (white; warm white in dark) with an offset shadow moving by `translateX` and settling on the nearest dot with the ease-out; the CLI-default state draws the knob hollow and dashed at the middle with no fill. Under the track one line of cost in words; under a hairline, the models as chips (ink fill when chosen, dashed for *Type a model id…*). The track is one `slider`: ← → Home End, Backspace for the default; Escape closes. Motion: the bolt (`.bolt`, an outline with a filled copy clipped by `clip-path: inset` to the level) fills over `--dur-slow`; on open the knob and fill start at the left edge for one frame and travel to the level; a dot the fill reaches ripples once (`::after`, scale .4 → 1.6, fading); the knob scales to 1.15 with a deeper shadow while held; the level name enters from 6 px below; three meters (`.meter`, five 9 × 3 px segments, accent for depth and cost, ink-2 for speed) recolour segment by segment on a 35 ms stagger.
- **Live presence:** a coauthor's caret is a 2 px bar in their colour with their name above it (`.cm-peer-caret`); a selection is a wash (`.cm-peer-sel`). In Visual the caret snaps to the nearest visible glyph so it is not swallowed by a replace widget. Avatars of peers sit in the title bar trailing cluster, left of Share.
- **Word view** (`.word-view`): a .docx on its own pages, in place of Visual/Source/PDF. The engine's menu bar and formatting bar sit above the page on raised, its variables mapped to Dabir tokens (accent for the active state, wash for hover); pages stay `--page` white in the dark theme. The title bar trails a segmented Editing / Suggesting / Viewing and an **Export** pull-down (`.tb-menu`: 300 px, raised, each item a label and a one-line hint, the conversion under a hairline, the highlighted item in accent). The status bar reads *Word document*, *Suggesting as <name>* in warn when suggesting, words, *Page n of m*, and the zoom as −, a pop-up (fit width, whole page, 50–200 %) and +. Comment and change cards open in a column beside the page only where it fits; the engine's comments button opens it anywhere.
- **Buttons:** `.btn` bordered on raised; `.btn.primary` filled accent; toolbar buttons are borderless per HIG.

## Motion
Pane collapse, spinner on a running step or compile, smooth scroll on outline jump, the effort knob and fill settling on a level, the popover rising 6 px as it opens, the history column sliding down as a step lands and the card following the pointer. Nothing else. `prefers-reduced-motion` disables all of them and adds a text “(running)” marker so state is never colour- or motion-only.

## Do not
Side-tab borders, gradients, glass as decoration, emoji icons, section-number eyebrows, hero metrics, nested cards.

## Keyboard
Owned by the native menu bar; the browser preview mirrors it. ⌘O open, ⌘S save, ⌘B compile (Bold in the Word view), ⌥⌘N and ⌥⌘O new and open a Word document, ⇧⌘L log, ⌘1/2/3 views, ⌃⌘S sidebar, ⌥⌘I inspector, ⌘K ask the agent, ⌘↩ send, ⌘F find, ⌘/ shortcut sheet. Trees take ↑↓ and ←→; segmented controls take ←→.

## Visual editing layer
Classes prefixed `vz-` in `app.css` style the decoration layer: `vz-title`, `vz-section`, `vz-abstract`, `vz-preamble`, `vz-eq`, `vz-math`, `vz-chip` (cite in accent wash, ref in paper-2, input dashed), `vz-figure`. Hover on a widget shows a wash; click reveals its source. Preamble and tables stay in mono at 12 px so the reader always knows what is source.

## Review and memory
Provenance badges: fresh in ok green, stale in warn amber, missing in deletion red. Sample data carries the amber `sample` tag. Agent log lines fold into a details element; tool steps use a check, failures an X, running a spinner with a text fallback under reduced motion.

## Mark
`design/dabir-icon.svg` (app icon) and `design/dabir-logo.svg` (flat mark): the nastaʿlīq dāl, the first letter of دبیر, written as a reed pen writes it, heavy on the descent and fine where the stroke turns and lifts; beside it the calligrapher's rhombic nuqta in madder, the unit every letter is measured in and the one mark a coauthor leaves on a page. Colourway C, the lapis-and-gold of the illuminated manuscript: lajvard #22396B as the ground, paper for the letter, saffron #E0A62E for the nuqta. The flat mark puts the lajvard letter and saffron dot on paper. These two pigments exist as `--lajvard` and `--saffron` tokens for identity moments only; the UI accent stays madder. No letters beyond the one that is the name. The app icon sits on the macOS grid (824 px squircle, standard margin) with a lit top edge. It reads at 16 px because it is one stroke and one dot. Rejected on the way: the line-and-caret (too close to arXiv's mark), the Simorgh (a bird on a stick at small sizes), the qalam (a generic pencil), the boteh and eslimi (ornament, not writing). The letter's knee is on the right and its tail runs left along the baseline, as د is written.
