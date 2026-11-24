// The pane polls this. Pi stores thinking, text, and tool calls as parts on the assistant
// message, and a tool result as its own message. The reply keeps that shape. A redacted
// thinking part is only the marker: the signature is for the provider, not the pane.
import type { TaskId } from "@earendil-works/pi-durable";
import { WRAP_UP_NUDGE_ENTRY } from "../../../shared/wrapUpNudge.ts";

// The harness's compaction entry kind and summary envelope (pi-durable harness/compaction.js).
// Not exported by the installed package, so they live here, beside the one formatter both reads use.
export const COMPACTION_ENTRY = "pi.compaction";
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

export type TranscriptSource = {
  id: string;
  streaming?: boolean;
  role?: string;
  content?: unknown;
  errorMessage?: string;
  turnError?: string;
  nudgeDeliveryId?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  /** Set when this user row is a compaction entry that carries a head marker. */
  compaction?: { reason: string };
  /** When the message was complete, ms since the epoch. */
  at?: number;
};

export type TranscriptToolSlot = {
  callId: string;
  name: string;
  status: "pending" | "running" | "done";
  output?: string;
};

export type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "redactedThinking" }
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown }
  | { type: "image"; mimeType: string; name?: string };

export type TranscriptReply = {
  id: string;
  role: "user" | "assistant" | "toolResult" | "compaction";
  streaming?: boolean;
  content: TranscriptPart[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  runningToolIds?: string[];
  turnError?: string;
  nudgeDeliveryId?: string;
  compactionReason?: string;
  at?: number;
};

type SpokenEntry = { kind?: string; model?: readonly { role?: string }[] | null };

/** Drop compaction summaries. They are the harness's words, not the person's (HD-1). */
export function withoutCompactionEntries<T extends { kind?: string }>(entries: readonly T[]): T[] {
  return entries.filter((entry) => entry.kind !== COMPACTION_ENTRY);
}

/** User-role model messages that are the person's, the count `userMessageCount` takes. */
export function spokenUserCount(entries: readonly SpokenEntry[]): number {
  return withoutCompactionEntries(entries).reduce((count, entry) => count + (entry.model ?? []).filter((message) => message.role === "user").length, 0);
}

/** Whether someone already spoke. A compaction summary's user-role payload does not count. */
export function hasSpoken(entries: readonly SpokenEntry[]): boolean {
  return withoutCompactionEntries(entries).some((entry) => entry.kind === "pi.user" || (entry.model ?? []).some((message) => message.role === "user"));
}

export function transcriptEntryId(id: unknown, index: number, length: number): string {
  return length === 1 ? String(id) : `${id}:${index}`;
}

export function appendEntryMessages(messages: TranscriptSource[], entry: { id: unknown; model?: unknown; byTaskId?: TaskId; kind?: string; data?: unknown; head?: unknown }, lastErrors?: Map<TaskId, TranscriptSource>) {
  if (!Array.isArray(entry.model)) return;
  for (const [index, message] of entry.model.entries()) {
    if (!message || typeof message !== "object") continue;
    const id = transcriptEntryId(entry.id, index, entry.model.length);
    const source = transcriptSource(id, message);
    if (source.role === "user" && entry.kind === WRAP_UP_NUDGE_ENTRY && entry.data && typeof entry.data === "object" && "deliveryId" in entry.data && typeof entry.data.deliveryId === "string") {
      source.nudgeDeliveryId = entry.data.deliveryId;
    }
    // A compaction entry without a head marker stays a plain user row, so a malformed entry cannot hide text.
    if (source.role === "user" && entry.kind === COMPACTION_ENTRY && entry.head) {
      source.compaction = { reason: String((entry.data as { reason?: unknown } | undefined)?.reason ?? "") };
    }
    messages.push(source);
    if (entry.byTaskId && source.role === "assistant" && lastErrors) {
      if ("stopReason" in message && message.stopReason === "error") lastErrors.set(entry.byTaskId, source);
      else lastErrors.delete(entry.byTaskId);
    }
  }
}

export function transcriptSource(id: string, message: object, streaming = false): TranscriptSource {
  const record = message as {
    role?: unknown;
    content?: unknown;
    errorMessage?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
    timestamp?: unknown;
    durationMs?: unknown;
  };
  // Pi stamps a reply when its request starts; the turn footer wants when it ended.
  const at = typeof record.timestamp === "number" ? record.timestamp + (typeof record.durationMs === "number" ? record.durationMs : 0) : undefined;
  return {
    id,
    ...(streaming ? { streaming: true } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(record.content !== undefined ? { content: record.content } : {}),
    ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
    ...(record.isError === true ? { isError: true } : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

/** Model-issued slots only. Nested slots are a different list and stay out of this reply. */
export function transcriptToolSlots(tools: unknown): TranscriptToolSlot[] {
  if (!Array.isArray(tools)) return [];
  const slots: TranscriptToolSlot[] = [];
  for (const item of tools) {
    if (!item || typeof item !== "object") continue;
    const slot = item as { callId?: unknown; name?: unknown; status?: unknown; output?: unknown };
    if (typeof slot.callId !== "string" || slot.callId.length === 0) continue;
    if (slot.status !== "pending" && slot.status !== "running" && slot.status !== "done") continue;
    const output = typeof slot.output === "string" && slot.output.length > 0 ? slot.output : undefined;
    slots.push({
      callId: slot.callId,
      name: typeof slot.name === "string" ? slot.name : "",
      status: slot.status,
      ...(output ? { output } : {}),
    });
  }
  return slots;
}

function textParts(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Array<{ type: "text"; text: string }> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string" && record.text.length > 0) parts.push({ type: "text", text: record.text });
  }
  return parts;
}

/**
 * A prompt's own parts: its text, and the images the person attached. An image is named, never carried: the
 * pane reads the same file back through BlobService, so a prompt with megabytes of image costs the wire
 * nothing. An image-only prompt is a row of its own (textParts alone would drop the whole message).
 */
function promptParts(content: unknown): TranscriptPart[] {
  if (typeof content === "string") return textParts(content);
  if (!Array.isArray(content)) return [];
  const parts: TranscriptPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; mimeType?: unknown; name?: unknown };
    if (record.type === "image") {
      parts.push({
        type: "image",
        mimeType: typeof record.mimeType === "string" ? record.mimeType : "",
        ...(typeof record.name === "string" && record.name.length > 0 ? { name: record.name } : {}),
      });
      continue;
    }
    if (record.type === "text" && typeof record.text === "string" && record.text.trim().length > 0) parts.push({ type: "text", text: record.text });
  }
  return parts;
}

function assistantParts(content: unknown, streaming: boolean): TranscriptPart[] {
  if (!Array.isArray(content)) return [];
  const parts: TranscriptPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      redacted?: unknown;
      name?: unknown;
      id?: unknown;
      arguments?: unknown;
    };
    if (record.type === "thinking") {
      if (record.redacted === true) {
        parts.push({ type: "redactedThinking" });
        continue;
      }
      const thinking = typeof record.thinking === "string" ? record.thinking : "";
      if (thinking.length > 0 || streaming) parts.push({ type: "thinking", thinking });
      continue;
    }
    if (record.type === "text" && typeof record.text === "string" && record.text.length > 0) {
      parts.push({ type: "text", text: record.text });
      continue;
    }
    if (record.type !== "toolCall" && record.type !== "tool_call") continue;
    parts.push({
      type: "toolCall",
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...("arguments" in record ? { arguments: record.arguments } : {}),
    });
  }
  return parts;
}

