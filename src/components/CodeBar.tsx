// The bar above a code file, the counterpart of the formatting bar above prose: where the file is, how to
// run it, its formatter, and what the language server thinks of it. Everything here is also a menu item or
// a shortcut; the bar is where a newcomer finds them.

import { ChevronRight, CirclePlay, ListEnd, Terminal, WandSparkles, CircleX, TriangleAlert, CircleCheck } from "lucide-react";
import { chord, RUN_FILE } from "../lib/keys";

/** What the language server (or the file's own linter) says about the open code file, for the bar and the Problems list. */
export interface LintItem { line: number; severity: "error" | "warning" | "info"; message: string }
export interface LintReport { errors: number; warnings: number; items: LintItem[] }
export const NO_LINT: LintReport = { errors: 0, warnings: 0, items: [] };

export interface CodeState {
  run: { label: string; command: string } | null;
  repl: { label: string; command: string } | null;
  canFormat: boolean;
  /** The language server in charge: undefined while looking, null when none is installed. */
  server: { command: string } | null | undefined;
  installHint: string | null;
  lint: LintReport;
  line: number;
  col: number;
}

interface Props {
  rel: string;
  state: CodeState;
  onRun: () => void;
  onRunSelection: () => void;
  onRepl: () => void;
  onFormat: () => void;
  onNextProblem: () => void;
}

export function CodeBar({ rel, state, onRun, onRunSelection, onRepl, onFormat, onNextProblem }: Props) {
  const parts = rel.split("/");
  const name = parts.pop() ?? rel;
  const { errors, warnings } = state.lint;
  const problems = errors + warnings;
  return (
    <div className="codebar" role="toolbar" aria-label="Code tools">
      <span className="crumbs" title={rel}>
        {parts.map((d, i) => <span key={i} className="dir">{d}<ChevronRight aria-hidden /></span>)}
        <span className="file">{name}</span>
      </span>
      <span className="sep" />
      {state.run && <button className="cb-btn" onClick={onRun} title={chord(`${state.run.label} in the terminal (${RUN_FILE})\n${state.run.command}`)}><CirclePlay aria-hidden /> Run</button>}
      <button className="cb-btn" onClick={onRunSelection} title={chord("Send the selection, or the current line, to the terminal (⇧⏎). With a REPL open there, it runs.")}><ListEnd aria-hidden /> Run Selection</button>
      {state.repl && <button className="cb-btn" onClick={onRepl} title={`Open a ${state.repl.label} session in the terminal\n${state.repl.command}`}><Terminal aria-hidden /> {state.repl.label} REPL</button>}
      {state.canFormat && <button className="cb-btn" onClick={onFormat} title={chord("Format Document with the project's formatter (⇧⌥F)")}><WandSparkles aria-hidden /> Format</button>}
      <span className="cb-grow" />
      {problems > 0 ? (
        <button className="cb-btn problems" onClick={onNextProblem} title="Next problem">
          {errors > 0 && <span className="err"><CircleX aria-hidden /> {errors}</span>}
          {warnings > 0 && <span className="warn"><TriangleAlert aria-hidden /> {warnings}</span>}
        </button>
      ) : state.server ? <span className="cb-status ok" title={`${state.server.command} reports no problems`}><CircleCheck aria-hidden /> No problems</span> : null}
      <span className={`cb-status server ${state.server ? "ok" : "off"}`} title={state.server ? chord(`Language server: ${state.server.command}. Completion, hover, go to definition (F12), references (⇧F12), rename (F2).`) : state.server === null ? `No language server for this file${state.installHint ? `. Install one: ${state.installHint}` : ""}` : "Looking for a language server…"}>
        <span className="dot" aria-hidden />{state.server ? state.server.command : state.server === null ? "no language server" : "…"}
      </span>
      <span className="cb-status pos" title="Line and column">Ln {state.line}, Col {state.col}</span>
    </div>
  );
}
