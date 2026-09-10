import { appendHarnessNotice, appendOptimisticUser, type ChatTranscriptState, type OptimisticKind } from "../chatTranscript";
import { findCommand, parseSlash } from "./commands";
import { routeSlash, type SlashDispatch } from "./slash";
import type { ChatCommand } from "./types";

export type ChatSendDispatch = SlashDispatch | { kind: "plain"; message: string };

export type ChatSendPlan = {
  dispatch: ChatSendDispatch;
  /**
   * This send should start an agent turn, so routing can steer the next one before `turn_start`
   * arrives. Decided here because only this layer has the catalog: `prompt` covers both builtins
   * OMP answers locally (`/thinking`) and the entries that do invoke the agent, and the source is
   * what separates them (docs/research/omp-rpc-slash-commands.md).
   */
  invokesModel: boolean;
  optimisticKind: OptimisticKind;
  slash?: { name: string; args?: string };
  notice?: string;
};

/** Map a composer submit onto host intercept vs prompt/follow_up. Catalog names become slash rows; unknown `/name` is a model turn plus a harness notice. */
export function planChatSend(raw: string, catalog: ChatCommand[], busy: boolean): ChatSendPlan {
  const parsed = parseSlash(raw);
  const routed = routeSlash(raw, catalog);
  if (!routed) {
    return { dispatch: { kind: "plain", message: raw }, invokesModel: true, optimisticKind: busy ? "follow_up" : "prompt" };
  }
  const slash = parsed ? { name: parsed.name, args: parsed.args || undefined } : undefined;
  if (routed.kind === "unknown-prompt") {
    return {
      dispatch: routed,
      invokesModel: true,
      optimisticKind: busy ? "follow_up" : "prompt",
      notice: `/${parsed?.name} is not in the command catalog. Sending as a prompt.`,
    };
  }
  if (routed.kind === "hatch") {
    return { dispatch: routed, invokesModel: false, optimisticKind: "slash", slash, notice: routed.reason };
  }
  if (routed.kind === "prompt" || routed.kind === "mcp-prompt" || routed.kind === "compact-mode") {
    return {
      dispatch: routed,
      invokesModel: invokesAgent(parsed?.name, catalog),
      optimisticKind: busy ? "follow_up" : "slash",
      slash: busy ? undefined : slash,
    };
  }
  return { dispatch: routed, invokesModel: false, optimisticKind: "slash", slash };
}

/** Catalog sources OMP answers with `agentInvoked: true`; a builtin or extension does not. */
const AGENT_SOURCES = new Set(["skill", "custom", "file", "mcp_prompt"]);

function invokesAgent(name: string | undefined, catalog: ChatCommand[]): boolean {
  if (!name) return false;
  if (name.toLowerCase().startsWith("skill:")) return true;
  const source = findCommand(name, catalog)?.source;
  return source !== undefined && AGENT_SOURCES.has(source);
}

export function applySendPlan(state: ChatTranscriptState, text: string, plan: ChatSendPlan): { state: ChatTranscriptState; entryId: string } {
  let next = appendOptimisticUser(state, text, plan.optimisticKind, plan.slash);
  const entryId = next.entries[next.entries.length - 1]?.id ?? "";
  if (plan.notice) {
    const event = plan.dispatch.kind === "hatch" ? "hatch" : "notice";
    next = appendHarnessNotice(next, event, plan.notice);
  }
  // Guess that a turn is starting, because `turn_start` trails the write and the observation poll
  // trails it by up to 1.5s — a second submit in that window has nothing else telling it to steer.
  // It stays a guess: `pendingTurn`, not `turnOpen`, so `turn_start` still emits its marker and
  // `turn` still counts what OMP actually ran. Every dispatch that reaches the model claims it,
  // `prompt` included — that is `/skill:*` and the custom/file/mcp_prompt catalog entries, which
  // do invoke the agent. Over-claiming is safe now that a refusal or `agentInvoked:false` clears
  // it; under-claiming is the bug this exists to prevent.
  return { state: plan.invokesModel ? { ...next, pendingTurn: true } : next, entryId };
}

export function commandOutputText(value: unknown): string | null {
  const rec = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!rec || rec.type !== "command_output") return null;
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.message === "string") return rec.message;
  if (typeof rec.output === "string") return rec.output;
  return "";
}

export function setModelReply(value: unknown): { ok: boolean; error?: string } | null {
  const rec = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!rec || rec.type !== "response" || rec.command !== "set_model") return null;
  if (rec.success === false) return { ok: false, error: typeof rec.error === "string" ? rec.error : "Could not set model." };
  return { ok: true };
}

export function loginReply(value: unknown): { ok: boolean; providerId?: string; error?: string } | null {
  const rec = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!rec || rec.type !== "response" || rec.command !== "login") return null;
  if (rec.success === false) return { ok: false, error: typeof rec.error === "string" ? rec.error : "Login failed." };
  const data = rec.data !== null && typeof rec.data === "object" && !Array.isArray(rec.data) ? (rec.data as Record<string, unknown>) : null;
  const providerId = data && typeof data.providerId === "string" ? data.providerId : undefined;
  return { ok: true, providerId };
}
