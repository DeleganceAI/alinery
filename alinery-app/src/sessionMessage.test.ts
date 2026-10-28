import { describe, expect, it } from "vitest";
import {
  appendGeneratedText,
  canInterruptSession,
  chatMessageDisabledReason,
  EMPTY_SESSION_MESSAGE_DRAFT,
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
import type { AgentState, LifecycleState, SessionObservation, SessionState } from "./types";

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

describe("EMPTY_SESSION_MESSAGE_DRAFT", () => {
  it("starts with no attachments", () => {
    expect("attachments" in EMPTY_SESSION_MESSAGE_DRAFT).toBe(true);
    if ("attachments" in EMPTY_SESSION_MESSAGE_DRAFT) {
      expect(EMPTY_SESSION_MESSAGE_DRAFT.attachments).toEqual([]);
    }
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
  const live = (agent: AgentState = { state: "idle" }): SessionObservation & { state: SessionState } => ({
    lifecycle: { state: "live" },
    state: {
      process: { state: "alive" },
      agent,
      playbook: { state: "in_progress" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
    checkpoint: {},
  });

  it("treats live transcript guesses and open turns as active even when the poll still says idle", () => {
    expect(isTurnActive({ observation: live() })).toBe(false);
    expect(isTurnActive({ observation: live({ state: "unknown" }) })).toBe(false);
    expect(isTurnActive({})).toBe(false);
    expect(isTurnActive({ pendingTurn: true, observation: live() })).toBe(true);
    expect(isTurnActive({ turnOpen: true, observation: live() })).toBe(true);
  });

  it.each<AgentState>([{ state: "busy" }, { state: "waiting_for_input", correlation_id: "input" }, { state: "waiting_for_approval", correlation_id: "approval" }])(
    "treats observed agent state $state as active only while its process is live",
    (agent) => {
      const observation = live(agent);
      expect(isTurnActive({ observation })).toBe(true);
      observation.state.process = { state: "exited", code: 0 };
      expect(isTurnActive({ observation, pendingTurn: true, turnOpen: true })).toBe(false);
    },
  );

  it.each<LifecycleState>([{ state: "live_exited" }, { state: "exited", code: 0 }, { state: "orphaned" }, { state: "interrupted" }])(
    "settles an unclosed replay for $state history even with a completed checkpoint",
    (lifecycle) => {
      const observation: SessionObservation = { lifecycle, state: null, checkpoint: { phase_completed_at: 100 } };
      expect(isTurnActive({ observation, pendingTurn: true, turnOpen: true })).toBe(false);
    },
  );

  it("keeps live activity at a ready-to-advance or completed playbook step", () => {
    const observation = live();
    for (const state of ["ready_to_advance", "completed"] as const) {
      observation.state.playbook = { state };
      expect(isTurnActive({ observation, turnOpen: true })).toBe(true);
    }
  });

  it("preserves optimistic activity before a live observation arrives", () => {
    for (const observation of [
      null,
      { lifecycle: { state: "live" }, state: null, checkpoint: {} },
      { lifecycle: { state: "never_started" }, state: null, checkpoint: {} },
    ] satisfies (SessionObservation | null)[]) {
      expect(isTurnActive({ observation, pendingTurn: true })).toBe(true);
      expect(isTurnActive({ observation, turnOpen: true })).toBe(true);
    }
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
