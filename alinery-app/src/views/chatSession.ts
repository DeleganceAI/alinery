import { decodeOmpPage } from "../chat/ompFile";
import { queuedCountFromGetState, trimQueuedFollowUps } from "../chat/queue";
import { applySendPlan } from "../chat/send";
import { applyFilePage, applyRpcLine, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import {
  abortAndPromptCommand,
  abortCommand,
  followUpCommand,
  getAvailableModelsCommand,
  getStateCommand,
  negotiateProtocolCommand,
  promptCommand,
  setModelCommand,
} from "../ompRpc";

export function journalState(buffer: ArrayBuffer): ChatTranscriptState {
  const page = decodeOmpPage(buffer);
  return applyFilePage(emptyTranscript(), { start: page.start, messages: page.messages }, "initial");
}

export function parseChatLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** One RPC line into the transcript. A `get_state` reply also drops follow-up rows OMP no longer holds. */
export function applyChatValue(state: ChatTranscriptState, value: unknown): ChatTranscriptState {
  if (value === undefined) return state;
  try {
    const next = applyRpcLine(state, value);
    const queued = queuedCountFromGetState(value);
    return queued === undefined ? next : { ...next, entries: trimQueuedFollowUps(next.entries, queued) };
  } catch {
    return state;
  }
}

/**
 * OMP streams no queue changes, so re-read `get_state` once a follow-up lands or a turn ends, as task
 * sessions do. Without it a delivered follow-up keeps its "queued" row beside the delivered copy.
 */
export function queueRefreshCommand(value: unknown) {
  const rec = value !== null && typeof value === "object" ? (value as { type?: unknown; success?: unknown; command?: unknown }) : null;
  if (!rec) return null;
  const queueMoved =
    (rec.type === "response" && rec.success === true && (rec.command === "follow_up" || rec.command === "abort_and_prompt")) || rec.type === "turn_end" || rec.type === "agent_end";
  return queueMoved ? getStateCommand() : null;
}

export function attachHandshake() {
  return [negotiateProtocolCommand(), getStateCommand(), getAvailableModelsCommand()];
}

/**
 * Idle sends a prompt; a running turn queues a follow-up. Never route on "has this thread started":
 * OMP drains follow-ups only after an assistant/toolResult message, so a follow-up on an empty
 * session is accepted and never run.
 */
export function sendCommand(text: string, busy: boolean) {
  return busy ? followUpCommand(text) : promptCommand(text);
}

/** The optimistic row for a plain send. Chat has no command catalog, so every send claims the turn. */
export function applyPlainSend(state: ChatTranscriptState, text: string, busy: boolean): ChatTranscriptState {
  return applySendPlan(state, text, { dispatch: { kind: "plain", message: text }, invokesModel: true, optimisticKind: busy ? "follow_up" : "prompt" }).state;
}

/** Send now: abort the running turn and prompt with this text instead of queueing it. */
export function sendNowCommand(text: string) {
  return abortAndPromptCommand(text);
}

export function abortTurnCommand() {
  return abortCommand();
}

export function applyModelCommand(provider: string, modelId: string) {
  return setModelCommand(provider, modelId);
}
