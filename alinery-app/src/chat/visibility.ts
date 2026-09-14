import { CHAT_FONT_DEFAULT, CHAT_RAIL_FONT_DEFAULT, normalizeChatRailDensity, normalizeChatRailFontSize } from "../appearance";
import type { AppearancePrefs, ChatMaxWidth, ChatRailDensity } from "../types";
import type { ChatEntry, SessionChatStatus } from "./types";

/** Chat prefs from Settings → Chat (Journal + Density). */
export type ChatPrefs = {
  showThinking: boolean;
  expandThinking: boolean;
  showTools: boolean;
  expandTools: boolean;
  showHarness: boolean;
  showTurnMarkers: boolean;
  showSubagentRows: boolean;
  showSubagentDrawer: boolean;
  autoCollapseThinking: boolean;
  autoCompaction: boolean;
  autoScroll: boolean;
  railDensity: ChatRailDensity;
  fontSize: number;
  railFontSize: number;
  showMeta: boolean;
  showComposerHints: boolean;
  maxWidth: ChatMaxWidth;
  showDate: boolean;
  showTime: boolean;
  showActorLabels: boolean;
  showAgentBubbles: boolean;
};

/** @deprecated Prefer ChatPrefs; kept as an alias for call sites mid-rename. */
export type ChatVisibilityPrefs = ChatPrefs;

export const DEFAULT_CHAT_VISIBILITY: ChatPrefs = {
  showThinking: false,
  expandThinking: false,
  showTools: false,
  expandTools: false,
  showHarness: true,
  showTurnMarkers: false,
  showSubagentRows: true,
  showSubagentDrawer: true,
  autoCollapseThinking: true,
  autoCompaction: true,
  autoScroll: true,
  railDensity: "normal",
  fontSize: CHAT_FONT_DEFAULT,
  railFontSize: CHAT_RAIL_FONT_DEFAULT,
  showMeta: true,
  showComposerHints: true,
  maxWidth: "900",
  showDate: true,
  showTime: true,
  showActorLabels: true,
  showAgentBubbles: true,
};

function normalizeMaxWidth(value: unknown): ChatMaxWidth {
  if (value === "600" || value === "900" || value === "1200" || value === "none") return value;
  return "900";
}

export function chatVisibilityFromAppearance(input: AppearancePrefs | Record<string, unknown>): ChatPrefs {
  const density = normalizeChatRailDensity(typeof input.chat_rail_density === "string" ? input.chat_rail_density : undefined);
  const fontRaw = typeof input.chat_font_size === "number" && Number.isFinite(input.chat_font_size) ? Math.round(input.chat_font_size) : CHAT_FONT_DEFAULT;
  const railFont = normalizeChatRailFontSize(typeof input.chat_rail_font_size === "number" ? input.chat_rail_font_size : undefined);
  return {
    showThinking: input.chat_show_thinking === true,
    expandThinking: input.chat_expand_thinking === true,
    showTools: input.chat_show_tools === true,
    expandTools: input.chat_expand_tools === true,
    showHarness: input.chat_show_harness !== false,
    showTurnMarkers: input.chat_show_turn_markers === true,
    showSubagentRows: input.chat_show_subagent_rows !== false,
    showSubagentDrawer: input.chat_show_subagent_drawer !== false,
    autoCollapseThinking: input.chat_auto_collapse_thinking !== false,
    autoCompaction: input.chat_auto_compaction !== false,
    autoScroll: input.chat_auto_scroll !== false,
    railDensity: density,
    fontSize: Math.min(22, Math.max(10, fontRaw)),
    railFontSize: railFont,
    showMeta: input.chat_show_meta !== false,
    showComposerHints: input.chat_show_composer_hints !== false,
    maxWidth: normalizeMaxWidth(input.chat_max_width),
    showDate: input.chat_show_date !== false,
    showTime: input.chat_show_time !== false,
    showActorLabels: input.chat_show_actor_labels !== false,
    showAgentBubbles: input.chat_show_agent_bubbles !== false,
  };
}

export function visibleChatEntries(entries: ChatEntry[], prefs: ChatPrefs): ChatEntry[] {
  return entries.filter((entry) => {
    if (entry.type === "thinking" || entry.type === "redacted_thinking") return prefs.showThinking;
    if (entry.type === "tool_call" || entry.type === "tool_result") return prefs.showTools;
    if (entry.type === "harness") return prefs.showHarness;
    if (entry.type === "turn_marker") return prefs.showTurnMarkers;
    if (entry.type === "subagent_status" || entry.actor.kind === "subagent") return prefs.showSubagentRows;
    return true;
  });
}

/** Whether a work rail should start expanded (live streaming still forces open in the row). */
export function workRailDefaultExpanded(entry: ChatEntry, prefs: ChatPrefs): boolean {
  if (entry.type === "thinking" || entry.type === "redacted_thinking") return prefs.expandThinking;
  if (entry.type === "tool_call" || entry.type === "tool_result") return prefs.expandTools;
  return false;
}

/** Sticky journal activity copy while the session is not idle. */
export function chatActivityLabel(status: SessionChatStatus, entries: ChatEntry[]): string | null {
  if (status === "idle") return null;
  if (status === "waiting_approval") return "Waiting for approval…";
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === "thinking" && entry.streaming && !entry.aborted) return "Thinking…";
    if (entry.type === "text" && entry.streaming) return "Working…";
    if (entry.type === "tool_call" && entry.status === "running") return "Working…";
  }
  return "Working…";
}

export function lastApprovalNotice(entries: ChatEntry[]): { action: string; detail: string } | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "approval") return { action: entry.action, detail: entry.detail };
  }
  return null;
}
