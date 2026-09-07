# Working on Dabir

Read PRODUCT.md and DESIGN.md before touching UI. Tokens live in src/styles/tokens.css; never hard-code a colour, face or spacing value in a component.

- Front end: React 19 + TypeScript in src/. Rust core in src-tauri/src/lib.rs. Commands are the only bridge.
- Run: `npm run tauri dev`. Browser-only preview: `npm run dev` (uses src/lib/sample.ts).
- Check before commit: `npx tsc --noEmit && npx vite build && (cd src-tauri && cargo check)`.
- UI changes: run `/impeccable critique` on the screen and consult .agents/skills/apple-design-skill for the matching HIG article.
- A paper project's own memory format is documented in examples/isgd-tci/.dabir/.
