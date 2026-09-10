import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useRef, useState } from "react";
import { ARTIFACT_VIEWER_WIDTH_MAX, ARTIFACT_VIEWER_WIDTH_MIN, clampArtifactViewerWidth, normalizeArtifactViewerWidth } from "./appearance";
import * as ipc from "./ipc";
import { toast } from "./toast";
import type { AppearancePrefs } from "./types";
import { usePointerDrag } from "./usePointerDrag";

const KEYBOARD_STEP = 20;

type ArtifactPaneResizerProps = {
  role: "separator";
  "aria-orientation": "vertical";
  "aria-label": string;
  "aria-valuemin": number;
  "aria-valuemax": number;
  "aria-valuenow": number;
  tabIndex: 0;
  onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (ev: ReactKeyboardEvent<HTMLElement>) => void;
};

export function useArtifactPaneWidth(appearance: AppearancePrefs, onAppearanceChange: (next: AppearancePrefs) => void): [number, ArtifactPaneResizerProps] {
  const [width, setWidth] = useState(() => normalizeArtifactViewerWidth(appearance.artifact_viewer_width));
  const accessibleMax = clampArtifactViewerWidth(ARTIFACT_VIEWER_WIDTH_MAX);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const changeRef = useRef(onAppearanceChange);
  changeRef.current = onAppearanceChange;

  const persistWidth = (nextWidth: number) => {
    const normalized = clampArtifactViewerWidth(nextWidth);
    setWidth(normalized);
    const next = { ...appearanceRef.current, artifact_viewer_width: normalized };
    changeRef.current(next);
    ipc.writeAppearance(next).catch((e) => toast(`Couldn't save appearance: ${String(e)}`, "error"));
  };

  const { start: startPointerDrag } = usePointerDrag();
  const onPointerDown = (ev: ReactPointerEvent<HTMLElement>) => {
    const startX = ev.clientX;
    const startWidth = clampArtifactViewerWidth(width);
    const apply = (clientX: number) => clampArtifactViewerWidth(startWidth + startX - clientX);
    startPointerDrag(ev, {
      onMove: (moveEv) => {
        setWidth(apply(moveEv.clientX));
      },
      onComplete: (completeEv) => {
        const nextWidth = apply(completeEv.clientX);
        if (nextWidth === startWidth) return;
        persistWidth(nextWidth);
      },
    });
  };

  const onKeyDown = (ev: ReactKeyboardEvent<HTMLElement>) => {
    const current = clampArtifactViewerWidth(width);
    const next =
      ev.key === "ArrowLeft"
        ? current + KEYBOARD_STEP
        : ev.key === "ArrowRight"
          ? current - KEYBOARD_STEP
          : ev.key === "Home"
            ? ARTIFACT_VIEWER_WIDTH_MIN
            : ev.key === "End"
              ? ARTIFACT_VIEWER_WIDTH_MAX
              : null;
    if (next == null) return;
    ev.preventDefault();
    const normalized = clampArtifactViewerWidth(next);
    if (normalized !== current) persistWidth(normalized);
  };

  return [
    width,
    {
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize artifact pane",
      "aria-valuemin": ARTIFACT_VIEWER_WIDTH_MIN,
      "aria-valuemax": accessibleMax,
      "aria-valuenow": clampArtifactViewerWidth(width),
      tabIndex: 0,
      onPointerDown,
      onKeyDown,
    },
  ];
}
