import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { ACTOR, type ChatEntry, TYPE_LABEL } from "../chat/types";
import { applyRpcLine, emptyTranscript } from "../chatTranscript";
import { ChatEntryRow } from "./ChatEntryRow";

vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatEntryRow", () => {
  it("approves with the extension request id, not the journal row id", () => {
    const onApprove = vi.fn();
    render(
      <ChatEntryRow
        entry={{
          id: "e9",
          actor: ACTOR.alinery,
          type: "approval",
          requestId: "ui-confirm",
          action: "Allow git push",
          detail: "",
        }}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onApprove).toHaveBeenCalledWith("ui-confirm", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onApprove).toHaveBeenCalledWith("ui-confirm", false);
  });

  it("left-aligns work rails with the icon first and no dash rulers", () => {
    const { container } = render(<ChatEntryRow entry={{ id: "t1", at: Date.now(), actor: ACTOR.agent, type: "thinking", text: "plan", streaming: true }} />);
    expect(container.querySelector(".chat-rail-rule")).toBeNull();
    const line = container.querySelector(".chat-rail-line");
    expect(line).toBeTruthy();
    const children = Array.from(line?.children ?? []);
    expect(children[0]?.classList.contains("chat-rail-icon")).toBe(true);
    expect(children[1]?.classList.contains("chat-rail-copy")).toBe(true);
  });

  it("labels a follow_up row as queued without actor labels", () => {
    expect(TYPE_LABEL.follow_up).toBe("Queued");
    const html = render(<ChatEntryRow entry={{ id: "f1", at: Date.now(), actor: ACTOR.you, type: "follow_up", text: "Continue." }} showActorLabels={false} />).container.innerHTML;
    expect(html).toContain("queued · after this turn");
    expect(html).toContain("Continue.");
  });

  it("does not put the queued kicker on a prompt", () => {
    const html = render(<ChatEntryRow entry={{ id: "p1", at: Date.now(), actor: ACTOR.you, type: "prompt", text: "Continue." }} showActorLabels={false} />).container.innerHTML;
    expect(html).not.toContain("queued · after this turn");
  });

  it("renders image thumbnails and file chips on prompt and follow_up, including empty captions", () => {
    const attachments = [
      { kind: "image" as const, name: "shot.png", mimeType: "image/png", src: "data:image/png;base64,aa" },
      { kind: "file" as const, name: "notes.pdf" },
    ];
    const prompt = {
      id: "p1",
      at: Date.now(),
      actor: ACTOR.you,
      type: "prompt" as const,
      text: "Look",
      attachments,
    };
    const { container: promptNode } = render(<ChatEntryRow entry={prompt as ChatEntry} />);
    const promptImg = promptNode.querySelector(".chat-entry-thumbs img");
    expect(promptImg?.getAttribute("alt")).toBe("shot.png");
    expect(promptImg?.getAttribute("src")).toBe("data:image/png;base64,aa");
    expect(promptNode.querySelector(".chat-entry-chips")?.textContent).toContain("notes.pdf");

    const followUp = {
      id: "f1",
      at: Date.now(),
      actor: ACTOR.you,
      type: "follow_up" as const,
      text: "",
      attachments,
    };
    const { container: followNode } = render(<ChatEntryRow entry={followUp as ChatEntry} showActorLabels={false} />);
    expect(followNode.querySelector(".chat-text-body")).toBeNull();
    expect(followNode.querySelector(".chat-entry-thumbs img")?.getAttribute("alt")).toBe("shot.png");
    expect(followNode.querySelector(".chat-entry-chips")?.textContent).toContain("notes.pdf");
    expect(followNode.textContent).toContain("queued · after this turn");
  });

  it("copies prompt and assistant message bodies from the bubble action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    const attachments = [
      { kind: "image" as const, name: "shot.png", mimeType: "image/png", src: "data:image/png;base64,aa" },
      { kind: "file" as const, name: "notes.pdf" },
    ];
    render(<ChatEntryRow entry={{ id: "p1", at: Date.now(), actor: ACTOR.you, type: "prompt", text: "Look\nhere", attachments }} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Look\nhere\nAttached image: shot.png\nAttached file: notes.pdf"));
    expect(screen.getByRole("button", { name: "Copied message" })).toBeTruthy();

    cleanup();
    writeText.mockClear();
    render(<ChatEntryRow entry={{ id: "a1", at: Date.now(), actor: ACTOR.agent, type: "text", text: "Done." }} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Done."));
    const copyButton = screen.getByRole("button", { name: "Copied message" });
    const body = copyButton.closest(".chat-msg-body");
    expect(body).toBeTruthy();
    expect(copyButton.closest(".chat-msg-copy-row")).toBeTruthy();
    expect(body?.textContent).toBe("Done.");
  });
});

