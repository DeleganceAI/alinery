import { Check, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export function restoreNameFocus(trigger: HTMLElement | null) {
  if (!trigger?.isConnected) return;
  // Restoring the pencil after Enter preserves :focus-visible and leaves it showing.
  // Return to the name field instead; Tab still reaches its edit button.
  (trigger.closest<HTMLElement>(".editable-name-display") ?? trigger).focus();
}

export function NameEditor({
  value,
  label,
  kind = "session",
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  kind?: "session" | "task";
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const mounted = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const [trigger] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    mounted.current = true;
    input.current?.focus();
    input.current?.select();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function save() {
    if (saving.current) return;
    // Rust str::trim uses Unicode White_Space, unlike JavaScript trim (BOM/NEL).
    const name = draft.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    if (!name) {
      setError("Name must not be empty.");
      return;
    }
    if (kind === "session") {
      if (/[\p{Cc}\p{Surrogate}\u2028\u2029]/u.test(name)) {
        setError("Use a single-line name without control characters.");
        return;
      }
      if ([...name].length > 40) {
        setError("Session names must be at most 40 characters.");
        return;
      }
    }
    saving.current = true;
    setPending(true);
    setError("");
    try {
      await onSave(name);
      if (mounted.current) restoreNameFocus(trigger);
    } catch (cause) {
      if (mounted.current) setError(String(cause instanceof Error ? cause.message : cause).slice(0, 300));
    } finally {
      saving.current = false;
      if (mounted.current) setPending(false);
    }
  }

  function cancel() {
    if (saving.current) return;
    onCancel();
    restoreNameFocus(trigger);
  }

  return (
    <div
      className="name-editor"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== "Escape" && event.key !== " ") return;
        event.stopPropagation();
        if (event.key === " " || (event.key === "Enter" && event.target !== input.current)) return;
        event.preventDefault();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") void save();
        else cancel();
      }}
    >
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <input
        ref={input}
        id={id}
        className="field-input"
        value={draft}
        disabled={pending}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="name-editor-actions">
        <button type="button" className="btn small" aria-label={pending ? "Saving…" : "Save"} title="Save (Enter)" disabled={pending} onClick={() => void save()}>
          <Check size={16} aria-hidden="true" />
        </button>
        <button type="button" className="btn ghost small" aria-label="Cancel" title="Cancel (Escape)" disabled={pending} onClick={cancel}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {error && (
        <div className="err" role="alert" id={`${id}-error`}>
          {error}
        </div>
      )}
    </div>
  );
}
