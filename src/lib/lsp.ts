// Language servers for the code beside the paper. A server is a command on the agents' PATH; when
// it is there, the editor gets completion, diagnostics, hover, signatures and go-to-definition from
// it, and when it is not, the file is edited with its grammar alone and Settings says what to install.

import { LSPClient, languageServerExtensions, languageServerSupport, type Transport } from "@codemirror/lsp-client";
import type { Extension } from "@codemirror/state";
import { lspAvailable, lspProbe, lspStart, lspSend, lspStop, onLspMessage, onLspExit } from "./backend";

export interface ServerSpec {
  command: string; args: string[]; languageId: string; install: string;
  /** For launchers (julia, R): arguments that exit 0 only when the server package behind the command is installed. */
  probe?: string[];
}

/** Servers by file extension, in order of preference. */
const SERVERS: Record<string, ServerSpec[]> = {
  py: [
    { command: "pyright-langserver", args: ["--stdio"], languageId: "python", install: "npm i -g pyright" },
    { command: "basedpyright-langserver", args: ["--stdio"], languageId: "python", install: "pip install basedpyright" },
    { command: "pylsp", args: [], languageId: "python", install: "pip install python-lsp-server" },
    { command: "ruff", args: ["server"], languageId: "python", install: "pip install ruff" },
  ],
  typ: [{ command: "tinymist", args: ["lsp"], languageId: "typst", install: "brew install tinymist" }],
  jl: [{ command: "julia", args: ["--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"], probe: ["--startup-file=no", "-e", "using LanguageServer"], languageId: "julia", install: "julia -e 'using Pkg; Pkg.add(\"LanguageServer\")'" }],
  r: [{ command: "R", args: ["--slave", "-e", "languageserver::run()"], probe: ["--slave", "-e", "library(languageserver)"], languageId: "r", install: "R -e 'install.packages(\"languageserver\")'" }],
  sh: [{ command: "bash-language-server", args: ["start"], languageId: "shellscript", install: "npm i -g bash-language-server" }],
  bash: [{ command: "bash-language-server", args: ["start"], languageId: "shellscript", install: "npm i -g bash-language-server" }],
  yml: [{ command: "yaml-language-server", args: ["--stdio"], languageId: "yaml", install: "npm i -g yaml-language-server" }],
  yaml: [{ command: "yaml-language-server", args: ["--stdio"], languageId: "yaml", install: "npm i -g yaml-language-server" }],
};

const ext = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";

/** The servers this file could use, best first. */
export function serversFor(path: string): ServerSpec[] { return SERVERS[ext(path)] ?? []; }

let availableCache: Promise<Set<string>> | null = null;
/** Which servers can run: the command is on the PATH and, for launchers, its probe succeeds. Checked once per session. */
export function availableServers(): Promise<Set<string>> {
  availableCache ??= (async () => {
    const specs = Object.values(SERVERS).flat();
    const onPath = new Set(await lspAvailable(specs.map((s) => s.command)));
    const probes = specs.filter((s) => s.probe && onPath.has(s.command));
    const results = await Promise.all(probes.map((s) => lspProbe(s.command, s.probe!)));
    probes.forEach((s, i) => { if (!results[i]) onPath.delete(s.command); });
    return onPath;
  })();
  return availableCache;
}

/** Servers that started and died within their first seconds this session: not tried again until the paper reopens. */
const failed = new Set<string>();

interface Running { client: LSPClient; id: number; root: string; command: string; startedAt: number }
const running = new Map<string, Running>();
let listening = false;
const handlers = new Map<number, Set<(m: string) => void>>();

function ensureListening() {
  if (listening) return;
  listening = true;
  onLspMessage((e) => { handlers.get(e.id)?.forEach((h) => h(e.message)); });
  onLspExit((e) => {
    for (const [key, r] of running) if (r.id === e.id) {
      if (Date.now() - r.startedAt < 20000) failed.add(r.command);   // died at start: broken install, not a crash mid-session
      r.client.disconnect(); running.delete(key);
    }
    handlers.delete(e.id);
  });
}

/** A connected client for `spec` in `root`, started on first use and shared by every file of that language. */
async function clientFor(root: string, spec: ServerSpec): Promise<LSPClient | null> {
  const key = `${root}::${spec.command}`;
  const have = running.get(key);
  if (have) return have.client;
  ensureListening();
  const id = await lspStart(root, spec.command, spec.args);
  if (id == null) return null;
  const subs = new Set<(m: string) => void>();
  handlers.set(id, subs);
  const transport: Transport = {
    send(message) { void lspSend(id, withWorkspace(message, root)); },
    subscribe(h) { subs.add(h); },
    unsubscribe(h) { subs.delete(h); },
  };
  const client = new LSPClient({ rootUri: toUri(root), timeout: 10000, extensions: languageServerExtensions() });
  client.connect(transport);
  running.set(key, { client, id, root, command: spec.command, startedAt: Date.now() });
  return client;
}

export const toUri = (path: string) => `file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`;

/** The client sends only `rootUri`; pyright and tinymist want `workspaceFolders` too, or they put the file in a default workspace. */
export function withWorkspace(message: string, root: string): string {
  if (!message.includes('"initialize"')) return message;
  try {
    const m = JSON.parse(message) as { method?: string; params?: Record<string, unknown> };
    if (m.method !== "initialize" || !m.params) return message;
    const caps = (m.params.capabilities ?? {}) as Record<string, unknown>;
    caps.workspace = { ...((caps.workspace as Record<string, unknown>) ?? {}), workspaceFolders: true, configuration: false };
    m.params.capabilities = caps;
    m.params.rootPath = root;
    m.params.workspaceFolders = [{ uri: toUri(root), name: root.split("/").filter(Boolean).pop() ?? root }];
    return JSON.stringify(m);
  } catch { return message; }
}

/** The editor extension for `file` (absolute path) in `root`, or null when no server for it is installed. */
export async function languageServerFor(root: string, file: string): Promise<{ extension: Extension; spec: ServerSpec } | null> {
  const specs = serversFor(file);
  if (!specs.length) return null;
  const have = await availableServers();
  const spec = specs.find((s) => have.has(s.command) && !failed.has(s.command));
  if (!spec) return null;
  const client = await clientFor(root, spec);
  if (!client) return null;
  return { extension: languageServerSupport(client, toUri(file), spec.languageId), spec };
}

/** Stop every server (when the paper closes). */
export function stopLanguageServers(): void {
  for (const [key, r] of running) { r.client.disconnect(); void lspStop(r.id); running.delete(key); handlers.delete(r.id); }
}
