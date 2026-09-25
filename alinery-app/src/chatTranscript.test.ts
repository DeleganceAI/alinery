import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectLiveSubagents } from "./chat/subagents";
import {
  appendHarnessNotice,
  appendOptimisticAbort,
  appendOptimisticUser,
  applyFilePage,
  applyRpcLine,
  applyRpcLines,
  type ChatTranscriptState,
  emptyTranscript,
  flattenWouldFail,
  mapHydratedMessage,
  matchingSendFailure,
  removeOptimisticSend,
} from "./chatTranscript";

const dir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(dir, "chat/fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
const jsonl = (name: string) =>
  readFileSync(join(fixtures, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

describe("chatTranscript (live grok-4.6 / omp 18.1.10)", () => {
  it("records ready protocol v1", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-ready.json"));
    expect(state.ready).toBe(true);
    expect(state.protocolVersion).toBe(1);
  });

  it("queues extension_ui_request for an ack", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-extension_ui_request.json"));
    expect(state.pendingUi).toEqual([{ id: "157311f0b17e2ace", method: "setWidget", widgetKey: "autoresearch" }]);
  });

  it("appends the user message_start echo", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-user_start.json"));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe("user");
    expect(state.messages[0].content).toEqual([{ type: "text", text: "Think step by step, then reply with ONLY the integer result of 17*19." }]);
  });

  it("does not treat stopReason stop on thinking_start as turn-complete", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-thinking_start.json"));
    const msg = state.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.stopReason).toBe("stop");
    expect(msg.content[0]).toEqual({ type: "thinking", thinking: "The user wants me to reply", streaming: true });
    expect(msg.content.some((part) => part.type === "text")).toBe(false);
  });

  it("keeps thinking_end sibling text as a second part, not a flattened string", () => {
    const state = applyRpcLines([load("live-thinking_start.json"), load("live-thinking_end.json")]);
    const msg = state.messages[0];
    expect(flattenWouldFail(msg.content)).toBe(true);
    expect(msg.content.map((part) => part.type)).toEqual(["thinking", "text"]);
    expect(msg.content[0]).toEqual({
      type: "thinking",
      thinking: "The user wants me to reply with ONLY the integer result of 17*19.\n\n\n",
    });
    expect(msg.content[1]).toEqual({ type: "text", text: "323" });
  });

  it("does not duplicate text when text_end repeats the snapshot", () => {
    const state = applyRpcLines([
      load("live-thinking_start.json"),
      load("live-thinking_end.json"),
      load("live-text_start.json"),
      load("live-text_delta.json"),
      load("live-text_end.json"),
    ]);
    const texts = state.messages[0].content.filter((part) => part.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toEqual({ type: "text", text: "323" });
  });

  it("surfaces a busy second prompt as a notice, not a user bubble", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-prompt-busy.json"));
    expect(state.messages).toEqual([]);
    expect(state.notice).toMatch(/steer\(\)|followUp\(\)/);
    expect(state.entries.some((e) => e.type === "error")).toBe(true);
  });

  it("records unknown types instead of no-op success", () => {
    const state = applyRpcLine(emptyTranscript(), { type: "host_uri_request", id: "x" });
    expect(state.unknownTypes).toEqual(["host_uri_request"]);
    expect(state.messages).toEqual([]);
  });

  it("ignores the Session Chat JSON-RPC envelope", () => {
    const state = applyRpcLine(emptyTranscript(), { id: "old1", method: "prompt", params: { text: "hello" } });
    expect(state.messages).toEqual([]);
    expect(state.unknownTypes).toEqual([]);
    expect(state.ready).toBe(false);
  });

  it("does not duplicate an optimistic user row when OMP echoes the same text", () => {
    const seeded = appendOptimisticUser(emptyTranscript(), "hello");
    const state = applyRpcLine(seeded, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    expect(state.messages).toHaveLength(1);
  });

  it("replays the grok-4.6 17×19 dump to one thinking part plus text 323", () => {
    const state = applyRpcLines(jsonl("type-prompt-grok-4.6.jsonl"));
    expect(state.ready).toBe(true);
    expect(state.pendingUi).toHaveLength(2);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe("user");
    const assistant = state.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content.map((part) => part.type)).toEqual(["thinking", "text"]);
    expect(assistant.content[1]).toEqual({ type: "text", text: "323" });
    expect(state.unknownTypes).toEqual([]);
    expect(state.entries.map((e) => e.type)).toEqual(["turn_marker", "prompt", "thinking", "text", "turn_marker"]);
  });

  it("appends harness events instead of overwriting notice", () => {
    const state = applyRpcLines([
      { type: "command_output", text: "first" },
      { type: "model_changed", text: "xai/grok-4.6" },
    ]);
    expect(state.entries.filter((e) => e.type === "harness")).toHaveLength(2);
    expect(state.notice).toBe("xai/grok-4.6");
    expect(state.sessionMeta.model).toBe("xai/grok-4.6");
  });

  it("opens and closes a turn from agent_start/agent_end, not stopReason stop", () => {
    const state = applyRpcLines([load("live-thinking_start.json"), { type: "agent_start" }, { type: "agent_end", stopReason: "complete" }]);
    const markers = state.entries.filter((e) => e.type === "turn_marker");
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ type: "turn_marker", phase: "start", turn: 1 });
    expect(markers[1]).toMatchObject({ type: "turn_marker", phase: "end", stopReason: "complete" });
    expect(state.messages[0]?.stopReason).toBe("stop");
  });

  it("does not double turn markers when both agent_* and turn_* fire", () => {
    const state = applyRpcLines([{ type: "agent_start" }, { type: "turn_start" }, { type: "agent_end", stopReason: "complete" }, { type: "turn_end" }]);
    expect(state.entries.filter((e) => e.type === "turn_marker")).toHaveLength(2);
  });

  it("shows a nested turn_end 401 and tells the user to Kill then Start fresh", () => {
    const state = applyRpcLines([
      { type: "turn_start" },
      {
        type: "turn_end",
        message: {
          content: [],
          stopReason: "error",
          errorStatus: 401,
          errorMessage: "401 Invalid API key. (type=invalid_request_error param=invalid_api_key)",
        },
      },
    ]);
    expect(state.entries.filter((e) => e.type === "error")).toEqual([
      expect.objectContaining({
        type: "error",
        text: "401 Invalid API key. (type=invalid_request_error param=invalid_api_key) Kill this session, then Start fresh.",
      }),
    ]);
  });

  it("marks an optimistic slash local when the prompt did not invoke the agent", () => {
    const seeded = appendOptimisticUser(emptyTranscript(), "/thinking high", "slash", { name: "thinking", args: "high" });
    const state = applyRpcLine(seeded, { type: "response", command: "prompt", success: true, data: { agentInvoked: false } });
    expect(state.entries[0]).toMatchObject({ type: "slash", name: "thinking", local: true });
  });

  it("hydrates journal rows without inventing timestamps", () => {
    const state = applyFilePage(
      emptyTranscript(),
      {
        start: 0,
        messages: [
          { rowId: "u1", role: "user", content: [{ type: "text", text: "hi" }] },
          {
            rowId: "a1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan" },
              { type: "text", text: "yo" },
            ],
          },
        ],
      },
      "initial",
    );
    expect(state.entries.map((e) => e.type)).toEqual(["prompt", "thinking", "text"]);
    // A row read off disk has no wall-clock we can trust, so it gets none rather than Date.now().
    expect(state.entries.every((e) => e.at == null)).toBe(true);
  });

  // History comes off the journal now, so an RPC page response is not a hydrate signal — and a
  // stale one replayed from the daemon ring must not disturb the transcript.
  it("ignores get_messages responses entirely", () => {
    const seeded = applyFilePage(emptyTranscript(), { start: 0, messages: [{ rowId: "a", role: "user", content: [{ type: "text", text: "from disk" }] }] }, "initial");
    const after = applyRpcLine(seeded, {
      type: "response",
      command: "get_messages_page",
      success: true,
      data: { messages: [{ role: "user", content: [{ type: "text", text: "stale replay" }] }], nextCursor: "cur-2" },
    });
    expect(after.entries).toEqual(seeded.entries);
    expect(after.messages).toEqual(seeded.messages);
  });

  it("rewrites transport-limit errors into an actionable notice", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "response",
      command: "get_messages",
      success: false,
      error: "RPC response exceeded the transport limit",
    });
    expect(state.entries).toEqual([expect.objectContaining({ type: "error", text: "History snapshot was too large; live messages still stream." })]);
  });

  it("records negotiate_protocol as protocol v2", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "response",
      command: "negotiate_protocol",
      success: true,
      data: { protocolVersion: 2 },
    });
    expect(state.protocolVersion).toBe(2);
  });

  it("records get_state context usage and dumpTools", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        model: { provider: "xai", id: "grok-4.6" },
        thinking: "high",
        contextUsage: { tokens: 19200, contextWindow: 128000, percent: 15 },
        dumpTools: [{ name: "read", description: "Read a file" }],
      },
    });
    expect(state.sessionMeta.model).toBe("xai/grok-4.6");
    expect(state.sessionMeta.thinking).toBe("high");
    expect(state.sessionMeta.contextUsage).toEqual({ tokens: 19200, contextWindow: 128000, percent: 15 });
    expect(state.sessionMeta.dumpTools?.[0]?.name).toBe("read");
  });

  it("records get_state autoCompactionEnabled", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "response",
      command: "get_state",
      success: true,
      data: { autoCompactionEnabled: false },
    });
    expect(state.sessionMeta.autoCompactionEnabled).toBe(false);
  });

  it("appends a host hatch notice without inventing a prompt", () => {
    const state = appendHarnessNotice(emptyTranscript(), "hatch", "Use Terminal to log in.");
    expect(state.entries).toEqual([expect.objectContaining({ type: "harness", event: "hatch", text: "Use Terminal to log in." })]);
    expect(state.notice).toBe("Use Terminal to log in.");
  });
});

