import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybookLibraryLink } from "./PlaybookLibraryLink";
import { Toast } from "./toast";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ openUrl }));

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("PlaybookLibraryLink", () => {
  it("opens the public library through the desktop browser opener", () => {
    render(<PlaybookLibraryLink />);
    const link = screen.getByRole("link", { name: "Browse the Playbook Library" });
    expect(link.getAttribute("href")).toBe("https://alinery.ai/playbooks");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://alinery.ai/playbooks");
  });

  it("keeps link interactions from triggering enclosing task actions", () => {
    const parentAction = vi.fn();
    render(
      <div role="button" tabIndex={0} onClick={parentAction} onKeyDown={parentAction}>
        <PlaybookLibraryLink />
      </div>,
    );
    const link = screen.getByRole("link", { name: "Browse the Playbook Library" });
    for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true }]) {
      const keyDown = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...modifiers });
      fireEvent(link, keyDown);
      expect(keyDown.defaultPrevented).toBe(false);
    }
    fireEvent.click(link);
    expect(parentAction).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledOnce();
  });

  it("reports browser opener failures", async () => {
    openUrl.mockRejectedValue(new Error("browser could not open"));
    render(
      <>
        <Toast />
        <PlaybookLibraryLink />
      </>,
    );
    await act(async () => fireEvent.click(screen.getByRole("link", { name: "Browse the Playbook Library" })));
    expect(screen.getByText(/browser could not open/)).toBeTruthy();
  });
});
