import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type ConfirmChoice, DEFAULT_CHOICES, defaultFocusKey } from "./confirm-focus";
import { Dialog } from "./shared";

export type { ConfirmChoice };
// Safe-by-default focus lives in confirm-focus.ts (React-free, unit-tested).
export { defaultFocusKey };

// WHY THIS EXISTS: `window.confirm` is BROKEN in this app and cannot be used.
//
// `tauri_plugin_dialog::init()` injects an init script that replaces `window.confirm`
// with an *async* function (`init-iife.js`: `window.confirm = async function (…)`), so
// `if (!window.confirm(msg)) return;` tests a Promise — always truthy — and the guarded
// destructive action runs unconditionally, with no dialog the user can answer. The
// native panel behind it never appears either: `dialog:allow-confirm` is not in
// capabilities/default.json, so the invoke is rejected. wry's WKWebView UI delegate
// implements only the file-open panel, so there is no browser fallback on macOS.
//
// Every loss-of-work confirmation in alinery therefore goes through this module instead:
// an in-app modal, promise-based, awaited by the caller. It also does what a native
// two-button confirm cannot — arbitrary choices (quit offers leave-running / stop-all /
// cancel) and themed danger styling.
//
// Guarded by scripts/tests/check-no-window-confirm.sh.

export type ConfirmRequest = {
  title: string;
  body: ReactNode;
  /** Left-to-right buttons. Defaults to a danger Confirm + ghost Cancel. */
  choices?: ConfirmChoice[];
  /** Returned on Esc, scrim click and ✕. Defaults to "cancel". */
  cancelKey?: string;
  /**
   * Which choice receives initial focus (Enter). Defaults to `cancelKey` so
   * destructive confirms never auto-accept on Enter. Multi-choice dialogs
   * (quit) should set this to leave-running / cancel, never "close all".
   */
  defaultKey?: string;
};

type Pending = { req: ConfirmRequest; resolve: (key: string) => void };
type Fn = (p: Pending) => void;
const listeners = new Set<Fn>();

/** Ask the user; resolves with the chosen key (the cancel key if dismissed). */
export function askConfirm(req: ConfirmRequest): Promise<string> {
  const cancelKey = req.cancelKey ?? "cancel";
  // No host mounted (tests, teardown) ⇒ cancel. Never hang, never assume "yes".
  if (listeners.size === 0) return Promise.resolve(cancelKey);
  return new Promise<string>((resolve) => {
    let done = false;
    const once = (key: string) => {
      if (done) return;
      done = true;
      resolve(key);
    };
    listeners.forEach((l) => {
      l({ req, resolve: once });
    });
  });
}

/** Two-button danger confirmation. `true` = the user accepted. */
export function confirmDanger(title: string, body: ReactNode, acceptLabel = "Confirm"): Promise<boolean> {
  return askConfirm({
    title,
    body,
    // Visual order: danger first (product convention); focus stays on Cancel
    // so Enter does not accept destroy.
    choices: [
      { key: "confirm", label: acceptLabel, tone: "danger" },
      { key: "cancel", label: "Cancel", tone: "ghost" },
    ],
    defaultKey: "cancel",
  }).then((key) => key === "confirm");
}

/** Mounted once at App level, next to <Toast/>. */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    // A second request while one is up (double-clicking the window's ✕) supersedes it —
    // resolve the old caller as cancelled rather than leaving its promise pending forever.
    const l: Fn = (p) =>
      setPending((prev) => {
        prev?.resolve(prev.req.cancelKey ?? "cancel");
        return p;
      });
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  const answer = (key: string) => {
    setPending(null);
    pending?.resolve(key);
  };

  if (!pending) return null;

  const { req } = pending;
  const cancelKey = req.cancelKey ?? "cancel";
  const choices = req.choices ?? DEFAULT_CHOICES;
  const focusKey = defaultFocusKey(req);

  // The shared Dialog owns modality: native showModal(), Esc → onClose, backdrop
  // click → onClose, focus restored to the opener. Safe-by-default focus stays in
  // defaultFocusKey; data-autofocus is how the native dialog receives it.
  return (
    <Dialog onClose={() => answer(cancelKey)} role="alertdialog" ariaLabel={req.title} className="confirm-modal">
      <div className="mh">
        <span className="mt">{req.title}</span>
        <button type="button" className="x" aria-label="Cancel" title="Cancel" onClick={() => answer(cancelKey)}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb confirm-body">{req.body}</div>
      <div className="mfoot">
        {choices.map((c) => (
          <button
            type="button"
            key={c.key}
            data-autofocus={c.key === focusKey ? "" : undefined}
            className={`btn small${c.tone === "danger" ? " danger" : c.tone === "ghost" ? " ghost" : ""}`}
            onClick={() => answer(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </Dialog>
  );
}
