# Third-party notices

Dabir is licensed under the AGPL-3.0 (see LICENSE). It bundles or depends on the following works, each under its own licence, all compatible with the AGPL. Their copyright and licence texts are preserved in the packages themselves under `node_modules/` and `~/.cargo/registry/`, and travel with the built application.

## Bundled programs and assets

- **Tectonic** (the LaTeX engine sidecar): MIT licence, copyright the Tectonic Project. https://tectonic-typesetting.github.io
- **PDF.js**: Apache License 2.0, copyright Mozilla Foundation.
- **KaTeX**: MIT licence, copyright Khan Academy.
- **CodeMirror 6**: MIT licence, copyright Marijn Haverbeke and contributors.
- **docx-editor** (the Word view's engine: `@eigenpal/docx-editor-react`, `-core`, `-i18n` and `-agents` 1.9.0): Apache License 2.0, copyright EigenPal. https://github.com/eigenpal/docx-editor. The project's later `@docx-editor.dev/pro` and `@docx-editor.dev/editor-api` packages are under the proprietary EigenPal Pro licence; Dabir does not use them.
- **ProseMirror** (under the Word view): MIT licence, copyright Marijn Haverbeke and contributors.
- **JSZip**: MIT or GPL-3.0-or-later, used under MIT. **pako**: MIT and Zlib. **sax** (read by xml-js inside the Word view): Blue Oak Model License 1.0.0, a permissive licence.
- **codemirror-lang-latex**: AGPL-3.0-or-later. This package is the reason Dabir cannot be relicensed more permissively without replacing it.
- **Yjs and y-protocols**: MIT licence, copyright Kevin Jahns.
- **Lucide icons**: ISC licence.
- **STIX Two Text** and **IBM Plex Mono** (when bundled): SIL Open Font License 1.1.

## npm packages (runtime)

| Package | Version | Licence |
|---|---|---|
| @codemirror/autocomplete | 6.20.3 | MIT |
| @codemirror/commands | 6.11.0 | MIT |
| @codemirror/lang-cpp | 6.0.3 | MIT |
| @codemirror/lang-css | 6.3.1 | MIT |
| @codemirror/lang-html | 6.4.12 | MIT |
| @codemirror/lang-javascript | 6.2.5 | MIT |
| @codemirror/lang-json | 6.0.2 | MIT |
| @codemirror/lang-markdown | 6.5.2 | MIT |
| @codemirror/lang-python | 6.2.1 | MIT |
| @codemirror/lang-rust | 6.0.2 | MIT |
| @codemirror/lang-yaml | 6.1.3 | MIT |
| @codemirror/language | 6.12.4 | MIT |
| @codemirror/legacy-modes | 6.5.4 | MIT |
| @codemirror/lint | 6.9.7 | MIT |
| @codemirror/lsp-client | 6.2.5 | MIT |
| @codemirror/search | 6.7.2 | MIT |
| @codemirror/state | 6.7.4 | MIT |
| @codemirror/view | 6.43.11 | MIT |
| @eigenpal/docx-editor-agents | 1.9.0 | Apache-2.0 |
| @eigenpal/docx-editor-core | 1.9.0 | Apache-2.0 |
| @eigenpal/docx-editor-i18n | 1.9.0 | Apache-2.0 |
| @eigenpal/docx-editor-react | 1.9.0 | Apache-2.0 |
| @floating-ui/core | 1.8.0 | MIT |
| @floating-ui/dom | 1.8.0 | MIT |
| @floating-ui/react-dom | 2.1.9 | MIT |
| @floating-ui/utils | 0.2.12 | MIT |
| @fontsource/ibm-plex-mono | 5.3.0 | OFL-1.1 |
| @fontsource/stix-two-text | 5.3.0 | OFL-1.1 |
| @lezer/common | 1.5.2 | MIT |
| @lezer/cpp | 1.1.6 | MIT |
| @lezer/css | 1.3.6 | MIT |
| @lezer/generator | 1.8.0 | MIT |
| @lezer/highlight | 1.2.3 | MIT |
| @lezer/html | 1.3.13 | MIT |
| @lezer/javascript | 1.5.4 | MIT |
| @lezer/json | 1.0.3 | MIT |
| @lezer/lr | 1.4.10 | MIT |
| @lezer/markdown | 1.7.2 | MIT |
| @lezer/python | 1.1.19 | MIT |
| @lezer/rust | 1.0.2 | MIT |
| @lezer/yaml | 1.0.4 | MIT |
| @marijn/find-cluster-break | 1.0.4 | MIT |
| @napi-rs/canvas | 1.0.9 | MIT |
| @napi-rs/canvas-android-arm64 | 1.0.9 | MIT |
| @napi-rs/canvas-darwin-arm64 | 1.0.9 | MIT |
| @napi-rs/canvas-darwin-x64 | 1.0.9 | MIT |
| @napi-rs/canvas-linux-arm-gnueabihf | 1.0.9 | MIT |
| @napi-rs/canvas-linux-arm64-gnu | 1.0.9 | MIT |
| @napi-rs/canvas-linux-arm64-musl | 1.0.9 | MIT |
| @napi-rs/canvas-linux-riscv64-gnu | 1.0.9 | MIT |
| @napi-rs/canvas-linux-x64-gnu | 1.0.9 | MIT |
| @napi-rs/canvas-linux-x64-musl | 1.0.9 | MIT |
| @napi-rs/canvas-win32-arm64-msvc | 1.0.9 | MIT |
| @napi-rs/canvas-win32-x64-msvc | 1.0.9 | MIT |
| @radix-ui/number | 1.1.3 | MIT |
| @radix-ui/primitive | 1.1.7 | MIT |
| @radix-ui/react-arrow | 1.1.15 | MIT |
| @radix-ui/react-collection | 1.1.15 | MIT |
| @radix-ui/react-compose-refs | 1.1.5 | MIT |
| @radix-ui/react-context | 1.2.2 | MIT |
| @radix-ui/react-direction | 1.1.4 | MIT |
| @radix-ui/react-dismissable-layer | 1.1.19 | MIT |
| @radix-ui/react-focus-guards | 1.1.6 | MIT |
| @radix-ui/react-focus-scope | 1.1.16 | MIT |
| @radix-ui/react-id | 1.1.4 | MIT |
| @radix-ui/react-popper | 1.3.7 | MIT |
| @radix-ui/react-portal | 1.1.17 | MIT |
| @radix-ui/react-presence | 1.1.10 | MIT |
| @radix-ui/react-primitive | 2.1.10 | MIT |
| @radix-ui/react-select | 2.3.7 | MIT |
| @radix-ui/react-slot | 1.3.3 | MIT |
| @radix-ui/react-use-callback-ref | 1.1.4 | MIT |
| @radix-ui/react-use-controllable-state | 1.2.6 | MIT |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT |
| @radix-ui/react-use-previous | 1.1.4 | MIT |
| @radix-ui/react-use-rect | 1.1.4 | MIT |
| @radix-ui/react-use-size | 1.1.4 | MIT |
| @radix-ui/react-visually-hidden | 1.2.11 | MIT |
| @radix-ui/rect | 1.1.3 | MIT |
| @replit/codemirror-indentation-markers | 6.5.3 | MIT |
| @replit/codemirror-vim | 6.4.0 | MIT |
| @replit/codemirror-vim-core | 0.1.0 | MIT |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.7.3 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-fs | 2.5.2 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | 2.5.5 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-shell | 2.3.6 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-updater | 2.11.0 | MIT OR Apache-2.0 |
| @xmldom/xmldom | 0.9.12 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| aria-hidden | 1.2.6 | MIT |
| base64-js | 1.5.1 | MIT |
| buffer | 6.0.3 | MIT |
| clsx | 2.1.1 | MIT |
| codemirror-lang-latex | 0.6.1 | AGPL-3.0-or-later |
| codemirror-lang-typst | 0.6.0 | Apache-2.0 |
| commander | 15.0.0 | MIT |
| core-util-is | 1.0.3 | MIT |
| crelt | 1.0.7 | MIT |
| debug | 4.4.3 | MIT |
| detect-node-es | 1.1.0 | MIT |
| diff | 9.0.0 | BSD-3-Clause |
| docxtemplater | 3.70.0 | MIT |
| dompurify | 3.4.15 | (MPL-2.0 OR Apache-2.0) |
| err-code | 3.0.1 | MIT |
| get-browser-rtc | 1.1.0 | MIT |
| get-nonce | 1.0.1 | MIT |
| hunspell-wasm | 0.3.0 | (LGPL-2.0 OR GPL-2.0 OR MPL-1.1) |
| ieee754 | 1.2.1 | BSD-3-Clause |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| isarray | 1.0.0 | MIT |
| isomorphic.js | 0.2.5 | MIT |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) |
| katex | 0.18.7 | MIT |
| lib0 | 0.2.117 | MIT |
| lie | 3.3.0 | MIT |
| lucide-react | 1.45.0 | ISC |
| marked | 15.0.12 | MIT |
| ms | 2.1.3 | MIT |
| orderedmap | 2.1.1 | MIT |
| pako | 1.0.11 | (MIT AND Zlib) |
| pako | 2.2.0 | (MIT AND Zlib) |
| pdfjs-dist | 6.3.289 | Apache-2.0 |
| pizzip | 3.2.0 | (MIT OR GPL-3.0) |
| process-nextick-args | 2.0.1 | MIT |
| prosemirror-commands | 1.7.2 | MIT |
| prosemirror-dropcursor | 1.8.3 | MIT |
| prosemirror-history | 1.5.0 | MIT |
| prosemirror-keymap | 1.2.3 | MIT |
| prosemirror-model | 1.25.11 | MIT |
| prosemirror-state | 1.4.4 | MIT |
| prosemirror-tables | 1.8.5 | MIT |
| prosemirror-transform | 1.12.1 | MIT |
| prosemirror-view | 1.42.3 | MIT |
| queue-microtask | 1.2.3 | MIT |
| randombytes | 2.1.0 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| react-remove-scroll | 2.7.2 | MIT |
| react-remove-scroll-bar | 2.3.8 | MIT |
| react-style-singleton | 2.2.3 | MIT |
| readable-stream | 2.3.8 | MIT |
| readable-stream | 3.6.2 | MIT |
| rope-sequence | 1.3.4 | MIT |
| safe-buffer | 5.1.2 | MIT |
| safe-buffer | 5.2.1 | MIT |
| sax | 1.6.1 | BlueOak-1.0.0 |
| scheduler | 0.28.0 | MIT |
| setimmediate | 1.0.5 | MIT |
| simple-peer | 9.11.1 | MIT |
| sonner | 2.0.8 | MIT |
| string_decoder | 1.1.1 | MIT |
| string_decoder | 1.3.0 | MIT |
| style-mod | 4.1.3 | MIT |
| tslib | 2.8.1 | 0BSD |
| use-callback-ref | 1.3.3 | MIT |
| use-sidecar | 1.1.3 | MIT |
| util-deprecate | 1.0.2 | MIT |
| vscode-jsonrpc | 9.0.2 | MIT |
| vscode-languageserver-protocol | 3.18.3 | MIT |
| vscode-languageserver-types | 3.18.3 | MIT |
| w3c-keyname | 2.2.8 | MIT |
| ws | 8.21.3 | MIT |
| xml-js | 1.6.11 | MIT |
| y-codemirror.next | 0.3.6 | MIT |
| y-indexeddb | 9.0.12 | MIT |
| y-protocols | 1.0.7 | MIT |
| y-webrtc | 10.3.0 | MIT |
| y-websocket | 3.1.0 | MIT |
| yjs | 13.6.32 | MIT |

