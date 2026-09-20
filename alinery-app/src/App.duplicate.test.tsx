import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "./appearance";
import * as taskMutationGuard from "./taskMutationGuard";
import { mockIpc } from "./test/mockIpc";
import type { AppConfig, BoardTask, Config, CreateTaskResult, Task } from "./types";

const appConfig: AppConfig = {
  active_repo: "/repo-a",
  known_repos: ["/repo-a", "/repo-b"],
  mcp_enabled: true,
  appearance: DEFAULT_APPEARANCE,
};

const sourceTask = {
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
  auto_advance: [],
  draft: false,
} as Task;

const sourceBoardTask = {
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
} as BoardTask;

const duplicateResult = (slug = "source-2", harness = "claude"): CreateTaskResult => ({
  task: { ...sourceTask, slug, branch: slug, worktree: `/repo-b/.alinery/worktrees/${slug}` },
  session: {
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
  },
  attachment_errors: [],
});

const mocks = vi.hoisted(() => {
  return {
    duplicateTaskForRepo: vi.fn(),
    spawnSessionDetachedForRepo: vi.fn(),
    setActiveRepo: vi.fn(),
    readAppConfig: vi.fn(),
    toast: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    onCloseRequested: vi.fn(async () => () => {}),
  };
});

vi.mock("./ipc", () =>
  mockIpc({
    getVersion: async () => "0.9.10",
    getName: async () => "Alinery Test",
    readAppConfig: mocks.readAppConfig,
    listBoardTasks: async () => [],
    listKanbanColumns: async () => [],
    duplicateTaskForRepo: mocks.duplicateTaskForRepo,
    spawnSessionDetachedForRepo: mocks.spawnSessionDetachedForRepo,
    setActiveRepo: mocks.setActiveRepo,
    getCurrentWindow: (() => ({ onCloseRequested: mocks.onCloseRequested, destroy: vi.fn() })) as never,
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) as unknown as ReturnType<typeof import("./ipc").getCurrentWebview>,
    readConfigForRepo: async () => ({ defaults: { harness: "omp", model: "", playbook: "superdevelop", draft_autosave: true } }) as Config,
    listPlaybooksForRepo: async () => [],
    listPlaybookStepsForRepo: async () => [],
    listHarnessModelsForRepo: async () => [],
    connectionStatuses: async () => [],
  }),
);
vi.mock("./toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./toast")>();
  return {
    ...actual,
    toast: Object.assign(mocks.toast, {
      success: mocks.toastSuccess,
      error: mocks.toastError,
      info: vi.fn(),
    }),
  };
});
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
  mocks.spawnSessionDetachedForRepo.mockReset().mockResolvedValue(undefined);
  mocks.readAppConfig.mockReset().mockResolvedValue(appConfig);
  mocks.setActiveRepo.mockReset().mockImplementation(async (path: string) => ({ ...appConfig, active_repo: path }));
  mocks.toast.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.onCloseRequested.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  taskMutationGuard.release();
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
    // The refused attempt is not silent: it says which operation is still running.
    expect(mocks.toast).toHaveBeenCalledWith("A task is already being duplicated — wait for it to finish.", "error");
    await waitFor(() => expect(mocks.duplicateTaskForRepo).toHaveBeenCalledTimes(1));
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

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("TASK DUPLICATION FAILED: Error: copy failed"));
    expect(screen.getByText("duplicate-source")).toBeDefined();
    expect(mocks.setActiveRepo).not.toHaveBeenCalled();
    expect(mocks.spawnSessionDetachedForRepo).not.toHaveBeenCalled();
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult());
    fireEvent.click(screen.getByText("duplicate-source"));
    await screen.findByText("task:source-2");
    expect(mocks.duplicateTaskForRepo).toHaveBeenCalledTimes(2);
  });

  it("switches to the source repository, opens the clone, and keeps it when launch fails", async () => {
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult());
    mocks.setActiveRepo.mockResolvedValue({ ...appConfig, active_repo: "/repo-b" });
    mocks.spawnSessionDetachedForRepo.mockRejectedValue(new Error("binary missing"));
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await screen.findByText("task:source-2");
    expect(mocks.setActiveRepo).toHaveBeenCalledWith("/repo-b", null);
    expect(mocks.spawnSessionDetachedForRepo).toHaveBeenCalledWith("/repo-b", "source-2", "s-source-2");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("TASK DUPLICATED");
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("SESSION NOT STARTED: Error: binary missing"));
  });

  it("skips detached launch for no-harness and still opens the clone", async () => {
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult("source-2", "no-harness"));
    mocks.setActiveRepo.mockResolvedValue({ ...appConfig, active_repo: "/repo-b" });
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await screen.findByText("task:source-2");
    expect(mocks.spawnSessionDetachedForRepo).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("TASK DUPLICATED");
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
    expect(mocks.spawnSessionDetachedForRepo).toHaveBeenCalledWith("/repo-b", "source-2", "s-source-2");
  });

  it("reports a routing failure without claiming the completed clone failed", async () => {
    mocks.duplicateTaskForRepo.mockResolvedValue(duplicateResult());
    mocks.setActiveRepo.mockRejectedValue(new Error("switch failed"));
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("TASK DUPLICATED BUT NOT OPENED: /repo-b/source-2: Error: switch failed"));
    expect(screen.getByText("duplicate-source")).toBeDefined();
    expect(screen.queryByText("task:source-2")).toBeNull();
    expect(mocks.spawnSessionDetachedForRepo).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalledWith(expect.stringContaining("TASK DUPLICATION FAILED"));
  });

  it("keeps a loader up for the whole clone and resolves it in place", async () => {
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

    expect(screen.getByText("Duplicating Task…")).toBeDefined();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    resolveDuplicate(duplicateResult());
    await screen.findByText("task:source-2");
    expect(screen.queryByText("Duplicating Task…")).toBeNull();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("TASK DUPLICATED");
  });

  it("refuses the new-task hotkey while a clone is running", async () => {
    let resolveDuplicate: (result: CreateTaskResult) => void = () => {};
    mocks.duplicateTaskForRepo.mockReturnValue(
      new Promise<CreateTaskResult>((resolve) => {
        resolveDuplicate = resolve;
      }),
    );
    const { default: App } = await import("./App");
    render(<App />);
    fireEvent.click(await screen.findByText("duplicate-source"));

    fireEvent.keyDown(document.body, { key: "n", metaKey: true });

    expect(mocks.toast).toHaveBeenCalledWith("A task is already being duplicated — wait for it to finish.", "error");
    // The create form never mounts, so the user stays on the board they were looking at.
    expect(screen.queryByPlaceholderText("New task name…")).toBeNull();
    expect(screen.getByText("duplicate-source")).toBeDefined();

    resolveDuplicate(duplicateResult());
    await screen.findByText("task:source-2");
  });

  it("shows opening toast until the create form is ready, then hides it", async () => {
    const { default: App } = await import("./App");
    render(<App />);
    await screen.findByText("duplicate-source");

    fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    expect(screen.getByText("Opening New Task…")).toBeDefined();

    await screen.findByPlaceholderText("New task name…");
    await waitFor(() => expect(screen.queryByText("Opening New Task…")).toBeNull());
  });
});
