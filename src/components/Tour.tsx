import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { chord } from "../lib/keys";

/** One stop of the guided tour: what to point at, what to say, and what the app should do as the stop opens. */
export interface TourStep {
  id: string;
  /** CSS selector of the element to spotlight; null centres the card with no spotlight. */
  target: string | null;
  title: string;
  body: ReactNode;
  /** Keys worth knowing at this stop, shown as a row of kbd hints. */
  keys?: { keys: string; does: string }[];
  /** Runs when the stop opens: open a panel, switch a mode, select a file. */
  enter?: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 6;

function measure(selector: string | null): Rect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

/** Where the card goes: below the target when there is room, else above, else beside it; centred when there is no target. */
function place(rect: Rect | null, card: { w: number; h: number }): { top: number; left: number; from: "top" | "bottom" | "left" | "right" | "center" } {
  const vw = window.innerWidth, vh = window.innerHeight, gap = 14, m = 12;
  if (!rect) return { top: Math.max(m, (vh - card.h) / 2), left: Math.max(m, (vw - card.w) / 2), from: "center" };
  const clampX = (x: number) => Math.min(Math.max(m, x), vw - card.w - m);
  const clampY = (y: number) => Math.min(Math.max(m, y), vh - card.h - m);
  if (rect.top + rect.height + gap + card.h <= vh - m) return { top: rect.top + rect.height + gap, left: clampX(rect.left + rect.width / 2 - card.w / 2), from: "top" };
  if (rect.top - gap - card.h >= m) return { top: rect.top - gap - card.h, left: clampX(rect.left + rect.width / 2 - card.w / 2), from: "bottom" };
  if (rect.left + rect.width + gap + card.w <= vw - m) return { top: clampY(rect.top + rect.height / 2 - card.h / 2), left: rect.left + rect.width + gap, from: "left" };
  return { top: clampY(rect.top + rect.height / 2 - card.h / 2), left: clampX(rect.left - gap - card.w), from: "right" };
}

/**
 * A step-by-step walk through the app on the sample paper. A spotlight follows the element each stop talks about;
 * the card sits beside it. The steps decide what the app does at each stop (App owns that), so the tour shows real
 * panels rather than pictures of them. Keyboard: → or Enter next, ← back, Esc leaves.
 */
export function Tour({ steps, step, onStep, onClose }: { steps: TourStep[]; step: number; onStep: (i: number) => void; onClose: () => void }) {
  const current = steps[step];
  const [rect, setRect] = useState<Rect | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; from: string } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const entered = useRef<number>(-1);

  // Enter the stop once, then keep measuring while panels open and layouts settle.
  useEffect(() => {
    if (entered.current !== step) { entered.current = step; current?.enter?.(); }
    let alive = true;
    let ticks = 0;
    const tick = () => {
      if (!alive) return;
      const r = measure(current?.target ?? null);
      setRect((old) => (old && r && old.top === r.top && old.left === r.left && old.width === r.width && old.height === r.height ? old : r));
      if (ticks++ < 40) window.setTimeout(tick, ticks < 10 ? 30 : 120);
    };
    tick();
    const onResize = () => { ticks = 0; tick(); };
    window.addEventListener("resize", onResize);
    return () => { alive = false; window.removeEventListener("resize", onResize); };
  }, [step, current]);

  useLayoutEffect(() => {
    const el = card.current; if (!el) return;
    const p = place(rect, { w: el.offsetWidth, h: el.offsetHeight });
    setPos(p);
  }, [rect, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { if (!(e.target instanceof HTMLTextAreaElement) && !(e.target as HTMLElement)?.closest?.(".cm-editor, input")) { e.preventDefault(); if (step < steps.length - 1) onStep(step + 1); else onClose(); } }
      else if (e.key === "ArrowLeft") { if (!(e.target as HTMLElement)?.closest?.(".cm-editor, input, textarea")) { e.preventDefault(); if (step > 0) onStep(step - 1); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, steps.length, onStep, onClose]);

  if (!current) return null;
  const last = step === steps.length - 1;
  return (
    <div className="tour" role="dialog" aria-modal="false" aria-label={`Tour, step ${step + 1} of ${steps.length}: ${current.title}`}>
      {/* One veil with a hole cut by a mask, and a ring on the hole: SVG geometry animates without touching layout. */}
      {(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        const r = rect ?? { top: vh / 2, left: vw / 2, width: 0, height: 0 };
        return (
          <svg className={`tour-veil ${rect ? "" : "none"}`} width={vw} height={vh} viewBox={`0 0 ${vw} ${vh}`} aria-hidden>
            <defs>
              <mask id="tour-mask">
                <rect width={vw} height={vh} fill="white" />
                <rect className="hole" width="1" height="1" fill="black" style={{ transform: `translate(${r.left}px, ${r.top}px) scale(${Math.max(r.width, 0.01)}, ${Math.max(r.height, 0.01)})` }} />
              </mask>
            </defs>
            <rect className="shade" width={vw} height={vh} mask="url(#tour-mask)" />
            <rect className="ring" width="1" height="1" vectorEffect="non-scaling-stroke" style={{ transform: `translate(${r.left}px, ${r.top}px) scale(${Math.max(r.width, 0.01)}, ${Math.max(r.height, 0.01)})` }} />
          </svg>
        );
      })()}
      <div ref={card} key={step} className={`tour-card from-${pos?.from ?? "center"} ${pos ? "" : "measuring"}`} style={pos ? { top: pos.top, left: pos.left } : undefined}>
        <div className="tour-head">
          <span className="tour-count">{step + 1} <span className="of">/ {steps.length}</span></span>
          <button className="tour-x" onClick={onClose} aria-label="Leave the tour" title="Leave the tour (Esc)"><X /></button>
        </div>
        <h2>{current.title}</h2>
        <div className="tour-body">{current.body}</div>
        {current.keys && current.keys.length > 0 && (
          <div className="tour-keys">
            {current.keys.map((k) => <span key={k.keys}><kbd>{chord(k.keys)}</kbd> {k.does}</span>)}
          </div>
        )}
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden>
            {steps.map((s, i) => <button key={s.id} className={i === step ? "on" : i < step ? "done" : ""} onClick={() => onStep(i)} tabIndex={-1} />)}
          </div>
          <div className="tour-nav">
            {step > 0 && <button className="btn" onClick={() => onStep(step - 1)}><ArrowLeft /> Back</button>}
            {last ? <button className="btn primary" onClick={onClose}>Done</button> : <button className="btn primary" onClick={() => onStep(step + 1)}>Next <ArrowRight /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}