## Rust crates

| Crate | Version | Licence |
|---|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aho-corasick | 1.1.5 | Unlicense OR MIT |
| alloc-no-stdlib | 2.0.4 | BSD-3-Clause |
| alloc-stdlib | 0.2.4 | BSD-3-Clause |
| android_system_properties | 0.1.6 | MIT OR Apache-2.0 |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 |
| arc-swap | 1.9.2 | MIT OR Apache-2.0 |
| async-broadcast | 0.7.2 | MIT OR Apache-2.0 |
| async-channel | 2.5.0 | Apache-2.0 OR MIT |
| async-executor | 1.14.0 | Apache-2.0 OR MIT |
| async-io | 2.6.0 | Apache-2.0 OR MIT |
| async-lock | 3.4.2 | Apache-2.0 OR MIT |
| async-process | 2.5.0 | Apache-2.0 OR MIT |
| async-recursion | 1.1.1 | MIT OR Apache-2.0 |
| async-signal | 0.2.14 | Apache-2.0 OR MIT |
| async-task | 4.7.1 | Apache-2.0 OR MIT |
| async-trait | 0.1.92 | MIT OR Apache-2.0 |
| atk | 0.18.2 | MIT |
| atk-sys | 0.18.2 | MIT |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT |
| atomic_refcell | 0.1.14 | Apache-2.0 OR MIT |
| autocfg | 1.5.1 | Apache-2.0 OR MIT |
| axum | 0.8.9 | MIT |
| axum-core | 0.5.6 | MIT |
| base64 | 0.21.7 | MIT OR Apache-2.0 |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| base64 | 0.23.1 | MIT OR Apache-2.0 |
| bit-set | 0.8.0 | Apache-2.0 OR MIT |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.13.1 | MIT OR Apache-2.0 |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| block2 | 0.6.2 | MIT |
| blocking | 1.7.0 | Apache-2.0 OR MIT |
| brotli | 8.0.4 | BSD-3-Clause AND MIT |
| brotli-decompressor | 5.0.3 | BSD-3-Clause/MIT |
| bs58 | 0.5.1 | MIT/Apache-2.0 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| cairo-rs | 0.18.5 | MIT |
| cairo-sys-rs | 0.18.2 | MIT |
| camino | 1.2.5 | MIT OR Apache-2.0 |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 |
| cargo_metadata | 0.19.2 | MIT |
| cargo_toml | 0.22.3 | Apache-2.0 OR MIT |
| cc | 1.4.5 | MIT OR Apache-2.0 |
| cesu8 | 1.1.0 | Apache-2.0/MIT |
| cfb | 0.7.3 | MIT |
| cfg-expr | 0.15.8 | MIT OR Apache-2.0 |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 |
| cfg_aliases | 0.1.1 | MIT |
| chrono | 0.4.45 | MIT OR Apache-2.0 |
| combine | 4.6.8 | MIT |
| concurrent-queue | 2.5.0 | Apache-2.0 OR MIT |
| cookie | 0.18.2 | MIT OR Apache-2.0 |
| core-foundation | 0.10.1 | MIT OR Apache-2.0 |
| core-foundation | 0.9.4 | MIT OR Apache-2.0 |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 |
| core-graphics | 0.25.0 | MIT OR Apache-2.0 |
| core-graphics-types | 0.2.0 | MIT OR Apache-2.0 |
| core_detect | 1.0.0 | MIT/Apache-2.0 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 |
| crc32fast | 1.5.1 | MIT OR Apache-2.0 |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| cssparser | 0.36.0 | MPL-2.0 |
| cssparser-macros | 0.6.1 | MPL-2.0 |
| ctor | 0.8.0 | Apache-2.0 OR MIT |
| ctor-proc-macro | 0.0.7 | Apache-2.0 OR MIT |
| darling | 0.23.0 | MIT |
| darling_core | 0.23.0 | MIT |
| darling_macro | 0.23.0 | MIT |
| data-encoding | 2.11.1 | MIT |
| dbus | 0.9.12 | Apache-2.0/MIT |
| defmt | 1.1.1 | MIT OR Apache-2.0 |
| defmt-macros | 1.1.1 | MIT OR Apache-2.0 |
| defmt-parser | 1.0.0 | MIT OR Apache-2.0 |
| deranged | 0.5.8 | MIT OR Apache-2.0 |
| derive_arbitrary | 1.4.2 | MIT OR Apache-2.0 |
| derive_more | 2.1.1 | MIT |
| derive_more-impl | 2.1.1 | MIT |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| dirs | 6.0.0 | MIT OR Apache-2.0 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 |
| dispatch2 | 0.3.1 | Zlib OR Apache-2.0 OR MIT |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 |
| dlopen2 | 0.8.2 | MIT |
| dlopen2_derive | 0.4.3 | MIT |
| dom_query | 0.27.0 | MIT |
| downcast-rs | 1.2.1 | MIT/Apache-2.0 |
| dpi | 0.1.2 | Apache-2.0 AND MIT |
| dtoa | 1.0.11 | MIT OR Apache-2.0 |
| dtoa-short | 0.3.5 | MPL-2.0 |
| dtor | 0.3.0 | Apache-2.0 OR MIT |
| dtor-proc-macro | 0.0.6 | Apache-2.0 OR MIT |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 |
| embed-resource | 3.0.11 | MIT |
| embed_plist | 1.2.2 | MIT OR Apache-2.0 |
| encoding_rs | 0.8.40 | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| endi | 1.1.1 | MIT |
| enumflags2 | 0.7.12 | MIT OR Apache-2.0 |
| enumflags2_derive | 0.7.12 | MIT OR Apache-2.0 |
| equivalent | 1.0.2 | Apache-2.0 OR MIT |
| erased-serde | 0.4.10 | MIT OR Apache-2.0 |
| errno | 0.3.14 | MIT OR Apache-2.0 |
| event-listener | 5.4.2 | Apache-2.0 OR MIT |
| event-listener-strategy | 0.5.4 | Apache-2.0 OR MIT |
| fastrand | 2.5.0 | Apache-2.0 OR MIT |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| field-offset | 0.3.6 | MIT OR Apache-2.0 |
| filedescriptor | 0.8.3 | MIT |
| filetime | 0.2.29 | MIT/Apache-2.0 |
| find-msvc-tools | 0.1.12 | MIT OR Apache-2.0 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 |
| fnv | 1.0.7 | Apache-2.0 / MIT |
| foldhash | 0.2.0 | Zlib |
| foreign-types | 0.5.0 | MIT/Apache-2.0 |
| foreign-types-macros | 0.2.4 | MIT/Apache-2.0 |
| foreign-types-shared | 0.3.1 | MIT/Apache-2.0 |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| futures-channel | 0.3.34 | MIT OR Apache-2.0 |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |
| futures-executor | 0.3.34 | MIT OR Apache-2.0 |
| futures-io | 0.3.34 | MIT OR Apache-2.0 |
| futures-lite | 2.6.1 | Apache-2.0 OR MIT |
| futures-macro | 0.3.34 | MIT OR Apache-2.0 |
| futures-sink | 0.3.34 | MIT OR Apache-2.0 |
| futures-task | 0.3.34 | MIT OR Apache-2.0 |
| futures-util | 0.3.34 | MIT OR Apache-2.0 |
| gdk | 0.18.2 | MIT |
| gdk-pixbuf | 0.18.5 | MIT |
| gdk-pixbuf-sys | 0.18.0 | MIT |
| gdk-sys | 0.18.2 | MIT |
| gdkwayland-sys | 0.18.2 | MIT |
| gdkx11 | 0.18.2 | MIT |
| gdkx11-sys | 0.18.2 | MIT |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.3 | MIT OR Apache-2.0 |
| gio | 0.18.4 | MIT |
| gio-sys | 0.18.1 | MIT |
| git2 | 0.21.0 | MIT OR Apache-2.0 |
| glib | 0.18.5 | MIT |
| glib-macros | 0.18.5 | MIT |
| glib-sys | 0.18.1 | MIT |
| glob | 0.3.4 | MIT OR Apache-2.0 |
| gobject-sys | 0.18.0 | MIT |
| gtk | 0.18.2 | MIT |
| gtk-sys | 0.18.2 | MIT |
| gtk3-macros | 0.18.2 | MIT |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 |
| heck | 0.4.1 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| hermit-abi | 0.5.3 | MIT OR Apache-2.0 |
| hex | 0.4.3 | MIT OR Apache-2.0 |
| html5ever | 0.38.0 | MIT OR Apache-2.0 |
| http | 1.5.0 | MIT OR Apache-2.0 |
| http-body | 1.1.0 | MIT |
| http-body-util | 0.1.5 | MIT |
| httparse | 1.10.1 | MIT OR Apache-2.0 |
| httpdate | 1.0.3 | MIT OR Apache-2.0 |
| hyper | 1.11.1 | MIT |
| hyper-rustls | 0.27.9 | Apache-2.0 OR ISC OR MIT |
| hyper-util | 0.1.20 | MIT |
| iana-time-zone | 0.1.65 | MIT OR Apache-2.0 |
| iana-time-zone-haiku | 0.1.2 | MIT OR Apache-2.0 |
| ico | 0.5.0 | MIT |
| icu_collections | 2.3.0 | Unicode-3.0 |
| icu_locale_core | 2.3.0 | Unicode-3.0 |
| icu_normalizer | 2.3.0 | Unicode-3.0 |
| icu_normalizer_data | 2.3.0 | Unicode-3.0 |
| icu_properties | 2.3.0 | Unicode-3.0 |
| icu_properties_data | 2.3.0 | Unicode-3.0 |
| icu_provider | 2.3.1 | Unicode-3.0 |
| ident_case | 1.0.1 | MIT/Apache-2.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT |
| indexmap | 1.9.3 | Apache-2.0 OR MIT |
| indexmap | 2.14.2 | Apache-2.0 OR MIT |
| infer | 0.19.0 | MIT |
| ipnet | 2.12.2 | MIT OR Apache-2.0 |
| is-docker | 0.2.0 | MIT |
| is-wsl | 0.4.0 | MIT |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| javascriptcore-rs | 1.1.2 | MIT |
| javascriptcore-rs-sys | 1.1.1 | MIT |
| jiff | 0.2.35 | Unlicense OR MIT |
| jiff-core | 0.1.0 | Unlicense OR MIT |
| jiff-static | 0.2.35 | Unlicense OR MIT |
| jiff-tzdb | 0.1.8 | Unlicense OR MIT |
| jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT |
| jni | 0.21.1 | MIT/Apache-2.0 |
| jni | 0.22.4 | MIT OR Apache-2.0 |
| jni-macros | 0.22.4 | MIT OR Apache-2.0 |
| jni-sys | 0.3.1 | MIT OR Apache-2.0 |
| jni-sys | 0.4.1 | MIT OR Apache-2.0 |
| jni-sys-macros | 0.4.1 | MIT OR Apache-2.0 |
| jobserver | 0.1.35 | MIT OR Apache-2.0 |
| js-sys | 0.3.105 | MIT OR Apache-2.0 |
| json-patch | 3.0.1 | MIT/Apache-2.0 |
| jsonptr | 0.6.3 | MIT OR Apache-2.0 |
| keyboard-types | 0.7.0 | MIT OR Apache-2.0 |
| lazy_static | 1.5.0 | MIT OR Apache-2.0 |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT |
| libc | 0.2.189 | MIT OR Apache-2.0 |
| libdbus-sys | 0.2.7 | Apache-2.0/MIT |
| libgit2-sys | 0.18.8+1.9.7 | MIT OR Apache-2.0 |
| libloading | 0.7.4 | ISC |
| libredox | 0.1.23 | MIT |
| libz-sys | 1.1.29 | MIT OR Apache-2.0 |
| linux-raw-sys | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| litemap | 0.8.3 | Unicode-3.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.34 | MIT OR Apache-2.0 |
| markup5ever | 0.38.0 | MIT OR Apache-2.0 |
| matchit | 0.8.4 | MIT AND BSD-3-Clause |
| memchr | 2.8.3 | Unlicense OR MIT |
| memoffset | 0.9.1 | MIT |
| mime | 0.3.17 | MIT OR Apache-2.0 |
| minisign-verify | 0.2.5 | MIT |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| mio | 1.2.3 | MIT |
| muda | 0.19.3 | Apache-2.0 OR MIT |
| multiversion | 0.8.0 | MIT OR Apache-2.0 |
| multiversion-macros | 0.8.0 | MIT OR Apache-2.0 |
| multiversion_no_op | 1.0.0 | Apache-2.0 OR MIT |
| ndk | 0.9.0 | MIT OR Apache-2.0 |
| ndk-sys | 0.6.0+11769913 | MIT OR Apache-2.0 |
| new_debug_unreachable | 1.0.6 | MIT |
| nix | 0.28.0 | MIT |
| num-conv | 0.2.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| num_enum | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| num_enum_derive | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| objc2 | 0.6.4 | MIT |
| objc2-app-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-cloud-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-data | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-foundation | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-graphics | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-image | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-location | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-core-text | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-encode | 4.1.0 | MIT |
| objc2-exception-helper | 0.1.1 | Zlib OR Apache-2.0 OR MIT |
| objc2-foundation | 0.3.2 | MIT |
| objc2-io-surface | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-osa-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-quartz-core | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-ui-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-user-notifications | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| objc2-web-kit | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| open | 5.4.3 | MIT |
| openssl-probe | 0.1.6 | MIT/Apache-2.0 |
| openssl-probe | 0.2.1 | MIT OR Apache-2.0 |
| openssl-src | 300.6.1+3.6.3 | MIT/Apache-2.0 |
| openssl-sys | 0.9.117 | MIT |
| option-ext | 0.2.0 | MPL-2.0 |
| ordered-stream | 0.2.0 | MIT OR Apache-2.0 |
| os_pipe | 1.2.3 | MIT |
| osakit | 0.3.1 | MIT OR Apache-2.0 |
| pango | 0.18.3 | MIT |
| pango-sys | 0.18.0 | MIT |
| parking | 2.2.1 | Apache-2.0 OR MIT |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| phf | 0.13.1 | MIT |
| phf_codegen | 0.13.1 | MIT |
| phf_generator | 0.13.1 | MIT |
| phf_macros | 0.13.1 | MIT |
| phf_shared | 0.13.1 | MIT |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| piper | 0.2.5 | MIT OR Apache-2.0 |
| pkg-config | 0.3.34 | MIT OR Apache-2.0 |
| plist | 1.10.1 | MIT |
| png | 0.17.16 | MIT OR Apache-2.0 |
| png | 0.18.1 | MIT OR Apache-2.0 |
| polling | 3.11.0 | Apache-2.0 OR MIT |
| portable-atomic | 1.15.0 | Apache-2.0 OR MIT |
| portable-atomic-util | 0.2.8 | Apache-2.0 OR MIT |
| portable-pty | 0.9.0 | MIT |
| potential_utf | 0.1.6 | Unicode-3.0 |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| precomputed-hash | 0.1.1 | MIT |
| proc-macro-crate | 1.3.1 | MIT OR Apache-2.0 |
| proc-macro-crate | 2.0.2 | MIT OR Apache-2.0 |
| proc-macro-crate | 3.5.0 | MIT OR Apache-2.0 |
| proc-macro-error | 1.0.4 | MIT OR Apache-2.0 |
| proc-macro-error-attr | 1.0.4 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| quick-xml | 0.42.0 | MIT |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| r-efi | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| redox_syscall | 0.5.18 | MIT |
| redox_users | 0.5.2 | MIT |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 |
| reqwest | 0.13.4 | MIT OR Apache-2.0 |
| rfd | 0.16.0 | MIT |
| ring | 0.17.14 | Apache-2.0 AND ISC |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT |
| rustc_version | 0.4.1 | MIT OR Apache-2.0 |
| rustix | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| rustls | 0.23.44 | Apache-2.0 OR ISC OR MIT |
| rustls-native-certs | 0.8.4 | Apache-2.0 OR ISC OR MIT |
| rustls-pki-types | 1.15.1 | MIT OR Apache-2.0 |
| rustls-platform-verifier | 0.7.0 | MIT OR Apache-2.0 |
| rustls-platform-verifier-android | 0.1.1 | MIT OR Apache-2.0 |
| rustls-webpki | 0.103.15 | ISC |
| rustversion | 1.0.23 | MIT OR Apache-2.0 |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| same-file | 1.0.6 | Unlicense/MIT |
| schannel | 0.1.29 | MIT |
| schemars | 0.8.22 | MIT |
| schemars | 0.9.0 | MIT |
| schemars | 1.2.2 | MIT |
| schemars_derive | 0.8.22 | MIT |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| security-framework | 3.7.0 | MIT OR Apache-2.0 |
| security-framework-sys | 2.17.0 | MIT OR Apache-2.0 |
| selectors | 0.36.1 | MPL-2.0 |
| semver | 1.0.28 | MIT OR Apache-2.0 |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 |
| serde_core | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| serde_path_to_error | 0.1.20 | MIT OR Apache-2.0 |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 |
| serde_spanned | 0.6.9 | MIT OR Apache-2.0 |
| serde_spanned | 1.1.1 | MIT OR Apache-2.0 |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 |
| serde_with | 3.22.0 | MIT OR Apache-2.0 |
| serde_with_macros | 3.22.0 | MIT OR Apache-2.0 |
| serial2 | 0.2.38 | BSD-2-Clause OR Apache-2.0 |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 |
| sha1 | 0.10.7 | MIT OR Apache-2.0 |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| shared_child | 1.1.2 | MIT |
| shared_library | 0.1.9 | Apache-2.0/MIT |
| shell-words | 1.1.1 | MIT/Apache-2.0 |
| shlex | 2.0.1 | MIT OR Apache-2.0 |
| sigchld | 0.2.5 | MIT |
| signal-hook | 0.4.4 | MIT OR Apache-2.0 |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 |
| simd-adler32 | 0.3.10 | MIT |
| simd_cesu8 | 1.2.0 | Apache-2.0 OR MIT |
| simdutf8 | 0.1.5 | MIT OR Apache-2.0 |
| siphasher | 1.0.3 | MIT/Apache-2.0 |
| slab | 0.4.12 | MIT |
| smallstr | 0.3.1 | MIT OR Apache-2.0 |
| smallvec | 1.16.0 | MIT OR Apache-2.0 |
| socket2 | 0.6.5 | MIT OR Apache-2.0 |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 |
| soup3 | 0.5.0 | MIT |
| soup3-sys | 0.5.0 | MIT |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| string_cache | 0.9.0 | MIT OR Apache-2.0 |
| string_cache_codegen | 0.6.1 | MIT OR Apache-2.0 |
| strsim | 0.11.1 | MIT |
| subtle | 2.6.1 | BSD-3-Clause |
| swift-rs | 1.0.8 | MIT OR Apache-2.0 |
| syn | 1.0.109 | MIT OR Apache-2.0 |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.5 | MIT OR Apache-2.0 |
| sync_wrapper | 1.0.2 | Apache-2.0 |
| synstructure | 0.13.2 | MIT |
| system-configuration | 0.7.0 | MIT OR Apache-2.0 |
| system-configuration-sys | 0.6.0 | MIT OR Apache-2.0 |
| system-deps | 6.2.2 | MIT OR Apache-2.0 |
| tao | 0.35.3 | Apache-2.0 |
| tao-macros | 0.1.4 | MIT OR Apache-2.0 |
| tar | 0.4.46 | MIT OR Apache-2.0 |
| target-features | 0.1.6 | MIT OR Apache-2.0 |
| target-lexicon | 0.12.16 | Apache-2.0 WITH LLVM-exception |
| tauri | 2.11.5 | Apache-2.0 OR MIT |
| tauri-build | 2.6.3 | Apache-2.0 OR MIT |
| tauri-codegen | 2.6.3 | Apache-2.0 OR MIT |
| tauri-macros | 2.6.3 | Apache-2.0 OR MIT |
| tauri-plugin | 2.6.3 | Apache-2.0 OR MIT |
| tauri-plugin-dialog | 2.7.3 | Apache-2.0 OR MIT |
| tauri-plugin-fs | 2.5.2 | Apache-2.0 OR MIT |
| tauri-plugin-opener | 2.5.5 | Apache-2.0 OR MIT |
| tauri-plugin-process | 2.3.1 | Apache-2.0 OR MIT |
| tauri-plugin-shell | 2.3.6 | Apache-2.0 OR MIT |
| tauri-plugin-updater | 2.11.0 | Apache-2.0 OR MIT |
| tauri-runtime | 2.11.3 | Apache-2.0 OR MIT |
| tauri-runtime-wry | 2.11.4 | Apache-2.0 OR MIT |
| tauri-utils | 2.9.3 | Apache-2.0 OR MIT |
| tauri-winres | 0.3.6 | MIT |
| tempfile | 3.27.0 | MIT OR Apache-2.0 |
| tendril | 0.5.1 | MIT OR Apache-2.0 |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.20 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.20 | MIT OR Apache-2.0 |
| time | 0.3.55 | MIT OR Apache-2.0 |
| time-core | 0.1.9 | MIT OR Apache-2.0 |
| time-macros | 0.2.32 | MIT OR Apache-2.0 |
| tinystr | 0.8.4 | Unicode-3.0 |
| tinyvec | 1.13.2 | Zlib OR Apache-2.0 OR MIT |
| tinyvec_macros | 0.1.1 | MIT OR Apache-2.0 OR Zlib |
| tokio | 1.53.1 | MIT |
| tokio-macros | 2.7.2 | MIT |
| tokio-rustls | 0.26.5 | MIT OR Apache-2.0 |
| tokio-tungstenite | 0.29.0 | MIT |
| tokio-util | 0.7.19 | MIT |
| toml | 0.8.2 | MIT OR Apache-2.0 |
| toml | 0.9.12+spec-1.1.0 | MIT OR Apache-2.0 |
| toml | 1.1.6+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 0.6.3 | MIT OR Apache-2.0 |
| toml_datetime | 0.7.5+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_datetime | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_edit | 0.19.15 | MIT OR Apache-2.0 |
| toml_edit | 0.20.2 | MIT OR Apache-2.0 |
| toml_edit | 0.25.13+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_parser | 1.1.3+spec-1.1.0 | MIT OR Apache-2.0 |
| toml_writer | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| tower | 0.5.3 | MIT |
| tower-http | 0.6.11 | MIT |
| tower-layer | 0.3.3 | MIT |
| tower-service | 0.3.3 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| tray-icon | 0.24.2 | MIT OR Apache-2.0 |
| try-lock | 0.2.5 | MIT |
| tungstenite | 0.29.0 | MIT OR Apache-2.0 |
| typeid | 1.0.3 | MIT OR Apache-2.0 |
| typenum | 1.20.1 | MIT OR Apache-2.0 |
| uds_windows | 1.2.1 | MIT |
| unic-char-property | 0.9.0 | MIT/Apache-2.0 |
| unic-char-range | 0.9.0 | MIT/Apache-2.0 |
| unic-common | 0.9.0 | MIT/Apache-2.0 |
| unic-ucd-ident | 0.9.0 | MIT/Apache-2.0 |
| unic-ucd-version | 0.9.0 | MIT/Apache-2.0 |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 |
| untrusted | 0.9.0 | ISC |
| ureq | 3.4.1 | MIT OR Apache-2.0 |
| ureq-proto | 0.6.2 | MIT OR Apache-2.0 |
| url | 2.5.8 | MIT OR Apache-2.0 |
| urlpattern | 0.3.0 | MIT |
| utf8-zero | 0.8.1 | MIT OR Apache-2.0 |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT |
| uuid | 1.26.1 | Apache-2.0 OR MIT |
| vcpkg | 0.2.15 | MIT/Apache-2.0 |
| version-compare | 0.2.1 | MIT |
| version_check | 0.9.5 | MIT/Apache-2.0 |
| vswhom | 0.1.0 | MIT |
| vswhom-sys | 0.1.3 | MIT |
| walkdir | 2.5.0 | Unlicense/MIT |
| want | 0.3.1 | MIT |
| wasi | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| wasm-bindgen | 0.2.128 | MIT OR Apache-2.0 |
| wasm-bindgen-futures | 0.4.78 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.128 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.128 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.128 | MIT OR Apache-2.0 |
| wasm-streams | 0.5.0 | MIT OR Apache-2.0 |
| web-sys | 0.3.105 | MIT OR Apache-2.0 |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 |
| webkit2gtk | 2.0.2 | MIT |
| webkit2gtk-sys | 2.0.2 | MIT |
| webpki-root-certs | 1.0.9 | CDLA-Permissive-2.0 |
| webpki-roots | 1.0.9 | CDLA-Permissive-2.0 |
| webview2-com | 0.38.2 | MIT |
| webview2-com-macros | 0.8.1 | MIT |
| webview2-com-sys | 0.38.2 | MIT |
| winapi | 0.3.9 | MIT/Apache-2.0 |
| winapi-i686-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 |
| winapi-util | 0.1.11 | Unlicense OR MIT |
| winapi-x86_64-pc-windows-gnu | 0.4.0 | MIT/Apache-2.0 |
| window-vibrancy | 0.6.0 | Apache-2.0 OR MIT |
| windows | 0.61.3 | MIT OR Apache-2.0 |
| windows-collections | 0.2.0 | MIT OR Apache-2.0 |
| windows-core | 0.61.2 | MIT OR Apache-2.0 |
| windows-core | 0.62.2 | MIT OR Apache-2.0 |
| windows-future | 0.2.1 | MIT OR Apache-2.0 |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 |
| windows-link | 0.1.3 | MIT OR Apache-2.0 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-numerics | 0.2.0 | MIT OR Apache-2.0 |
| windows-registry | 0.6.1 | MIT OR Apache-2.0 |
| windows-result | 0.3.4 | MIT OR Apache-2.0 |
| windows-result | 0.4.1 | MIT OR Apache-2.0 |
| windows-strings | 0.4.2 | MIT OR Apache-2.0 |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 |
| windows-sys | 0.45.0 | MIT OR Apache-2.0 |
| windows-sys | 0.52.0 | MIT OR Apache-2.0 |
| windows-sys | 0.59.0 | MIT OR Apache-2.0 |
| windows-sys | 0.60.2 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| windows-targets | 0.42.2 | MIT OR Apache-2.0 |
| windows-targets | 0.52.6 | MIT OR Apache-2.0 |
| windows-targets | 0.53.5 | MIT OR Apache-2.0 |
| windows-threading | 0.1.0 | MIT OR Apache-2.0 |
| windows-version | 0.1.7 | MIT OR Apache-2.0 |
| windows_aarch64_gnullvm | 0.42.2 | MIT OR Apache-2.0 |
| windows_aarch64_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_aarch64_gnullvm | 0.53.1 | MIT OR Apache-2.0 |
| windows_aarch64_msvc | 0.42.2 | MIT OR Apache-2.0 |
| windows_aarch64_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_aarch64_msvc | 0.53.1 | MIT OR Apache-2.0 |
| windows_i686_gnu | 0.42.2 | MIT OR Apache-2.0 |
| windows_i686_gnu | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_gnu | 0.53.1 | MIT OR Apache-2.0 |
| windows_i686_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_gnullvm | 0.53.1 | MIT OR Apache-2.0 |
| windows_i686_msvc | 0.42.2 | MIT OR Apache-2.0 |
| windows_i686_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_i686_msvc | 0.53.1 | MIT OR Apache-2.0 |
| windows_x86_64_gnu | 0.42.2 | MIT OR Apache-2.0 |
| windows_x86_64_gnu | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_gnu | 0.53.1 | MIT OR Apache-2.0 |
| windows_x86_64_gnullvm | 0.42.2 | MIT OR Apache-2.0 |
| windows_x86_64_gnullvm | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_gnullvm | 0.53.1 | MIT OR Apache-2.0 |
| windows_x86_64_msvc | 0.42.2 | MIT OR Apache-2.0 |
| windows_x86_64_msvc | 0.52.6 | MIT OR Apache-2.0 |
| windows_x86_64_msvc | 0.53.1 | MIT OR Apache-2.0 |
| winnow | 0.5.40 | MIT |
| winnow | 0.7.15 | MIT |
| winnow | 1.0.4 | MIT |
| winreg | 0.10.1 | MIT |
| winreg | 0.55.0 | MIT |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| writeable | 0.6.4 | Unicode-3.0 |
| wry | 0.55.1 | Apache-2.0 OR MIT |
| x11 | 2.21.0 | MIT |
| x11-dl | 2.21.0 | MIT |
| xattr | 1.6.1 | MIT OR Apache-2.0 |
| yoke | 0.8.3 | Unicode-3.0 |
| yoke-derive | 0.8.2 | Unicode-3.0 |
| yrs | 0.18.8 | MIT |
| yrs-axum | 0.8.2 | MIT |
| zbus | 5.19.0 | MIT |
| zbus_macros | 5.19.0 | MIT |
| zbus_names | 4.3.4 | MIT |
| zcheapstr | 1.1.0 | MIT |
| zerocopy | 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.56 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.8 | Unicode-3.0 |
| zerofrom-derive | 0.1.7 | Unicode-3.0 |
| zeroize | 1.9.0 | Apache-2.0 OR MIT |
| zerotrie | 0.2.5 | Unicode-3.0 |
| zerovec | 0.11.8 | Unicode-3.0 |
| zerovec-derive | 0.11.6 | Unicode-3.0 |
| zip | 4.6.1 | MIT |
| zlib-rs | 0.6.7 | Zlib |
| zmij | 1.0.23 | MIT |
| zopfli | 0.8.3 | Apache-2.0 |
| zvariant | 5.15.0 | MIT |
| zvariant_derive | 5.15.0 | MIT |
| zvariant_utils | 4.2.0 | MIT |