describe("extension_ui_request confirm", () => {
  it("maps OMP confirm message onto the approval row and pending instructions", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-extension_ui_confirm.json"));
    const approval = state.entries.filter((e) => e.type === "approval");
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({
      type: "approval",
      requestId: "ui-confirm-1",
      action: "Proceed despite Biome issues?",
      detail: "4 FIXABLE issues",
    });
    expect(state.pendingUi).toEqual([
      {
        id: "ui-confirm-1",
        method: "confirm",
        title: "Proceed despite Biome issues?",
        instructions: "4 FIXABLE issues",
      },
    ]);
  });

  it("keeps instructions-only confirm detail for non-OMP producers", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "extension_ui_request",
      id: "ui-confirm-instructions",
      method: "confirm",
      title: "Allow git push",
      instructions: "Publishes the branch",
    });
    expect(state.pendingUi).toEqual([
      {
        id: "ui-confirm-instructions",
        method: "confirm",
        title: "Allow git push",
        instructions: "Publishes the branch",
      },
    ]);
    expect(state.entries.filter((e) => e.type === "approval")).toEqual([
      expect.objectContaining({
        requestId: "ui-confirm-instructions",
        action: "Allow git push",
        detail: "Publishes the branch",
      }),
    ]);
  });

  it("prefers message over instructions when both exist", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "extension_ui_request",
      id: "ui-confirm-both",
      method: "confirm",
      title: "Proceed?",
      message: "4 FIXABLE issues",
      instructions: "legacy instructions",
    });
    expect(state.pendingUi[0]?.instructions).toBe("legacy instructions");
    expect(state.entries.filter((e) => e.type === "approval")[0]).toMatchObject({
      requestId: "ui-confirm-both",
      detail: "4 FIXABLE issues",
    });
  });
});

