import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ACTOR, type ChatEntry, subagent, type WrapUpPrompt } from "../chat/types";
import { chatVisibilityFromAppearance, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import { applyRpcLine, applyVinculumTranscript, emptyTranscript } from "../chatTranscript";
import { stubScrollSize } from "../test/scroll";
import { ChatPane } from "./ChatPane";

vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

const at = Date.parse("2026-09-05T12:11:00Z");

function pane(entries: ChatEntry[], visibility = DEFAULT_CHAT_VISIBILITY, status: "idle" | "running" | "waiting_approval" = "idle") {
  return renderToStaticMarkup(<ChatPane entries={entries} visibility={visibility} status={status} />);
}

describe("ChatPane compaction tail", () => {
  it("renders one row per in-flight compaction and a failure sentence, and removes them when cleared", () => {
    const running = {
      compactions: [{ reason: "threshold", blocking: false, attempt: 1 }],
      failure: null,
    };
    const two = render(
      <ChatPane
        entries={[]}
        compactionState={{
          compactions: [...running.compactions, { reason: "manual", blocking: true, attempt: 2, retryAt: Date.parse("2026-09-05T12:11:00Z"), retryError: "busy" }],
          failure: { reason: "overflow", error: "no room" },
        }}
      />,
    );
    expect(two.getAllByText(/Compacting context/)).toHaveLength(2);
    expect(two.container.textContent).toContain("Compacting context · threshold · attempt 1");
    expect(two.container.textContent).toContain("Compacting context · manual · attempt 2");
    expect(two.container.textContent).toContain("retrying at 2026-09-05T12:11:00.000Z");
    expect(two.container.textContent).toContain("busy");
    expect(two.container.textContent).toContain("Compaction failed: no room. The conversation is unchanged.");
    expect(two.container.textContent).not.toContain("waiting");
    two.unmount();
    const cleared = render(<ChatPane entries={[]} compactionState={{ compactions: [], failure: null }} />);
    expect(cleared.container.textContent).not.toContain("Compacting context");
    expect(cleared.container.textContent).not.toContain("Compaction failed");
    cleared.unmount();
  });

  it("renders two compactions that share a reason, attempt, blocking flag, and retry time", () => {
    const same = { reason: "manual", blocking: false, attempt: 1 };
    const view = render(<ChatPane entries={[]} compactionState={{ compactions: [same, { ...same }], failure: null }} />);
    expect(view.getAllByText("Compacting context · manual · attempt 1")).toHaveLength(2);
    view.unmount();
  });

  it("follows a compaction or failure to the bottom only while stuck", () => {
    const stub = stubScrollSize();
    const entries = [{ id: "1", at, actor: ACTOR.you, type: "prompt" as const, text: "hello" }];
    try {
      const view = render(<ChatPane entries={entries} />);
      const list = view.container.querySelector(".chat-list") as HTMLElement;
      expect(list.scrollTop).toBe(2000);
      stub.writes.length = 0;
      view.rerender(<ChatPane entries={entries} compactionState={{ compactions: [{ reason: "manual", blocking: false, attempt: 1 }], failure: null }} />);
      expect(stub.writes).toEqual([2000]);
      stub.writes.length = 0;
      view.rerender(<ChatPane entries={entries} compactionState={{ compactions: [], failure: { reason: "overflow", error: "no room" } }} />);
      expect(stub.writes).toEqual([2000]);

      list.scrollTop = 40;
      fireEvent.scroll(list);
      stub.writes.length = 0;
      view.rerender(
        <ChatPane
          entries={entries}
          compactionState={{ compactions: [{ reason: "threshold", blocking: true, attempt: 2, retryAt: 9 }], failure: { reason: "overflow", error: "still no room" } }}
        />,
      );
      expect(stub.writes).toEqual([]);
      expect(list.scrollTop).toBe(40);
      view.unmount();
    } finally {
      stub.restore();
    }
  });
});

describe("ChatPane", () => {
  it("shows a wrap-up prompt immediately and reconciles the same bubble by delivery ID within the active turn", () => {
    const text = "Please wrap up this step.";
    const nudge: WrapUpPrompt = { deliveryId: "receipt-1", text, at, status: "sending" };
    const messages = [
      { id: "u1", role: "user", text, at },
      { id: "a1", role: "assistant", text: "Checking the result.", at },
    ];
    const entries = applyVinculumTranscript(messages).entries;
    const placed = applyVinculumTranscript([
      ...messages,
      { id: "a2", role: "assistant", text: "The check finished.", at: at + 1_000 },
      { id: "u2", role: "user", nudgeDeliveryId: nudge.deliveryId, text, at: at + 2_000 },
    ]).entries;
    const view = render(<ChatPane status="running" entries={entries} wrapUpPrompt={nudge} />);
    const row = view.getByText("Wrap-up nudge").closest("li");
    expect(row?.dataset.node).toBe("you");
    expect(row?.textContent).toContain(text);
    expect(row?.textContent).toContain("Sending…");
    expect(view.getAllByText(text)).toHaveLength(2); // An ordinary message with identical text is independent.
    expect(view.container.querySelector(".chat-turn-end")).toBeNull();

    view.rerender(<ChatPane status="running" entries={entries} wrapUpPrompt={{ ...nudge, status: "pending" }} />);
    expect(view.getByText("Sent").closest("li")).toBe(row);

    // The authoritative stream can arrive before the RPC reply, even a late refusal.
    for (const status of ["sending", "failed", "pending", "ended"] as const) {
      view.rerender(<ChatPane status="running" entries={placed} wrapUpPrompt={{ ...nudge, status }} />);
      expect(view.getByText("Wrap-up nudge").closest("li")).toBe(row);
      expect(row?.previousElementSibling).toBe(view.getByText("The check finished.").closest("li"));
      expect(row?.querySelector(".chat-status")).toBeNull();
      expect(view.getAllByText(text)).toHaveLength(2);
      expect(view.container.querySelector(".chat-turn-end")).toBeNull();
    }
    view.rerender(<ChatPane status="idle" entries={placed} />);
    expect(view.getByText("Wrap-up nudge").closest("li")).toBe(row);
    expect(view.container.querySelectorAll(".chat-turn-end")).toHaveLength(1);
    view.unmount();
  });

  it("keeps a nudge at its send time when its original prompt is unavailable", () => {
    const entries = applyVinculumTranscript([
      { id: "u1", role: "user", text: "Research terminal input.", at },
      { id: "a1", role: "assistant", text: "Checking arrow keys.", at },
    ]).entries;
    const nudge: WrapUpPrompt = { deliveryId: "receipt-1", text: "Please wrap up.", at: at + 1_000, status: "pending" };
    const view = render(<ChatPane status="running" entries={entries} wrapUpPrompt={nudge} />);
    const original = view.getByText("Sent").closest("li");
    const next = applyVinculumTranscript([
      { id: "u2", role: "user", text: "Keep going.", at: at + 2_000 },
      { id: "a2", role: "assistant", text: "Continuing the investigation.", at: at + 3_000 },
    ]).entries;
    view.rerender(<ChatPane status="running" entries={[...entries, ...next]} wrapUpPrompt={{ ...nudge, status: "ended" }} />);

    expect(view.getByText("Turn ended · delivery unconfirmed").closest("li")).toBe(original);
    const rows = [...view.container.querySelectorAll<HTMLElement>(".chat-journal-item")];
    expect(rows.map((row) => row.dataset.entryId ?? row.dataset.node)).toEqual([entries[0].id, entries[1].id, original?.dataset.entryId, "turn", next[0].id, next[1].id]);
    view.unmount();
  });

  it("updates block copy controls on existing replies without hiding whole-message copying", () => {
    const entries: ChatEntry[] = [{ id: "copy", at, actor: ACTOR.agent, type: "text", text: "```sh\nsudo ls\n```\n\n> Quoted advice" }];
    const view = render(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({})} />);
    expect(view.getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy quote" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy message" })).toBeTruthy();

    view.rerender(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({ chat_show_block_copy_buttons: false })} />);
    expect(view.queryByRole("button", { name: "Copy code block" })).toBeNull();
    expect(view.queryByRole("button", { name: "Copy quote" })).toBeNull();
    expect(view.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(view.getByText("sudo ls")).toBeTruthy();
    expect(view.getByText("Quoted advice")).toBeTruthy();

    view.rerender(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({ chat_show_block_copy_buttons: true })} />);
    expect(view.getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy quote" })).toBeTruthy();

    view.rerender(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({ chat_show_block_copy_buttons: true, chat_show_copy_buttons: false })} />);
    expect(view.queryByRole("button", { name: "Copy message" })).toBeNull();
    expect(view.getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy quote" })).toBeTruthy();
    view.unmount();
  });

  it("renders thinking, text, and a tool card without flattening", () => {
    const html = pane(
      [
        { id: "1", at, actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true },
        { id: "2", at, actor: ACTOR.agent, type: "text", text: "323" },
        { id: "3", at, actor: ACTOR.agent, type: "tool_call", tool: "read", args: '{"path":"a.ts"}', target: "a.ts", status: "ok" },
      ],
      { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, showTools: true, expandTools: true },
    );
    expect(html).toContain("plan");
    expect(html).toContain("323");
    expect(html).toContain("read");
    expect(html).toContain("a.ts");
  });

  // A collapsed rail is hidden by CSS, so building its body cost layout and DOM for something
  // nobody could read. Tool output is the bulk of a journal, so this is most of the cost of a
  // fully loaded conversation.
  it("builds no body for a collapsed work rail", () => {
    const entry: ChatEntry = { id: "3", at, actor: ACTOR.agent, type: "tool_call", tool: "read", args: '{"path":"a.ts"}', target: "a.ts", status: "ok" };
    expect(pane([entry], { ...DEFAULT_CHAT_VISIBILITY, showTools: true, expandTools: false })).not.toContain("a.ts");
    expect(pane([entry], { ...DEFAULT_CHAT_VISIBILITY, showTools: true, expandTools: true })).toContain("a.ts");
  });

  it("pairs each result with the earliest call still waiting, whatever the result is named", () => {
    const html = pane(
      [
        { id: "c1", at, actor: ACTOR.agent, type: "tool_call", tool: "bash", args: '{"command":"ls"}', status: "ok" },
        { id: "c2", at, actor: ACTOR.agent, type: "tool_call", tool: "read", args: '{"path":"a.ts"}', target: "a.ts", status: "ok" },
        { id: "r1", at, actor: ACTOR.agent, type: "tool_result", tool: "tool", text: "ls output", status: "ok" },
        { id: "r2", at, actor: ACTOR.agent, type: "tool_result", tool: "tool", text: "file body", status: "ok" },
      ],
      { ...DEFAULT_CHAT_VISIBILITY, showTools: true, expandTools: true },
    );
    expect(html).toContain('aria-label="2 steps · bash · read"');
    expect(html.indexOf("ls output")).toBeLessThan(html.indexOf("a.ts"));
    expect(html.indexOf("file body")).toBeGreaterThan(html.indexOf("a.ts"));
  });

  it("renders journal row kinds from the Chat mockup", () => {
    const html = pane(
      [
        { id: "p", at, actor: ACTOR.you, type: "prompt", text: "Map ChatPane" },
        { id: "f", at, actor: ACTOR.you, type: "follow_up", text: "Continue." },
        { id: "h", at, actor: ACTOR.vinculum, type: "harness", event: "todo", text: "Composer grow + cap" },
        { id: "t", at, actor: ACTOR.vinculum, type: "turn_marker", turn: 3, phase: "end", stopReason: "complete" },
        { id: "r", at, actor: ACTOR.agent, type: "redacted_thinking" },
        {
          id: "a",
          at,
          actor: ACTOR.alinery,
          type: "approval",
          requestId: "u1",
          action: "git push origin chat-pane",
          detail: "Publishes the branch",
          scope: "repo alinery",
        },
        {
          id: "s",
          at,
          actor: subagent("plan"),
          type: "subagent_status",
          subagentId: "sa-plan",
          agent: "plan",
          role: "architect",
          status: "running",
          summary: "Drafting composer grow rules",
        },
      ],
      { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, showTurnMarkers: true, showSubagentRows: true },
    );

    expect(html).toContain("Map ChatPane");
    expect(html).toContain("Continue.");
    expect(html).toContain("queued · after this turn");
    expect(html).toContain("todo");
    expect(html).toContain("Turn 3 end");
    expect(html).toContain('aria-label="1 step · thinking"');
    expect(html).toContain("git push origin chat-pane");
    expect(html).toContain("Allow");
    expect(html).toContain("subagents · 1");
    // `toContain("subagents · 1")` is a substring of the old "subagents · 1 running", so the
    // blanket claim needs its own negative assertion to be discriminating.
    expect(html).not.toContain("subagents · 1 running");
    expect(html).toContain("Drafting composer grow rules");
    // The card no longer prints the subagent's origin (`agentSource`, stored as `role`) in the
    // status position; the journal rail renders `plan running`, never the role.
    expect(html).not.toContain("architect");
    expect(html).not.toContain("/compact");
  });

  it("hides harness, turn markers, subagent rows, and the drawer by prefs", () => {
    const entries: ChatEntry[] = [
      { id: "h", at, actor: ACTOR.vinculum, type: "harness", event: "todo", text: "hidden harness" },
      { id: "t", at, actor: ACTOR.vinculum, type: "turn_marker", turn: 1, phase: "end" },
      {
        id: "s",
        at,
        actor: subagent("plan"),
        type: "subagent_status",
        subagentId: "sa-plan",
        agent: "plan",
        status: "running",
        summary: "hidden sub",
      },

      { id: "x", at, actor: ACTOR.agent, type: "text", text: "kept" },
    ];
    const html = pane(entries, {
      ...DEFAULT_CHAT_VISIBILITY,
      showHarness: false,
      showTurnMarkers: false,
      showSubagentRows: false,
      showSubagentDrawer: false,
      railDensity: "dense",
    });
    expect(html).toContain("kept");
    expect(html).not.toContain("hidden harness");
    expect(html).not.toContain("Turn 1");
    expect(html).not.toContain("hidden sub");
    expect(html).not.toContain("subagents ·");
    expect(html).toContain('data-density="dense"');
  });

  it("marks density and chrome toggles on the pane", () => {
    const html = pane([{ id: "1", at, actor: ACTOR.agent, type: "text", text: "hi" }], {
      ...DEFAULT_CHAT_VISIBILITY,
      railDensity: "comfortable",
      showActorLabels: true,
      showAgentBubbles: true,
    });
    expect(html).toContain('data-density="comfortable"');
    expect(html).toContain('data-actor-labels="on"');
    expect(html).toContain('data-agent-bubbles="on"');
    expect(html).toContain("Copy message");
    expect(pane([{ id: "1", at, actor: ACTOR.agent, type: "text", text: "hi" }], { ...DEFAULT_CHAT_VISIBILITY, showCopyButtons: false })).not.toContain("Copy message");
  });

  it("shows labelled agent bubbles when those prefs are on and keeps user prompts bubbled", () => {
    const html = pane(
      [
        { id: "1", at, actor: ACTOR.you, type: "prompt", text: "Hello" },
        { id: "2", at, actor: ACTOR.agent, type: "text", text: "Reply" },
        { id: "3", at, actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true },
      ],
      { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, showDate: true, showTime: true, showActorLabels: true, showAgentBubbles: true },
    );
    expect(html).toContain('data-agent-bubbles="on"');
    expect(html).toContain('data-actor-labels="on"');
    expect(html).toContain('data-density="normal"');
    expect(html).toContain("chat-msg-mine");
    expect(html).toContain("chat-msg-reply");
    expect(html).toContain("chat-rail");
    expect(html).toContain("chat-msg-who");
  });

  it("starts with actor labels and agent bubbles and honors saved opt-outs", () => {
    const entries: ChatEntry[] = [
      { id: "1", at, actor: ACTOR.you, type: "prompt", text: "Hello" },
      { id: "2", at, actor: ACTOR.agent, type: "text", text: "Reply" },
    ];
    const html = pane(entries);
    expect(html).toContain('data-agent-bubbles="on"');
    expect(html).toContain('data-actor-labels="on"');
    expect(html).toContain("chat-msg-mine");
    expect(html).toContain("chat-msg-who");
    const hidden = pane(entries, chatVisibilityFromAppearance({ chat_show_actor_labels: false, chat_show_agent_bubbles: false }));
    expect(hidden).toContain('data-agent-bubbles="off"');
    expect(hidden).toContain('data-actor-labels="off"');
    expect(hidden).not.toContain("chat-msg-who");
  });

  it("shows a sticky activity strip while running", () => {
    const html = pane([{ id: "1", at, actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true }], { ...DEFAULT_CHAT_VISIBILITY, showThinking: true }, "running");
    expect(html).toContain('data-testid="chat-activity"');
    expect(html).toContain("Thinking…");
  });

  it("switches from a static review marker to the activity orb when the agent starts working again", () => {
    const view = render(<ChatPane entries={[]} status="idle" stepActivity="Ready for review" />);
    const strip = view.getByTestId("chat-activity");
    expect(strip.textContent).toBe("Ready for review");
    expect(strip.querySelector(".ind-dot")).toBeTruthy();
    expect(strip.querySelector(".ind-orb")).toBeNull();
    view.rerender(<ChatPane entries={[]} status="running" stepActivity="Ready for review" />);
    expect(strip.textContent).toBe("Working…");
    expect(strip.querySelector(".ind-orb")).toBeTruthy();
  });

  it("hides journal stamps when date and time prefs are off", () => {
    const withStamp = pane([{ id: "1", at, actor: ACTOR.you, type: "prompt", text: "Hello" }]);
    expect(withStamp).toContain("chat-msg-time");
    const hidden = pane([{ id: "1", at, actor: ACTOR.you, type: "prompt", text: "Hello" }], {
      ...DEFAULT_CHAT_VISIBILITY,
      showDate: false,
      showTime: false,
    });
    expect(hidden).not.toContain("chat-msg-time");
  });

  it("applies thread max-width on the pane, not a column wrapper", () => {
    const html = pane([{ id: "1", at, actor: ACTOR.agent, type: "text", text: "hi" }], { ...DEFAULT_CHAT_VISIBILITY, maxWidth: "600" });
    expect(html).toContain("--chat-max-width:600px");
    expect(html).not.toContain("chat-column");
  });
});

