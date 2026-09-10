import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalSearch, type SearchItem } from "./CommandPalette";

vi.mock("./WindowChrome", () => ({ WindowControls: () => null }));
vi.mock("./ipc");

afterEach(cleanup);

const item = (overrides: Partial<SearchItem>): SearchItem => ({
  id: "action:settings",
  kind: "action",
  title: "Open Settings",
  detail: "",
  searchText: "settings",
  run: vi.fn(),
  ...overrides,
});

describe("GlobalSearch", () => {
  it("is labeled as search, focuses the combobox, and opens entity results with Enter", () => {
    const run = vi.fn();
    render(
      <GlobalSearch
        open
        loading={false}
        error=""
        onClose={vi.fn()}
        items={[item({}), item({ id: "task:search", kind: "task", title: "Build unified search", detail: "alinery · feature/search", searchText: "task", run })]}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Search" })).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "unified" } });
    expect(screen.getByRole("option").textContent).toContain("Build unified search");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("wraps arrow navigation, exposes the active option, and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <GlobalSearch
        open
        loading={false}
        error=""
        onClose={onClose}
        items={[item({ id: "task:one", kind: "task", title: "One", searchText: "match" }), item({ id: "session:two", kind: "session", title: "Two", searchText: "match" })]}
      />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "match" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe("search-result-1");
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus to the trigger after Escape closes search", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Search
          </button>
          <GlobalSearch open={open} loading={false} error="" items={[item({})]} onClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Search" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  });
});