describe("journal pages", () => {
  const msg = (rowId: string, role: "user" | "assistant" | "toolResult", text: string, extra = {}) => ({
    rowId,
    role,
    content: [{ type: "text" as const, text }],
    ...extra,
  });

  // hydrateEntries only branched on user and assistant, so every toolResult message fell through
  // with no entry pushed — 37 of 49 message rows in a real journal rendered as nothing.
  it("renders tool output instead of dropping it", () => {
    const state = applyFilePage(emptyTranscript(), { start: 0, messages: [msg("t1", "toolResult", "ls output", { toolName: "bash" })] }, "initial");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({ type: "tool_result", tool: "bash", text: "ls output", status: "ok" });
  });

  it("marks a failed tool result", () => {
    const state = applyFilePage(emptyTranscript(), { start: 0, messages: [msg("t2", "toolResult", "boom", { toolName: "bash", isError: true })] }, "initial");
    expect(state.entries[0]).toMatchObject({ status: "error" });
  });

  // Entry ids must come from the OMP row, or prepending an older page renumbers every mounted row
  // and React remounts the whole journal.
  it("keeps entry ids stable when an older page is prepended", () => {
    const first = applyFilePage(emptyTranscript(), { start: 400, messages: [msg("b", "user", "second")] }, "initial");
    const idsBefore = first.entries.map((entry) => entry.id);
    const older = applyFilePage(first, { start: 0, messages: [msg("a", "user", "first")] }, "older");
    expect(older.entries.map((entry) => entry.id).slice(1)).toEqual(idsBefore);
    expect(older.entries.map((entry) => entry.id)).toEqual(["f:a", "f:b"]);
    expect(older.fileStart).toBe(0);
  });

  // The seam: the journal owns everything below it, the stream everything above.
  it("keeps live entries when a page lands", () => {
    const live = appendHarnessNotice(emptyTranscript(), "notice", "connected");
    expect(live.entries.every((entry) => !entry.id.startsWith("f:"))).toBe(true);
    const merged = applyFilePage(live, { start: 0, messages: [msg("a", "user", "from disk")] }, "initial");
    expect(merged.entries.map((entry) => entry.id.startsWith("f:"))).toEqual([true, false]);
  });

  // upsertMessages overwrites messages[last] when the last role is assistant — which is exactly
  // what a journal page usually ends with. Without the rowId guard the first delta of the next
  // turn silently replaces the last committed message of the previous one.
  it("does not let a live turn overwrite the last committed message", () => {
    const seeded = applyFilePage(emptyTranscript(), { start: 0, messages: [{ rowId: "a1", role: "assistant", content: [{ type: "text", text: "committed answer" }] }] }, "initial");
    const streaming = applyRpcLine(seeded, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "new turn" }] } });
    expect(streaming.messages).toHaveLength(2);
    expect(streaming.messages[0]).toMatchObject({ rowId: "a1" });
    expect(streaming.entries.some((entry) => entry.type === "text" && entry.text === "committed answer")).toBe(true);
  });

  it("tracks how far back the journal is loaded", () => {
    const state = applyFilePage(emptyTranscript(), { start: 900, messages: [] }, "initial");
    expect(state.fileStart).toBe(900);
  });
  it("lets OMP's turn_start emit its marker even after a send already guessed a turn", () => {
    // Regression: the guess used to set `turnOpen`, so `openTurn` short-circuited and no start
    // marker was ever appended — leaving a dangling "Turn 1 end" for every prompt.
    const guessed = { ...emptyTranscript(), pendingTurn: true };
    const started = applyRpcLine(guessed, { type: "turn_start" });
    expect(started.pendingTurn).toBe(false);
    expect(started.turnOpen).toBe(true);
    expect(started.turn).toBe(1);
    expect(started.entries.filter((e) => e.type === "turn_marker" && e.phase === "start")).toHaveLength(1);

    const ended = applyRpcLine(started, { type: "turn_end" });
    expect(ended.entries.filter((e) => e.type === "turn_marker")).toHaveLength(2);
    expect(ended.turnOpen).toBe(false);
  });

  it("drops the guessed turn when OMP refuses the send", () => {
    // Regression: nothing cleared the guess, so one refusal forced every later send to steer a
    // turn that did not exist, for the life of the mount.
    const guessed = { ...emptyTranscript(), pendingTurn: true };
    const refused = applyRpcLine(guessed, { type: "response", command: "prompt", success: false, error: "Agent is already processing" });
    expect(refused.pendingTurn).toBe(false);
    expect(refused.entries.some((e) => e.type === "error")).toBe(true);
  });

  it("does not clear a pending turn when an unrelated RPC command fails", () => {
    const guessed = { ...emptyTranscript(), pendingTurn: true };
    const failed = applyRpcLine(guessed, { type: "response", command: "get_state", success: false, error: "temporary" });
    expect(failed.pendingTurn).toBe(true);
    expect(failed.entries.some((e) => e.type === "error")).toBe(true);
  });

  it("keeps session_busy silent for history-shaped refusals but not for prompt", () => {
    const guessed = { ...emptyTranscript(), pendingTurn: true };
    expect(applyRpcLine(guessed, { type: "response", command: "get_history", success: false, code: "session_busy", error: "busy" })).toEqual(guessed);
    const refused = applyRpcLine(guessed, {
      type: "response",
      command: "prompt",
      success: false,
      code: "session_busy",
      error: "Agent is already processing",
    });
    expect(refused.pendingTurn).toBe(false);
    expect(refused.entries.some((e) => e.type === "error")).toBe(true);
  });

  it("removes an optimistic send without leaving the user bubble behind", () => {
    const seeded = appendOptimisticUser(emptyTranscript(), "keep me", "prompt");
    const entryId = seeded.entries[0]?.id ?? "";
    const next = removeOptimisticSend(seeded, entryId);
    expect(next.entries).toEqual([]);
    expect(next.messages).toEqual([]);
    expect(next.pendingTurn).toBe(false);
  });

  it("matches only the refused prompt/follow_up for the pending command id", () => {
    expect(matchingSendFailure({ type: "response", id: "c1", command: "prompt", success: false, error: "nope" }, "c1")).toBe("nope");
    expect(matchingSendFailure({ type: "response", id: "c1", command: "abort_and_prompt", success: false, error: "nope" }, "c1")).toBe("nope");
    expect(matchingSendFailure({ type: "response", id: "c1", command: "get_state", success: false, error: "nope" }, "c1")).toBeNull();
    expect(matchingSendFailure({ type: "response", id: "c2", command: "prompt", success: false, error: "nope" }, "c1")).toBeNull();
  });
  it("drops the guessed turn when OMP handled the command locally", () => {
    const guessed = { ...emptyTranscript(), pendingTurn: true };
    const handled = applyRpcLine(guessed, { type: "response", success: true, command: "prompt", data: { agentInvoked: false } });
    expect(handled.pendingTurn).toBe(false);
  });
});

function liveIds(cards: ReadonlyArray<{ id?: string }>): Array<string | undefined> {
  return cards.map((card) => card.id);
}

