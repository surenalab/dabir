// Lint for the front end. Kept small: the type checker does the heavy lifting; this catches the
// mistakes it cannot (unused values, hook rules, accidental globals).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "relay/dist/**", "node_modules/**", "docs/**", "examples/**", "**/.dabir/**", "templates/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // TypeScript owns undefined-name checking in .ts/.tsx files.
      "no-undef": "off",
      // The React Compiler rules are advisory here until the code is migrated; they warn, they do not block.
      "react-hooks/refs": "warn", "react-hooks/set-state-in-effect": "warn", "react-hooks/purity": "warn", "react-hooks/immutability": "warn", "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }], // error once the in-flight track-changes branch lands
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  { files: ["relay/**/*.mjs", "scripts/**/*.mjs"], languageOptions: { globals: { ...globals.node } } },
  { files: ["relay/signaling-worker.js"], languageOptions: { globals: { ...globals.serviceworker, WebSocketPair: "readonly", Response: "readonly", Request: "readonly" } }, rules: { "@typescript-eslint/no-unused-vars": "off" } },
);
