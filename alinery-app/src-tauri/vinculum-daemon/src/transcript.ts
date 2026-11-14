// The pane polls this. Pi stores thinking, text, and tool calls as parts on the assistant
// message, and a tool result as its own message. The reply keeps that shape. A redacted
// thinking part is only the marker: the signature is for the provider, not the pane.

export type TranscriptSource = {
  id: string;
  streaming?: boolean;
  role?: string;
  content?: unknown;
  errorMessage?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
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
  | { type: "toolCall"; id?: string; name?: string; arguments?: unknown };

export type TranscriptReply = {
  id: string;
  role: "user" | "assistant" | "toolResult";
  streaming?: boolean;
  content: TranscriptPart[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  runningToolIds?: string[];
};

export function transcriptSource(id: string, message: object, streaming = false): TranscriptSource {
  const record = message as {
    role?: unknown;
    content?: unknown;
    errorMessage?: unknown;
    toolName?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
  };
  return {
    id,
    ...(streaming ? { streaming: true } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(record.content !== undefined ? { content: record.content } : {}),
    ...(typeof record.errorMessage === "string" ? { errorMessage: record.errorMessage } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
    ...(record.isError === true ? { isError: true } : {}),
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

export function formatTranscript(messages: readonly TranscriptSource[], tools: readonly TranscriptToolSlot[] = []): TranscriptReply[] {
  const running = tools.filter((slot) => slot.status === "pending" || slot.status === "running");
  const runningIds = new Set(running.map((slot) => slot.callId));
  const out: TranscriptReply[] = [];
  const emittedResults = new Set<string>();

  for (const message of messages) {
    if (message.role === "user") {
      const content = textParts(message.content).filter((part) => part.text.trim().length > 0);
      if (content.length === 0) continue;
      out.push({ id: message.id, role: "user", content });
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
        content: textParts(message.content),
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const content = assistantParts(message.content, message.streaming === true);
    if (content.length === 0 && message.errorMessage?.trim()) content.push({ type: "text", text: message.errorMessage.trim() });
    if (content.length === 0) continue;
    const callIds = content.flatMap((part) => (part.type === "toolCall" && part.id && runningIds.has(part.id) ? [part.id] : []));
    out.push({
      id: message.id,
      role: "assistant",
      ...(message.streaming ? { streaming: true } : {}),
      ...(callIds.length > 0 ? { runningToolIds: callIds } : {}),
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
