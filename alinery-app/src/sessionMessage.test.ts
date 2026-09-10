import { describe, expect, it } from "vitest";
import {
  appendGeneratedText,
  canInterruptSession,
  chatMessageDisabledReason,
  isTurnActive,
  LARGE_MESSAGE_BYTES,
  MAX_SESSION_MESSAGE_BYTES,
  OMP_BRACKETED_PASTE_END,
  OMP_INTERRUPT_DATA,
  requestsSessionMessageSubmit,
  type SessionMessageReadiness,
  sessionMessageDisabledReason,
  sessionMessageDraftKey,
  sessionMessageMetrics,
  shouldShowChatComposer,
} from "./sessionMessage";

const ready = (overrides: Partial<SessionMessageReadiness> = {}): SessionMessageReadiness => ({
  connection: "open",
  lifecycle: { state: "live" },
  process: { state: "alive" },
  agent: { state: "idle" },
  messageAdapter: "omp_bracketed_paste",
  body: "message",
  composing: false,
  sending: false,
  interrupting: false,
  ...overrides,
});

describe("sessionMessageDraftKey", () => {
  it("uses repository, task, and session identity", () => {
    const base = sessionMessageDraftKey("/repo-a", "task-a", "session-a");

    expect(sessionMessageDraftKey("/repo-b", "task-a", "session-a")).not.toBe(base);
    expect(sessionMessageDraftKey("/repo-a", "task-b", "session-a")).not.toBe(base);
    expect(sessionMessageDraftKey("/repo-a", "task-a", "session-b")).not.toBe(base);
  });

  it("does not collide when identity components contain the separator", () => {
    expect(sessionMessageDraftKey("repo", "task|session", "id")).not.toBe(sessionMessageDraftKey("repo|task", "session", "id"));
  });
});

describe("appendGeneratedText", () => {
  it.each([
    ["", "generated", "generated"],
    ["draft", "generated", "draft\n\ngenerated"],
    ["draft\n", "generated", "draft\n\ngenerated"],
    ["draft\n\n", "generated", "draft\n\ngenerated"],
    ["draft\n\n\n", "generated", "draft\n\n\ngenerated"],
    ["draft\r\n", "generated", "draft\r\n\ngenerated"],
  ])("preserves %j and adds only the required LF separator", (current, generated, expected) => {
    expect(appendGeneratedText(current, generated)).toBe(expected);
  });
});

describe("sessionMessageMetrics", () => {
  it("counts Unicode code points separately from UTF-8 bytes", () => {
    expect(sessionMessageMetrics("A😀é")).toEqual({ codePoints: 3, utf8Bytes: 7, large: false, overLimit: false });
  });

  it("matches UTF-8 replacement semantics for unpaired UTF-16 surrogates", () => {
    expect(sessionMessageMetrics("\ud800A\udc00")).toEqual({ codePoints: 3, utf8Bytes: 7, large: false, overLimit: false });
  });

  it("warns strictly above 256 KiB without changing the body", () => {
    const boundary = "a".repeat(LARGE_MESSAGE_BYTES);
    expect(sessionMessageMetrics(boundary).large).toBe(false);
    expect(sessionMessageMetrics(`${boundary}a`).large).toBe(true);
  });

  it("rejects only above the 4 MiB transport limit", () => {
    const boundary = "a".repeat(MAX_SESSION_MESSAGE_BYTES);
    expect(sessionMessageMetrics(boundary).overLimit).toBe(false);
    expect(sessionMessageMetrics(`${boundary}a`).overLimit).toBe(true);
  });
});

describe("shouldShowChatComposer", () => {
  const visible = {
    hasWritableTerminal: true,
    history: false,
    actionPanel: false,
    utilityTerminal: false,
    harness: "omp",
  };

  it("shows only beside writable task harness terminals", () => {
    expect(shouldShowChatComposer(visible)).toBe(true);
    expect(shouldShowChatComposer({ ...visible, hasWritableTerminal: false })).toBe(false);
    expect(shouldShowChatComposer({ ...visible, history: true })).toBe(false);
    expect(shouldShowChatComposer({ ...visible, actionPanel: true })).toBe(false);
    expect(shouldShowChatComposer({ ...visible, utilityTerminal: true })).toBe(false);
    expect(shouldShowChatComposer({ ...visible, harness: "no-harness" })).toBe(false);
  });
});

