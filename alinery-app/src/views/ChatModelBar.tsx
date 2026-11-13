import { Brain, Check, ChevronUp, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";

/**
 * The model and thinking level above the chat composer: two joined buttons, each opening a list upward. The model list is
 * the starred models plus Providers, which opens the full dialog; the thinking list is this model's levels.
 */
export function ChatModelBar({
  model,
  title,
  thinkingTitle,
  thinking,
  thinkingLevels,
  thinkingDisabledReason,
  onPickModel,
  onPickThinking,
  onProviders,
}: {
  model: string;
  /** Shown while enabled: an in-flight turn says the next turn picks the change up. */
  title?: string;
  thinkingTitle?: string;
  thinking: string | undefined;
  thinkingLevels: string[] | undefined;
  thinkingDisabledReason: string | null;
  onPickModel: (model: string) => void;
  onPickThinking: (level: string) => void;
  onProviders: () => void;
}) {
  const [open, setOpen] = useState<"model" | "thinking" | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (open === "model") {
      // Read on every open: stars change in the Providers dialog.
      void ipc.readModelFavorites("omp").then(setFavorites, () => undefined);
    }
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The stored level always shows, even one this model's list does not name.
  const levels = thinking && thinkingLevels?.length ? (thinkingLevels.includes(thinking) ? thinkingLevels : [...thinkingLevels, thinking]) : [];
  const toggle = (which: "model" | "thinking") => setOpen((current) => (current === which ? null : which));
  const pick = (fn: () => void) => () => {
    setOpen(null);
    fn();
  };

  return (
    <div className="chat-model-bar" ref={box}>
      <div className="btn-group">
        <button
          type="button"
          className="btn small chat-model-btn"
          aria-haspopup="menu"
          aria-expanded={open === "model"}
          title={title ?? "Change model"}
          onClick={() => toggle("model")}
        >
          <span className="chat-model-label">{model}</span>
          <ChevronUp size={14} aria-hidden="true" />
        </button>
        {thinking ? (
          <button
            type="button"
            className="btn small chat-thinking-btn"
            aria-label={`Thinking level: ${thinking}`}
            aria-haspopup="menu"
            aria-expanded={open === "thinking"}
            title={thinkingDisabledReason ?? thinkingTitle ?? "Change thinking level"}
            disabled={thinkingDisabledReason !== null || levels.length === 0}
            onClick={() => toggle("thinking")}
          >
            <Brain size={13} aria-hidden="true" />
            {thinking}
            <ChevronUp size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {open === "model" ? (
        <div className="repo-menu account-chip-list chat-dropup" role="menu" aria-label="Model">
          <button type="button" role="menuitem" className="account-chip-action" onClick={pick(onProviders)}>
            <Settings2 size={14} aria-hidden="true" />
            Providers…
          </button>
          {favorites.length === 0 ? <p className="chat-dropup-empty">Star a model under Providers to list it here.</p> : null}
          {favorites.map((row) => (
            <button
              key={row}
              type="button"
              role="menuitemradio"
              aria-checked={row === model}
              className="account-chip-action chat-dropup-model"
              onClick={pick(() => onPickModel(row))}
            >
              <span className="chat-model-label">{row}</span>
              {row === model ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
      {open === "thinking" ? (
        <div className="repo-menu account-chip-list chat-dropup" role="menu" aria-label="Thinking level">
          {levels.map((level) => (
            <button key={level} type="button" role="menuitemradio" aria-checked={level === thinking} className="account-chip-action" onClick={pick(() => onPickThinking(level))}>
              {level}
              {level === thinking ? <Check size={14} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
