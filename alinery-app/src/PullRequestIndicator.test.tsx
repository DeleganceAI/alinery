import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestIndicator } from "./PullRequestIndicator";
import { Toast } from "./toast";
import type { PullRequestSnapshot } from "./types";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ openUrl }));
const snapshot = { pr: { number: 42, url: "https://github.com/acme/app/pull/42", state: "open" }, error: null } satisfies PullRequestSnapshot;

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("PullRequestIndicator", () => {
  it("opens the discovered PR without activating its enclosing card for clicks, Enter, or Space", () => {
    const navigate = vi.fn();
    render(
      <div role="button" tabIndex={0} onClick={navigate} onKeyDown={navigate} onKeyUp={navigate}>
        <PullRequestIndicator snapshot={snapshot} compact />
      </div>,
    );
    const link = screen.getByRole("link", { name: /PR #42.*Open/i });
    expect(link.getAttribute("href")).toBe(snapshot.pr?.url);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);
    for (const key of ["Enter", " "]) {
      const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      fireEvent(link, down);
      expect(down.defaultPrevented).toBe(true);
      fireEvent.keyDown(link, { key, repeat: true });
      fireEvent.keyUp(link, { key });
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(openUrl.mock.calls).toEqual([[snapshot.pr?.url], [snapshot.pr?.url], [snapshot.pr?.url]]);
  });

  it("keeps a stale known PR clickable and exposes its unavailable freshness", () => {
    render(<PullRequestIndicator snapshot={{ ...snapshot, error: "offline" }} />);
    const link = screen.getByRole("link", { name: /PR #42.*stale.*offline/i });
    expect(link.textContent).toMatch(/PR #42.*Open.*stale/i);
    fireEvent.click(link);
    expect(openUrl).toHaveBeenCalledWith(snapshot.pr?.url);
  });

  it("distinguishes unavailable discovery from loading and successful absence without inventing a link", () => {
    const { container, rerender } = render(<PullRequestIndicator />);
    expect(container.textContent).toBe("");
    rerender(<PullRequestIndicator snapshot={{ pr: null, error: null }} />);
    expect(container.textContent).toBe("");
    rerender(<PullRequestIndicator snapshot={{ pr: null, error: "GitHub authentication required" }} compact />);
    expect(screen.getByRole("img", { name: /unavailable.*authentication/i })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows updated PR states in detail text and compact accessible labels", () => {
    const { rerender } = render(<PullRequestIndicator snapshot={snapshot} />);
    expect(screen.getByRole("link").textContent).toMatch(/PR #42.*Open/);
    rerender(<PullRequestIndicator snapshot={{ pr: { ...snapshot.pr, state: "merged" }, error: null }} />);
    expect(screen.getByRole("link").textContent).toMatch(/PR #42.*Merged/);
    rerender(<PullRequestIndicator snapshot={{ pr: { ...snapshot.pr, state: "closed" }, error: null }} compact />);
    expect(screen.getByRole("link", { name: /PR #42.*Closed/ })).toBeTruthy();
  });

  it("reports browser opener failures through the existing toast surface", async () => {
    openUrl.mockRejectedValue(new Error("browser could not open"));
    render(
      <>
        <Toast />
        <PullRequestIndicator snapshot={snapshot} />
      </>,
    );
    await act(async () => fireEvent.click(screen.getByRole("link", { name: /PR #42/ })));
    expect(screen.getByText(/browser could not open/)).toBeTruthy();
  });
});
