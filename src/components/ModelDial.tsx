import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ModelOptions } from "../lib/backend";

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** One position of the needle: a model, an effort, or both. Empty strings mean "leave it to the CLI". */
export interface Notch { model: string; effort: string; label: string; group: string }

const LIGHT = /\b(mini|fast|flash|haiku|lite|small|nano|turbo|instant)\b/i;
const HEAVY = /\b(opus|max|pro|thinking|ultra|heavy|reasoning|deep)\b/i;
/** Weakest to strongest, from the names when they say so, keeping the CLI's order otherwise. */
function tier(id: string, label: string): number {
  const t = `${id} ${label}`;
  if (LIGHT.test(t)) return 0;
  if (HEAVY.test(t)) return 2;
  return 1;
}

/**
 * The notches for one provider, Fast → Deepest. Models the CLI lists are ordered by tier and each carries
 * every effort level the CLI accepts, so one sweep of the needle covers "Haiku at low effort" to "Opus at
 * max". A provider that lists no models (Codex) gets efforts alone; one with no efforts (Cursor) gets models.
 */
export function notchesFor(o: ModelOptions, currentModel: string): Notch[] {
  const models = o.models.map((m, i) => ({ ...m, t: tier(m.id, m.label), i })).sort((a, b) => a.t - b.t || a.i - b.i);
  if (models.length && o.efforts.length) {
    return models.flatMap((m) => o.efforts.map((e) => ({ model: m.id, effort: e, label: `${m.label} · ${EFFORT_LABEL[e] ?? e} effort`, group: m.label })));
  }
  if (models.length) return models.map((m) => ({ model: m.id, effort: "", label: m.label, group: m.label }));
  if (o.efforts.length) return o.efforts.map((e) => ({ model: currentModel, effort: e, label: `${EFFORT_LABEL[e] ?? e} effort`, group: "" }));
  return [];
}

/** What the position costs, in words the author can act on; no invented seconds or dollars. */
function pace(f: number): string {
  if (f < 0.34) return "Quick and cheap. Wording, small fixes, a caption.";
  if (f < 0.67) return "Balanced. Most requests, one file or two.";
  return "Slow and costly. Reasoning across the code and the paper.";
}