describe("ChatPane scroll-back paging", () => {
  const row = (id: string, text: string): ChatEntry => ({ id, at, actor: ACTOR.you, type: "prompt", text });

  // Stable f:<rowId> keys exist so that paging older history in is cheap. If a prepend remounts
  // rows the reader is already looking at, the pane flickers and the scroll anchor has nothing
  // real to measure against.
  it("keeps already-mounted rows mounted when an older page is prepended", () => {
    const { container, rerender } = render(<ChatPane entries={[row("f:b", "second"), row("f:c", "third")]} atStart={false} />);
    const before = container.querySelector('[data-entry-id="f:b"]');
    expect(before).toBeTruthy();

    rerender(<ChatPane entries={[row("f:a", "first"), row("f:b", "second"), row("f:c", "third")]} atStart={false} />);
    const after = container.querySelector('[data-entry-id="f:a"]');
    expect(after).toBeTruthy();
    expect(container.querySelector('[data-entry-id="f:b"]')).toBe(before);
  });

  // jsdom has no layout: a row sits 100px below the one before it, which is all the anchor measures.
  it("keeps the reader's place through a re-render that lands while an older page is still loading", () => {
    const stub = stubScrollSize();
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 100;
    });
    try {
      const asked = vi.fn();
      const old = [row("f:b", "second"), row("f:c", "third")];
      const view = render(<ChatPane entries={old} atStart={false} onLoadOlder={asked} />);
      const list = view.container.querySelector(".chat-list") as HTMLElement;
      list.scrollTop = 100;
      fireEvent.scroll(list);
      expect(asked).toHaveBeenCalledTimes(1);
      stub.writes.length = 0;

      // The rows rebuilt under the reader while the page is on its way: nothing to restore yet.
      view.rerender(<ChatPane entries={[...old]} atStart={false} onLoadOlder={asked} loadingOlder />);
      expect(stub.writes).toEqual([]);

      view.rerender(<ChatPane entries={[row("f:a", "first"), ...old]} atStart={false} onLoadOlder={asked} />);
      expect(stub.writes).toEqual([200]);
    } finally {
      offsetTop.mockRestore();
      stub.restore();
    }
  });

  it("tells the reader when the whole conversation is loaded", () => {
    const html = renderToStaticMarkup(<ChatPane entries={[row("f:a", "first")]} atStart />);
    expect(html).toContain("Start of conversation");
  });

  it("shows that earlier messages are on the way", () => {
    const html = renderToStaticMarkup(<ChatPane entries={[row("f:b", "second")]} atStart={false} loadingOlder />);
    expect(html).toContain("Loading earlier messages");
    expect(html).not.toContain("Start of conversation");
  });

  // A journal shorter than the viewport fires no scroll event, so onScroll alone would strand the
  // reader partway through the conversation with no way to ask for the rest.
  it("asks for more when the pane is not scrollable", () => {
    let asked = 0;
    render(
      <ChatPane
        entries={[row("f:c", "third")]}
        atStart={false}
        onLoadOlder={() => {
          asked += 1;
        }}
      />,
    );
    expect(asked).toBeGreaterThan(0);
  });

  it("stops asking once the start is reached", () => {
    let asked = 0;
    render(
      <ChatPane
        entries={[row("f:a", "first")]}
        atStart
        onLoadOlder={() => {
          asked += 1;
        }}
      />,
    );
    expect(asked).toBe(0);
  });
});

