import { type CSSProperties, useEffect, useRef, useState } from "react";

/** How long typing has to stop before the value is saved. */
const COMMIT_DELAY_MS = 700;

/**
 * A number field that autosaves without fighting the keyboard.
 *
 * Clamping a controlled input on every keystroke makes it unusable: clearing the field
 * lands on the minimum, so a digit cannot be deleted past it, and typing the "30" of
 * "100 → 30" passes through "130", which clamps straight back to the maximum. This keeps
 * what was typed in a local draft, saves the clamped number once typing pauses (or on
 * Enter, or on blur), and only then shows the clamped number. An empty or half-typed
 * field saves nothing and falls back to the saved value.
 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  label,
  disabled = false,
  onChange,
  style,
  className = "field-input",
  delay = COMMIT_DELAY_MS,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  disabled?: boolean;
  onChange: (next: number) => void;
  style?: CSSProperties;
  className?: string;
  delay?: number;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  const [draft, setDraft] = useState(() => String(value));
  const [editing, setEditing] = useState(false);
  const draftRef = useRef(draft);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the saved value while nobody is typing here, so a change made elsewhere shows up.
  useEffect(() => {
    if (editing) return;
    setDraft(String(value));
    draftRef.current = String(value);
  }, [value, editing]);

  const clearTimer = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };

  /** Save the draft if it is a number; anything unparseable leaves the saved value alone. */
  const commit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const next = clamp(parsed);
    if (next !== value) onChange(next);
  };

  // Leaving the section mid-pause must not lose the edit, and the timer must not outlive the field.
  // The latest commit lives in a ref so that cleanup sees the last rendered value, not the first.
  const latest = useRef({ commit, editing });
  useEffect(() => {
    latest.current = { commit, editing };
  });
  useEffect(
    () => () => {
      clearTimer();
      if (latest.current.editing) latest.current.commit(draftRef.current);
    },
    [],
  );

  return (
    <input
      className={className}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      style={style}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        draftRef.current = text;
        clearTimer();
        timer.current = setTimeout(() => {
          timer.current = null;
          commit(text);
        }, delay);
      }}
      onBlur={() => {
        clearTimer();
        setEditing(false);
        commit(draftRef.current);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        clearTimer();
        commit(draftRef.current);
        // Leaving the field's editing state is what snaps the display to the saved number.
        setEditing(false);
        event.currentTarget.blur();
      }}
    />
  );
}
