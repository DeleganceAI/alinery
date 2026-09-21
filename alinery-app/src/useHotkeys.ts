import { useEffect, useRef } from "react";

// Continuous nav (j/k/h/l) is bare, discrete commands are ⌘+key (plan §5.1). Flip this
// to require ⌘ for nav too — then remap search off ⌘K to break the collision.
export const NAV_REQUIRES_CMD = false;

export type Handlers = {
  overlayOpen: boolean;
  isFullscreen: boolean;
  board: "kanban" | "grid" | "list" | "sessions" | "notifications" | null; // nav only active on a board view
  toggleSearch: () => void;
  openCreate: () => void;
  goList: () => void;
  goKanban: () => void;
  goGrid: (slot: number) => void;
  goSessions: () => void;
  goNotifications: () => void;
  goSettings: () => void;
  archiveSelected: () => void;
  duplicateSelected: () => void;
  openSelected: () => void;
  toggleGlow: () => void;
  sync: () => void;
  back: () => void;
  moveRow: (d: number) => void;
  moveCol: (d: number) => void;
  toggleTerminalDrawer: () => void;
  killTerminalDrawer: () => void;
  /** ⌘⇧O — toggle Orbitron View. */
  toggleCanvas?: () => void;
  /** Present only while Orbitron is showing. Invoked instead of back(). */
  canvasEscape?: () => void;
  /** Bare (non-cmd) keys while Orbitron is showing. true = consumed. */
  canvasKey?: (e: KeyboardEvent) => boolean;
};

// One global keydown listener installed once at App level (plan §5.3). Reads the latest
// handlers via a ref so the listener itself never re-binds.
export function useHotkeys(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const H = ref.current;
      const k = e.key;
      const cmd = e.metaKey || e.ctrlKey;

      // 1. ⌘K always toggles search.
      if (cmd && k.toLowerCase() === "k") {
        e.preventDefault();
        H.toggleSearch();
        return;
      }
      // 2. An overlay owns its own keys (search/create modal handle arrows/enter/esc).
      if (H.overlayOpen) return;
      // 3. Typing guard: never hijack a focused text field. Its own handlers do Esc/⌘⏎.
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,[contenteditable]")) return;
      // 4. Bare Esc backs out of the current view — except in native fullscreen, where
      //    Esc is macOS's own "exit fullscreen" shortcut; let the OS own it exclusively
      //    there instead of also firing back-navigation underneath it.
      //
      //    Orbitron owns Esc outright: the presence of `canvasEscape` means that view is
      //    showing, and there Esc cancels a gesture or clears a selection. It must never
      //    fall through to `back()`, even when there is nothing to cancel — leaving a
      //    spatial view by accident loses the user's place in it.
      if (k === "Escape") {
        if (H.isFullscreen) return;
        if (H.canvasEscape) {
          H.canvasEscape();
          return;
        }
        H.back();
        return;
      }
      // 5. ⌘+key commands.
      if (cmd) {
        // Prefer e.code: Shift+` yields e.key === "~" on some layouts.
        if (e.code === "Backquote") {
          if (e.shiftKey) return end(e, H.killTerminalDrawer);
          return end(e, H.toggleTerminalDrawer);
        }
        const lk = k.toLowerCase();
        if (lk === "n") return end(e, H.openCreate);
        if (k === "1") return end(e, H.goList);
        if (k === "2") return end(e, () => H.goGrid(0));
        if (k === "3") return end(e, H.goKanban);
        if (k === "4") return end(e, () => H.goGrid(1));
        if (k === "5") return end(e, () => H.goGrid(2));
        if (k === "7") return end(e, H.goSessions);
        if (k === "8") return end(e, H.goNotifications);
        if (k === "9" || k === ",") return end(e, H.goSettings);
        if (lk === "e") return end(e, H.archiveSelected);
        if (lk === "d") return end(e, H.duplicateSelected);
        if (lk === "g") return end(e, H.toggleGlow);
        if (lk === "r" && e.shiftKey) return end(e, H.sync);
        if (k === "Enter") return end(e, H.openSelected);
        if (lk === "o" && e.shiftKey) return end(e, () => H.toggleCanvas?.());
        if (NAV_REQUIRES_CMD) navKey(e, k, H);
        return;
      }
      // 6. Orbitron's own bare keys (tools, fit, arrows) get first refusal. `board` is
      //    null while that view shows, but the guard is on `canvasKey` rather than on
      //    `board` so the ownership is explicit rather than a side effect.
      if (H.canvasKey?.(e)) {
        e.preventDefault();
        return;
      }
      // 7. Bare nav on board views.
      if (!NAV_REQUIRES_CMD && H.board) navKey(e, k, H);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function end(e: KeyboardEvent, fn: () => void) {
  e.preventDefault();
  fn();
}

function navKey(e: KeyboardEvent, k: string, H: Handlers) {
  switch (k) {
    case "j":
    case "ArrowDown":
      return end(e, () => H.moveRow(1));
    case "k":
    case "ArrowUp":
      return end(e, () => H.moveRow(-1));
    case "l":
    case "ArrowRight":
      return end(e, () => H.moveCol(1));
    case "h":
    case "ArrowLeft":
      return end(e, () => H.moveCol(-1));
    case "Enter":
      return end(e, H.openSelected);
  }
}
