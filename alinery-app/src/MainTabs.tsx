import { X } from "lucide-react";
import { useEffect, useState } from "react";

/** `temp`: opened by a single click. The next single-click open replaces it, so browsing reuses one tab until it is kept. */
export type OpenTab = { key: string; name: string; mode: "preview" | "raw"; temp?: boolean };

/** The opened files behind `MainTabs`. `active` is "" while the pinned tab shows; a change of `scope` (another task or
 * session) closes them all. */
export function useOpenTabs<T extends OpenTab>(scope: string) {
  const [tabs, setTabs] = useState<T[]>([]);
  const [active, setActive] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reset keyed on the scope only
  useEffect(() => {
    setTabs([]);
    setActive("");
  }, [scope]);
  return {
    tabs,
    active,
    current: tabs.find((tab) => tab.key === active),
    setActive,
    /** `keep: false` opens it temporarily, in place of the current temporary tab. Opening an open tab with `keep` keeps it. */
    open: (tab: T, keep = true) => {
      setTabs((open) => {
        if (open.some((t) => t.key === tab.key)) return keep ? open.map((t) => (t.key === tab.key ? { ...t, temp: false } : t)) : open;
        if (keep) return [...open, tab];
        const temp = open.findIndex((t) => t.temp);
        const next = { ...tab, temp: true };
        return temp < 0 ? [...open, next] : open.map((t, at) => (at === temp ? next : t));
      });
      setActive(tab.key);
    },
    /** A click on a tab in the strip: shows it, and keeps it if it was temporary. */
    select: (key: string) => {
      setTabs((open) => open.map((t) => (t.key === key && t.temp ? { ...t, temp: false } : t)));
      setActive(key);
    },
    close: (key: string) => {
      const at = tabs.findIndex((tab) => tab.key === key);
      setTabs((open) => open.filter((tab) => tab.key !== key));
      if (key === active) setActive(tabs[at - 1]?.key ?? "");
    },
    setMode: (mode: OpenTab["mode"]) => setTabs((open) => open.map((tab) => (tab.key === active ? { ...tab, mode } : tab))),
    reset: () => {
      setTabs([]);
      setActive("");
    },
  };
}

/** The main pane's tab strip in the task, session and chat views: an optional pinned tab (active while `active` is ""), then
 * each opened file or thread, closable. A tab's label is the last segment of its name; the full name is its tooltip. A
 * temporary tab's label is italic. */
export function MainTabs({
  pinned,
  tabs,
  active,
  onSelect,
  onClose,
}: {
  pinned?: string;
  tabs: { key: string; name: string; temp?: boolean }[];
  active: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const pinnedOn = !tabs.some((tab) => tab.key === active);
  return (
    <div className="task-main-tabs" role="group" aria-label="Open files">
      {pinned && (
        <div className={`task-main-tab${pinnedOn ? " on" : ""}`}>
          <button type="button" className="task-main-tab-label" aria-pressed={pinnedOn} onClick={() => onSelect("")}>
            {pinned}
          </button>
        </div>
      )}
      {tabs.map((tab) => (
        <div key={tab.key} className={`task-main-tab${tab.key === active ? " on" : ""}${tab.temp ? " temp" : ""}`}>
          <button
            type="button"
            className="task-main-tab-label"
            aria-pressed={tab.key === active}
            title={tab.temp ? `${tab.name} (preview: click to keep open)` : tab.name}
            onClick={() => onSelect(tab.key)}
            onAuxClick={(ev) => ev.button === 1 && onClose(tab.key)}
          >
            {tab.name.slice(tab.name.lastIndexOf("/") + 1)}
          </button>
          <button type="button" className="task-main-tab-close" aria-label={`Close ${tab.name}`} title="Close" onClick={() => onClose(tab.key)}>
            <X size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
