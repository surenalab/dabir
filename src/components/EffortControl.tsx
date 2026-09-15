import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, RotateCcw, Zap } from "lucide-react";
import type { ModelOptions } from "../lib/backend";

const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const effortName = (e: string) => EFFORT_LABEL[e] ?? e;

const LIGHT = /\b(mini|fast|flash|haiku|lite|small|nano|turbo|instant)\b/i;
const HEAVY = /\b(opus|max|pro|thinking|ultra|heavy|reasoning|deep)\b/i;
/** Weakest to strongest, from the names when they say so, keeping the CLI's order otherwise. */
function tier(id: string, label: string): number {
  const t = `${id} ${label}`;
  if (LIGHT.test(t)) return 0;
  if (HEAVY.test(t)) return 2;
  return 1;
}

/** What a level costs, in words the author can act on; no invented seconds or dollars. */
function pace(f: number): string {
  if (f < 0.34) return "Quick and cheap: wording, a caption, a small fix.";
  if (f < 0.67) return "Balanced: most requests, one file or two.";
  return "Slow and thorough: reasoning across the code and the paper.";
}

/** Knob radius and the track's inner padding, in px. Kept in step with .effort-track in app.css. */
const PAD = 12;

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
 * The model and effort choice for the composer: a pill in the composer's bar that names the setting, and a
 * popover above it with one slider across the effort levels the CLI accepts (drag the knob, or click a dot;
 * on release it settles on the nearest level) and the models the CLI lists as chips, weakest to strongest.
 * The readout names the level in the accent and the model under it; Reset hands both back to the CLI.
 */
