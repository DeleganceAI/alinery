import { type RefObject, useLayoutEffect, useRef } from "react";
import type { Tab, View } from "./types";

export type TabBox = { left: number; width: number };
export type TabPill = { x: number; w: number };

export function layoutTabPill(navLeft: number, active: TabBox | null): TabPill | null {
  if (!active || !(active.width > 0)) return null;
  return { x: active.left - navLeft, w: active.width };
}

export function applyTabPill(nav: HTMLElement, layout: TabPill | null, opts: { instant?: boolean } = {}) {
  if (!layout) {
    nav.style.removeProperty("--pill-x");
    nav.style.removeProperty("--pill-w");
    return;
  }
  nav.classList.toggle("instant", Boolean(opts.instant));
  nav.style.setProperty("--pill-x", `${layout.x}px`);
  nav.style.setProperty("--pill-w", `${layout.w}px`);
  nav.classList.add("pill-ready");
}

export function viewFadeClass(instant: boolean) {
  return instant ? "view-fade instant" : "view-fade";
}

export function isPrimaryTab(kind: string): boolean {
  return kind === "kanban" || kind === "list" || kind === "grid" || kind === "sessions" || kind === "notifications" || kind === "settings";
}

/** Every drill-down view (task, session, create, ...) nests back to the primary
    tab it was opened from. The tab bar has nothing to highlight for the raw
    view kind — resolve to that owning tab so the pill stays parked instead of
    collapsing to zero width.

    Not every view carries `from`: Orbitron is reached by chord from anywhere and
    deliberately owns no tab (see AGENTS.md "Orbitron View"). Walking off the end of
    the chain used to dereference `undefined` and throw *during App's render*, which
    blanked the entire window — so the walk stops at the default surface instead. */
export function primaryTabOf(view: View): Tab {
  let v: View = view;
  while (!isPrimaryTab(v.kind)) {
    if (!("from" in v)) return "grid";
    v = v.from;
  }
  return v.kind as Tab;
}

export function gridViewIdOf(view: View): string | undefined {
  let v: View = view;
  while (!isPrimaryTab(v.kind)) {
    if (!("from" in v)) return undefined;
    v = v.from;
  }
  return v.kind === "grid" ? v.gridViewId : undefined;
}

export function useTabPill(navRef: RefObject<HTMLElement | null>, activeKey: string, instant: boolean) {
  const activeKeyRef = useRef(activeKey);
  const instantRef = useRef(instant);
  activeKeyRef.current = activeKey;
  instantRef.current = instant;

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const paint = (snap: boolean) => {
      const on = nav.querySelector<HTMLElement>(`.tab[data-tab="${CSS.escape(activeKeyRef.current)}"]`);
      const navBox = nav.getBoundingClientRect();
      const onBox = on?.getBoundingClientRect();
      applyTabPill(nav, layoutTabPill(navBox.left, onBox ? { left: onBox.left, width: onBox.width } : null), { instant: snap });
    };

    let seenObservation = false;
    const ro = new ResizeObserver(() => {
      if (!seenObservation) {
        seenObservation = true;
        return;
      }
      paint(true);
    });
    ro.observe(nav);
    for (const tab of nav.querySelectorAll(".tab")) ro.observe(tab);
    return () => ro.disconnect();
  }, [navRef]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const on = nav.querySelector<HTMLElement>(`.tab[data-tab="${CSS.escape(activeKey)}"]`);
    const navBox = nav.getBoundingClientRect();
    const onBox = on?.getBoundingClientRect();
    applyTabPill(nav, layoutTabPill(navBox.left, onBox ? { left: onBox.left, width: onBox.width } : null), { instant });
  }, [activeKey, instant, navRef]);
}