const CX = 120, CY = 108, R = 98;
const A0 = 168, A1 = 12; // degrees, left end → right end of the sweep
const rad = (deg: number) => (deg * Math.PI) / 180;
const at = (deg: number, r: number) => ({ x: CX + r * Math.cos(rad(deg)), y: CY - r * Math.sin(rad(deg)) });
const angleOf = (i: number, n: number) => (n <= 1 ? (A0 + A1) / 2 : A0 - (i * (A0 - A1)) / (n - 1));
function arc(from: number, to: number, r: number): string {
  const a = at(from, r), b = at(to, r);
  const large = Math.abs(from - to) > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

interface Props {
  options: ModelOptions;
  model: string;
  effort: string;
  /** The CLI's name, for the readout ("claude's default"). */
  cli: string;
  onChange: (model: string, effort: string) => void;
  /** Type a model id the list does not know. Shown only when the provider accepts one. */
  onCustom?: () => void;
}

/**
 * One needle over one arc, Fast at the left and Deep at the right: the model tiers the CLI knows, each
 * divided into its effort levels. Drag the needle, click a tick, or use the arrow keys. The readout names
 * the position and what it costs in time and money; Default hands both choices back to the CLI.
 */
export function ModelDial({ options, model, effort, cli, onChange, onCustom }: Props) {
  const notches = useMemo(() => notchesFor(options, model), [options, model]);
  const n = notches.length;
  const idx = notches.findIndex((k) => k.model === model && k.effort === effort);
  const isDefault = model === "" && effort === "";
  const custom = idx < 0 && !isDefault;
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const groups = useMemo(() => {
    const out: { label: string; from: number; to: number }[] = [];
    notches.forEach((k, i) => { const g = out[out.length - 1]; if (g && g.label === k.group) g.to = i; else out.push({ label: k.group, from: i, to: i }); });
    return out;
  }, [notches]);

  const indexAt = (clientX: number, clientY: number): number => {
    const el = svg.current!; const r = el.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * 240, y = ((clientY - r.top) / r.height) * 132;
    let deg = (Math.atan2(CY - y, x - CX) * 180) / Math.PI; // 0 right, 90 up, 180 left
    if (deg < -60) deg = 180; // below the hub on the left: clamp to the left end
    else if (deg < 0) deg = 0;
    const f = (A0 - Math.min(A0, Math.max(A1, deg))) / (A0 - A1);
    return Math.round(f * (n - 1));
  };
  const commit = (i: number) => { const k = notches[Math.max(0, Math.min(n - 1, i))]; if (k) onChange(k.model, k.effort); };
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => { if (!n) return; dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ } commit(indexAt(e.clientX, e.clientY)); };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => { if (!n) return; const i = indexAt(e.clientX, e.clientY); if (dragging.current) commit(i); else setHover(i); };
  const onPointerUp = () => { dragging.current = false; };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!n) return;
    const cur = idx >= 0 ? idx : Math.floor((n - 1) / 2);
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); commit(cur + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); commit(cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); commit(0); }
    else if (e.key === "End") { e.preventDefault(); commit(n - 1); }
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); onChange("", ""); }
  };

  if (!n) {
    // Nothing to sweep: the CLI names no models and takes no effort flag. Only a typed id is possible.
    return (
      <div className="dial empty">
        <span className="dial-name">{model ? model : `${cli}'s default model`}</span>
        {onCustom && <button className="link" onClick={onCustom}>{model ? "Change model id…" : "Type a model id…"}</button>}
        {model && <button className="link" onClick={() => onChange("", "")}>Default</button>}
      </div>
    );
  }

  const shownIdx = hover ?? (idx >= 0 ? idx : null);
  const needleIdx = idx >= 0 ? idx : (n - 1) / 2;
  const needleDeg = angleOf(needleIdx, n);
  const f = n > 1 ? needleIdx / (n - 1) : 0.5;
  const read = shownIdx != null ? notches[shownIdx] : null;
  const valueText = isDefault ? `${cli}'s default` : custom ? model : notches[idx].label;
  const showGroupLabels = groups.length > 1 && groups.length <= 4 && groups[0].label;

  return (
    <div className={`dial ${isDefault ? "default" : ""} ${custom ? "custom" : ""}`}>
      <svg ref={svg} viewBox="0 0 240 132" className="dial-face" role="slider" tabIndex={0}
        aria-label="Model and effort" aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={idx >= 0 ? idx : Math.floor((n - 1) / 2)} aria-valuetext={valueText}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown}>
        <path className="track" d={arc(A0, A1, R)} />
        {idx >= 0 && <path className="travel" d={arc(A0, needleDeg, R)} />}
        {notches.map((k, i) => {
          const deg = angleOf(i, n);
          const boundary = i === 0 || k.group !== notches[i - 1].group;
          const a = at(deg, R - (boundary ? 14 : 8)), b = at(deg, R);
          return <line key={i} className={`tick ${boundary ? "major" : ""} ${i === shownIdx ? "at" : ""} ${idx >= 0 && i <= idx ? "past" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
        {showGroupLabels && groups.map((g) => {
          const mid = (angleOf(g.from, n) + angleOf(g.to, n)) / 2; const p = at(mid, R - 26);
          return <text key={g.label} className="group" x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle">{g.label}</text>;
        })}
        <text className="end" x={at(A0, R + 2).x} y={CY + 14} textAnchor="start">Fast</text>
        <text className="end" x={at(A1, R + 2).x} y={CY + 14} textAnchor="end">Deep</text>
        <g className="needle" style={{ transform: `rotate(${90 - needleDeg}deg)`, transformOrigin: `${CX}px ${CY}px` }}>
          <line x1={CX} y1={CY} x2={CX} y2={CY - (R - 18)} />
          <circle cx={CX} cy={CY - (R - 18)} r="2.5" />
        </g>
        <circle className="hub" cx={CX} cy={CY} r="4" />
      </svg>
      <div className="dial-read">
        <div className="dial-line">
          <span className="dial-name">{read ? read.label : isDefault ? `${cli}'s default` : model}</span>
          {!isDefault && !read && custom && <span className="dial-tag">typed</span>}
        </div>
        <p className="dial-pace">{read ? pace(shownIdx! / Math.max(1, n - 1)) : isDefault ? "Model and effort as the CLI is configured. Sweep the needle to choose." : custom ? "A model id the list does not know; the CLI decides its effort." : pace(f)}</p>
        <div className="dial-actions">
          {!isDefault && <button className="link" onClick={() => onChange("", "")} title="Let the CLI pick both">Default</button>}
          {onCustom && <button className="link" onClick={onCustom}>Type a model id…</button>}
        </div>
      </div>
    </div>
  );
}
