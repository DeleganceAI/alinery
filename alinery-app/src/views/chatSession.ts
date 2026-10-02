import { decodeOmpPage } from "../chat/ompFile";
import { queuedCountFromGetState, trimQueuedFollowUps } from "../chat/queue";
import { applySendPlan } from "../chat/send";
import { applyFilePage, applyRpcLine, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import * as ipc from "../ipc";
import {
  abortAndPromptCommand,
  abortCommand,
  followUpCommand,
  getAvailableCommandsCommand,
  getAvailableModelsCommand,
  getStateCommand,
  getSubagentsCommand,
  negotiateProtocolCommand,
  promptCommand,
  setAutoCompactionCommand,
  setModelCommand,
  setSubagentSubscriptionCommand,
} from "../ompRpc";
import type { SessionTerminalIo } from "../SessionTerminal";

export function journalState(buffer: ArrayBuffer): ChatTranscriptState {
  const page = decodeOmpPage(buffer);
  return applyFilePage(emptyTranscript(), { start: page.start, messages: page.messages }, "initial");
}

/** An older page of the journal, prepended; the caller names the thread it asked for. */
export function olderPageState(current: ChatTranscriptState, buffer: ArrayBuffer): ChatTranscriptState {
  const page = decodeOmpPage(buffer);
  return applyFilePage(current, { start: page.start, messages: page.messages }, "older");
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

export function attachHandshake(autoCompaction: boolean) {
  // The command catalog too: OMP sends available_commands_update once at startup, and the daemon's
  // replay drops it after the first turn, so only an explicit ask fills the `/` list on reattach.
  // Subscribe before get_subagents so rows that finished during the gap still arrive as events.
  return [
    negotiateProtocolCommand(),
    getAvailableCommandsCommand(),
    getStateCommand(),
    setAutoCompactionCommand(autoCompaction),
    setSubagentSubscriptionCommand("events"),
    getSubagentsCommand(),
    getAvailableModelsCommand(),
  ];
}

/**
 * Idle sends a prompt; a running turn queues a follow-up. Never route on "has this thread started":
 * OMP drains follow-ups only after an assistant/toolResult message, so a follow-up on an empty
 * session is accepted and never run.
 */
export function sendCommand(text: string, busy: boolean) {
  return busy ? followUpCommand(text) : promptCommand(text);
}

/** The optimistic row for a send that resumed the thread: plain text, so it claims the turn. */
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

/** The terminal hatch's daemon calls, scoped to the thread's own repo instead of the active one. */
export function chatTerminalIo(repoPath: string, id: string): SessionTerminalIo {
  return {
    open: (args) => ipc.chatPtyAttach({ repoPath, id, attachId: args.attachId, streamToken: args.streamToken, cols: args.cols, rows: args.rows, onBytes: args.onBytes }),
    write: (data) => ipc.chatPtyWrite(repoPath, id, data),
    resize: (cols, rows) => ipc.chatPtyResize(repoPath, id, cols, rows),
    detach: (attachId) => ipc.chatDetach(repoPath, id, attachId),
    status: () => ipc.chatSessionStatus(repoPath, id),
  };
}
