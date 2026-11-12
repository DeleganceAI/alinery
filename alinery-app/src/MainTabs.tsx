import { X } from "lucide-react";
import { useEffect, useState } from "react";

export type OpenTab = { key: string; name: string; mode: "preview" | "raw" };

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
    open: (tab: T) => {
      setTabs((open) => (open.some((t) => t.key === tab.key) ? open : [...open, tab]));
      setActive(tab.key);
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
 * each opened file or thread, closable. A tab's label is the last segment of its name; the full name is its tooltip. */
export function MainTabs({
  pinned,
  tabs,
  active,
  onSelect,
  onClose,
}: {
  pinned?: string;
  tabs: { key: string; name: string }[];
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
        <div key={tab.key} className={`task-main-tab${tab.key === active ? " on" : ""}`}>
          <button
            type="button"
            className="task-main-tab-label"
            aria-pressed={tab.key === active}
            title={tab.name}
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