describe("subagent envelopes", () => {
  it("maps a lifecycle payload to one live drawer card", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-subagent_lifecycle.json"));
    const cards = collectLiveSubagents(state.entries);
    expect(cards).toHaveLength(1);
    expect(liveIds(cards)).toEqual(["sa-1"]);
    expect(cards[0]?.name).toBe("Explore");
    expect(cards[0]?.preview).toBe("Search the repo");
    expect(cards[0]?.status).toBe("running");
  });

  it("updates the same id from nested progress description", () => {
    const state = applyRpcLines([load("live-subagent_lifecycle.json"), load("live-subagent_progress.json")]);
    const cards = collectLiveSubagents(state.entries);
    expect(cards).toHaveLength(1);
    expect(liveIds(cards)).toEqual(["sa-1"]);
    expect(cards[0]?.preview).toBe("Still searching");
  });

  it("keeps two Explores with distinct ids as two cards", () => {
    const state = applyRpcLines([load("live-subagent_lifecycle.json"), load("live-subagent_lifecycle-b.json")]);
    const cards = collectLiveSubagents(state.entries);
    expect(cards).toHaveLength(2);
    expect(liveIds(cards).sort()).toEqual(["sa-1", "sa-2"]);
  });

  it("produces no card when the envelope has no OMP id", () => {
    const state = applyRpcLine(emptyTranscript(), { type: "subagent_lifecycle", payload: { agent: "Explore", status: "started" } });
    expect(collectLiveSubagents(state.entries)).toEqual([]);
  });

  it("still maps an event-wrapped payload as a fallback", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "subagent_lifecycle",
      event: { id: "sa-3", agent: "Explore", description: "via event", status: "started" },
    });
    const cards = collectLiveSubagents(state.entries);
    expect(cards).toHaveLength(1);
    expect(liveIds(cards)).toEqual(["sa-3"]);
    expect(cards[0]?.preview).toBe("via event");
  });

  it("hydrates the drawer from a get_subagents snapshot", () => {
    const state = applyRpcLine(emptyTranscript(), load("live-get_subagents.json"));
    const cards = collectLiveSubagents(state.entries);
    expect(cards).toHaveLength(1);
    expect(liveIds(cards)).toEqual(["sa-9"]);
    expect(cards[0]?.preview).toBe("Hydrated");
  });

  it("does not duplicate get_subagents rows already present for the same id", () => {
    const first = applyRpcLine(emptyTranscript(), load("live-get_subagents.json"));
    const second = applyRpcLine(first, load("live-get_subagents.json"));
    expect(second.entries.filter((entry) => entry.type === "subagent_status")).toHaveLength(1);
  });

  it("skips a get_subagents item that already has a live status row", () => {
    const live = applyRpcLine(emptyTranscript(), load("live-subagent_lifecycle.json"));
    expect(live.entries.filter((entry) => entry.type === "subagent_status")).toHaveLength(1);
    const next = applyRpcLine(live, {
      type: "response",
      command: "get_subagents",
      success: true,
      data: { subagents: [{ id: "sa-1", agent: "Explore", description: "Search the repo", status: "running" }] },
    });
    expect(next.entries.filter((entry) => entry.type === "subagent_status")).toHaveLength(1);
  });

  // The progress snapshot is the only frame carrying live activity. `currentTool` is set on
  // tool_execution_start and cleared on tool_execution_end, so a running agent with no current
  // tool is reasoning between calls.
  it("labels a running subagent that is executing a tool", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "subagent_progress",
      payload: {
        agent: "Explore",
        agentSource: "bundled",
        progress: { id: "sa-1", status: "running", currentTool: "read", lastIntent: "Search the repo", toolCount: 3, durationMs: 1500 },
      },
    });
    const cards = collectLiveSubagents(state.entries);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.activity).toBe("using read");
    expect(cards[0]?.tools).toBe(3);
    expect(cards[0]?.durationMs).toBe(1500);
    expect(cards[0]?.preview).toBe("Search the repo");
  });

  it("labels a running subagent between tools as thinking", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "subagent_progress",
      payload: { agent: "Explore", agentSource: "bundled", progress: { id: "sa-1", status: "running", description: "Still searching" } },
    });
    const cards = collectLiveSubagents(state.entries);
    expect(cards[0]?.activity).toBe("thinking");
    expect(cards[0]?.preview).toBe("Still searching");
  });

  // OMP stores recentOutput newest-first (executor.ts refreshRecentOutput reverses the tail), so
  // element 0 is what the subagent is saying now. `description` is an async LLM-generated label.
  it("prefers the newest output line over the intent and the description", () => {
    const withOutput = applyRpcLine(emptyTranscript(), {
      type: "subagent_progress",
      payload: {
        agent: "Explore",
        agentSource: "bundled",
        progress: { id: "sa-1", status: "running", recentOutput: ["newest line", "older line"], lastIntent: "intent", description: "desc" },
      },
    });
    expect(collectLiveSubagents(withOutput.entries)[0]?.preview).toBe("newest line");

    const withoutOutput = applyRpcLine(withOutput, {
      type: "subagent_progress",
      payload: {
        agent: "Explore",
        agentSource: "bundled",
        progress: { id: "sa-1", status: "running", recentOutput: [], lastIntent: "intent", description: "desc" },
      },
    });
    expect(collectLiveSubagents(withoutOutput.entries)[0]?.preview).toBe("intent");
  });

  // Guard: only a progress snapshot may invent an activity. Lifecycle, event-wrapped, and
  // hydration frames carry none, and the fold must keep the last real label instead of
  // replacing it with a fabricated one.
  it("carries no activity on lifecycle, event, and hydration frames", () => {
    const lifecycle = applyRpcLine(emptyTranscript(), load("live-subagent_lifecycle.json"));
    expect(collectLiveSubagents(lifecycle.entries)[0]?.activity).toBeUndefined();

    const wrapped = applyRpcLine(emptyTranscript(), {
      type: "subagent_lifecycle",
      event: { id: "sa-3", agent: "Explore", description: "via event", status: "started" },
    });
    expect(collectLiveSubagents(wrapped.entries)[0]?.activity).toBeUndefined();

    const hydrated = applyRpcLine(emptyTranscript(), load("live-get_subagents.json"));
    expect(collectLiveSubagents(hydrated.entries)[0]?.activity).toBeUndefined();
  });
});

describe("live assistant GC and journal join", () => {
  it("drops live thinking rows on turn_end, not only the key map", () => {
    const open = applyRpcLine(emptyTranscript(), load("live-thinking_start.json"));
    expect(open.entries.filter((entry) => entry.type === "thinking")).toHaveLength(1);
    const closed = applyRpcLine(open, { type: "turn_end" });
    expect(closed.entries.filter((entry) => entry.type === "thinking")).toHaveLength(0);
    const next = applyRpcLine(closed, load("live-thinking_start.json"));
    expect(next.entries.filter((entry) => entry.type === "thinking")).toHaveLength(1);
  });

  it("drops live thinking rows when a closed turn opens again", () => {
    const live = applyRpcLine(emptyTranscript(), load("live-thinking_start.json"));
    const next = applyRpcLine(live, { type: "turn_start" });
    expect(next.entries.filter((entry) => entry.type === "thinking")).toHaveLength(0);
  });

  it("does not allocate a live thinking row the journal already owns", () => {
    const journal = applyFilePage(
      emptyTranscript(),
      {
        start: 0,
        messages: [
          {
            rowId: "a1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "The user wants me to reply" },
              { type: "text", text: "323" },
            ],
          },
        ],
      },
      "initial",
    );
    expect(journal.entries.filter((entry) => entry.type === "thinking")).toHaveLength(1);
    expect(journal.entries.filter((entry) => entry.type === "text")).toHaveLength(1);
    const joined = applyRpcLine(journal, load("live-thinking_start.json"));
    expect(joined.entries.filter((entry) => entry.type === "thinking")).toHaveLength(1);
    expect(joined.entries.filter((entry) => entry.type === "text")).toHaveLength(1);
    expect(joined.entries.some((entry) => entry.type === "thinking" && entry.id.startsWith("e"))).toBe(false);
    const thinking = joined.entries.find((entry) => entry.type === "thinking");
    expect(thinking && "streaming" in thinking ? thinking.streaming : undefined).not.toBe(true);
  });

  it("still allocates a live row when the incoming text differs", () => {
    const journal = applyFilePage(
      emptyTranscript(),
      {
        start: 0,
        messages: [
          {
            rowId: "a1",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "plan" },
              { type: "text", text: "yo" },
            ],
          },
        ],
      },
      "initial",
    );
    const joined = applyRpcLine(journal, load("live-thinking_start.json"));
    expect(joined.entries.filter((entry) => entry.type === "thinking")).toHaveLength(2);
  });
});

describe("queuedMessageCount", () => {
  it("records get_state queuedMessageCount including 0", () => {
    const state = applyRpcLine(emptyTranscript(), {
      type: "response",
      command: "get_state",
      success: true,
      data: { queuedMessageCount: 0 },
    });
    expect("queuedMessageCount" in state.sessionMeta).toBe(true);
    expect("queuedMessageCount" in state.sessionMeta ? state.sessionMeta.queuedMessageCount : undefined).toBe(0);
  });
});