describe("sessionMessageDisabledReason", () => {
  it("accepts exact non-empty whitespace when every live readiness axis is ready", () => {
    expect(sessionMessageDisabledReason(ready({ body: " \n " }))).toBeNull();
  });

  it.each([
    [{ messageAdapter: "unsupported" } as Partial<SessionMessageReadiness>, "has no message delivery adapter"],
    [{ connection: "opening" } as Partial<SessionMessageReadiness>, "opening"],
    [{ connection: "recovering" } as Partial<SessionMessageReadiness>, "recovering"],
    [{ connection: "failed" } as Partial<SessionMessageReadiness>, "connection failed"],
    [{ agent: { state: "busy" } } as Partial<SessionMessageReadiness>, "running"],
    [{ agent: { state: "unknown" } } as Partial<SessionMessageReadiness>, "unknown"],
    [{ process: { state: "starting" } } as Partial<SessionMessageReadiness>, "starting"],
    [{ process: { state: "exited", code: 0 } } as Partial<SessionMessageReadiness>, "exited"],
    [{ lifecycle: { state: "live_exited" } } as Partial<SessionMessageReadiness>, "exited"],
    [{ lifecycle: { state: "orphaned" } } as Partial<SessionMessageReadiness>, "not live"],
    [{ body: `before${OMP_BRACKETED_PASTE_END}after` } as Partial<SessionMessageReadiness>, "end marker"],
    [{ body: "a".repeat(MAX_SESSION_MESSAGE_BYTES + 1) } as Partial<SessionMessageReadiness>, "limited to"],
    [{ body: "" } as Partial<SessionMessageReadiness>, "Enter a message"],
    [{ composing: true } as Partial<SessionMessageReadiness>, "composition"],
    [{ sending: true } as Partial<SessionMessageReadiness>, "in progress"],
  ])("explains a blocked readiness state", (overrides, text) => {
    expect(sessionMessageDisabledReason(ready(overrides))).toContain(text);
  });
});

describe("chatMessageDisabledReason", () => {
  it("allows send while the agent is busy; Chat steers the open turn instead of blocking", () => {
    expect(chatMessageDisabledReason(ready({ agent: { state: "busy" } }))).toBeNull();
  });
});

describe("canInterruptSession", () => {
  it.each([{ state: "busy" } as const, { state: "waiting_for_input", correlation_id: "ask-1" } as const, { state: "waiting_for_approval", correlation_id: "approval-1" } as const])(
    "allows interruption while the OMP turn is active: %j",
    (agent) => {
      expect(canInterruptSession(ready({ agent }))).toBe(true);
    },
  );

  it("blocks interrupt outside a connected live process or while one is already being sent", () => {
    expect(canInterruptSession(ready())).toBe(false);
    expect(canInterruptSession(ready({ agent: { state: "unknown" } }))).toBe(false);
    expect(canInterruptSession(ready({ agent: { state: "busy" }, connection: "recovering" }))).toBe(false);
    expect(canInterruptSession(ready({ agent: { state: "busy" }, process: { state: "exited", code: 1 } }))).toBe(false);
    expect(canInterruptSession(ready({ agent: { state: "busy" }, lifecycle: { state: "orphaned" } }))).toBe(false);
    expect(canInterruptSession(ready({ agent: { state: "busy" }, interrupting: true }))).toBe(false);
  });

  it("uses OMP's verified Escape interrupt byte", () => {
    expect(OMP_INTERRUPT_DATA).toHaveLength(1);
    expect(OMP_INTERRUPT_DATA.charCodeAt(0)).toBe(27);
  });
});

describe("isTurnActive", () => {
  it("treats live transcript guesses and open turns as active even when the poll still says idle", () => {
    expect(isTurnActive({ agentState: "idle" })).toBe(false);
    expect(isTurnActive({ agentState: "unknown" })).toBe(false);
    expect(isTurnActive({})).toBe(false);
    expect(isTurnActive({ pendingTurn: true, agentState: "idle" })).toBe(true);
    expect(isTurnActive({ turnOpen: true, agentState: "idle" })).toBe(true);
  });

  it.each(["busy", "waiting_for_input", "waiting_for_approval"] as const)("treats observed agent state %s as active", (agentState) => {
    expect(isTurnActive({ agentState })).toBe(true);
  });
});

describe("requestsSessionMessageSubmit", () => {
  const key = (overrides: Record<string, unknown> = {}) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...overrides,
  });

  it("accepts only Cmd/Ctrl+Enter", () => {
    expect(requestsSessionMessageSubmit(key({ metaKey: true }), false)).toBe(true);
    expect(requestsSessionMessageSubmit(key({ ctrlKey: true }), false)).toBe(true);
    expect(requestsSessionMessageSubmit(key(), false)).toBe(false);
    expect(requestsSessionMessageSubmit(key({ metaKey: true, shiftKey: true }), false)).toBe(false);
    expect(requestsSessionMessageSubmit(key({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it("suppresses the shortcut during browser or tracked IME composition", () => {
    expect(requestsSessionMessageSubmit(key({ metaKey: true, isComposing: true }), false)).toBe(false);
    expect(requestsSessionMessageSubmit(key({ metaKey: true }), true)).toBe(false);
  });
});
