import { useState } from "react";
import { AlertCircle, AlertTriangle, ChevronRight, Info, Sparkles } from "lucide-react";
import type { Diagnostic } from "../lib/backend";

export interface Problem extends Diagnostic { count: number; key: string }

/** Collapse identical diagnostics (Tectonic repeats notes once per pass) and give each a stable key. */
export function groupProblems(ds: Diagnostic[]): Problem[] {
  const out: Problem[] = [];
  for (const d of ds) {
    const key = `${d.severity}|${d.file ?? ""}|${d.line ?? ""}|${d.message}`;
    const same = out.find((g) => g.key === key);
    if (same) same.count += 1; else out.push({ ...d, count: 1, key });
  }
  return out;
}

/** The prompt an agent gets when asked to fix one problem. Short, traceable, and it names the skill. */
export function fixPrompt(p: Problem, mainFile: string): string {
  const where = p.file ? `${p.file}${p.line != null ? `:${p.line}` : ""}` : mainFile;
  const excerpt = p.context ? `\n\nLog excerpt:\n${p.context.split("\n").slice(0, 8).join("\n")}` : "";
  return `Fix this LaTeX ${p.severity} at ${where}: ${p.message}.${excerpt}\n\nFollow the compile-and-fix skill: make the smallest change at the source of the problem, recompile with Tectonic, and confirm the ${p.severity} is gone. Do not silence warnings; fix their cause.`;
}

interface Props {
  problems: Problem[];
  mainFile: string;
  agentReady: boolean;
  onJump: (file: string | null, line: number) => void;
  onFix: (prompt: string) => void;
}

const ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;
const LABEL: Record<string, string> = { syntax: "syntax", citation: "citation", reference: "reference", rerun: "rerun", box: "layout", font: "font", package: "package", file: "file", code: "code", other: "" };

export function Problems({ problems, mainFile, agentReady, onJump, onFix }: Props) {
  const [showInfo, setShowInfo] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");
  const infos = problems.filter((p) => p.severity === "info");
  const shown = [...errors, ...warnings, ...(showInfo ? infos : [])];
  if (problems.length === 0) return null;

  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const fixAll = () => {
    const list = errors.length ? errors : warnings;
    const body = list.slice(0, 12).map((p) => `- ${p.file ?? mainFile}${p.line != null ? `:${p.line}` : ""}: ${p.message}`).join("\n");
    const kind = errors.length ? "errors" : "warnings";
    // Code findings come from the language server, so the compile-and-fix recipe does not apply to them.
    if (list.every((p) => p.category === "code")) {
      onFix(`Fix these ${kind} the language server reports, one by one:\n${body}\n\nMake the smallest change at the source of each; do not suppress diagnostics with comments or config. Rerun the file's own tests or the script if there is a cheap way to. List what you changed.`);
      return;
    }
    onFix(`Fix these LaTeX ${kind} one by one, recompiling after each:\n${body}\n\nFollow the compile-and-fix skill. Make the smallest change at the source of each problem; do not silence warnings. Finish with a clean compile and list what you changed.`);
  };

  return (
    <section className="problems" aria-label="Problems">
      <header className="problems-head">
        <span className="summary">
          {errors.length > 0 && <span className="pill error"><AlertCircle aria-hidden /> {errors.length} error{errors.length > 1 ? "s" : ""}</span>}
          {warnings.length > 0 && <span className="pill warning"><AlertTriangle aria-hidden /> {warnings.length} warning{warnings.length > 1 ? "s" : ""}</span>}
          {infos.length > 0 && <button className={`pill info ${showInfo ? "on" : ""}`} onClick={() => setShowInfo((v) => !v)} aria-pressed={showInfo} title="Font substitutions, overfull boxes and rerun notes"><Info aria-hidden /> {infos.length} note{infos.length > 1 ? "s" : ""}</button>}
        </span>
        {(errors.length > 0 || warnings.length > 0) && (
          <button className="btn small" onClick={fixAll} disabled={!agentReady} title={agentReady ? "Send all of them to the agent with the compile-and-fix skill" : "Choose an installed agent first"}>
            <Sparkles /> Fix {errors.length ? "errors" : "warnings"} with agent
          </button>
        )}
      </header>
      <ul className="problem-list" role="list">
        {shown.map((p) => {
          const Icon = ICON[p.severity as keyof typeof ICON] ?? Info;
          const isOpen = open.has(p.key);
          const canJump = p.line != null;
          return (
            <li key={p.key} className={`problem ${p.severity} ${isOpen ? "open" : ""}`}>
              <div className="row">
                <button className="disclose" onClick={() => toggle(p.key)} aria-expanded={isOpen} aria-label={isOpen ? "Hide excerpt" : "Show log excerpt"} disabled={!p.context}><ChevronRight /></button>
                <Icon className="sev" aria-label={p.severity} />
                <button className="where" onClick={() => canJump && onJump(p.file ?? null, p.line!)} disabled={!canJump} title={canJump ? "Go to this line" : "No line recorded"}>
                  {p.file ?? mainFile}{p.line != null ? `:${p.line}` : ""}
                </button>
                <span className="msg">{p.message}{p.count > 1 && <span className="count"> ×{p.count}</span>}</span>
                {LABEL[p.category] && <span className="cat">{LABEL[p.category]}</span>}
                <button className="fix" onClick={() => onFix(fixPrompt(p, mainFile))} disabled={!agentReady} title="Ask the agent to fix this"><Sparkles /> Fix</button>
              </div>
              {isOpen && p.context && <pre className="excerpt">{p.context}</pre>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
