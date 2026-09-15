import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PenLine, RotateCcw, Sparkles } from "lucide-react";
import type { Checkpoint } from "../lib/backend";

/** Dash plus gap along the rail, in px. Kept in step with .rail in app.css. */
const PITCH = 7;

export type StepKind = "you" | "agent" | "system";
/** Who made a step, from its message: the author, an agent, or Dabir itself (restore, undo, discard). */
export function stepKind(message: string): StepKind {
  if (/^You /.test(message)) return "you";
  if (/^(Before |Restored |Undid|Autosave)/.test(message)) return "system";
  return "agent";
}
export type Axis = "vertical" | "horizontal";

interface Props {
  /** Newest first, as the History list holds them. */
  steps: Checkpoint[];
  kindOf: (message: string) => StepKind;
  /** Down the left edge of the History pane (newest at the top), or along the bottom of the sidebar (newest at the right). */
  axis?: Axis;
  /** The step open in the list, if any. */
  openId: string | null;
  /** Hover or drag reaches a step: the list marks it. Null when the pointer leaves. */
  onPeek?: (id: string | null) => void;
  /** Click, release after a drag, or Enter: open the step. */
  onPick: (id: string) => void;
}

function when(at: number): string {
  const d = new Date(at * 1000); const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${time}`;
}

/**
 * The paper's history as a line of dashes, one per save or accepted agent change. Down the left edge of the
 * History pane it runs newest at the top; along the bottom of the sidebar it runs oldest at the left, newest at
 * the right edge. Your saves are short, agent steps longer in the accent, restores and autosaves shortest. The
 * dash under the pointer stretches to full length and its neighbours lean toward it; a card beside it names
 * the step, its time and its files, and the list marks the row. Click, release after a drag, or press Enter
 * to open the step; the open step stays long in the accent. A new step slides the line along by one dash and
 * draws itself in. Keyboard: the line is one slider, arrows along its axis, Home and End.
 */
export function Scrubber({ steps, kindOf, axis = "vertical", openId, onPeek, onPick }: Props) {
  const vertical = axis === "vertical";
  const rail = useRef<HTMLDivElement>(null);
  const col = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(40);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const known = useRef<Set<string> | null>(null);

  // How many dashes fit: the pane's height for the vertical rail (which is made as tall as the pane, so it can
  // stay put while the list scrolls), the rail's own width along the bottom of the sidebar.
  useLayoutEffect(() => {
    const el = rail.current; if (!el) return;
    if (vertical) {
      const pane = el.closest<HTMLElement>(".inspector-body") ?? el.parentElement!;
      const measure = () => {
        const h = pane.clientHeight - 2 * 12; // the pane's padding
        el.style.height = `${Math.max(60, h)}px`;
        setFit(Math.max(6, Math.floor((h - 20) / PITCH)));
      };
      measure();
      const ro = new ResizeObserver(measure); ro.observe(pane);
      return () => ro.disconnect();
    }
    const measure = () => setFit(Math.max(6, Math.floor((el.clientWidth - 16) / PITCH)));
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [vertical]);

  // In reading order along the axis: top to bottom is newest first; left to right is oldest first.
  const shown = useMemo(() => { const s = steps.slice(0, fit); return vertical ? s : s.reverse(); }, [steps, fit, vertical]);
  const hidden = steps.length - shown.length;
  const newest = vertical ? 0 : shown.length - 1;

  // A new step lands at the newest end; the line slides along by its width so the eye sees the older dashes
  // make room. Driven from here rather than from state so a re-render never replays it.
  useEffect(() => {
    const ids = new Set(steps.map((s) => s.id));
    if (known.current && col.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      let fresh = 0; for (const s of steps) { if (!known.current.has(s.id)) fresh++; else break; }
      if (fresh > 0) {
        const from = vertical ? `translateY(${-fresh * PITCH}px)` : `translateX(${fresh * PITCH}px)`;
        col.current.animate([{ transform: from }, { transform: "translate(0, 0)" }], { duration: 380, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
      }
    }
    known.current = ids;
  }, [steps, vertical]);

  const indexAt = (e: PointerEvent<HTMLDivElement>): number | null => {
    const el = col.current; if (!el || !shown.length) return null;
    const r = el.getBoundingClientRect();
    const along = vertical ? e.clientY - r.top : e.clientX - r.left;
    return Math.max(0, Math.min(shown.length - 1, Math.floor(along / PITCH)));
  };
  const peek = (i: number | null) => { setHover(i); onPeek?.(i == null ? null : shown[i].id); };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => { peek(indexAt(e)); };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => { dragging.current = true; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } peek(indexAt(e)); };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return; dragging.current = false;
    const i = indexAt(e); if (i != null) onPick(shown[i].id);
  };
  const onPointerLeave = () => { if (!dragging.current) peek(null); };

  const openIndex = openId ? shown.findIndex((s) => s.id === openId) : -1;
  const [focused, setFocused] = useState(false);
  const current = hover ?? (focused && openIndex >= 0 ? openIndex : null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = shown.length; if (!n) return;
    const at = current ?? (openIndex >= 0 ? openIndex : newest);
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") next = Math.min(n - 1, at + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(shown[at].id); return; }
    if (next != null) { e.preventDefault(); peek(next); }
  };

  const read = current != null ? shown[current] : null;
  const readKind = read ? kindOf(read.message) : null;
  const stub = hidden > 0 && <span className="stub" title={`${hidden} earlier step${hidden === 1 ? "" : "s"}`} aria-hidden />;
  return (
    <div ref={rail} className={`rail ${axis}`} role="slider" tabIndex={0} aria-label="History"
      aria-valuemin={0} aria-valuemax={Math.max(0, shown.length - 1)} aria-valuenow={current ?? Math.max(0, openIndex)}
      aria-valuetext={read ? `${read.message}, ${when(read.at)}` : `${steps.length} steps`}
      onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); peek(null); }}>
      <div ref={col} className="rail-col">
        {!vertical && stub}
        {shown.map((s, i) => {
          const d = current == null ? 9 : Math.abs(i - current);
          const cls = ["dash", kindOf(s.message), d === 0 ? "at" : d === 1 ? "near" : d === 2 ? "far" : "", s.id === openId ? "open" : "", i === newest ? "newest" : ""].filter(Boolean).join(" ");
          return <span key={s.id} className={cls} aria-hidden />;
        })}
        {vertical && stub}
      </div>
      {read && current != null && (
        <div className="rail-card" style={vertical ? { transform: `translateY(${current * PITCH}px)` } : undefined} aria-hidden>
          <div className="rail-card-head">
            <span className={`who ${readKind}`}>{readKind === "you" ? <PenLine /> : readKind === "agent" ? <Sparkles /> : <RotateCcw />}</span>
            <span className="msg">{read.message}</span>
          </div>
          <span className="when">{when(read.at)}</span>
          <div className="files">
            {read.files.slice(0, 3).map((f) => (
              <span key={f.path} className="f"><span className="name">{f.path}</span>{f.binary ? <span className="bin">binary</span> : <><span className="add">+{f.add}</span><span className="del">−{f.del}</span></>}</span>
            ))}
            {read.files.length > 3 && <span className="more">and {read.files.length - 3} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}