describe("chat attachments", () => {
  const imagePart = { type: "image", mimeType: "image/png", data: "aa" };

  it("maps image parts instead of dropping them", () => {
    const mapped = mapHydratedMessage({
      role: "user",
      content: [{ type: "text", text: "look" }, imagePart],
    });
    expect(mapped?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: "aa" },
    ]);
  });

  it("still drops unknown content types", () => {
    const mapped = mapHydratedMessage({
      role: "assistant",
      content: [{ type: "video", mimeType: "video/mp4" }],
    });
    expect(mapped?.content).toEqual([]);
  });

  it("hydrates a user message with text and an image into a prompt with a data URL", () => {
    const mapped = mapHydratedMessage({
      role: "user",
      rowId: "u1",
      content: [{ type: "text", text: "look" }, imagePart],
    });
    expect(mapped).not.toBeNull();
    const state = applyFilePage(emptyTranscript(), { start: 0, messages: mapped ? [mapped] : [] }, "initial");
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0];
    expect(entry).toMatchObject({ type: "prompt", text: "look" });
    expect(entry && "attachments" in entry && entry.attachments).toEqual([{ kind: "image", name: expect.any(String), mimeType: "image/png", src: "data:image/png;base64,aa" }]);
  });

  it("turns trailer-only user text into file chips and strips trailers from the caption", () => {
    const state = applyFilePage(
      emptyTranscript(),
      {
        start: 0,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Attached file: /repo/.alinery/tasks/task/artifacts/attachments/notes.pdf",
              },
            ],
          },
        ],
      },
      "initial",
    );
    const entry = state.entries[0];
    expect(entry).toMatchObject({ type: "prompt", text: "" });
    expect(entry && "attachments" in entry && entry.attachments).toEqual([{ kind: "file", name: "notes.pdf" }]);
  });

  it("preserves attachments on an optimistic user row", () => {
    const attachments = [{ kind: "image" as const, name: "shot.png", mimeType: "image/png", src: "blob:1" }];
    const next = appendOptimisticUser(emptyTranscript(), "hi", "prompt", undefined, attachments);
    const entry = next.entries[0];
    expect(entry).toMatchObject({ type: "prompt", text: "hi" });
    expect(entry && "attachments" in entry && entry.attachments).toEqual(attachments);
  });

  it("does not add a second user row when message_start is empty text plus images", () => {
    const attachments = [{ kind: "image" as const, name: "shot.png", mimeType: "image/png", src: "blob:1" }];
    const optimistic = appendOptimisticUser(emptyTranscript(), "", "prompt", undefined, attachments);
    const live = applyRpcLine(optimistic, {
      type: "message_start",
      message: { role: "user", content: [imagePart] },
    });
    expect(live.entries.filter((entry) => entry.type === "prompt")).toHaveLength(1);
  });

  it("does not add a second user row when message_start includes file trailers", () => {
    const attachments = [{ kind: "file" as const, name: "notes.pdf" }];
    const optimistic = appendOptimisticUser(emptyTranscript(), "see file", "prompt", undefined, attachments);
    const live = applyRpcLine(optimistic, {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "see file\n\nAttached file: /repo/.alinery/tasks/task/artifacts/attachments/notes.pdf" }],
      },
    });
    expect(live.entries.filter((entry) => entry.type === "prompt")).toHaveLength(1);
    const entry = live.entries[0];
    expect(entry).toMatchObject({ type: "prompt", text: "see file" });
    expect(entry && "attachments" in entry && entry.attachments).toEqual([{ kind: "file", name: "notes.pdf" }]);
  });

  it("does not add a second user row when message_start is trailer-only files", () => {
    const attachments = [{ kind: "file" as const, name: "notes.pdf" }];
    const optimistic = appendOptimisticUser(emptyTranscript(), "", "prompt", undefined, attachments);
    const live = applyRpcLine(optimistic, {
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: "Attached file: /repo/.alinery/tasks/task/artifacts/attachments/notes.pdf" }],
      },
    });
    expect(live.entries.filter((entry) => entry.type === "prompt")).toHaveLength(1);
    const entry = live.entries[0];
    expect(entry).toMatchObject({ type: "prompt", text: "" });
    expect(entry && "attachments" in entry && entry.attachments).toEqual([{ kind: "file", name: "notes.pdf" }]);
  });

  it("replaces optimistic image blob src with live image data on message_start", () => {
    const attachments = [{ kind: "image" as const, name: "shot.png", mimeType: "image/png", src: "blob:1" }];
    const optimistic = appendOptimisticUser(emptyTranscript(), "", "prompt", undefined, attachments);
    const live = applyRpcLine(optimistic, {
      type: "message_start",
      message: { role: "user", content: [imagePart] },
    });
    const entry = live.entries[0];
    expect(entry && "attachments" in entry && entry.attachments).toEqual([{ kind: "image", name: "image", mimeType: "image/png", src: "data:image/png;base64,aa" }]);
  });
});

