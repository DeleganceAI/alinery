// App is imported inside each case after the shared board stub is initialized;
// static import would execute the hoisted mock factory before that stub exists.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "./appearance";
import { mockIpc } from "./test/mockIpc";
import type { AppConfig, BoardTask, CreateTaskResult, Task } from "./types";

const appConfig: AppConfig = {
  active_repo: "/repo-a",
  known_repos: ["/repo-a", "/repo-b"],
  mcp_enabled: true,
  appearance: DEFAULT_APPEARANCE,
};

const sourceTask: Task = {
  name: "Source",
  slug: "source",
  requested_slug: "source",
  branch: "source",
  worktree: "/repo-b/.alinery/worktrees/source",
  has_worktree: true,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "superdevelop",
  engine_version: 2,
  playbook_ref: { scope: "bundled", key: "superdevelop" },
  auto_advance: [],
  draft: false,
};

const sourceBoardTask: BoardTask = {
  ...sourceTask,
  repo_path: "/repo-b",
  session_count: 1,
  playbook_title: "SuperDevelop",
  updated: 1,
  current_phase: "design",
  current_step_title: "Design",
  latest_session_title: "Design",
  latest_session_column_key: "research-design",
  current_column_key: "research-design",
  current_column_title: "Research & Design",
};

const duplicateResult = (slug = "source-2", harness = "claude"): CreateTaskResult => ({
  task: { ...sourceTask, slug, branch: slug, worktree: `/repo-b/.alinery/worktrees/${slug}` },
  sessions: [{
    id: `s-${slug}`,
    worktree: `/repo-b/.alinery/worktrees/${slug}`,
    created: 2,
    archived: false,
    phase: "implement",
    harness,
    model: "model-a",
    playbook: "superdevelop",
    generic: false,
    artifact: "",
    handoff_artifact: "",
    prompt_extra: "",
    prompt: null,
    started_at: null,
    ended_at: null,
    exit_code: null,
    harness_resume_token: "",
  }],
  executions: [],
  creation: "ready",
  start: "started",
  errors: [],
  attachment_errors: [],
});

const mocks = vi.hoisted(() => ({
  duplicateTaskForRepo: vi.fn(),
  startSession: vi.fn(),
  setActiveRepo: vi.fn(),
  readAppConfig: vi.fn(),
  toast: vi.fn(),
  onCloseRequested: vi.fn(async () => () => {}),
}));

