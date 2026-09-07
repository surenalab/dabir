import { useRef } from "react";

interface Option { value: string; label: string; title?: string; disabled?: boolean }

/** A macOS-style segmented control: one choice, radio semantics, arrow keys move between segments. */
export function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    onChange(next.value);
    ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label} ref={ref} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value} role="radio" aria-checked={value === o.value} data-value={o.value}
          tabIndex={value === o.value ? 0 : -1} title={o.title} disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
