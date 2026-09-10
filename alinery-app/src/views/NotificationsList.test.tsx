import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionNoticeRow } from "../sessionAttention";
import { mockIpc } from "../test/mockIpc";
import { navReady, requireNav } from "../test/nav";
import type { BoardNav, SessionListItem } from "../types";
import { NotificationsList } from "./NotificationsList";

const mocks = vi.hoisted(() => ({
  listSessionItems: vi.fn(),
  sessionListStatuses: vi.fn(),
}));
vi.mock("../ipc", () => mockIpc(mocks));

const item = (id: string, over: Partial<SessionListItem> = {}): SessionListItem => ({
  id,
  worktree: "/repos/a/.alinery/worktrees/task",
  created: 10,
  archived: false,
  phase: "design",
  harness: "omp",
  model: "",
  playbook: "superdevelop",
  generic: false,
  harness_resume_token: "",
  semantic: {},
  task_slug: "task",
  task_name: "Task",
  task_worktree: "/repos/a/.alinery/worktrees/task",
  repo_path: "/repos/a",
  playbook_title: "SuperDevelop",
  step_title: "Design",
  is_playbook_step: true,
  ...over,
});

const row = (id: string, notice: SessionNoticeRow["notice"] = "waiting_for_input", over: Partial<SessionListItem> = {}): SessionNoticeRow => ({
  item: item(id, over),
  notice,
});

function renderList(
  over: Partial<{
    allRepos: boolean;
    activeRepo: string;
    rows: SessionNoticeRow[];
    loaded: boolean;
    error: { source: "load" | "clear"; detail: string } | null;
    busy: boolean;
    onClear: () => void;
    onClearAll: () => void;
    onOpen: (value: SessionListItem) => void;
    registerNav: (nav: BoardNav | null) => void;
  }> = {},
) {
  return render(
    <NotificationsList
      allRepos={false}
      activeRepo="/repos/a"
      rows={[]}
      loaded
      error={null}
      busy={false}
      onClear={() => {}}
      onClearAll={() => {}}
      onOpen={() => {}}
      registerNav={() => {}}
      {...over}
    />,
  );
}

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".notification-row .notification-identity .mono")].map((node) => node.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("NotificationsList", () => {
  it("renders shared rows in their supplied order without polling", async () => {
    vi.useFakeTimers();
    const rows = [row("approval", "waiting_for_approval"), row("input"), row("completion", "unread_completion"), row("failure", "failure")];
    const { container } = renderList({ rows });
    expect(rowIds(container)).toEqual(["approval", "input", "completion", "failure"]);
    expect(screen.getByText("Needs approval")).toBeDefined();
    expect(screen.getByText("Needs input")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mocks.listSessionItems).not.toHaveBeenCalled();
    expect(mocks.sessionListStatuses).not.toHaveBeenCalled();
  });

  it("filters only presentation scope and keeps repository-qualified rows", () => {
    const rows = [row("same", "waiting_for_input", { repo_path: "/repos/a" }), row("same", "waiting_for_approval", { repo_path: "/repos/b" })];
    const { container, rerender } = renderList({ rows });
    expect(rowIds(container)).toEqual(["same"]);
    expect(screen.queryByText("b")).toBeNull();

    rerender(
      <NotificationsList
        allRepos
        activeRepo="/repos/a"
        rows={rows}
        loaded
        error={null}
        busy={false}
        onClear={() => {}}
        onClearAll={() => {}}
        onOpen={() => {}}
        registerNav={() => {}}
      />,
    );
    expect(rowIds(container)).toEqual(["same", "same"]);
    expect(screen.getByText("a")).toBeDefined();
    expect(screen.getByText("b")).toBeDefined();
  });

  it("opens exact rows and repairs repository-qualified keyboard selection", async () => {
    const first = row("first", "waiting_for_input", { created: 20 });
    const second = row("second", "waiting_for_input", { created: 10 });
    const onOpen = vi.fn();
    let nav: BoardNav | null = null;
    const { container, rerender } = renderList({
      rows: [first, second],
      onOpen,
      registerNav: (next) => {
        nav = next;
      },
    });
    const secondButton = screen.getByText("second").closest("button");
    if (!secondButton) throw new Error("notification row must be a button");
    fireEvent.click(secondButton);
    expect(onOpen).toHaveBeenLastCalledWith(second.item);
    await navReady(() => nav);
    act(() => requireNav(nav).moveRow(1));
    act(() => requireNav(nav).openSelected());
    expect(onOpen).toHaveBeenLastCalledWith(second.item);

    rerender(
      <NotificationsList
        allRepos={false}
        activeRepo="/repos/a"
        rows={[second]}
        loaded
        error={null}
        busy={false}
        onClear={() => {}}
        onClearAll={() => {}}
        onOpen={onOpen}
        registerNav={(next) => {
          nav = next;
        }}
      />,
    );
    expect(container.querySelector(".notification-row.sel .mono")?.textContent).toBe("second");
  });

  it("calls global clear handlers and disables both controls when unavailable", () => {
    const onClear = vi.fn();
    const onClearAll = vi.fn();
    const { rerender } = renderList({ rows: [row("a"), row("b", "failure", { repo_path: "/repos/b" })], onClear, onClearAll });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onClearAll).toHaveBeenCalledOnce();
    expect(screen.getByText("1 notice")).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear" }).closest(".notification-actions")).not.toBeNull();

    rerender(
      <NotificationsList
        allRepos={false}
        activeRepo="/repos/a"
        rows={[]}
        loaded
        error={null}
        busy
        onClear={onClear}
        onClearAll={onClearAll}
        onOpen={() => {}}
        registerNav={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Clear" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Clear all" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the load-error contract", () => {
    renderList({ error: { source: "load", detail: "load failed" } });
    expect(screen.getByText("Could not load notifications.")).toBeDefined();
    expect(screen.getByText("load failed")).toBeDefined();
  });

  it("renders the clear-error contract without hiding current rows", () => {
    const { container } = renderList({
      rows: [row("still-visible")],
      error: { source: "clear", detail: "clear failed" },
    });
    expect(screen.getByText("Could not clear notifications.")).toBeDefined();
    expect(screen.getByText("clear failed")).toBeDefined();
    expect(rowIds(container)).toEqual(["still-visible"]);
  });
});
