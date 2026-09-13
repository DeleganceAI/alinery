/**
 * Product mapper for OMP 18.1.10 RPC stdout.
 * Rules from docs/research/omp-rpc-probe.md: replace sibling snapshots, do not flatten,
 * do not append text_end, do not treat stopReason "stop" as turn-complete.
 * Journal rows live on `entries`; `messages` stays the hydrate/upsert snapshot.
 */

import { parseSlash } from "./chat/commands";
import { explodeAssistantParts } from "./chat/journal";
import { ACTOR, type ChatCommand, type ChatEntry, type CommandSource, type SubagentStatus, subagent } from "./chat/types";
import { transportLimitMessage } from "./ompRpc";
import type { ChatMessage, ChatPart } from "./types";

export type { ChatCommand } from "./chat/types";

export type PendingUi = {
  id: string;
  method?: string;
  widgetKey?: string;
  url?: string;
  launchUrl?: string;
  title?: string;
  placeholder?: string;
  instructions?: string;
  options?: string[];
  optionDetails?: { description?: string }[];
};

export type DumpTool = { name: string; description?: string; parameters?: unknown; examples?: unknown };

export type ChatModelOption = { provider: string; id: string };

export type ChatLoginProvider = {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
};

export type SessionChatMeta = {
  model?: string;
  thinking?: string;
  contextUsage?: { tokens: number; contextWindow: number; percent?: number };
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  dumpTools?: DumpTool[];
  models?: ChatModelOption[];
  loginProviders?: ChatLoginProvider[];
  queuedMessageCount?: number;
};

export type ChatTranscriptState = {
  ready: boolean;
  protocolVersion: number | null;
  messages: ChatMessage[];
  commands: ChatCommand[];
  pendingUi: PendingUi[];
  unknownTypes: string[];
  /** Latest harness/error line for callers that still read a single notice. */
  notice: string | null;
  entries: ChatEntry[];
  sessionMeta: SessionChatMeta;
  turn: number;
  /** OMP said a turn is open: set by `turn_start`, cleared by `turn_end`. Never guessed. */
  turnOpen: boolean;
  /**
   * We sent something that should start a turn and OMP has not answered yet. Send routing needs
   * this because `turn_start` trails the write, but it is deliberately NOT `turnOpen`: keeping
   * them apart is what lets `turn_start` still emit its marker, and what lets a refusal clear
   * the guess without inventing a `turn_end` OMP never sent.
   */
  pendingTurn: boolean;
  liveAssistantKeys: Record<string, string>;
  entrySeq: number;
  /**
   * Index of the seam: entries below it came from the journal, entries at or above it from the
   * live stream. Streaming updates only ever rewrite the tail, so a large loaded history costs
   * nothing per token.
   */
  liveStart: number;
  /**
   * Byte offset of the oldest journal row currently loaded, or null when nothing has been read
   * from disk. Zero means the whole conversation is loaded — there is nothing older to page in.
   */
  fileStart: number | null;
};

