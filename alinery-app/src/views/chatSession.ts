import type { UserRowAttachment } from "../chat/attachments";
import { decodeOmpPage } from "../chat/ompFile";
import { applySendPlan } from "../chat/send";
import { applyFilePage, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import * as ipc from "../ipc";
import { abortAndPromptCommand, followUpCommand, type ImageContent, promptCommand } from "../ompRpc";
import type { SessionTerminalIo } from "../SessionTerminal";
import { observationNow } from "../sync/sessionObservation";

export function journalState(buffer: ArrayBuffer): ChatTranscriptState {
  const page = decodeOmpPage(buffer);
  return applyFilePage(emptyTranscript(), { start: page.start, messages: page.messages }, "initial");
}

/** An older page of the journal, prepended; the caller names the thread it asked for. */
export function olderPageState(current: ChatTranscriptState, buffer: ArrayBuffer): ChatTranscriptState {
  const page = decodeOmpPage(buffer);
  return applyFilePage(current, { start: page.start, messages: page.messages }, "older");
}

/**
 * Idle sends a prompt; a running turn queues a follow-up. Never route on "has this thread started":
 * OMP drains follow-ups only after an assistant/toolResult message, so a follow-up on an empty
 * session is accepted and never run.
 */
export function sendCommand(text: string, busy: boolean, images?: ImageContent[]) {
  return busy ? followUpCommand(text, undefined, images) : promptCommand(text, undefined, images);
}

/** The optimistic row for a send that resumed the thread: plain text, so it claims the turn. */
export function applyPlainSend(state: ChatTranscriptState, text: string, busy: boolean, attachments?: UserRowAttachment[]): { state: ChatTranscriptState; entryId: string } {
  return applySendPlan(state, text, { dispatch: { kind: "plain", message: text }, invokesModel: true, optimisticKind: busy ? "follow_up" : "prompt" }, attachments);
}

/** Send now: abort the running turn and prompt with this text instead of queueing it. */
export function sendNowCommand(text: string, images?: ImageContent[]) {
  return abortAndPromptCommand(text, undefined, images);
}

/** The terminal hatch's daemon calls, scoped to the thread's own repo instead of the active one. */
export function chatTerminalIo(repoPath: string, id: string): SessionTerminalIo {
  return {
    open: (args) => ipc.chatPtyAttach({ repoPath, id, attachId: args.attachId, streamToken: args.streamToken, cols: args.cols, rows: args.rows, onBytes: args.onBytes }),
    write: (data) => ipc.chatPtyWrite(repoPath, id, data),
    resize: (cols, rows) => ipc.chatPtyResize(repoPath, id, cols, rows),
    detach: (attachId) => ipc.chatDetach(repoPath, id, attachId),
    status: () => observationNow(repoPath, "", id),
  };
}
