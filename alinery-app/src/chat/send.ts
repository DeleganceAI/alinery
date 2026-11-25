import { appendHarnessNotice, appendOptimisticUser, type ChatTranscriptState, type OptimisticKind, type QueueAbortCue, type QueuedPanelLine } from "../chatTranscript";
import type { UserRowAttachment } from "./attachments";
import { findCommand, parseSlash } from "./commands";
import { routeSlash, type SlashDispatch } from "./slash";
import type { ChatCommand, QueuedLine } from "./types";

export type ChatSendDispatch = SlashDispatch | { kind: "plain"; message: string };

export type ChatSendPlan = {
  dispatch: ChatSendDispatch;
  /**
   * This send should start an agent turn, so routing can steer the next one before `turn_start`
   * arrives. Decided here because only this layer has the catalog: `prompt` covers both builtins
   * Vinculum answers locally (`/effort`) and the entries that do invoke the agent, and the source is
   * what separates them (docs/research/vinculum-rpc-slash-commands.md).
   */
  invokesModel: boolean;
  optimisticKind: OptimisticKind;
  slash?: { name: string; args?: string };
  notice?: string;
};

/** Map a composer submit onto host intercept vs prompt. A busy send waits in the Queued panel, so this plan never names a follow_up row. Catalog names become slash rows; unknown `/name` is a model turn plus a harness notice. */
export function planChatSend(raw: string, catalog: ChatCommand[], busy: boolean): ChatSendPlan {
  const parsed = parseSlash(raw);
  const routed = routeSlash(raw, catalog);
  if (!routed) {
    return { dispatch: { kind: "plain", message: raw }, invokesModel: true, optimisticKind: "prompt" };
  }
  const slash = parsed ? { name: parsed.name, args: parsed.args || undefined } : undefined;
  if (routed.kind === "unknown-prompt") {
    return {
      dispatch: routed,
      invokesModel: true,
      optimisticKind: "prompt",
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
      optimisticKind: busy ? "prompt" : "slash",
      slash: busy ? undefined : slash,
    };
  }
  return { dispatch: routed, invokesModel: false, optimisticKind: "slash", slash };
}

/** Catalog sources Vinculum answers with `agentInvoked: true`; a builtin or extension does not. */
const AGENT_SOURCES = new Set(["skill", "custom", "file", "mcp_prompt"]);

function invokesAgent(name: string | undefined, catalog: ChatCommand[]): boolean {
  if (!name) return false;
  if (name.toLowerCase().startsWith("skill:")) return true;
  const source = findCommand(name, catalog)?.source;
  return source !== undefined && AGENT_SOURCES.has(source);
}

export function applySendPlan(state: ChatTranscriptState, text: string, plan: ChatSendPlan, attachments?: UserRowAttachment[]): { state: ChatTranscriptState; entryId: string } {
  let next = appendOptimisticUser(state, text, plan.optimisticKind, plan.slash, attachments);
  const entryId = next.entries[next.entries.length - 1]?.id ?? "";
  if (plan.notice) {
    const event = plan.dispatch.kind === "hatch" ? "hatch" : "notice";
    next = appendHarnessNotice(next, event, plan.notice);
  }
  // Guess that a turn is starting, because `turn_start` trails the write and the observation poll
  // trails it by up to 1.5s — a second submit in that window has nothing else telling it to steer.
  // It stays a guess: `pendingTurn`, not `turnOpen`, so `turn_start` still emits its marker and
  // `turn` still counts what Vinculum actually ran. Every dispatch that reaches the model claims it,
  // `prompt` included — that is `/skill:*` and the custom/file/mcp_prompt catalog entries, which
  // do invoke the agent. Over-claiming is safe now that a refusal or `agentInvoked:false` clears
  // it; under-claiming is the bug this exists to prevent.
  return { state: plan.invokesModel ? { ...next, pendingTurn: true } : next, entryId };
}

/**
 * The daemon accepted this send and will deliver it later: the line waits in the Queued panel instead of becoming a
 * thread row. `pendingTurn` is set exactly as `applySendPlan` sets it for a send that invokes the model — the turn is
 * still coming — and neither `entries` nor `messages` is touched, so the thread shows nothing until delivery.
 */
export function queueOptimisticLine(state: ChatTranscriptState, line: QueuedLine, plan?: Pick<ChatSendPlan, "invokesModel">): ChatTranscriptState {
  // A frame may have folded this id before the reply arrived. Keep that line — the server's, if it sent one — and only raise the flag.
  if (state.queued.some((item) => item.id === line.id)) return plan?.invokesModel ? { ...state, pendingTurn: true } : state;
  const queued = [...state.queued, { ...line, origin: "pending" as const, stale: false }];
  const next = { ...state, queued, sessionMeta: { ...state.sessionMeta, queuedMessageCount: queued.length } };
  return plan?.invokesModel ? { ...next, pendingTurn: true } : next;
}

/** The panel line a queued admission names. `mode` is the product's follow-up; the daemon's frame is what later corrects it. */
export function queuedLineOf(admitted: { submissionId: string }, text: string, images: readonly { name?: string; mimeType: string }[]): QueuedLine {
  return { id: admitted.submissionId, mode: "followUp", text, images: images.map((image) => ({ name: image.name ?? "", mimeType: image.mimeType })) };
}

/** Drop a panel line, ask the daemon to withdraw it, and put the line back if that call fails. Each view passes its own ref and setter. */
export async function removeQueuedAndRestore(drop: () => QueuedPanelLine | undefined, call: () => Promise<unknown>, restore: (line: QueuedPanelLine) => void): Promise<void> {
  const line = drop();
  if (!line) return;
  try {
    await call();
  } catch {
    restore(line);
  }
}

/** Take one line out of the panel. The count moves with the list, in the same update. */
export function dropQueuedLine(state: ChatTranscriptState, id: string): { state: ChatTranscriptState; removed?: QueuedPanelLine } {
  const removed = state.queued.find((line) => line.id === id);
  if (!removed) return { state };
  const queued = state.queued.filter((line) => line.id !== id);
  return { removed, state: { ...state, queued, sessionMeta: { ...state.sessionMeta, queuedMessageCount: queued.length } } };
}

/** Put a line back after a remove call rejected. A frame that already holds the id wins; the previous origin and stale flag are kept. */
export function restoreQueuedLine(state: ChatTranscriptState, line: QueuedPanelLine): ChatTranscriptState {
  if (state.queued.some((item) => item.id === line.id)) return state;
  const queued = [...state.queued, line];
  return { ...state, queued, sessionMeta: { ...state.sessionMeta, queuedMessageCount: queued.length } };
}

/**
 * The abort call rejected: it withdrew nothing. Retract the cue's claim before putting the lines back, or the first
 * fold after the call settles takes them again — and the daemon will never re-send a queue it never changed. Every
 * rejection path goes through here; a successful abort keeps the claim and the fold empties the panel for it.
 */
export function restoreAfterRejectedAbort(cue: QueueAbortCue, state: ChatTranscriptState, held: readonly QueuedPanelLine[]): ChatTranscriptState {
  cue.withdrawn = false;
  return held.reduce((current, line) => restoreQueuedLine(current, line), state);
}