export function emptyTranscript(): ChatTranscriptState {
  return {
    ready: false,
    protocolVersion: null,
    messages: [],
    commands: [],
    pendingUi: [],
    unknownTypes: [],
    notice: null,
    entries: [],
    sessionMeta: {},
    turn: 0,
    turnOpen: false,
    pendingTurn: false,
    liveAssistantKeys: {},
    entrySeq: 0,
    liveStart: 0,
    fileStart: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapPart(raw: unknown): ChatPart | null {
  const part = asRecord(raw);
  if (!part || typeof part.type !== "string") return null;
  if (part.type === "thinking") {
    return { type: "thinking", thinking: typeof part.thinking === "string" ? part.thinking : "" };
  }
  if (part.type === "redactedThinking") return { type: "redactedThinking" };
  if (part.type === "text") {
    return { type: "text", text: typeof part.text === "string" ? part.text : "" };
  }
  if (part.type === "toolCall" || part.type === "tool_call") {
    return {
      type: "toolCall",
      name: typeof part.name === "string" ? part.name : undefined,
      id: typeof part.id === "string" ? part.id : undefined,
      args: part.arguments ?? part.args,
    };
  }
  if (part.type === "toolResult" || part.type === "tool_result") {
    const body = typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : undefined;
    return { type: "toolResult", body };
  }
  return null;
}

function mapContent(raw: unknown): ChatPart[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(mapPart).filter((part): part is ChatPart => part !== null);
}

export function mapHydratedMessage(raw: unknown, rowId?: string): ChatMessage | null {
  const message = asRecord(raw);
  if (!message) return null;
  const role = message.role === "user" || message.role === "assistant" ? message.role : message.role === "toolResult" ? "toolResult" : null;
  if (!role) return null;
  const mapped: ChatMessage = { role, content: mapContent(message.content) };
  if (typeof message.stopReason === "string") mapped.stopReason = message.stopReason;
  if (typeof message.customType === "string") mapped.customType = message.customType;
  if (rowId) mapped.rowId = rowId;
  if (typeof message.toolName === "string") mapped.toolName = message.toolName;
  if (typeof message.toolCallId === "string") mapped.toolCallId = message.toolCallId;
  if (message.isError === true) mapped.isError = true;
  return mapped;
}

const STREAMING_EVENTS = new Set(["thinking_start", "thinking_delta", "text_start", "text_delta"]);

const HARNESS_EVENTS = new Set([
  "command_output",
  "notice",
  "auto_compaction_start",
  "auto_compaction_end",
  "model_changed",
  "usage",
  "todo",
  "retry_fallback_applied",
  "thinking_level_changed",
  "follow_up",
  "available_commands_update",
]);

const PRESENTATION_UI = new Set(["setWidget", "notify", "setStatus", "setTitle", "set_editor_text"]);

function withStreaming(parts: ChatPart[], streaming: boolean): ChatPart[] {
  if (!streaming) {
    return parts.map((part) => {
      if (part.type === "thinking") return { type: "thinking", thinking: part.thinking };
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "toolCall") return { type: "toolCall", id: part.id, name: part.name, args: part.args };
      return part;
    });
  }
  return parts.map((part) => {
    if (part.type === "thinking") return { ...part, streaming: true };
    if (part.type === "text") return { ...part, streaming: true };
    if (part.type === "toolCall") return { ...part, streaming: true };
    return part;
  });
}

function allocId(state: ChatTranscriptState): { id: string; entrySeq: number } {
  const entrySeq = state.entrySeq + 1;
  return { id: `e${entrySeq}`, entrySeq };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function appendEntry(state: ChatTranscriptState, entry: DistributiveOmit<ChatEntry, "id"> & { id?: string }): ChatTranscriptState {
  const { id, entrySeq } = entry.id ? { id: entry.id, entrySeq: state.entrySeq } : allocId(state);
  const row = { ...entry, id } as ChatEntry;
  const notice = row.type === "harness" || row.type === "error" ? row.text : state.notice;
  return { ...state, entrySeq, entries: [...state.entries, row], notice };
}

function patchLastSlash(state: ChatTranscriptState, local: boolean): ChatTranscriptState {
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const row = state.entries[i];
    if (row?.type === "slash") {
      const entries = state.entries.slice();
      entries[i] = { ...row, local };
      return { ...state, entries };
    }
  }
  return state;
}

function upsertMessages(state: ChatTranscriptState, content: ChatPart[], stopReason: string | undefined, streaming: boolean): ChatMessage[] {
  const message: ChatMessage = { role: "assistant", content: withStreaming(content, streaming) };
  if (stopReason) message.stopReason = stopReason;
  const messages = state.messages.slice();
  const last = messages[messages.length - 1];
  // Only an in-flight assistant message is upserted in place. A message carrying a rowId came off
  // the journal and is already committed — a page whose last row is an assistant message (the
  // common case) would otherwise be overwritten by the first delta of the next turn.
  if (last?.role === "assistant" && last.rowId === undefined) messages[messages.length - 1] = message;
  else messages.push(message);
  return messages;
}

function dropLiveAssistantRows(state: ChatTranscriptState): ChatTranscriptState {
  const ids = Object.values(state.liveAssistantKeys);
  if (ids.length === 0) return { ...state, liveAssistantKeys: {} };
  const drop = new Set(ids);
  return { ...state, entries: state.entries.filter((entry) => !drop.has(entry.id)), liveAssistantKeys: {} };
}

const JOURNAL_ASSISTANT_TYPES = new Set(["thinking", "redacted_thinking", "text"]);

function snapshotPartText(part: ChatPart): string | null {
  if (part.type === "thinking") return part.thinking;
  if (part.type === "text") return part.text;
  if (part.type === "redactedThinking") return "";
  return null;
}

function journalEntryText(entry: ChatEntry): string | null {
  if (entry.type === "thinking" || entry.type === "text") return entry.text;
  if (entry.type === "redacted_thinking") return "";
  return null;
}

function journalOwnsAssistantSnapshot(state: ChatTranscriptState, content: ChatPart[]): boolean {
  const incoming = content
    .map((part) => {
      const text = snapshotPartText(part);
      if (text === null) return null;
      const type = part.type === "redactedThinking" ? "redacted_thinking" : part.type;
      return { type, text };
    })
    .filter((part): part is { type: string; text: string } => part !== null);
  if (incoming.length === 0) return false;
  const committed = state.entries.slice(0, state.liveStart);
  let end = committed.length;
  while (end > 0) {
    const entry = committed[end - 1];
    if (!entry || entry.actor.kind !== "assistant" || !JOURNAL_ASSISTANT_TYPES.has(entry.type)) {
      end -= 1;
      continue;
    }
    break;
  }
  const cluster: ChatEntry[] = [];
  for (let i = end - 1; i >= 0; i -= 1) {
    const entry = committed[i];
    if (!entry || entry.actor.kind !== "assistant" || !JOURNAL_ASSISTANT_TYPES.has(entry.type)) break;
    cluster.unshift(entry);
  }
  if (incoming.length > cluster.length) return false;
  for (let i = 0; i < incoming.length; i += 1) {
    const part = incoming[i];
    const entry = cluster[i];
    if (!part || !entry || entry.type !== part.type || journalEntryText(entry) !== part.text) return false;
  }
  return true;
}

function syncLiveAssistant(state: ChatTranscriptState, content: ChatPart[], stopReason: string | undefined, streaming: boolean): ChatTranscriptState {
  const messages = upsertMessages(state, content, stopReason, streaming);
  if (journalOwnsAssistantSnapshot(state, content)) {
    return { ...state, messages };
  }
  const aborted = stopReason === "aborted";
  let entrySeq = state.entrySeq;
  const keys = { ...state.liveAssistantKeys };
  const idFor = (key: string) => {
    const existing = keys[key];
    if (existing) return existing;
    entrySeq += 1;
    const id = `e${entrySeq}`;
    keys[key] = id;
    return id;
  };
  const exploded = explodeAssistantParts(withStreaming(content, streaming), idFor, Date.now(), aborted);
  // Everything below the seam is committed journal history and can never be part of the message
  // being streamed, so it is never scanned. This runs on every token delta: over a fully loaded
  // 50 MB journal the old whole-array Map, findIndex and two filters were ~12,000 elements each.
  const committed = state.entries.slice(0, state.liveStart);
  const live = state.entries.slice(state.liveStart);
  const oldById = new Map(live.map((e) => [e.id, e]));
  const stamped = exploded.map((row) => {
    const prev = oldById.get(row.id);
    return prev?.at != null ? ({ ...row, at: prev.at } as ChatEntry) : row;
  });
  const oldLiveIds = new Set(Object.values(state.liveAssistantKeys));
  const firstLiveIndex = live.findIndex((e) => oldLiveIds.has(e.id));
  const before = firstLiveIndex === -1 ? live : live.slice(0, firstLiveIndex).filter((e) => !oldLiveIds.has(e.id));
  const after = firstLiveIndex === -1 ? [] : live.slice(firstLiveIndex).filter((e) => !oldLiveIds.has(e.id));
  const used = new Set(stamped.map((e) => e.id));
  const liveAssistantKeys = Object.fromEntries(Object.entries(keys).filter(([, id]) => used.has(id)));
  return { ...state, messages, entries: [...committed, ...before, ...stamped, ...after], liveAssistantKeys, entrySeq };
}

function mapCommands(raw: unknown): ChatCommand[] {
  if (!Array.isArray(raw)) return [];
  const commands: ChatCommand[] = [];
  for (const item of raw) {
    const command = asRecord(item);
    if (!command || typeof command.name !== "string") continue;
    const aliases = Array.isArray(command.aliases) ? command.aliases.filter((a): a is string => typeof a === "string") : undefined;
    const input = asRecord(command.input);
    const hint = asString(input?.hint);
    const source = asString(command.source) as CommandSource | undefined;
    commands.push({
      name: command.name,
      ...(aliases && aliases.length > 0 ? { aliases } : {}),
      ...(typeof command.description === "string" ? { description: command.description } : {}),
      ...(source ? { source } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return commands;
}

function eventText(event: Record<string, unknown>): string {
  if (typeof event.text === "string") return event.text;
  if (typeof event.message === "string") return event.message;
  if (typeof event.model === "string") return event.model;
  if (typeof event.level === "string") return event.level;
  return "";
}

function mapContextUsage(raw: unknown): SessionChatMeta["contextUsage"] {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const tokens = typeof usage.tokens === "number" ? usage.tokens : typeof usage.used === "number" ? usage.used : undefined;
  const contextWindow = typeof usage.contextWindow === "number" ? usage.contextWindow : typeof usage.window === "number" ? usage.window : undefined;
  const percent = typeof usage.percent === "number" ? usage.percent : undefined;
  if (tokens == null && contextWindow == null) return undefined;
  return { tokens: tokens ?? 0, contextWindow: contextWindow ?? 0, percent };
}

function modelLabel(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const provider = asString(rec.provider);
  const id = asString(rec.id) ?? asString(rec.modelId);
  if (provider && id) return `${provider}/${id}`;
  return id ?? provider;
}

function applySessionMeta(state: ChatTranscriptState, data: Record<string, unknown>): ChatTranscriptState {
  const sessionMeta: SessionChatMeta = { ...state.sessionMeta };
  const model = modelLabel(data.model);
  if (model) sessionMeta.model = model;
  const thinking = asString(data.thinking) ?? asString(data.thinkingLevel);
  if (thinking) sessionMeta.thinking = thinking;
  const usage = mapContextUsage(data.contextUsage);
  if (usage) sessionMeta.contextUsage = usage;
  if (typeof data.isCompacting === "boolean") sessionMeta.isCompacting = data.isCompacting;
  if (typeof data.autoCompactionEnabled === "boolean") sessionMeta.autoCompactionEnabled = data.autoCompactionEnabled;
  if (typeof data.queuedMessageCount === "number") sessionMeta.queuedMessageCount = data.queuedMessageCount;

  if (Array.isArray(data.dumpTools)) {
    sessionMeta.dumpTools = data.dumpTools.flatMap((item) => {
      const tool = asRecord(item);
      if (!tool || typeof tool.name !== "string") return [];
      return [
        {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
          ...(tool.examples !== undefined ? { examples: tool.examples } : {}),
        },
      ];
    });
  }
  return { ...state, sessionMeta };
}

function applyModels(state: ChatTranscriptState, data: Record<string, unknown>): ChatTranscriptState {
  const list = Array.isArray(data.models) ? data.models : [];
  const models: ChatModelOption[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const provider = asString(rec.provider);
    const id = asString(rec.id) ?? asString(rec.modelId);
    if (!provider || !id) continue;
    models.push({ provider, id });
  }
  return { ...state, sessionMeta: { ...state.sessionMeta, models } };
}

function applyLoginProviders(state: ChatTranscriptState, data: Record<string, unknown>): ChatTranscriptState {
  const list = Array.isArray(data.providers) ? data.providers : [];
  const loginProviders: ChatLoginProvider[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = asString(rec.id);
    if (!id) continue;
    loginProviders.push({
      id,
      name: asString(rec.name) ?? id,
      available: rec.available !== false,
      authenticated: rec.authenticated === true,
    });
  }
  return { ...state, sessionMeta: { ...state.sessionMeta, loginProviders } };
}

function hydrateEntries(messages: ChatMessage[]): { entries: ChatEntry[]; entrySeq: number; liveAssistantKeys: Record<string, string> } {
  let entrySeq = 0;
  const entries: ChatEntry[] = [];
  // A message read from the journal keys its entries off the OMP row id, so paging older history
  // in leaves every already-mounted row's key untouched. Positional `e1..eN` ids would renumber
  // the whole list on each prepend and remount the pane.
  const allocFor = (message: ChatMessage) => {
    const rowId = message.rowId;
    if (rowId) return (key?: string) => (key === undefined ? `f:${rowId}` : `f:${rowId}:${key}`);
    return () => {
      entrySeq += 1;
      return `e${entrySeq}`;
    };
  };
  for (const message of messages) {
    const alloc = allocFor(message);
    if (message.role === "user") {
      const text = message.content.find((p) => p.type === "text");
      entries.push({
        id: alloc(),
        actor: ACTOR.you,
        type: "prompt",
        text: text && text.type === "text" ? text.text : "",
      });
      continue;
    }
    // Tool output used to vanish here: the loop only branched on user and assistant, so every
    // toolResult message fell through with no entry pushed. They are the bulk of a real journal.
    if (message.role === "toolResult") {
      entries.push({
        id: alloc(),
        actor: ACTOR.agent,
        type: "tool_result",
        tool: message.toolName ?? "tool",
        text: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        status: message.isError ? "error" : "ok",
      });
      continue;
    }
    if (message.role === "assistant") {
      const keys: Record<string, string> = {};
      const exploded = explodeAssistantParts(
        message.content,
        (key) => {
          if (!keys[key]) keys[key] = alloc(key);
          return keys[key];
        },
        undefined,
        message.stopReason === "aborted",
      );
      entries.push(...exploded);
    }
  }
  return { entries, entrySeq, liveAssistantKeys: {} };
}

/**
 * Fold one page of the on-disk journal into the transcript.
 *
 * The seam: the journal owns everything up to the byte offset read at attach, the RPC stream owns
 * everything after it. Live entries are identified by their ids never starting with `f:`, so they
 * survive a page landing and always sort after the file content.
 */
export function applyFilePage(state: ChatTranscriptState, page: { start: number; messages: ChatMessage[] }, position: "initial" | "older"): ChatTranscriptState {
  const messages = position === "older" ? [...page.messages, ...state.messages] : page.messages;
  const hydrated = hydrateEntries(messages);
  const live = state.entries.filter((entry) => !entry.id.startsWith("f:"));
  return {
    ...state,
    messages,
    entries: [...hydrated.entries, ...live],
    entrySeq: Math.max(state.entrySeq, hydrated.entrySeq),
    liveStart: hydrated.entries.length,
    fileStart: page.start,
  };
}

function lastUserText(state: ChatTranscriptState): string | undefined {
  const last = state.messages[state.messages.length - 1];
  if (last?.role !== "user") return undefined;
  const text = last.content.find((p) => p.type === "text");
  return text && text.type === "text" ? text.text : undefined;
}

export type OptimisticKind = "prompt" | "follow_up" | "slash";

export function appendOptimisticUser(state: ChatTranscriptState, text: string, kind: OptimisticKind = "prompt", slash?: { name: string; args?: string }): ChatTranscriptState {
  const messages: ChatMessage[] = [...state.messages, { role: "user", content: [{ type: "text", text }] }];
  if (kind === "slash" && slash) {
    return appendEntry({ ...state, messages }, { actor: ACTOR.you, type: "slash", name: slash.name, args: slash.args, at: Date.now() });
  }
  return appendEntry({ ...state, messages }, { actor: ACTOR.you, type: kind === "follow_up" ? "follow_up" : "prompt", text, at: Date.now() });
}

/** Drop a send that OMP refused after the daemon already acked the stdin write. */
export function removeOptimisticSend(state: ChatTranscriptState, entryId: string): ChatTranscriptState {
  const entry = state.entries.find((row) => row.id === entryId);
  const entries = state.entries.filter((row) => row.id !== entryId);
  let messages = state.messages;
  if (entry && (entry.type === "prompt" || entry.type === "follow_up")) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      const text = message.content.find((part) => part.type === "text");
      if (text?.type === "text" && text.text === entry.text) {
        messages = [...messages.slice(0, i), ...messages.slice(i + 1)];
        break;
      }
    }
  }
  return { ...state, entries, messages, pendingTurn: false };
}

/** True when this response is the failure of the prompt/follow_up we just wrote. */
export function matchingSendFailure(value: unknown, commandId: string): string | null {
  const event = asRecord(value);
  if (!event || event.type !== "response" || event.success !== false) return null;
  if (event.id !== commandId) return null;
  if (event.command !== "prompt" && event.command !== "follow_up" && event.command !== "abort_and_prompt") return null;

  return typeof event.error === "string" ? event.error : "Send was refused.";
}

export function appendOptimisticAbort(state: ChatTranscriptState, text = "Stopped the running turn."): ChatTranscriptState {
  return appendEntry(state, { actor: ACTOR.you, type: "abort", text, at: Date.now() });
}

export function appendHarnessNotice(state: ChatTranscriptState, event: string, text: string): ChatTranscriptState {
  return appendEntry(state, { actor: ACTOR.omp, type: "harness", event, text, at: Date.now() });
}

function openTurn(state: ChatTranscriptState): ChatTranscriptState {
  if (state.turnOpen) return { ...state, pendingTurn: false };
  const cleaned = dropLiveAssistantRows(state);
  const turn = cleaned.turn + 1;
  return appendEntry({ ...cleaned, turn, turnOpen: true, pendingTurn: false }, { actor: ACTOR.omp, type: "turn_marker", turn, phase: "start", at: Date.now() });
}

function closeTurn(state: ChatTranscriptState, stopReason?: string): ChatTranscriptState {
  if (!state.turnOpen) {
    return { ...dropLiveAssistantRows(state), pendingTurn: false };
  }
  // Keep this turn's live assistant rows as committed history. Deleting them would
  // wipe the visible reply at turn_end (the grok dump / any live session without a
  // journal re-seed). Keys are cleared and liveStart advances so the next turn cannot
  // orphan or rewrite them.
  return appendEntry(
    { ...state, turnOpen: false, pendingTurn: false, liveAssistantKeys: {}, liveStart: state.entries.length },
    { actor: ACTOR.omp, type: "turn_marker", turn: state.turn, phase: "end", stopReason, at: Date.now() },
  );
}

const SUBAGENT_STATUS: SubagentStatus[] = ["spawned", "running", "waiting", "completed", "failed", "aborted"];

function subagentEnvelopeId(event: Record<string, unknown>): string | undefined {
  const progress = asRecord(event.progress);
  return asString((progress?.id ?? event.id) as unknown);
}

function applySubagent(state: ChatTranscriptState, event: Record<string, unknown>): ChatTranscriptState {
  const progress = asRecord(event.progress);
  const subagentId = subagentEnvelopeId(event);
  if (!subagentId) return state;
  const label = asString(event.agent) ?? asString(event.name) ?? subagentId;
  const role = asString(event.agentSource) ?? asString(event.role);
  const summary = asString((progress?.description ?? event.description ?? event.summary ?? event.text ?? event.message ?? event.preview) as unknown) ?? "";
  let rawStatus = asString((progress?.status ?? event.status ?? event.state) as unknown) ?? "running";
  if (rawStatus === "started" || rawStatus === "pending") rawStatus = "running";
  const status = (SUBAGENT_STATUS as string[]).includes(rawStatus) ? (rawStatus as SubagentStatus) : "running";
  const tools = typeof event.tools === "number" ? event.tools : undefined;
  const durationMs = typeof event.durationMs === "number" ? event.durationMs : typeof event.duration_ms === "number" ? event.duration_ms : undefined;
  return appendEntry(state, {
    actor: subagent(label),
    type: "subagent_status",
    subagentId,
    agent: label,
    role,
    status,
    summary,
    tools,
    durationMs,
    at: Date.now(),
  });
}

function applyPendingUi(state: ChatTranscriptState, event: Record<string, unknown>): ChatTranscriptState {
  const id = asString(event.id);
  if (!id) return state;
  const method = asString(event.method);
  const pending: PendingUi = { id, method };
  const widgetKey = asString(event.widgetKey);
  if (widgetKey) pending.widgetKey = widgetKey;
  const url = asString(event.url);
  if (url) pending.url = url;
  const launchUrl = asString(event.launchUrl);
  if (launchUrl) pending.launchUrl = launchUrl;
  const title = asString(event.title);
  if (title) pending.title = title;
  const placeholder = asString(event.placeholder);
  if (placeholder) pending.placeholder = placeholder;
  const instructions = asString(event.instructions);
  const message = asString(event.message);
  if (instructions) pending.instructions = instructions;
  else if (message) pending.instructions = message;
  const options = event.options;
  if (Array.isArray(options)) pending.options = options.filter((o): o is string => typeof o === "string");
  const details = event.optionDetails;
  if (Array.isArray(details)) {
    pending.optionDetails = details.map((item) => {
      const rec = asRecord(item);
      return { description: asString(rec?.description) };
    });
  }
  let next: ChatTranscriptState = { ...state, pendingUi: [...state.pendingUi, pending] };
  if (method === "confirm") {
    next = appendEntry(next, {
      actor: ACTOR.alinery,
      type: "approval",
      requestId: id,
      action: title ?? "Approval required",
      detail: message ?? instructions ?? "",
      options: pending.options,
      at: Date.now(),
    });
  }
  if (method === "open_url") {
    // An extension-supplied link is never launched on arrival: it becomes an approval the user has
    // to answer. The heading stays ours because `title` is extension-controlled and could dress
    // the link up, and the detail is the origin rather than the raw string — `new URL()` resolves
    // `https://accounts.google.com@evil.example/x` to `https://evil.example`, which is the part
    // that decides where the click actually goes.
    next = appendEntry(next, {
      actor: ACTOR.alinery,
      type: "approval",
      requestId: id,
      action: "Open a link in your browser?",
      detail: displayUrl(pending.launchUrl ?? pending.url ?? ""),
      at: Date.now(),
    });
  }
  if (method === "notify") {
    next = appendEntry(next, { actor: ACTOR.omp, type: "harness", event: "notify", text: title ?? instructions ?? "", at: Date.now() });
  }
  return next;
}

/** Origin + path of an extension-supplied URL: drops userinfo, query and fragment, which are
 *  where a link disguises its destination. Falls back to the raw string when it will not parse —
 *  such a URL is refused at approval time anyway, and the user should still see what was asked. */
function displayUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
}

export function dismissPendingUi(state: ChatTranscriptState, id: string): ChatTranscriptState {
  return {
    ...state,
    pendingUi: state.pendingUi.filter((p) => p.id !== id),
    entries: state.entries.filter((e) => !(e.type === "approval" && e.requestId === id)),
  };
}

export function applyRpcLine(state: ChatTranscriptState, value: unknown): ChatTranscriptState {
  const event = asRecord(value);
  if (!event || typeof event.type !== "string") return state;

  if (event.type === "ready") {
    return {
      ...state,
      ready: true,
      protocolVersion: typeof event.protocolVersion === "number" ? event.protocolVersion : state.protocolVersion,
    };
  }

  if (event.type === "extension_ui_request") {
    return applyPendingUi(state, event);
  }

  if (event.type === "available_commands_update") {
    return { ...state, commands: mapCommands(event.commands) };
  }

  if (HARNESS_EVENTS.has(event.type) && event.type !== "available_commands_update") {
    const text =
      event.type === "auto_compaction_start"
        ? (asString(event.text) ?? "Compacting conversation…")
        : event.type === "auto_compaction_end"
          ? (asString(event.text) ?? "")
          : eventText(event);
    const nextMeta =
      event.type === "model_changed" && text
        ? { ...state.sessionMeta, model: text }
        : event.type === "thinking_level_changed" && text
          ? { ...state.sessionMeta, thinking: text }
          : event.type === "auto_compaction_start"
            ? { ...state.sessionMeta, isCompacting: true }
            : event.type === "auto_compaction_end"
              ? { ...state.sessionMeta, isCompacting: false }
              : state.sessionMeta;
    return appendEntry({ ...state, sessionMeta: nextMeta }, { actor: ACTOR.omp, type: "harness", event: event.type, text, at: Date.now() });
  }

  if (event.type === "response") {
    const sendCommand = event.command === "prompt" || event.command === "follow_up";
    if (event.success === false && typeof event.error === "string") {
      // OMP refuses history requests while it is busy. Nothing asks for history over RPC any
      // more (the journal is read from disk), so a history-shaped refusal is noise. A rejected
      // prompt/follow_up is not — that is a real user-facing failure.
      if ((event.code === "session_busy" || event.code === "stale_cursor") && !sendCommand) return state;
      // Only a refused send clears the turn guess. A failed get_state / set_model / login must
      // not open a window where the next submit uses `prompt` inside an active turn.
      const next = sendCommand ? { ...state, pendingTurn: false } : state;
      return appendEntry(next, { actor: ACTOR.omp, type: "error", text: transportLimitMessage(event.error), at: Date.now() });
    }
    if (event.command === "negotiate_protocol") {
      const data = asRecord(event.data);
      const version = typeof data?.protocolVersion === "number" ? data.protocolVersion : 2;
      return { ...state, protocolVersion: version };
    }
    const data = asRecord(event.data);
    if (event.command === "get_available_commands" && data) {
      return { ...state, commands: mapCommands(data.commands) };
    }
    if (event.command === "get_state" && data) {
      return applySessionMeta(state, data);
    }
    if (event.command === "set_auto_compaction" && data && typeof data.enabled === "boolean") {
      return { ...state, sessionMeta: { ...state.sessionMeta, autoCompactionEnabled: data.enabled } };
    }
    if (event.command === "get_available_models" && data) {
      return applyModels(state, data);
    }
    if (event.command === "get_login_providers" && data) {
      return applyLoginProviders(state, data);
    }
    if (event.command === "get_subagents") {
      const subagents = data?.subagents;
      if (!Array.isArray(subagents)) return state;
      return subagents.reduce<ChatTranscriptState>((next, item) => {
        const rec = asRecord(item);
        if (!rec) return next;
        const subagentId = subagentEnvelopeId(rec);
        if (subagentId && next.entries.some((entry) => entry.type === "subagent_status" && entry.subagentId === subagentId)) {
          return next;
        }
        return applySubagent(next, rec);
      }, state);
    }

    if (event.command === "set_model" && data) {
      const model = modelLabel(data) ?? modelLabel({ provider: data.provider, id: data.modelId ?? data.id });
      return model ? { ...state, sessionMeta: { ...state.sessionMeta, model } } : state;
    }
    if (sendCommand && data?.agentInvoked === false) {
      // OMP handled it locally — no turn is coming.
      return patchLastSlash({ ...state, pendingTurn: false }, true);
    }
    if (sendCommand && data?.agentInvoked === true) {
      return patchLastSlash(state, false);
    }
    return state;
  }

  if (event.type === "message_start" || event.type === "message_end") {
    const message = asRecord(event.message);
    if (!message) return state;
    const role = message.role === "user" || message.role === "assistant" ? message.role : null;
    const content = mapContent(message.content);
    if (role === "user") {
      if (event.type === "message_start") {
        const incomingText = content.find((part) => part.type === "text");
        const incoming = incomingText?.type === "text" ? incomingText.text : "";
        if (incoming) {
          for (let i = state.entries.length - 1; i >= 0; i -= 1) {
            const entry = state.entries[i];
            if (entry?.type === "follow_up" && entry.text === incoming) {
              const entries = state.entries.slice();
              entries[i] = { ...entry, type: "prompt" };
              return { ...state, entries };
            }
          }
          const lastUserEntry = [...state.entries].reverse().find((entry) => entry.type === "prompt" || entry.type === "follow_up");
          if (lastUserText(state) === incoming && lastUserEntry?.type === "prompt") {
            return state;
          }
        }
        const parsed = parseSlash(incoming);
        const next = { ...state, messages: [...state.messages, { role: "user" as const, content }] };
        if (parsed) {
          return appendEntry(next, { actor: ACTOR.you, type: "slash", name: parsed.name, args: parsed.args || undefined, at: Date.now() });
        }
        return appendEntry(next, { actor: ACTOR.you, type: "prompt", text: incoming, at: Date.now() });
      }
      return state;
    }
    if (role === "assistant") {
      return syncLiveAssistant(state, content, typeof message.stopReason === "string" ? message.stopReason : undefined, event.type === "message_start");
    }
    return state;
  }

  if (event.type === "message_update") {
    const incoming = asRecord(event.message);
    if (incoming?.role !== "assistant") return state;
    const rpcEvent = asRecord(event.assistantMessageEvent);
    const eventType = typeof rpcEvent?.type === "string" ? rpcEvent.type : "";
    const content = mapContent(incoming.content);
    const stopReason = typeof incoming.stopReason === "string" ? incoming.stopReason : undefined;
    return syncLiveAssistant(state, content, stopReason, STREAMING_EVENTS.has(eventType));
  }

  if (event.type === "agent_start" || event.type === "turn_start") {
    return openTurn(state);
  }
  if (event.type === "agent_end" || event.type === "turn_end") {
    const stop = asString(event.stopReason) ?? (event.isTerminal === false ? undefined : asString(event.reason));
    return closeTurn(state, stop);
  }

  if (event.type === "subagent_lifecycle" || event.type === "subagent_progress" || event.type === "subagent_event" || event.type === "subagent_status") {
    const payload = asRecord(event.payload) ?? asRecord(event.event) ?? asRecord(event.data) ?? event;
    return applySubagent(state, payload);
  }

  if (event.type === "advisor_cost_changed" || event.type === "prompt_result") {
    if (event.type === "prompt_result") {
      const data = asRecord(event.data) ?? event;
      if (data.agentInvoked === false) return patchLastSlash(state, true);
      if (data.agentInvoked === true) return patchLastSlash(state, false);
    }
    return state;
  }

  if (event.type === "error") {
    return appendEntry(state, { actor: ACTOR.omp, type: "error", text: eventText(event) || "Error", at: Date.now() });
  }

  void PRESENTATION_UI;
  return { ...state, unknownTypes: [...state.unknownTypes, event.type] };
}

export function applyRpcLines(lines: unknown[]): ChatTranscriptState {
  return lines.reduce<ChatTranscriptState>((state, line) => applyRpcLine(state, line), emptyTranscript());
}

export function flattenWouldFail(parts: ChatPart[]): boolean {
  return parts.length > 1;
}

export function isPresentationUi(method?: string): boolean {
  return method != null && PRESENTATION_UI.has(method);
}

export function needsUiReply(method?: string): boolean {
  return method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "open_url";
}
