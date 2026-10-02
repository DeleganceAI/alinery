import { decodeOmpPage } from "../chat/ompFile";
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

export function applyChatLine(state: ChatTranscriptState, line: string): ChatTranscriptState {
  try {
    return applyRpcLine(state, JSON.parse(line) as unknown);
  } catch {
    return state;
  }
}

export function attachHandshake() {
  return [negotiateProtocolCommand(), getStateCommand(), getAvailableModelsCommand()];
}

/** First turn is a prompt. A later idle turn is a follow-up. A running turn is aborted and replaced. */
export function sendCommand(text: string, running: boolean, hasTurn: boolean) {
  if (running) return abortAndPromptCommand(text);
  if (hasTurn) return followUpCommand(text);
  return promptCommand(text);
}

export function abortTurnCommand() {
  return abortCommand();
}

export function applyModelCommand(provider: string, modelId: string) {
  return setModelCommand(provider, modelId);
}
