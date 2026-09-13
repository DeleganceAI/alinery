import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, chatComposerLineCap } from "./ChatComposer";
import type { ChatCommand } from "./chat/types";

afterEach(cleanup);

const catalog: ChatCommand[] = [
  { name: "model", description: "Switch model", source: "builtin" },
  { name: "compact", description: "Compact context", source: "builtin", input: { hint: "[soft|remote]" } },
  { name: "thinking", description: "Set thinking level", source: "builtin" },
];

describe("ChatComposer", () => {
  it("caps grow at eight 20px lines", () => {
    expect(chatComposerLineCap()).toEqual({ line: 20, max: 160 });
  });

  it("uses Enter to send and Shift+Enter for a newline", () => {
    const onSend = vi.fn();
    render(<ChatComposer body="hello" status="idle" catalog={catalog} onBodyChange={vi.fn()} onSend={onSend} onAbort={vi.fn()} />);
    const field = screen.getByLabelText("Message or /command");
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("shows draft chars in the hints row", () => {
    const html = renderToStaticMarkup(<ChatComposer body="hello" status="idle" catalog={[]} onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} />);
    expect(html).toContain("5 chars");
    expect(html).not.toContain("5 chars ·");
    expect(html).toContain("send");
    expect(html).not.toContain("data-chars");
  });

  it("keeps the char count when key hints are hidden", () => {
    const html = renderToStaticMarkup(
      <ChatComposer body="hello" status="idle" catalog={[]} showHints={false} onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} />,
    );
    expect(html).toContain("5 chars");
    expect(html).not.toContain("5 chars ·");
    expect(html).not.toContain(">send<");
    expect(html).not.toContain(">commands<");
  });

  it("opens the catalog on slash and fills on Tab", () => {
    const onBodyChange = vi.fn();
    render(<ChatComposer body="/mod" status="idle" catalog={catalog} onBodyChange={onBodyChange} onSend={vi.fn()} onAbort={vi.fn()} />);
    expect(screen.getByRole("listbox", { name: "Available commands" }).textContent).toContain("/model");
    expect(screen.getByRole("listbox").textContent).not.toContain("/login");
    fireEvent.keyDown(screen.getByLabelText("Message or /command"), { key: "Tab" });
    expect(onBodyChange).toHaveBeenCalledWith("/model");
  });

  it("disables send while waiting on approval", () => {
    const html = renderToStaticMarkup(
      <ChatComposer body="ok" status="waiting_approval" catalog={[]} onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} />,
    );
    expect(html).toContain("Waiting on approval");
    expect(html).toContain("disabled");
  });

  it("aborts on Escape while running", () => {
    const onAbort = vi.fn();
    render(<ChatComposer body="" status="running" catalog={[]} onBodyChange={vi.fn()} onSend={vi.fn()} onAbort={onAbort} />);
    fireEvent.keyDown(screen.getByLabelText("Send after this turn…"), { key: "Escape" });
    expect(onAbort).toHaveBeenCalled();
  });

  it("keeps a large draft sendable and clearable once the text area is hidden", () => {
    const onSend = vi.fn();
    const onBodyChange = vi.fn();
    const large = "a".repeat(256 * 1024 + 1);
    render(<ChatComposer body={large} status="idle" catalog={[]} onBodyChange={onBodyChange} onSend={onSend} onAbort={vi.fn()} />);

    expect(screen.queryByLabelText("Message or /command")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith(large);
    fireEvent.click(screen.getByRole("button", { name: "Clear large draft" }));
    expect(onBodyChange).toHaveBeenCalledWith("");
  });

  it("blocks send past the 4 MiB limit but still clears", () => {
    const onSend = vi.fn();
    const onBodyChange = vi.fn();
    render(<ChatComposer body={"a".repeat(4 * 1024 * 1024 + 1)} status="idle" catalog={[]} onBodyChange={onBodyChange} onSend={onSend} onAbort={vi.fn()} />);

    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear large draft" }));
    expect(onBodyChange).toHaveBeenCalledWith("");
  });

  it("labels running send as Queue, not Steer", () => {
    const html = renderToStaticMarkup(
      <ChatComposer body="later" status="running" catalog={[]} onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} />,
    );
    expect(html).toContain('data-mode="queue"');
    expect(html).toContain("Send after this turn…");
    expect(html).toContain('aria-label="Queue"');
    expect(html).not.toContain("Steer");
  });

  it("keeps send enabled and shows the approval copy while running with a notice", () => {
    const extras = {
      approvalNotice: { action: "Allow git push", detail: "Publishes" },
      canAbort: false,
      sendNowEnabled: false,
    };
    const html = renderToStaticMarkup(
      <ChatComposer body="ok" status="running" catalog={[]} onBodyChange={() => undefined} onSend={() => undefined} onAbort={() => undefined} {...extras} />,
    );
    expect(html).toContain("Allow git push");
    expect(html).toContain("Publishes");
    expect(html).not.toContain("Waiting on approval");
    expect(html).not.toContain("Send now");
  });

  it("fires onSendNow from Send now, not onSend", () => {
    const onSend = vi.fn();
    const onSendNow = vi.fn();
    const extras = { onSendNow, sendNowEnabled: true };
    render(<ChatComposer body="now" status="running" catalog={[]} onBodyChange={vi.fn()} onSend={onSend} onAbort={vi.fn()} {...extras} />);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(onSendNow).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows Queue and Send now on a large running draft", () => {
    const extras = { onSendNow: () => undefined, sendNowEnabled: true };
    render(<ChatComposer body={"a".repeat(256 * 1024 + 1)} status="running" catalog={[]} onBodyChange={vi.fn()} onSend={vi.fn()} onAbort={vi.fn()} {...extras} />);
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
  });
});
