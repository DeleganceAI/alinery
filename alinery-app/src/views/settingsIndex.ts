import type { SettingsSectionKey } from "../types";

// The one list of Settings: its order on the page, the rail's links and the anchors a deep link scrolls to.
// `keywords` are the words people type that the label does not say ("dark mode" for Appearance).
export type SettingsPart = { id: SettingsSectionKey; label: string; keywords: string };
export type SettingsGroup = { key: SettingsSectionKey; label: string; keywords?: string; parts: SettingsPart[]; globalOnly?: boolean };

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    key: "appearance",
    label: "Appearance",
    keywords: "theme dark mode light system accent color colour interface scale zoom size terminal font text starting view startup launch",
    parts: [],
    globalOnly: true,
  },
  {
    key: "views",
    label: "Views",
    globalOnly: true,
    parts: [
      { id: "views.sessions", label: "Session chat", keywords: "sessions view journal thinking tool labels copy buttons reply bubbles density rail width font size collapse" },
      { id: "views.chat", label: "Chat view", keywords: "chat threads journal thinking copy buttons bubbles density rail width font size" },
      { id: "views.grid", label: "Grid views", keywords: "grid board kanban columns shortcuts" },
    ],
  },
  {
    key: "agents",
    label: "Agents",
    parts: [
      {
        id: "agents.defaults",
        label: "Session defaults",
        keywords: "model default model thinking level reasoning effort compaction auto-compaction context tokens harness preferences",
      },
      { id: "agents.providers", label: "Providers", keywords: "sign in login accounts api key openai anthropic claude xai customizations skills extensions agent directory" },
      { id: "agents.playbooks", label: "Playbooks", keywords: "default playbook superdevelop" },
    ],
  },
  { key: "connections", label: "Connections", keywords: "github linear oauth token keychain gh ssh remote hosts machines import issues", parts: [] },
  { key: "notifications", label: "Notifications", keywords: "alerts banner sound dock badge bounce test notification approval input waits failures", parts: [], globalOnly: true },
  {
    key: "data",
    label: "Data",
    parts: [
      { id: "data.storage", label: "Storage", keywords: "disk space paths folders archived purge delete reclaim worktrees .alinery" },
      { id: "data.backup", label: "Backup", keywords: "backups restore archive zip retention destination folder automatic" },
    ],
  },
  { key: "mcp", label: "MCP server", keywords: "mcp socket host config tools integration claude desktop cursor json", parts: [] },
  {
    key: "system",
    label: "System",
    parts: [
      { id: "system.updates", label: "Updates", keywords: "update version upgrade check runtime remote hosts daemon" },
      { id: "system.sessions", label: "Session service", keywords: "daemon background stop sessions restart kill live" },
      { id: "system.misc", label: "Power and privacy", keywords: "keep awake sleep power idle telemetry analytics usage anonymous" },
      { id: "system.experimental", label: "Experimental", keywords: "experiments chat thread canvas grok api key xai" },
    ],
  },
];

/** The group an anchor belongs to: `data.backup` → `data`. */
export const groupOf = (anchor: string) => anchor.split(".")[0] as SettingsSectionKey;

/** The groups and parts on screen: Chat view only while the experimental Chat view is on. */
export function visibleGroups(chatEnabled: boolean): SettingsGroup[] {
  return chatEnabled ? SETTINGS_GROUPS : SETTINGS_GROUPS.map((group) => ({ ...group, parts: group.parts.filter((part) => part.id !== "views.chat") }));
}

/**
 * The anchors a search keeps on screen, or null for no search. Every word must appear in a part's label or keywords, its
 * group's counting too; a group whose own label or keywords match keeps all its parts. Substring matching: fuzzy is not
 * worth a dependency for a list this short.
 */
export function matchSettings(groups: SettingsGroup[], query: string): Set<SettingsSectionKey> | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const hits = (...texts: (string | undefined)[]) => {
    const hay = texts.join(" ").toLowerCase();
    return words.every((word) => hay.includes(word));
  };
  const shown = new Set<SettingsSectionKey>();
  for (const group of groups) {
    const groupText = [group.label, group.keywords];
    const parts = hits(...groupText) ? group.parts : group.parts.filter((part) => hits(...groupText, part.label, part.keywords));
    if (parts.length || hits(...groupText)) shown.add(group.key);
    for (const part of parts) shown.add(part.id);
  }
  return shown;
}
