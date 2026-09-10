/// <reference types="vite/client" />

/** Commit and day of this build, set in vite.config.ts. */
declare const __DABIR_BUILD__: string;

// nspell ships no types; this is the part Dabir uses.
declare module "nspell" {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string, model?: string): NSpell;
  }
  function nspell(aff: string | Uint8Array, dic?: string | Uint8Array): NSpell;
  export default nspell;
}
