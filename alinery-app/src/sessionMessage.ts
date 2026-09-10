import type { SessionTerminalConnectionState } from "./SessionTerminal";
import type { AgentState, LifecycleState, MessageAdapter, ProcessState, SessionMessageActionProvenance } from "./types";

export const LARGE_MESSAGE_BYTES = 256 * 1024;
export const MAX_SESSION_MESSAGE_BYTES = 4 * 1024 * 1024;
export const OMP_BRACKETED_PASTE_END = "\u001b[201~";
export const OMP_INTERRUPT_DATA = "\u001b";

export type SessionMessageDraft = {
  body: string;
  pendingActions: SessionMessageActionProvenance[];
};

export const EMPTY_SESSION_MESSAGE_DRAFT: SessionMessageDraft = {
  body: "",
  pendingActions: [],
};

export const sessionMessageDraftKey = (repoPath: string, taskSlug: string, sessionId: string): string =>
  [repoPath, taskSlug, sessionId].map((component) => `${component.length}:${component}`).join("|");

export function appendGeneratedText(current: string, generated: string): string {
  if (current.length === 0) return generated;
  if (current.endsWith("\n\n")) return current + generated;
  if (current.endsWith("\n")) return `${current}\n${generated}`;
  return `${current}\n\n${generated}`;
}

export type SessionMessageMetrics = {
  codePoints: number;
  utf8Bytes: number;
  large: boolean;
  overLimit: boolean;
};

export function sessionMessageMetrics(body: string): SessionMessageMetrics {
  let codePoints = 0;
  let utf8Bytes = 0;

  for (let index = 0; index < body.length; index += 1) {
    const unit = body.charCodeAt(index);
    codePoints += 1;

    if (unit <= 0x7f) {
      utf8Bytes += 1;
    } else if (unit <= 0x7ff) {
      utf8Bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < body.length) {
      const next = body.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        utf8Bytes += 4;
        index += 1;
      } else {
        utf8Bytes += 3;
      }
    } else {
      utf8Bytes += 3;
    }
  }

  return {
    codePoints,
    utf8Bytes,
    large: utf8Bytes > LARGE_MESSAGE_BYTES,
    overLimit: utf8Bytes > MAX_SESSION_MESSAGE_BYTES,
  };
}

export type ComposerVisibility = {
  hasWritableTerminal: boolean;
  history: boolean;
  actionPanel: boolean;
  utilityTerminal: boolean;
  harness: string;
};

export const shouldShowChatComposer = (visibility: ComposerVisibility): boolean =>
  visibility.hasWritableTerminal && !visibility.history && !visibility.actionPanel && !visibility.utilityTerminal && visibility.harness !== "no-harness";

export type SessionMessageReadiness = {
  connection: SessionTerminalConnectionState;
  lifecycle: LifecycleState;
  process: ProcessState | null;
  agent: AgentState | null;
  messageAdapter: MessageAdapter;
  body: string;
  composing: boolean;
  sending: boolean;
  interrupting: boolean;
};

export function sessionMessageDisabledReason(readiness: SessionMessageReadiness, metrics = sessionMessageMetrics(readiness.body)): string | null {
  if (readiness.messageAdapter === "unsupported") {
    return "This session has no message delivery adapter. Use the terminal for raw input; start a fresh session after changing harness settings.";
  }
  if (readiness.connection === "recovering") return "The terminal is recovering its session connection.";
  if (readiness.connection === "failed") return "The terminal connection failed. Use the terminal after reconnecting.";
  if (readiness.connection === "opening") return "The terminal is opening.";
  if (!readiness.agent || readiness.agent.state !== "idle") {
    return readiness.agent?.state === "unknown" ? "Session readiness is unknown." : "The session is running. Wait until it is Idle.";
  }
  if (!readiness.process || readiness.process.state === "starting") return "The session process is starting.";
  if (readiness.process.state === "exited" || readiness.lifecycle.state === "live_exited" || readiness.lifecycle.state === "exited") {
    return "The session has exited.";
  }
  if (readiness.lifecycle.state !== "live") return "The session is not live.";
  if (readiness.body.includes(OMP_BRACKETED_PASTE_END)) {
    return "The draft contains the OMP bracketed-paste end marker and cannot be delivered safely.";
  }
  if (metrics.overLimit) return `Messages are limited to ${MAX_SESSION_MESSAGE_BYTES.toLocaleString()} UTF-8 bytes.`;
  if (readiness.body.length === 0) return "Enter a message to send.";
  if (readiness.composing) return "Finish text composition before sending.";
  if (readiness.sending) return "Message delivery is in progress.";
  return null;
}

export function canInterruptSession(readiness: SessionMessageReadiness): boolean {
  if (readiness.interrupting || readiness.connection !== "open" || readiness.lifecycle.state !== "live" || readiness.process?.state !== "alive") return false;
  return readiness.agent?.state === "busy" || readiness.agent?.state === "waiting_for_input" || readiness.agent?.state === "waiting_for_approval";
}

export function chatMessageDisabledReason(readiness: SessionMessageReadiness, metrics = sessionMessageMetrics(readiness.body)): string | null {
  if (readiness.connection === "recovering") return "The session connection is recovering.";
  if (readiness.connection === "failed") return "The session connection failed.";
  if (readiness.connection === "opening") return "The session is opening.";
  if (!readiness.process || readiness.process.state === "starting") return "The session process is starting.";
  if (readiness.process.state === "exited" || readiness.lifecycle.state === "live_exited" || readiness.lifecycle.state === "exited") {
    return "The session has exited.";
  }
  if (readiness.lifecycle.state !== "live") return "The session is not live.";
  if (metrics.overLimit) return `Messages are limited to ${MAX_SESSION_MESSAGE_BYTES.toLocaleString()} UTF-8 bytes.`;
  if (readiness.body.length === 0) return "Enter a message to send.";
  if (readiness.composing) return "Finish text composition before sending.";
  if (readiness.sending) return "Message delivery is in progress.";
  return null;
}

export function canAbortChatSession(readiness: SessionMessageReadiness): boolean {
  return canInterruptSession(readiness);
}

/**
 * One predicate for send routing, hatch confirmation, and Chat status: live transcript state
 * leads the 1.5s observation poll, and OMP calls a turn that is asking a question
 * `waiting_for_input` / `waiting_for_approval`, not only `busy`.
 */
export type TurnActivity = {
  pendingTurn?: boolean;
  turnOpen?: boolean;
  agentState?: AgentState["state"] | null;
};

export function isTurnActive(activity: TurnActivity): boolean {
  if (activity.pendingTurn || activity.turnOpen) return true;
  const state = activity.agentState;
  return state === "busy" || state === "waiting_for_input" || state === "waiting_for_approval";
}

export type MessageSubmitKey = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
};

export const requestsSessionMessageSubmit = (event: MessageSubmitKey, composing: boolean): boolean =>
  event.key === "Enter" && !event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && !event.isComposing && !composing;
