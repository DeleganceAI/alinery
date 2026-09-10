import { Maximize2, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import * as ipc from "./ipc";

// Frameless window (decorations:false) → we own the controls, the drag bar, and the
// edge resize. All three go through the Tauri window API and need the matching
// core:window permissions in capabilities/default.json.
const win = ipc.getCurrentWindow();

// Same literals as @tauri-apps/api's ResizeDirection (structurally assignable).
type Dir = "North" | "South" | "East" | "West" | "NorthWest" | "NorthEast" | "SouthWest" | "SouthEast";
const EDGES: [Dir, string][] = [
  ["North", "n"],
  ["South", "s"],
  ["East", "e"],
  ["West", "w"],
  ["NorthWest", "nw"],
  ["NorthEast", "ne"],
  ["SouthWest", "sw"],
  ["SouthEast", "se"],
];

// Fullscreen state mirror: read once on mount, then re-check after every resize event
// (native fullscreen enter/exit fires a resize; there's no dedicated Tauri event for it).
export function useWindowFullscreen() {
  const [fs, setFs] = useState(false);
  useEffect(() => {
    let alive = true;
    win.isFullscreen().then((v) => alive && setFs(v));
    const unlisten = win.onResized(() => {
      win.isFullscreen().then((v) => alive && setFs(v));
    });
    return () => {
      alive = false;
      unlisten.then((u) => u());
    };
  }, []);
  return fs;
}

// Minimize / fullscreen-toggle / close — rendered next to the brand mark in the header.
// The fullscreen button uses real native macOS fullscreen (separate Space, no menu bar).
// Esc exiting fullscreen is macOS's own shortcut; useHotkeys stands down its own Esc="go
// back" handler while isFullscreen is true so the OS is the sole owner of that key there.
export function WindowControls() {
  const fs = useWindowFullscreen();
  const fsLabel = fs ? "Exit full screen" : "Enter full screen";
  return (
    <div className="wctl">
      <button type="button" className="wbtn" title="Minimize" aria-label="Minimize" onClick={() => win.minimize()}>
        <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button type="button" className="wbtn" title={fsLabel} aria-label={fsLabel} onClick={() => win.setFullscreen(!fs)}>
        <Maximize2 size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <button type="button" className="wbtn cls" title="Close" aria-label="Close window" onClick={() => win.close()}>
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

// Eight fixed edge/corner strips that grab-resize the frameless window. Corners come
// last so they win at the overlaps. Hover shows a quiet accent line so the edge reads
// as grabbable.
export function ResizeHandles() {
  return (
    <div className="resizers">
      {EDGES.map(([dir, cls]) => (
        <div
          key={cls}
          className={`rz rz-${cls}`}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            win.startResizeDragging(dir);
          }}
        />
      ))}
    </div>
  );
}