function runningResult(slot: TranscriptToolSlot): TranscriptReply {
  return {
    id: `live:${slot.callId}`,
    role: "toolResult",
    streaming: true,
    ...(slot.name ? { toolName: slot.name } : {}),
    toolCallId: slot.callId,
    content: [{ type: "text", text: slot.output ?? "" }],
  };
}

const stamp = (message: TranscriptSource) => (message.at !== undefined ? { at: message.at } : {});

/** The first text part. A compaction entry carries exactly one; a string payload is that text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return "";
}

/** Strip the harness envelope when both ends are present; otherwise the stored text, unchanged. */
function unwrapSummary(text: string): string {
  if (text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX) && text.length >= SUMMARY_PREFIX.length + SUMMARY_SUFFIX.length) {
    return text.slice(SUMMARY_PREFIX.length, text.length - SUMMARY_SUFFIX.length);
  }
  return text;
}

export function formatTranscript(messages: readonly TranscriptSource[], tools: readonly TranscriptToolSlot[] = []): TranscriptReply[] {
  const running = tools.filter((slot) => slot.status === "pending" || slot.status === "running");
  const runningIds = new Set(running.map((slot) => slot.callId));
  const out: TranscriptReply[] = [];
  const emittedResults = new Set<string>();

  for (const message of messages) {
    if (message.compaction) {
      const text = message.compaction ? unwrapSummary(textOf(message.content)) : "";
      out.push({ id: message.id, role: "compaction", content: [{ type: "text", text }], compactionReason: message.compaction.reason, ...stamp(message) });
      continue;
    }
    if (message.role === "user") {
      const content = promptParts(message.content);
      if (content.length === 0) continue;
      out.push({ id: message.id, role: "user", content, ...(message.nudgeDeliveryId ? { nudgeDeliveryId: message.nudgeDeliveryId } : {}), ...stamp(message) });
      continue;
    }
    if (message.role === "toolResult") {
      if (message.toolCallId) emittedResults.add(message.toolCallId);
      out.push({
        id: message.id,
        role: "toolResult",
        ...(message.streaming ? { streaming: true } : {}),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.isError ? { isError: true } : {}),
        ...stamp(message),
        content: textParts(message.content),
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const content = assistantParts(message.content, message.streaming === true);
    if (content.length === 0 && !message.turnError && message.errorMessage?.trim()) content.push({ type: "text", text: message.errorMessage.trim() });
    if (content.length === 0 && !message.turnError) continue;
    const callIds = content.flatMap((part) => (part.type === "toolCall" && part.id && runningIds.has(part.id) ? [part.id] : []));
    out.push({
      id: message.id,
      role: "assistant",
      ...(message.turnError ? { turnError: message.turnError } : {}),
      ...(message.streaming ? { streaming: true } : {}),
      ...(callIds.length > 0 ? { runningToolIds: callIds } : {}),
      ...stamp(message),
      content,
    });
    for (const slot of running) {
      if (!callIds.includes(slot.callId) || !slot.output || emittedResults.has(slot.callId)) continue;
      emittedResults.add(slot.callId);
      out.push(runningResult(slot));
    }
  }
  return out;
}
