import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ACTOR, type ChatEntry, subagent } from "../chat/types";
import { chatVisibilityFromAppearance, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import { ChatPane } from "./ChatPane";

const at = Date.parse("2026-09-05T12:11:00Z");

function pane(entries: ChatEntry[], visibility = DEFAULT_CHAT_VISIBILITY, status: "idle" | "running" | "waiting_approval" = "idle") {
  return renderToStaticMarkup(<ChatPane entries={entries} visibility={visibility} status={status} />);
}

describe("ChatPane", () => {
  it("updates block copy controls on existing replies without hiding whole-message copying", () => {
    const entries: ChatEntry[] = [{ id: "copy", at, actor: ACTOR.agent, type: "text", text: "```sh\nsudo ls\n```\n\n> Quoted advice" }];
    const view = render(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({})} />);
    expect(view.getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Copy quote" })).toBeTruthy();

    view.rerender(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({ chat_show_block_copy_buttons: false })} />);
    expect(view.queryByRole("button", { name: "Copy code block" })).toBeNull();
    expect(view.queryByRole("button", { name: "Copy quote" })).toBeNull();
    expect(view.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(view.getByText("sudo ls")).toBeTruthy();
    expect(view.getByText("Quoted advice")).toBeTruthy();

    view.rerender(<ChatPane entries={entries} visibility={chatVisibilityFromAppearance({ chat_show_block_copy_buttons: true })} />);
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

  it("renders journal row kinds from the Chat mockup", () => {
    const html = pane(
      [
        { id: "p", at, actor: ACTOR.you, type: "prompt", text: "Map ChatPane" },
        { id: "f", at, actor: ACTOR.you, type: "follow_up", text: "Continue." },
        { id: "h", at, actor: ACTOR.omp, type: "harness", event: "todo", text: "Composer grow + cap" },
        { id: "t", at, actor: ACTOR.omp, type: "turn_marker", turn: 3, phase: "end", stopReason: "complete" },
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
    expect(html).toContain("redacted");
    expect(html).toContain("git push origin chat-pane");
    expect(html).toContain("Allow");
    expect(html).toContain("subagents · 1 running");
    expect(html).toContain("Drafting composer grow rules");
    expect(html).not.toContain("/compact");
  });

  it("hides harness, turn markers, subagent rows, and the drawer by prefs", () => {
    const entries: ChatEntry[] = [
      { id: "h", at, actor: ACTOR.omp, type: "harness", event: "todo", text: "hidden harness" },
      { id: "t", at, actor: ACTOR.omp, type: "turn_marker", turn: 1, phase: "end" },
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
  });

  it("defaults agent replies to labelled bubbles and keeps user prompts bubbled", () => {
    const html = pane(
      [
        { id: "1", at, actor: ACTOR.you, type: "prompt", text: "Hello" },
        { id: "2", at, actor: ACTOR.agent, type: "text", text: "Reply" },
        { id: "3", at, actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true },
      ],
      { ...DEFAULT_CHAT_VISIBILITY, showThinking: true, showDate: true, showTime: true },
    );
    expect(html).toContain('data-agent-bubbles="on"');
    expect(html).toContain('data-actor-labels="on"');
    expect(html).toContain('data-density="normal"');
    expect(html).toContain("chat-msg-mine");
    expect(html).toContain("chat-msg-reply");
    expect(html).toContain("chat-rail");
    expect(html).toContain("chat-msg-who");
  });

  it("shows a sticky activity strip while running", () => {
    const html = pane([{ id: "1", at, actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true }], { ...DEFAULT_CHAT_VISIBILITY, showThinking: true }, "running");
    expect(html).toContain('data-testid="chat-activity"');
    expect(html).toContain("Thinking…");
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
