import type { UserRowAttachment } from "../chat/attachments";
import { applySendPlan } from "../chat/send";
import { decodeVinculumPage } from "../chat/vinculumFile";
import { applyFilePage, type ChatTranscriptState, emptyTranscript } from "../chatTranscript";
import type { SessionTerminalIo } from "../SessionTerminal";
import { observationNow } from "../sync/sessionObservation";
import { abortAndPromptCommand, followUpCommand, type ImageContent, promptCommand } from "../vinculumRpc";

export function journalState(buffer: ArrayBuffer): ChatTranscriptState {
  const page = decodeVinculumPage(buffer);
  return applyFilePage(emptyTranscript(), { start: page.start, messages: page.messages }, "initial");
}

/**
 * Idle sends a prompt command; a running turn is still classified as a follow-up so the verdict treats it as a judged
 * send. That classification is not a thread row: a waiting input is a Queued panel line, never a follow_up entry.
 * Never route on "has this thread started": Vinculum drains follow-ups only after an assistant/toolResult message, so
 * a follow-up on an empty session is accepted and never run.
 */
export function sendCommand(text: string, busy: boolean, images?: ImageContent[]) {
  return busy ? followUpCommand(text, undefined, images) : promptCommand(text, undefined, images);
}

/** The optimistic row for a send the daemon already placed. Always a prompt: a busy send is a panel line, not a follow_up row. */
export function applyPlainSend(state: ChatTranscriptState, text: string, _busy: boolean, attachments?: UserRowAttachment[]): { state: ChatTranscriptState; entryId: string } {
  return applySendPlan(state, text, { dispatch: { kind: "plain", message: text }, invokesModel: true, optimisticKind: "prompt" }, attachments);
}

/** Send now: abort the running turn and prompt with this text instead of queueing it. */
export function sendNowCommand(text: string, images?: ImageContent[]) {
  return abortAndPromptCommand(text, undefined, images);
}

/** The terminal hatch's daemon calls, scoped to the thread's own repo instead of the active one. It only attaches: the thread's shell is already running. */
export function chatTerminalIo(repoPath: string, id: string): SessionTerminalIo {
  return {
    open: async () => {},
    repo: async () => repoPath,
    status: () => observationNow(repoPath, "", id),
  };
}
