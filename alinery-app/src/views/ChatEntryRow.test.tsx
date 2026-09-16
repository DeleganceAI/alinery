import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTOR, type ChatEntry, TYPE_LABEL } from "../chat/types";
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
});