vi.mock("./ipc", () =>
  mockIpc({
    getVersion: async () => "0.9.10",
    getName: async () => "Alinery Test",
    readAppConfig: mocks.readAppConfig,
    listBoardTasks: async () => [],
    listKanbanColumns: async () => [],
    duplicateTaskForRepo: mocks.duplicateTaskForRepo,
    startSession: mocks.startSession,
    setActiveRepo: mocks.setActiveRepo,
    getCurrentWindow: (() => ({ onCloseRequested: mocks.onCloseRequested, destroy: vi.fn() })) as never,
  }),
);
vi.mock("./toast", () => ({ Toast: () => null, toast: mocks.toast }));
vi.mock("./BackgroundFX", () => ({ BackgroundFX: () => null }));
vi.mock("./Boot", () => ({ Boot: () => null }));
vi.mock("./HotkeyBar", () => ({ HotkeyBar: () => null }));
vi.mock("./DaemonConflictBanner", () => ({ DaemonConflictBanner: () => null, RepoBusyBanner: () => null, HostGuardWarning: () => null }));
vi.mock("./WindowChrome", () => ({ ResizeHandles: () => null, WindowControls: () => null, useWindowFullscreen: () => false }));
vi.mock("./useDaemonStatus", () => ({ useDaemonStatus: () => ({ repo_busy: false, conflict: null }) }));
vi.mock("./useMcpStatus", () => ({ useMcpStatus: () => ({}) }));
// Both board views are stubbed the same way: the duplicate coordinator is what is under test
// here, and it does not care which board raised the request. Grid is the default board, so it is
// the one these tests actually mount; Kanban stays stubbed for the show_original_kanban route.
const boardStub = ({ onDuplicate }: { onDuplicate: (task: BoardTask) => void }) => (
  <button type="button" onClick={() => onDuplicate(sourceBoardTask)}>
    duplicate-source
  </button>
);
vi.mock("./views/Kanban", () => ({ Kanban: boardStub }));
vi.mock("./views/Grid", () => ({ Grid: boardStub }));
vi.mock("./views/TaskDetail", () => ({
  TaskDetail: ({ slug, onDuplicate }: { slug: string; onDuplicate: (task: Task) => void }) => (
    <div>
      <span>{`task:${slug}`}</span>
      <button type="button" onClick={() => onDuplicate({ ...sourceTask, slug })}>
        duplicate-current
      </button>
    </div>
  ),
}));

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  },
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.duplicateTaskForRepo.mockReset();
  mocks.startSession.mockReset();
  mocks.readAppConfig.mockReset().mockResolvedValue(appConfig);
  mocks.setActiveRepo.mockReset().mockImplementation(async (path: string) => ({ ...appConfig, active_repo: path }));
  mocks.toast.mockReset();
  mocks.onCloseRequested.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App duplicate coordinator", () => {
  it("serializes the active request and resets after success", async () => {
    let resolveDuplicate: (result: CreateTaskResult) => void = () => {};
    mocks.duplicateTaskForRepo.mockReturnValue(
      new Promise<CreateTaskResult>((resolve) => {
        resolveDuplicate = resolve;
      }),
    );
    const { default: App } = await import("./App");
    render(<App />);
    const trigger = await screen.findByText("duplicate-source");

    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(mocks.duplicateTaskForRepo).toHaveBeenCalledTimes(1);
    expect(mocks.duplicateTaskForRepo).toHaveBeenCalledWith("/repo-b", "source");

    resolveDuplicate(duplicateResult());
    await screen.findByText("task:source-2");
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult("source-3"));
    fireEvent.click(screen.getByText("duplicate-current"));
    await waitFor(() => expect(mocks.duplicateTaskForRepo).toHaveBeenCalledTimes(2));
  });

  it("keeps the current view and reports a backend failure", async () => {
    mocks.duplicateTaskForRepo.mockRejectedValue(new Error("copy failed"));
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("copy failed")));
    expect(screen.getByText("duplicate-source")).toBeDefined();
    expect(mocks.setActiveRepo).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult());
    fireEvent.click(screen.getByText("duplicate-source"));
    await screen.findByText("task:source-2");
    expect(mocks.duplicateTaskForRepo).toHaveBeenCalledTimes(2);
  });

  it("opens the persisted clone and reports backend launch failure without launching again", async () => {
    mocks.duplicateTaskForRepo.mockResolvedValue({
      ...duplicateResult(),
      creation: "partial",
      start: "failed",
      errors: [{ stage: "launch", code: "launch_failed", message: "binary missing" }],
    } satisfies CreateTaskResult);
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await screen.findByText("task:source-2");
    expect(mocks.setActiveRepo).toHaveBeenCalledWith("/repo-b", null);
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("binary missing"));
  });

  it("keeps the source available when the backend returns no task", async () => {
    mocks.duplicateTaskForRepo.mockResolvedValue({
      task: null, sessions: [], executions: [], creation: "partial", start: "not_requested",
      errors: [{ stage: "copy", code: "copy_failed", message: "source unavailable" }],
    } satisfies CreateTaskResult);
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("source unavailable"), "error"));
    expect(screen.getByText("duplicate-source")).toBeTruthy();
    expect(mocks.setActiveRepo).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("restores the source repository when the active repository changes during creation", async () => {
    let resolveDuplicate: (result: CreateTaskResult) => void = () => {};
    mocks.readAppConfig.mockResolvedValue({ ...appConfig, active_repo: "/repo-b" });
    mocks.duplicateTaskForRepo.mockReturnValue(
      new Promise<CreateTaskResult>((resolve) => {
        resolveDuplicate = resolve;
      }),
    );
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/repo-a"));
    await waitFor(() => expect(mocks.setActiveRepo).toHaveBeenCalledWith("/repo-a", null));

    resolveDuplicate(duplicateResult());
    await screen.findByText("task:source-2");
    expect(mocks.setActiveRepo).toHaveBeenLastCalledWith("/repo-b", null);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it("reports a routing failure without claiming the completed clone failed", async () => {
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult());
    mocks.setActiveRepo.mockRejectedValue(new Error("switch failed"));
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("/repo-b/source-2: Error: switch failed")));
    expect(screen.getByText("duplicate-source")).toBeDefined();
    expect(screen.queryByText("task:source-2")).toBeNull();
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("TASK DUPLICATION FAILED"));
  });
});
