import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACTOR, type ChatEntry, TYPE_LABEL } from "../chat/types";
import { ChatEntryRow } from "./ChatEntryRow";

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
});
