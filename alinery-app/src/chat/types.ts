import type { UserRowAttachment } from "./attachments";

export type ActorKind = "user" | "assistant" | "subagent" | "harness" | "system";

export type Actor = {
  kind: ActorKind;
  name: string;
};

export type ToolStatus = "running" | "ok" | "error" | "blocked" | "aborted" | "denied";

export type SubagentStatus = "spawned" | "running" | "waiting" | "completed" | "failed" | "aborted";

export type ChatEntryType =
  | "prompt"
  | "follow_up"
  | "slash"
  | "thinking"
  | "redacted_thinking"
  | "text"
  | "tool_call"
  | "tool_result"
  | "subagent_status"
  | "approval"
  | "turn_marker"
  | "error"
  | "abort"
  | "harness";

type Base = {
  id: string;
  /** Wall clock when we first saw this row. Omitted for hydrated history with no timestamp. */
  at?: number;
  actor: Actor;
};

export type ChatEntry =
  | (Base & { type: "prompt" | "follow_up"; text: string; attachments?: UserRowAttachment[] })
  | (Base & { type: "slash"; name: string; args?: string; local?: boolean })
  | (Base & {
      type: "thinking";
      text: string;
      streaming?: boolean;
      durationMs?: number;
      aborted?: boolean;
    })
  | (Base & { type: "redacted_thinking" })
  | (Base & { type: "text"; text: string; streaming?: boolean })
  | (Base & {
      type: "tool_call";
      tool: string;
      toolId?: string;
      args?: string;
      target?: string;
      status: ToolStatus;
      durationMs?: number;
      detail?: string;
    })
  | (Base & { type: "tool_result"; tool: string; text: string; status: ToolStatus })
  | (Base & {
      type: "subagent_status";
      /** OMP identity. Distinct from Base.id (transcript row / React key). */
      subagentId: string;
      agent: string;
      role?: string;
      status: SubagentStatus;
      summary: string;
      durationMs?: number;
      tools?: number;
    })
  | (Base & { type: "approval"; requestId: string; action: string; detail: string; scope?: string; options?: string[] })
  | (Base & { type: "turn_marker"; turn: number; phase: "start" | "end"; stopReason?: string })
  | (Base & { type: "error"; text: string })
  | (Base & { type: "abort"; text: string })
  | (Base & { type: "harness"; event: string; text: string });

export type SessionChatStatus = "idle" | "running" | "waiting_approval";

export type CommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export type ChatCommand = {
  name: string;
  aliases?: string[];
  description?: string;
  source?: CommandSource;
  input?: { hint: string };
};

export const ACTOR = {
  you: { kind: "user", name: "You" } as const,
  agent: { kind: "assistant", name: "Agent" } as const,
  omp: { kind: "harness", name: "OMP" } as const,
  alinery: { kind: "system", name: "Alinery" } as const,
};

export function subagent(name: string): Actor {
  return { kind: "subagent", name };
}

export type WhoLane = "you" | "agent" | "alinery";

export function whoLane(actor: Actor): WhoLane {
  if (actor.kind === "user") return "you";
  if (actor.kind === "system") return "alinery";
  return "agent";
}

export function whoLabel(actor: Actor): string {
  const lane = whoLane(actor);
  if (lane === "you") return "You";
  if (lane === "alinery") return "Alinery";
  return "Agent";
}

export const TYPE_LABEL: Record<ChatEntryType, string> = {
  prompt: "Prompt",
  follow_up: "Queued",

  slash: "Command",
  thinking: "Thinking",
  redacted_thinking: "Thinking",
  text: "Reply",
  tool_call: "Tool",
  tool_result: "Result",
  subagent_status: "Subagent",
  approval: "Approval",
  turn_marker: "Turn",
  error: "Error",
  abort: "Abort",
  harness: "Harness",
};

export const SOURCE_GROUPS: CommandSource[] = ["builtin", "skill", "extension", "custom", "mcp_prompt", "file"];

export const SOURCE_LABEL: Record<CommandSource, string> = {
  builtin: "builtin",
  skill: "skill",
  extension: "extension",
  custom: "custom",
  mcp_prompt: "mcp",
  file: "file",
};