describe("DEL-722 block-local streaming", () => {
  beforeEach(() => {
    // Advance the clock on every read so replacing a retained timestamp cannot pass by chance.
    let now = Date.parse("2026-09-25T12:00:00Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    return () => clock.mockRestore();
  });

  const update = (content: unknown, type: string, contentIndex?: unknown, stopReason?: string) => ({
    type: "message_update",
    message: { role: "assistant", content, stopReason },
    assistantMessageEvent: { type, ...(contentIndex === undefined ? {} : { contentIndex }) },
  });
  const activity = (state: ChatTranscriptState) => ({
    message: state.messages[state.messages.length - 1]?.content
      .filter((part) => part.type === "thinking" || part.type === "text" || part.type === "toolCall")
      .map((part) => Boolean("streaming" in part && part.streaming)),
    rows: state.entries
      .filter((entry) => !entry.id.startsWith("f:") && (entry.type === "thinking" || entry.type === "text" || entry.type === "tool_call"))
      .map((entry) => (entry.type === "tool_call" ? entry.status === "running" : Boolean("streaming" in entry && entry.streaming))),
  });
  const expectActivity = (state: ChatTranscriptState, expected: boolean[], label?: string) => {
    expect.soft(activity(state), label).toEqual({ message: expected, rows: expected });
  };
  const content = [
    { type: "thinking", thinking: "Working it out" },
    { type: "text", text: "The answer" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "source.ts" } },
  ];
  const streamAll = (state = emptyTranscript()) =>
    applyRpcLine(applyRpcLine(applyRpcLine(state, update(content, "toolcall_delta", 2)), update(content, "thinking_start", 0)), update(content, "text_start", 1));

  it("keeps completed thinking closed through every recorded answer transition", () => {
    let state = emptyTranscript();
    const trace = [];
    const identities = new Map<string, number | undefined>();
    for (const name of ["thinking_start", "thinking_end", "text_start", "text_delta", "text_end"]) {
      state = applyRpcLine(state, load(`live-${name}.json`));
      trace.push(activity(state));
      for (const entry of state.entries) {
        if (identities.has(entry.id)) expect.soft(entry.at, name).toBe(identities.get(entry.id));
        else identities.set(entry.id, entry.at);
      }
      expect
        .soft(
          state.entries.filter((entry) => entry.type === "thinking" || entry.type === "text").map((entry) => entry.text),
          name,
        )
        .toEqual(state.messages[0].content.map((part) => (part.type === "thinking" ? part.thinking : part.type === "text" ? part.text : undefined)));
    }
    expect.soft(trace).toEqual([
      { message: [true], rows: [true] },
      { message: [false, false], rows: [false, false] },
      { message: [false, true], rows: [false, true] },
      { message: [false, true], rows: [false, true] },
      { message: [false, false], rows: [false, false] },
    ]);
    const completed = applyRpcLines([load("live-thinking_start.json"), load("live-thinking_end.json")]);
    let replayed = completed;
    for (const name of ["text_start", "text_delta", "text_end", "text_end"]) {
      replayed = applyRpcLine(replayed, load(`live-${name}.json`));
      expect.soft(replayed.entries.map(({ id, at }) => ({ id, at }))).toEqual(completed.entries.map(({ id, at }) => ({ id, at })));
      expect.soft(replayed.messages[0].content).toMatchObject([
        { type: "thinking", thinking: "The user wants me to reply with ONLY the integer result of 17*19.\n\n\n" },
        { type: "text", text: "323" },
      ]);
      expect.soft(replayed.entries.filter((entry) => entry.type === "text")).toHaveLength(1);
    }
  });

  it("keeps the first text complete while the second text starts, grows and ends", () => {
    const first = { type: "text", text: "## Finished" };
    const second = { type: "text", text: "Second" };
    let state = applyRpcLine(emptyTranscript(), update([first], "text_start", 0));
    expectActivity(state, [true]);
    const firstRow = state.entries[0];
    state = applyRpcLine(state, update([first], "text_end", 0));
    expectActivity(state, [false]);
    state = applyRpcLine(state, update([first, second], "text_start", 1));
    expectActivity(state, [false, true]);
    const identities = state.entries.map(({ id, at }) => ({ id, at }));
    for (const [event, live] of [
      ["text_delta", true],
      ["text_end", false],
    ] as const) {
      state = applyRpcLine(state, update([first, { ...second, text: "Second answer" }], event, 1));
      expectActivity(state, [false, live], event);
      expect.soft(state.entries.map(({ id, at }) => ({ id, at }))).toEqual(identities);
      expect.soft(state.entries[0]).toMatchObject({ id: firstRow.id, at: firstRow.at, type: "text", text: first.text });
      expect.soft(state.messages[0].content).toMatchObject([first, { type: "text", text: "Second answer" }]);
      expect.soft(state.entries[1]).toMatchObject({ type: "text", text: "Second answer" });
    }
  });

  it("preserves overlapping thinking, text and tool arguments in both end orders", () => {
    let state = emptyTranscript();
    const transitions: [string, number, boolean[]][] = [
      ["thinking_start", 0, [true, false, false]],
      ["text_start", 1, [true, true, false]],
      ["toolcall_start", 2, [true, true, true]],
      ["thinking_end", 0, [false, true, true]],
      ["toolcall_delta", 2, [false, true, true]],
      ["text_end", 1, [false, false, true]],
      ["toolcall_end", 2, [false, false, false]],
      ["thinking_delta", 0, [true, false, false]],
      ["text_delta", 1, [true, true, false]],
      ["toolcall_delta", 2, [true, true, true]],
      ["toolcall_end", 2, [true, true, false]],
      ["text_end", 1, [true, false, false]],
      ["thinking_end", 0, [false, false, false]],
    ];
    for (const [event, index, expected] of transitions) {
      state = applyRpcLine(state, update(content, event, index));
      expectActivity(state, expected, event);
    }
    expect.soft(state.entries.find((entry) => entry.type === "tool_call")).toMatchObject({
      toolId: "call-1",
      args: '{"path":"source.ts"}',
      status: "ok",
    });
    const alias = content.map((part) => (part.type === "toolCall" ? { ...part, type: "tool_call" } : part));
    state = applyRpcLine(state, update(alias, "toolcall_delta", 2));
    expectActivity(state, [false, false, true], "tool_call alias");
  });

  it("addresses raw indices across filtered, redacted and image blocks", () => {
    const raw = [
      { type: "producer_metadata", value: "not displayed" },
      { type: "redactedThinking" },
      content[0],
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      content[1],
    ];
    let state = applyRpcLine(emptyTranscript(), update(raw, "text_start", 4));
    expectActivity(state, [false, true]);
    const identities = state.entries.map(({ id, at }) => ({ id, at }));
    state = applyRpcLine(state, update(raw, "thinking_start", 2));
    expectActivity(state, [true, true]);
    state = applyRpcLine(state, update(raw, "thinking_end", 2));
    expectActivity(state, [false, true]);
    state = applyRpcLine(state, update(raw, "text_end", 4));
    expectActivity(state, [false, false]);
    expect
      .soft(state.messages[0].content)
      .toEqual([
        { type: "redactedThinking" },
        expect.objectContaining(content[0]),
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        expect.objectContaining(content[1]),
      ]);
    expect.soft(state.entries.map(({ type }) => type)).toEqual(["redacted_thinking", "thinking", "text"]);
    expect.soft(state.entries.map(({ id, at }) => ({ id, at }))).toEqual(identities);
    for (const index of [0, 1, 3]) {
      state = applyRpcLine(state, update(raw, "thinking_start", index));
      expectActivity(state, [false, false], `non-streamable raw index ${index}`);
    }
  });

  it("prunes removed and changed-kind active indices before later snapshots reuse them", () => {
    let state = applyRpcLine(emptyTranscript(), update(content.slice(0, 2), "text_start", 1));
    state = applyRpcLine(state, update([content[0]], "unknown_event"));
    expectActivity(state, [false], "removed active index");
    state = applyRpcLine(state, update(content.slice(0, 2), "unknown_event"));
    expectActivity(state, [false, false], "reintroduced index");
    state = applyRpcLine(state, update(content.slice(0, 2), "thinking_start", 0));
    state = applyRpcLine(state, update([{ type: "text", text: "Replacement kind" }, content[1]], "thinking_end", 0));
    expectActivity(state, [false, false], "mismatched end still reconciles changed kind");
    state = applyRpcLine(state, update(content.slice(0, 2), "unknown_event"));
    expectActivity(state, [false, false], "original kind returns without activity");
  });

  it("rejects distinct invalid indices without reviving or ending valid siblings", () => {
    let state = applyRpcLine(emptyTranscript(), update(content.slice(0, 2), "text_start", 1));
    state = applyRpcLine(state, update(content.slice(0, 2), "text_end", 1));
    state = applyRpcLine(state, update(content.slice(0, 2), "thinking_start", 0));
    const indices = [
      ["missing", undefined],
      ["string", "1"],
      ["fractional", 0.5],
      ["negative", -1],
      ["out of range", 2],
    ] as const;
    for (const [label, index] of indices) {
      state = applyRpcLine(state, update(content.slice(0, 2), "text_start", index));
      expectActivity(state, [true, false], `${label} start`);
      state = applyRpcLine(state, update(content.slice(0, 2), "thinking_end", index));
      expectActivity(state, [true, false], `${label} end`);
    }
    for (const [event, index] of [
      ["text_start", 0],
      ["thinking_end", 1],
    ] as const) {
      state = applyRpcLine(state, update(content.slice(0, 2), event, index));
      expectActivity(state, [true, false], `kind-mismatched ${event}`);
    }
  });

  it("retains activity through unknown, image and non-array frames without inferring a target", () => {
    const raw = [...content.slice(0, 2), { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }];
    let state = applyRpcLine(emptyTranscript(), update(raw, "thinking_delta", 0));
    for (const event of ["unknown_event", "image_end"]) {
      state = applyRpcLine(state, update(raw, event, 2));
      expectActivity(state, [true, false], event);
    }
    state = applyRpcLine(state, update(raw, "thinking_end\n", 0));
    expectActivity(state, [true, false], "event names must match exactly");
    for (const missing of [undefined, { type: "text", text: "not an array" }]) {
      state = applyRpcLine(state, update(missing, "thinking_end", 0));
      expect.soft(state.messages[state.messages.length - 1]?.content).toEqual([]);
      expect.soft(activity(state).rows).toEqual([]);
      state = applyRpcLine(state, update(raw, "unknown_event"));
      expectActivity(state, [true, false], "valid snapshot after non-array content");
    }
  });

  it("accepts an indexed delta without start despite a partial stop reason", () => {
    const state = applyRpcLine(emptyTranscript(), update(content.slice(0, 2), "text_delta", 1, "stop"));
    expectActivity(state, [false, true]);
    expect.soft(state.messages[0]).toMatchObject({ stopReason: "stop", content: content.slice(0, 2) });
  });

  it("retains activity across initial and older hydration without mutating retained states or inputs", () => {
    const input = update(content.slice(0, 2), "thinking_start", 0);
    const inputBefore = structuredClone(input);
    const first = applyRpcLine(emptyTranscript(), input);
    const retained = structuredClone({ messages: first.messages, entries: first.entries });
    const overlap = applyRpcLine(first, update(content.slice(0, 2), "text_start", 1));
    const page = { start: 100, messages: [{ rowId: "history", role: "assistant" as const, content: [{ type: "text" as const, text: "Earlier answer" }] }] };
    const pageBefore = structuredClone(page);
    const hydrated = applyFilePage(overlap, page, "initial");
    const historyRows = hydrated.entries.filter((entry) => entry.id.startsWith("f:"));
    const olderPage = { start: 0, messages: [{ rowId: "older", role: "user" as const, content: [{ type: "text" as const, text: "Older question" }] }] };
    const paged = applyFilePage(hydrated, olderPage, "older");
    const pagedBefore = structuredClone({ messages: paged.messages, entries: paged.entries });
    let state = applyRpcLine(paged, update(content.slice(0, 2), "text_end", 1));
    expectActivity(state, [true, false], "sibling end after both page modes");
    state = applyRpcLine(state, update(content.slice(0, 2), "thinking_end", 0));
    expectActivity(state, [false, false]);
    expect.soft(state.entries.filter((entry) => entry.id.startsWith("f:history"))).toEqual(historyRows);
    expect.soft(state.messages.filter((message) => message.rowId)).toEqual([...olderPage.messages, ...page.messages]);
    expect.soft({ messages: first.messages, entries: first.entries }).toEqual(retained);
    expect.soft({ messages: paged.messages, entries: paged.entries }).toEqual(pagedBefore);
    expect.soft(input).toEqual(inputBefore);
    expect.soft(page).toEqual(pageBefore);
    const forked = applyRpcLine(first, update(content.slice(0, 2), "unknown_event"));
    expectActivity(forked, [true, false], "later reductions cannot change an earlier state's activity");
  });

  it("resets reused indices on message starts but keeps repeated open notifications idempotent", () => {
    const opened = applyRpcLine(emptyTranscript(), { type: "turn_start" });
    const live = applyRpcLine(opened, update(content.slice(0, 2), "thinking_start", 0));
    let repeated = live;
    for (const type of ["agent_start", "turn_start"]) {
      repeated = applyRpcLine(repeated, { type });
      expectActivity(repeated, [true, false], type);
      expect.soft(repeated.entries.filter((entry) => entry.type === "turn_marker")).toEqual(live.entries.filter((entry) => entry.type === "turn_marker"));
    }
    for (const reset of [{ type: "message_start", message: { role: "assistant", content: content.slice(0, 2) } }, update(content.slice(0, 2), "start")]) {
      const restarted = applyRpcLine(repeated, reset);
      expectActivity(restarted, [false, false], "replacement snapshot is not live");
      expectActivity(applyRpcLine(restarted, update(content.slice(0, 2), "text_delta", 1)), [false, true], "old thinking activity stays cleared");
    }
    expectActivity(applyRpcLine(emptyTranscript(), update(content.slice(0, 2), "unknown_event")), [false, false], "fresh session");
    const provisional = applyRpcLine(emptyTranscript(), update(content.slice(0, 2), "thinking_start", 0));
    const newTurn = applyRpcLine(provisional, { type: "turn_start" });
    expectActivity(applyRpcLine(newTurn, update(content.slice(0, 2), "text_delta", 1)), [false, true], "genuine new turn");
    const ended = applyRpcLine(repeated, { type: "turn_end" });
    const history = structuredClone(ended.entries);
    let next = applyRpcLine(ended, { type: "turn_start" });
    next = applyRpcLine(next, update([{ type: "text", text: "Distinct next turn" }], "text_delta", 0));
    expect.soft(next.entries.slice(0, history.length)).toEqual(history);
    expect.soft(activity(next).message).toEqual([true]);
    expect.soft(activity(next).rows).toEqual([false, false, true]);
    expect.soft(next.entries[next.entries.length - 1]).toMatchObject({ type: "text", text: "Distinct next turn" });
  });

  it.each([
    ["message_end stop", "message_end", "stop"],
    ["message_end aborted", "message_end", "aborted"],
    ["message_end error", "message_end", "error"],
    ["nested done", "done", "stop"],
    ["nested error", "error", "error"],
  ])("finalizes all active kinds on %s", (_label, event, stopReason) => {
    const live = streamAll();
    const identities = live.entries.map(({ id, at }) => ({ id, at }));
    const terminal = event === "message_end" ? { type: event, message: { role: "assistant", content, stopReason } } : update(content, event, undefined, stopReason);
    const state = applyRpcLine(live, terminal);
    expectActivity(state, [false, false, false]);
    expect.soft(state.entries.map(({ id, at }) => ({ id, at }))).toEqual(identities);
    expect.soft(state.entries).toMatchObject([
      { type: "thinking", text: "Working it out" },
      { type: "text", text: "The answer" },
      { type: "tool_call", toolId: "call-1", args: '{"path":"source.ts"}', status: "ok" },
    ]);
    expect.soft(state.messages[0].content).toMatchObject([content[0], content[1], { type: "toolCall", id: "call-1", args: { path: "source.ts" } }]);
    const thinking = state.entries.find((entry) => entry.type === "thinking");
    expect.soft(Boolean(thinking?.type === "thinking" && thinking.aborted)).toBe(stopReason === "aborted");
    expectActivity(applyRpcLine(state, update(content, "unknown_event")), [false, false, false], "completion clears retained activity");
  });

  it("drops an unfinished tool on confirmed abort but does not finalize on abort or error notices", () => {
    const live = streamAll();
    let noticed = appendOptimisticAbort(live);
    noticed = applyRpcLine(noticed, { type: "error", message: "Temporary transport problem" });
    expectActivity(noticed, [true, true, true], "notices are not completion");
    expect.soft(noticed.entries.some((entry) => entry.type === "abort")).toBe(true);
    expect.soft(noticed.entries.some((entry) => entry.type === "error")).toBe(true);
    noticed = applyRpcLine(noticed, update(content, "unknown_event"));
    expectActivity(noticed, [true, true, true], "notice did not clear retained activity");
    const aborted = applyRpcLine(noticed, { type: "message_end", message: { role: "assistant", content: content.slice(0, 2), stopReason: "aborted" } });
    expectActivity(aborted, [false, false]);
    expect.soft(aborted.entries.find((entry) => entry.type === "thinking")).toMatchObject({ aborted: true, text: "Working it out" });
    expect.soft(aborted.entries.some((entry) => entry.type === "tool_call")).toBe(false);
    expectActivity(applyRpcLine(aborted, update(content, "unknown_event")), [false, false, false], "removed tool activity cannot return");
  });

  it.each([
    ["turn_end", "stop"],
    ["agent_end", "aborted"],
  ])("finalizes missing message_end on %s and ignores repeated terminal notifications", (type, stopReason) => {
    const live = streamAll(applyRpcLine(emptyTranscript(), { type: "turn_start" }));
    const retained = structuredClone({ messages: live.messages, entries: live.entries });
    const identities = live.entries.map(({ id, at }) => ({ id, at }));
    const state = applyRpcLine(live, { type, stopReason });
    expectActivity(state, [false, false, false]);
    expect.soft(state.entries.slice(0, live.entries.length).map(({ id, at }) => ({ id, at }))).toEqual(identities);
    expect.soft(state.entries.find((entry) => entry.type === "thinking")).toMatchObject({ text: "Working it out" });
    expect.soft(state.entries.find((entry) => entry.type === "tool_call")).toMatchObject({ args: '{"path":"source.ts"}', status: "ok" });
    const thinking = state.entries.find((entry) => entry.type === "thinking");
    expect.soft(Boolean(thinking?.type === "thinking" && thinking.aborted)).toBe(stopReason === "aborted");
    const repeated = applyRpcLine(state, { type, stopReason });
    expect.soft(repeated.entries).toEqual(state.entries);
    expect.soft(repeated.entries.filter((entry) => entry.type === "turn_marker" && entry.phase === "end")).toHaveLength(1);
    expect.soft({ messages: live.messages, entries: live.entries }).toEqual(retained);
  });

  it("drops provisional rows without an open turn while clearing retained message activity", () => {
    const live = streamAll();
    const closed = applyRpcLine(live, { type: "agent_end" });
    expect.soft(activity(closed)).toEqual({ message: [false, false, false], rows: [] });
    expect.soft(closed.messages[0].content).toMatchObject([content[0], content[1], { type: "toolCall", id: "call-1" }]);
    expect.soft(closed.entries.some((entry) => entry.type === "turn_marker")).toBe(false);
    expectActivity(applyRpcLine(closed, update(content, "unknown_event")), [false, false, false], "next snapshot cannot restore old activity");
  });

  it("finalizes hydrated live rows in place without rewriting history or unrelated rows", () => {
    let live = streamAll(applyRpcLine(emptyTranscript(), { type: "turn_start" }));
    live = appendHarnessNotice(live, "notice", "Keep this notice");
    live = applyRpcLine(live, load("live-subagent_lifecycle.json"));
    const withResult = [...content, { type: "toolResult", text: "Independent result" }];
    live = applyRpcLine(live, update(withResult, "text_delta", 1));
    const rowsBefore = structuredClone(live.entries);
    const page = {
      start: 0,
      messages: [
        { rowId: "result", role: "toolResult" as const, toolName: "bash", isError: true, content: [{ type: "text" as const, text: "Older failed result" }] },
        { rowId: "other-answer", role: "assistant" as const, content: [{ type: "text" as const, text: "Different hydrated answer" }] },
      ],
    };
    const hydrated = applyFilePage(live, page, "initial");
    const messagesBefore = structuredClone(hydrated.messages);
    const history = structuredClone(hydrated.entries.filter((entry) => entry.id.startsWith("f:")));
    const state = applyRpcLine(hydrated, { type: "turn_end", stopReason: "aborted" });
    expect.soft(state.messages).toEqual(messagesBefore);
    expect.soft(state.entries.filter((entry) => entry.id.startsWith("f:"))).toEqual(history);
    for (const row of rowsBefore) {
      const after = state.entries.find((entry) => entry.id === row.id);
      if (row.type === "thinking" || row.type === "text") {
        expect.soft(after).toMatchObject({ id: row.id, at: row.at, type: row.type, text: row.text });
        expect.soft(Boolean(after && "streaming" in after && after.streaming)).toBe(false);
        if (row.type === "thinking") expect.soft(after).toMatchObject({ aborted: true });
      } else if (row.type === "tool_call") {
        expect.soft(after).toEqual({ ...row, status: "ok" });
      } else {
        expect.soft(after).toEqual(row);
      }
    }
    expect.soft(state.entries.filter((entry) => entry.type === "text").map((entry) => entry.text)).toEqual(["Different hydrated answer", "The answer"]);
    expect.soft(hydrated.messages).toEqual(messagesBefore);
    expect.soft(hydrated.entries.filter((entry) => !entry.id.startsWith("f:"))).toEqual(rowsBefore);
  });

  it("clears terminal activity even when journal ownership suppresses every live row", () => {
    const journal = applyFilePage(
      emptyTranscript(),
      {
        start: 0,
        messages: [
          {
            rowId: "same",
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Working it out" },
              { type: "text", text: "The answer" },
            ],
          },
        ],
      },
      "initial",
    );
    const suppressed = applyRpcLine(journal, update(content.slice(0, 2), "thinking_start", 0));
    expect.soft(suppressed.entries).toEqual(journal.entries);
    expect.soft(activity(suppressed).message).toEqual([true, false]);
    const closed = applyRpcLine(suppressed, { type: "turn_end" });
    expect.soft(closed.entries).toEqual(journal.entries);
    expect.soft(activity(closed).message).toEqual([false, false]);
    const later = applyRpcLine(closed, update([{ type: "thinking", thinking: "Different later thinking" }, content[1]], "text_delta", 1));
    expectActivity(later, [false, true]);
    expect.soft(later.entries.filter((entry) => entry.id.startsWith("f:"))).toEqual(journal.entries);
    expect.soft(later.entries.filter((entry) => entry.type === "thinking")).toHaveLength(2);
  });
});
