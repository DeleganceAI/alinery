import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Module-level pub/sub so any component can fire a toast without prop-drilling.
// Stacking toasts.
export type ToastTone = "info" | "success" | "error" | "loading";
/** "short" is a bare acknowledgement — the user knows what they asked for and
    there is nothing to read; "long" is the default, for a message that carries
    information. */
export type ToastLength = "short" | "long";
export type ToastEntry = { id: string; msg: string; tone: ToastTone; length?: ToastLength; removing?: boolean; expanded?: boolean };

/** Handle for a toast that reports work in progress: resolving it transitions that same
    entry in place, however much the message text changes on the way. */
export type LoadingToast = { success: (msg: string, length?: ToastLength) => void; error: (msg: string) => void };

/** `id` pins an update to one existing entry — a loading toast being resolved. Without it
    the message text identifies the entry, which is how repeats refresh in place. */
type ToastMessage = Omit<ToastEntry, "id"> & { id?: string };
type Fn = (entry: ToastMessage) => void;
const listeners = new Set<Fn>();

export function toast(msg: string, tone: ToastTone = "info", length: ToastLength = "long") {
  for (const l of listeners) l({ msg, tone, length });
}
toast.success = (msg: string, length?: ToastLength) => toast(msg, "success", length);
toast.error = (msg: string) => toast(msg, "error");
toast.info = (msg: string, length?: ToastLength) => toast(msg, "info", length);

// A loading toast is the one tone whose caller owns the ending: it stays up until the
// work it announces settles, so the entry is pinned by id rather than by its message —
// which necessarily changes when it resolves.
let loadingSeq = 0;
toast.loading = (msg: string): LoadingToast => {
  const id = `loading:${++loadingSeq}`;
  const resolve = (next: Omit<ToastEntry, "id">) => {
    for (const l of listeners) l({ ...next, id });
  };
  resolve({ msg, tone: "loading" });
  return {
    success: (next, length) => resolve({ msg: next, tone: "success", length }),
    error: (next) => resolve({ msg: next, tone: "error" }),
  };
};

const AUTO_DISMISS_MS: Record<ToastLength, number> = { short: 1800, long: 4000 };
// Matches the --dur-overlay exit transition in theme.css.
const REMOVE_MS = 200;
const ICONS: Record<ToastTone, typeof Info> = { info: Info, success: CircleCheck, error: CircleAlert, loading: LoaderCircle };

// A toast is identified by what it says, so firing the same message again
// refreshes that toast in place instead of stacking a copy of it. Repeat
// notifications are how the stack gets spammed: one drag across the interface
// scale slider saves once per step, and that has to read as a single toast.
const entryId = (e: Omit<ToastEntry, "id">) => `${e.tone}:${e.msg}`;

export function Toast() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /* Only sweeps an entry still marked removing: a refresh that revives an id
     mid-exit clears the flag, and this stale timer must leave it alone. */
  const sweep = (id: string) => {
    // Cancel any sweep already pending for this id so it can't fire after this one.
    clearTimeout(timers.current.get(`sweep:${id}`));
    const handle = setTimeout(() => {
      timers.current.delete(`sweep:${id}`);
      setToasts((prev) => prev.filter((t) => !(t.id === id && t.removing)));
    }, REMOVE_MS);
    // Keyed apart from the dismiss timer so unmount clears both.
    timers.current.set(`sweep:${id}`, handle);
  };

  useEffect(() => {
    const timeouts = timers.current;
    const l: Fn = (e) => {
      const id = e.id ?? entryId(e);
      // A refresh moves the entry to the end so it reads as the newest —
      // otherwise a repeat of an already-overflowed toast stays hidden.
      setToasts((prev) => [...prev.filter((t) => t.id !== id), { ...e, id }]);

      // Refreshing restarts the dismiss countdown; the previous one is void.
      clearTimeout(timeouts.get(id));
      timeouts.delete(id);
      // Errors hold detail the user may need to read; a loading toast is held by the
      // caller that started it, which resolves this same entry when the work settles.
      if (e.tone !== "error" && e.tone !== "loading") {
        timeouts.set(
          id,
          setTimeout(
            () => {
              timeouts.delete(id);
              setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, removing: true } : t)));
              sweep(id);
            },
            AUTO_DISMISS_MS[e.length ?? "long"],
          ),
        );
      }
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      for (const t of timeouts.values()) clearTimeout(t);
      timeouts.clear();
    };
  }, []);

  const dismiss = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, removing: true } : t)));
    sweep(id);
  };

  const VISIBLE_COUNT = 3;

  return (
    // The live region must exist before content arrives — AT reliably announces
    // insertions into a pre-existing region, not regions created with their content
    // (same pattern as the palette count region in CommandPalette).
    <div
      className="toast-viewport"
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setExpanded(false);
      }}
    >
      {toasts.map((entry, index) => {
        const Icon = ICONS[entry.tone];
        // Calculate offset from the *end* of the array (most recent is at the end)
        const reverseIndex = toasts.length - 1 - index;
        // Overflow toasts past the visible window: fully hidden (inert removes
        // them from tab order and hit testing), not just faded to opacity 0.
        const hiddenOverflow = !expanded && reverseIndex >= VISIBLE_COUNT;
        const isRemoving = entry.removing || hiddenOverflow;

        let yOffset = 0;
        let scale = 1;
        let opacity = 1;

        if (isRemoving) {
          yOffset = 20;
          scale = 0.9;
          opacity = 0;
        } else if (expanded) {
          // When expanded, list them vertically
          yOffset = -(reverseIndex * 56); // approximate height + gap
          scale = 1;
          opacity = 1;
        } else {
          // Sonner stacking effect
          yOffset = -(reverseIndex * 14);
          scale = 1 - reverseIndex * 0.05;
          opacity = 1 - reverseIndex * 0.15;
        }

        return (
          <div
            key={entry.id}
            className={`toast ${entry.tone}${entry.removing ? "" : " on"}`}
            inert={hiddenOverflow}
            style={
              {
                "--y": `${yOffset}px`,
                "--scale": scale,
                "--opacity": opacity,
                // Entries are appended, so a higher index is newer — it must paint on top.
                zIndex: index + 1,
              } as React.CSSProperties
            }
          >
            <Icon size={16} strokeWidth={2} aria-hidden="true" />
            <span className="toast-msg">{entry.msg}</span>
            <button type="button" className="toast-dismiss" aria-label="Dismiss" title="Dismiss" onClick={(e) => dismiss(entry.id, e)}>
              <X size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