export function EffortControl({ options, model, effort, cli, onChange, onCustom }: Props) {
  const [open, setOpen] = useState(false);
  const [below, setBelow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // The popover opens upward, over the composer's text; when the composer sits near the top of the scrolling
  // pane there is no room there, so it opens downward instead.
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const pane = root.current.closest(".inspector-body")?.getBoundingClientRect();
    const r = root.current.getBoundingClientRect();
    setBelow(!!pane && r.top - pane.top < 250);
  }, [open]);
  const efforts = options.efforts;
  const n = efforts.length;
  const models = useMemo(() => options.models.map((m, i) => ({ ...m, t: tier(m.id, m.label), i })).sort((a, b) => a.t - b.t || a.i - b.i), [options.models]);
  const modelLabel = model ? (options.models.find((m) => m.id === model)?.label ?? model) : "";
  const isDefault = !model && !effort;
  const idx = efforts.indexOf(effort);

  // Close on a click elsewhere or Escape; the pill keeps focus so the keyboard user lands back where they were.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); (root.current?.querySelector(".effort-pill") as HTMLElement | null)?.focus(); } };
    document.addEventListener("pointerdown", away, true); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", esc); };
  }, [open]);

  // ---- the slider ----
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null); // knob x while the pointer holds it
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const el = track.current; if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [open, n]);
  const inner = Math.max(0, width - 2 * PAD);
  const xOf = (i: number) => PAD + (n > 1 ? (i * inner) / (n - 1) : inner / 2);
  const indexAtX = (x: number): number => {
    const f = inner > 0 ? (x - PAD) / inner : 0.5;
    return Math.round(Math.min(1, Math.max(0, f)) * (n - 1));
  };
  const localX = (e: PointerEvent<HTMLDivElement>) => e.clientX - e.currentTarget.getBoundingClientRect().left;
  const commit = (i: number) => { const e = efforts[Math.max(0, Math.min(n - 1, i))]; if (e != null && e !== effort) onChange(model, e); };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!n) return;
    e.currentTarget.focus();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    setDrag(Math.min(width - PAD, Math.max(PAD, localX(e))));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!n) return;
    if (drag != null) setDrag(Math.min(width - PAD, Math.max(PAD, localX(e))));
    else setHover(indexAtX(localX(e)));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (drag == null) return;
    setDrag(null); commit(indexAtX(localX(e)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const cur = idx >= 0 ? idx : Math.floor((n - 1) / 2);
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); commit(cur + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); commit(cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); commit(0); }
    else if (e.key === "End") { e.preventDefault(); commit(n - 1); }
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); onChange(model, ""); }
  };

  // Where the knob sits: under the pointer while dragging, on its level otherwise, at the middle when the
  // CLI decides (drawn hollow so it reads as "not set").
  const restIdx = idx >= 0 ? idx : (n - 1) / 2;
  const knobX = drag ?? xOf(restIdx);
  const liveIdx = drag != null ? indexAtX(drag) : null;
  const shownIdx = liveIdx ?? hover ?? (idx >= 0 ? idx : null);
  const shownEffort = shownIdx != null ? efforts[shownIdx] : "";
  const fillTo = drag ?? (idx >= 0 ? xOf(idx) : PAD);

  const pillText = isDefault ? "Select effort" : [modelLabel, effort ? effortName(effort) : ""].filter(Boolean).join(" · ");
  const reset = () => onChange("", "");

  return (
    <div ref={root} className={`effort ${open ? "open" : ""}`}>
      <button type="button" className={`effort-pill ${isDefault ? "unset" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        title="Model and effort for this agent" onClick={() => setOpen((o) => !o)}>
        <Zap aria-hidden />
        <span className="effort-pill-text">{pillText}</span>
        <ChevronDown aria-hidden className="chev" />
      </button>
      {open && (
        <div className={`effort-pop ${below ? "below" : ""}`} role="dialog" aria-label="Model and effort">
          <div className="effort-head">
            <span className="effort-bolt" aria-hidden><Zap /></span>
            <div className="effort-read">
              <span key={shownEffort || "default"} className={`effort-level ${shownEffort ? "" : "quiet"}`}>
                {shownEffort ? effortName(shownEffort) : n ? "Default effort" : modelLabel || "Default"}
              </span>
              <span className="effort-model">{modelLabel || `${cli}'s default model`}</span>
            </div>
            <button type="button" className="effort-reset" onClick={reset} disabled={isDefault} title="Back to the CLI's own model and effort" aria-label="Reset to default"><RotateCcw aria-hidden /></button>
          </div>

          {n > 0 && (
            <>
              <div ref={track} className={`effort-track ${drag != null ? "dragging" : ""} ${idx < 0 ? "unset" : ""}`} role="slider" tabIndex={0}
                aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={idx >= 0 ? idx : Math.floor((n - 1) / 2)} aria-valuetext={effort ? effortName(effort) : "Default"}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={() => setHover(null)} onKeyDown={onKeyDown}>
                <div className="effort-fill" style={{ transform: `scaleX(${width ? fillTo / width : 0})` }} />
                {efforts.map((e, i) => <span key={e} className={`effort-dot ${xOf(i) <= fillTo + 0.5 ? "on" : ""}`} style={{ transform: `translateX(${xOf(i)}px)` }} aria-hidden />)}
                <div className="effort-knob" style={{ transform: `translateX(${knobX}px)` }} />
              </div>
              <p className="effort-pace">{shownIdx != null ? pace(shownIdx / Math.max(1, n - 1)) : "Effort as the CLI is configured. Drag the knob to choose."}</p>
            </>
          )}

          {(models.length > 0 || onCustom) && (
            <div className="effort-models" role="radiogroup" aria-label="Model">
              {models.map((m) => (
                <button type="button" key={m.id} role="radio" aria-checked={m.id === model} className={`effort-chip ${m.id === model ? "on" : ""}`} onClick={() => onChange(m.id, effort)}>{m.label}</button>
              ))}
              {model && !options.models.some((m) => m.id === model) && <button type="button" role="radio" aria-checked className="effort-chip on typed" onClick={onCustom}>{model}</button>}
              {onCustom && <button type="button" className="effort-chip more" onClick={onCustom}>Type a model id…</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