describe("ChatEntryRow markdown + copy", () => {
  it("renders finished agent text as markdown", () => {
    const html = render(<ChatEntryRow entry={{ id: "t1", at: Date.now(), actor: ACTOR.agent, type: "text", text: "## Heading\n\n- item **bold**" }} />).container.innerHTML;
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("streaming agent text stays plain and has no copy button", () => {
    const { container } = render(<ChatEntryRow entry={{ id: "t2", at: Date.now(), actor: ACTOR.agent, type: "text", text: "partial **chunk", streaming: true }} />);
    expect(container.querySelector(".chat-text-body")).toBeTruthy();
    expect(container.querySelector("button[title='Copy message']")).toBeNull();
  });

  it("copies the raw message text from the copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = render(<ChatEntryRow entry={{ id: "t3", at: Date.now(), actor: ACTOR.agent, type: "text", text: "## Heading" }} />);
    const copyButton = container.querySelector("button[title='Copy message']");
    expect(copyButton).toBeTruthy();
    fireEvent.click(copyButton as HTMLButtonElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("## Heading"));
  });

  it("hides copy buttons when disabled", () => {
    const { container } = render(<ChatEntryRow entry={{ id: "t4", at: Date.now(), actor: ACTOR.agent, type: "text", text: "Copy me" }} showCopyButton={false} />);
    expect(container.querySelector("button[title='Copy message']")).toBeNull();
    expect(container.querySelector(".chat-msg-body")?.textContent).toBe("Copy me");
  });
});

describe("DEL-722 block-local streaming", () => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../chat/fixtures");
  const rows = (entries: ChatEntry[]) => (
    <ol>
      {entries.map((entry) => (
        <li key={entry.id} data-entry-id={entry.id}>
          <ChatEntryRow entry={entry} defaultExpanded={false} autoCollapseThinking />
        </li>
      ))}
    </ol>
  );

  it("keeps completed thinking collapsed while the recorded answer streams in the same mounted list", () => {
    let state = emptyTranscript();
    const view = render(rows(state.entries));
    const events = ["thinking_start", "thinking_end", "text_start", "text_delta", "text_end"];
    const expanded: boolean[] = [];
    let originalRail: Element | null = null;

    for (const [index, event] of events.entries()) {
      const frame: unknown = JSON.parse(readFileSync(join(fixtures, `live-${event}.json`), "utf8"));
      state = applyRpcLine(state, frame);
      view.rerender(rows(state.entries));
      const thinking = state.entries.find((entry) => entry.type === "thinking");
      expect(thinking).toBeTruthy();
      const row = view.container.querySelector<HTMLElement>(`[data-entry-id="${thinking?.id}"]`);
      expect(row).not.toBeNull();
      const rail = row?.querySelector(".chat-rail");
      expect(rail).toBeTruthy();
      if (index === 0) originalRail = rail ?? null;
      expect.soft(rail, event).toBe(originalRail);
      expanded.push(row?.querySelector(".chat-rail-line")?.getAttribute("aria-expanded") === "true");
      if (index === 0) {
        expect.soft(row?.querySelector(".chat-work-pre")?.textContent, event).toBe("The user wants me to reply");
      } else {
        expect.soft(row?.querySelector(".chat-work-pre"), event).toBeNull();
        expect.soft(row?.querySelector(".chat-rail-panel")?.textContent, event).toBe("");
      }

      if (index >= 1) {
        const answer = state.entries.find((entry) => entry.type === "text");
        expect(answer).toBeTruthy();
        const answerRow = view.container.querySelector<HTMLElement>(`[data-entry-id="${answer?.id}"]`);
        assert(answerRow, "Missing answer row");
        expect.soft(answerRow?.querySelector(".chat-msg-body")?.textContent, event).toContain("323");
        const live = event === "text_start" || event === "text_delta";
        expect.soft(Boolean(answerRow?.querySelector(".chat-caret")), event).toBe(live);
        if (live) {
          expect.soft(answerRow?.querySelector(".chat-text-body")?.textContent, event).toBe("323");
          expect.soft(within(answerRow).queryByRole("button", { name: "Copy message" }), event).toBeNull();
        }
      }
    }

    expect(expanded).toEqual([true, false, false, false, false]);
    view.unmount();
  });

  it("preserves an earlier text row's Markdown and copy controls while a second indexed text block streams", () => {
    const events = [
      { type: "text_start", contentIndex: 0, texts: ["## Finished"] },
      { type: "text_end", contentIndex: 0, texts: ["## Finished"] },
      { type: "text_start", contentIndex: 1, texts: ["## Finished", "## Later"] },
      { type: "text_delta", contentIndex: 1, texts: ["## Finished", "## Later answer"], delta: " answer" },
      { type: "text_end", contentIndex: 1, texts: ["## Finished", "## Later answer"] },
    ];
    let state = emptyTranscript();
    const view = render(rows(state.entries));
    let firstMessage: Element | null = null;
    let secondMessage: Element | null = null;

    for (const [index, event] of events.entries()) {
      state = applyRpcLine(state, {
        type: "message_update",
        assistantMessageEvent: { type: event.type, contentIndex: event.contentIndex, delta: event.delta },
        message: { role: "assistant", content: event.texts.map((text) => ({ type: "text", text })), stopReason: "stop" },
      });
      view.rerender(rows(state.entries));
      const texts = state.entries.filter((entry) => entry.type === "text");
      const first = view.container.querySelector<HTMLElement>(`[data-entry-id="${texts[0]?.id}"]`);
      assert(first, "Missing first text row");
      const message = first?.querySelector(".chat-msg");
      expect(message).toBeTruthy();
      if (index === 0) firstMessage = message ?? null;
      expect.soft(message, event.type).toBe(firstMessage);
      if (index >= 1) {
        expect.soft(within(first).queryByRole("heading", { level: 2, name: "Finished" }), event.type).not.toBeNull();
        expect.soft(within(first).queryByRole("button", { name: "Copy message" }), event.type).not.toBeNull();
        expect.soft(first?.querySelector(".chat-caret"), event.type).toBeNull();
        expect.soft(first?.querySelector(".chat-text-body"), event.type).toBeNull();
      }

      if (index >= 2) {
        const second = view.container.querySelector<HTMLElement>(`[data-entry-id="${texts[1]?.id}"]`);
        assert(second, "Missing second text row");
        const siblingMessage = second?.querySelector(".chat-msg");
        expect(siblingMessage).toBeTruthy();
        if (index === 2) secondMessage = siblingMessage ?? null;
        expect.soft(siblingMessage, event.type).toBe(secondMessage);
        if (event.type !== "text_end") {
          expect.soft(second?.querySelector(".chat-text-body")?.textContent, event.type).toBe(event.texts[1]);
          expect.soft(second?.querySelector(".chat-caret"), event.type).not.toBeNull();
          expect.soft(within(second).queryByRole("heading"), event.type).toBeNull();
          expect.soft(within(second).queryByRole("button", { name: "Copy message" }), event.type).toBeNull();
        } else {
          expect.soft(within(second).queryByRole("heading", { level: 2, name: "Later answer" }), event.type).not.toBeNull();
          expect.soft(within(second).queryByRole("button", { name: "Copy message" }), event.type).not.toBeNull();
          expect.soft(second?.querySelector(".chat-caret"), event.type).toBeNull();
          expect.soft(second?.querySelector(".chat-text-body"), event.type).toBeNull();
        }
      }
    }

    view.unmount();
  });
});
