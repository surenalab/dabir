import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Checkpoint } from "../lib/backend";

/** Dash width plus gap, in px. Kept in step with .scrub in app.css. */
const PITCH = 6;

export type StepKind = "you" | "agent" | "system";

interface Props {
  /** Newest first, as the History list holds them. */
  steps: Checkpoint[];
  kindOf: (message: string) => StepKind;
  /** The step open in the list, if any. */
  openId: string | null;
  /** Hover or drag reaches a step: the list marks it. Null when the pointer leaves. */
  onPeek: (id: string | null) => void;
  /** Click, release after a drag, or Enter: open the step. */
  onPick: (id: string) => void;
}

function dayOf(at: number): string { return new Date(at * 1000).toDateString(); }
function when(at: number): string {
  const d = new Date(at * 1000); const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${time}`;
}

/**
 * The paper's history as a row of dashes, oldest on the left, newest at the right edge. Each save or
 * accepted agent change is one dash; agent steps stand taller and take the accent, system steps (restores, autosaves) sit low, a day boundary opens
 * a gap. Hover or drag across the row to read a step and see it marked in the list below; release or
 * click to open it. When a new step lands, the row slides left by one dash to make room for it.
 */
export function Scrubber({ steps, kindOf, openId, onPeek, onPick }: Props) {
  const rail = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(60);
  const [hover, setHover] = useState<number | null>(null); // index into `shown`
  const dragging = useRef(false);
  const row = useRef<HTMLDivElement>(null);
  const known = useRef<Set<string> | null>(null);

  // How many dashes the rail can hold, from its width; the rest fold into a stub at the left.
  useLayoutEffect(() => {
    const el = rail.current; if (!el) return;
    const measure = () => setFit(Math.max(8, Math.floor((el.clientWidth - 24) / PITCH)));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Oldest → newest, cut to what fits.
  const shown = useMemo(() => {
    const oldestFirst = steps.slice().reverse();
    return oldestFirst.slice(Math.max(0, oldestFirst.length - fit));
  }, [steps, fit]);
  const hidden = steps.length - shown.length;

  // New steps arrive at the right edge; the whole row slides left by their width so the eye follows the
  // older dashes making room. Driven from here rather than from state so a re-render never replays it.
  useEffect(() => {
    const ids = new Set(steps.map((s) => s.id));
    if (known.current && row.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      let fresh = 0; for (const s of steps) { if (!known.current.has(s.id)) fresh++; else break; }
      if (fresh > 0) row.current.animate([{ transform: `translateX(${fresh * PITCH}px)` }, { transform: "translateX(0)" }], { duration: 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
    known.current = ids;
  }, [steps]);

  const indexAt = (clientX: number): number | null => {
    const el = rail.current; if (!el) return null;
    const dashes = el.querySelectorAll<HTMLElement>(".dash");
    let best: number | null = null, bestD = Infinity;
    dashes.forEach((d) => {
      const r = d.getBoundingClientRect(); const cx = r.left + r.width / 2; const dist = Math.abs(clientX - cx);
      if (dist < bestD) { bestD = dist; best = Number(d.dataset.i); }
    });
    return best;
  };
  const peek = (i: number | null) => { setHover(i); onPeek(i == null ? null : shown[i].id); };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { peek(indexAt(e.clientX)); };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => { dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ } peek(indexAt(e.clientX)); };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return; dragging.current = false;
    const i = indexAt(e.clientX); if (i != null) onPick(shown[i].id);
  };
  const onPointerLeave = () => { if (!dragging.current) peek(null); };

  const openIndex = openId ? shown.findIndex((s) => s.id === openId) : -1;
  const current = hover ?? (openIndex >= 0 ? openIndex : null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = shown.length; if (!n) return;
    const at = current ?? n - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "ArrowRight") next = Math.min(n - 1, at + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(shown[at].id); return; }
    if (next != null) { e.preventDefault(); peek(next); }
  };

  const read = current != null ? shown[current] : null;
  const first = shown[0];
  return (
    <div className="scrub" aria-label="History scrubber">
      <div ref={rail} className="scrub-rail" role="slider" tabIndex={0}
        aria-valuemin={0} aria-valuemax={Math.max(0, shown.length - 1)} aria-valuenow={current ?? Math.max(0, shown.length - 1)}
        aria-valuetext={read ? `${read.message}, ${when(read.at)}` : `${steps.length} steps`}
        onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave} onKeyDown={onKeyDown} onBlur={() => peek(null)}>
        <div ref={row} className="scrub-row">
          {hidden > 0 && <span className="stub" title={`${hidden} earlier step${hidden === 1 ? "" : "s"}`} aria-hidden />}
          {shown.map((s, i) => {
            const newDay = i > 0 && dayOf(s.at) !== dayOf(shown[i - 1].at);
            const cls = ["dash", kindOf(s.message), i === current ? "at" : "", s.id === openId ? "open" : "", newDay ? "day" : ""].filter(Boolean).join(" ");
            return <span key={s.id} className={cls} data-i={i} aria-hidden />;
          })}
        </div>
      </div>
      <div className="scrub-read" aria-live="polite">
        {read ? (
          <><span className="msg">{read.message}</span><span className="when">{when(read.at)}</span></>
        ) : (
          <><span className="msg quiet">{steps.length} step{steps.length === 1 ? "" : "s"}{first ? ` since ${new Date(first.at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</span><span className="when">now</span></>
        )}
      </div>
    </div>
  );
}
