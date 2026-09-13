import type { ChatPart } from "../types";
import { ACTOR, type ChatEntry, type ToolStatus } from "./types";

export function projectJournal(entries: ChatEntry[]): ChatEntry[] {
  return entries;
}

function argsText(args: unknown): string | undefined {
  if (args == null) return undefined;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function toolTarget(args: unknown): string | undefined {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["path", "command", "target", "file", "url"]) {
    if (typeof rec[key] === "string") return rec[key];
  }
  return undefined;
}

function toolStatus(streaming: boolean | undefined): ToolStatus {
  return streaming ? "running" : "ok";
}

/** Explode an assistant content[] snapshot into sibling journal rows. Stable ids come from `idFor`. */
export function explodeAssistantParts(content: ChatPart[], idFor: (key: string) => string, at: number | undefined, aborted: boolean): ChatEntry[] {
  const rows: ChatEntry[] = [];
  let thinkingIndex = 0;
  let textIndex = 0;
  let resultIndex = 0;
  for (const part of content) {
    if (part.type === "thinking") {
      const key = `thinking:${thinkingIndex}`;
      thinkingIndex += 1;
      rows.push({
        id: idFor(key),
        at,
        actor: ACTOR.agent,
        type: "thinking",
        text: part.thinking,
        streaming: part.streaming,
        aborted: aborted || undefined,
      });
      continue;
    }
    if (part.type === "redactedThinking") {
      rows.push({
        id: idFor(`redacted:${thinkingIndex}`),
        at,
        actor: ACTOR.agent,
        type: "redacted_thinking",
      });
      thinkingIndex += 1;
      continue;
    }
    if (part.type === "text") {
      const key = `text:${textIndex}`;
      textIndex += 1;
      rows.push({
        id: idFor(key),
        at,
        actor: ACTOR.agent,
        type: "text",
        text: part.text,
        streaming: part.streaming,
      });
      continue;
    }
    if (part.type === "toolCall") {
      const key = `tool:${part.id ?? part.name ?? textIndex}`;
      rows.push({
        id: idFor(key),
        at,
        actor: ACTOR.agent,
        type: "tool_call",
        tool: part.name ?? "tool",
        toolId: part.id,
        args: argsText(part.args),
        target: toolTarget(part.args),
        status: toolStatus(part.streaming),
      });
      continue;
    }
    if (part.type !== "toolResult") continue;
    const key = `result:${resultIndex}`;
    resultIndex += 1;
    rows.push({
      id: idFor(key),
      at,
      actor: ACTOR.agent,
      type: "tool_result",
      tool: "tool",
      text: part.body ?? "",
      status: "ok",
    });
  }
  return rows;
}
