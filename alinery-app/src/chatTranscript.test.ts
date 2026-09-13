import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectLiveSubagents } from "./chat/subagents";
import {
  appendHarnessNotice,
  appendOptimisticUser,
  applyFilePage,
  applyRpcLine,
  applyRpcLines,
  emptyTranscript,
  flattenWouldFail,
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