describe("DEL-722 block-local streaming", () => {
  it("keeps thinking expanded across recorded sibling events when expand-thinking overrides auto-collapse", () => {
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../chat/fixtures");
    const visibility = { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, expandThinking: true, autoCollapseThinking: true };
    let state = emptyTranscript();
    const view = render(<ChatPane entries={state.entries} visibility={visibility} />);
    const expanded: boolean[] = [];
    let originalStrip: Element | null = null;

    try {
      for (const event of ["thinking_start", "thinking_end", "text_start", "text_delta", "text_end"]) {
        const frame: unknown = JSON.parse(readFileSync(join(fixtures, `live-${event}.json`), "utf8"));
        state = applyRpcLine(state, frame);
        view.rerender(<ChatPane entries={state.entries} visibility={visibility} />);
        const thinking = state.entries.find((entry) => entry.type === "thinking");
        expect(thinking).toBeTruthy();
        const row = view.container.querySelector(`[data-entry-id="${thinking?.id}"]`);
        expect(row).not.toBeNull();
        const strip = row?.querySelector(".chat-work");
        expect(strip).toBeTruthy();
        if (event === "thinking_start") originalStrip = strip ?? null;
        expect.soft(strip, event).toBe(originalStrip);
        expanded.push(row?.querySelector(".chat-work-line")?.getAttribute("aria-expanded") === "true");
        expect.soft(row?.querySelector(".chat-step-out")?.textContent, event).toBe(thinking?.type === "thinking" ? thinking.text : undefined);
      }

      expect(expanded).toEqual([true, true, true, true, true]);
    } finally {
      view.unmount();
    }
  });

  it("opens the work strip while thinking streams and folds it once the answer starts", () => {
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../chat/fixtures");
    const visibility = { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, expandThinking: false, autoCollapseThinking: true };
    let state = emptyTranscript();
    const view = render(<ChatPane entries={state.entries} visibility={visibility} />);
    const expanded: boolean[] = [];
    let originalStrip: Element | null = null;
    let originalAnswer: Element | null = null;

    try {
      for (const [index, event] of ["thinking_start", "thinking_end", "text_start", "text_delta", "text_end"].entries()) {
        const frame: unknown = JSON.parse(readFileSync(join(fixtures, `live-${event}.json`), "utf8"));
        state = applyRpcLine(state, frame);
        view.rerender(<ChatPane entries={state.entries} visibility={visibility} />);
        const thinking = state.entries.find((entry) => entry.type === "thinking");
        const row = view.container.querySelector(`[data-entry-id="${thinking?.id}"]`);
        const strip = row?.querySelector(".chat-work");
        expect(strip).toBeTruthy();
        if (index === 0) originalStrip = strip ?? null;
        expect.soft(strip, event).toBe(originalStrip);
        expanded.push(row?.querySelector(".chat-work-line")?.getAttribute("aria-expanded") === "true");
        // A folded strip builds no step rows at all.
        if (index === 0) expect.soft(row?.querySelector(".chat-step-out")?.textContent, event).toBe("The user wants me to reply");
        else expect.soft(row?.querySelector(".chat-steps"), event).toBeNull();

        if (index >= 1) {
          const answer = state.entries.find((entry) => entry.type === "text");
          const answerRow = view.container.querySelector(`[data-entry-id="${answer?.id}"]`);
          const message = answerRow?.querySelector(".chat-msg");
          expect(message).toBeTruthy();
          if (index === 1) originalAnswer = message ?? null;
          expect.soft(message, event).toBe(originalAnswer);
          expect.soft(answerRow?.querySelector(".chat-msg-body")?.textContent, event).toContain("323");
        }
      }
      expect(expanded).toEqual([true, false, false, false, false]);
    } finally {
      view.unmount();
    }
  });
});
