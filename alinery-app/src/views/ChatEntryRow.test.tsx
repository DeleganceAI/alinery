import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ACTOR } from "../chat/types";
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
});
