import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navReady, requireNav } from "../test/nav";
import type {
  BoardNav,
  BoardTask,
  ExecutionLifecycle,
  ExecutionRecord,
  KanbanColumn,
  NormalizedStep,
  PlaybookRef,
  PullRequestSnapshot,
  ScopedPlaybook,
  TaskActivityMap,
  TaskActivityRef,
  TaskExecutionReply,
} from "../types";
import { Grid } from "./Grid";

const now = Math.floor(Date.now() / 1000);
const makeTask = (over: Partial<BoardTask>): BoardTask => ({
  name: "A task",
  slug: "a-task",
  requested_slug: "a-task",
  branch: "a-task",
  worktree: "/worktrees/a-task",
  has_worktree: true,
  created: now - 86400,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "superdevelop",
  engine_version: 2,
  playbook_steps: [
    { key: "research", title: "Research" },
    { key: "design", title: "Design" },
    { key: "implementation", title: "Implementation" },
  ],
  auto_advance: [],
  draft: false,
  repo_path: "/repo-a",
  session_count: 2,
  playbook_title: "SuperDevelop",
  updated: now - 3600,
  current_phase: "implementation",
  current_step_title: "Implementation",
  latest_session_title: "Implementation",
  latest_session_column_key: "implementation",
  current_column_key: "implementation",
  current_column_title: "Implementation",
  ...over,
});

const tasks = [
  makeTask({ name: "Build API", slug: "build-api" }),
  makeTask({
    name: "Review queue",
    slug: "review-queue",
    repo_path: "/repo-b",
    playbook: "review",
    playbook_title: "Review",
    playbook_steps: [
      { key: "context", title: "Context" },
      { key: "findings", title: "Findings" },
    ],
    current_phase: "findings",
    current_step_title: "Findings",
    latest_session_title: "Findings",
    current_column_key: "review",
    current_column_title: "Review",
  }),
  makeTask({
    name: "Release app",
    slug: "release-app",
    playbook: "one-shot",
    playbook_title: "One-shot",
    playbook_steps: [
      { key: "queued", title: "Queued" },
      { key: "implementation", title: "Implementation" },
      { key: "pr", title: "PR" },
    ],
    current_phase: "pr",
    current_step_title: "PR",
    latest_session_title: "PR",
    current_column_key: "review",
    current_column_title: "Review",
  }),
];

const columns: KanbanColumn[] = [
  { key: "research-design", title: "Research & Design" },
  { key: "implementation", title: "Implementation" },
  { key: "review", title: "Review" },
];
const step = (key: string, title: string): NormalizedStep => ({
  key,
  title,
  short: title,
  is_coding_step: false,
  auto_advance_default: false,
  inputs: [],
  outputs: [],
  model: "default",
  harness: "omp",
  prompt: "",
});
function retainedExecution(steps: NormalizedStep[], states: [string, ExecutionLifecycle][] = []): TaskExecutionReply {
  const executions = Object.fromEntries(
    states.map(([stepKey, lifecycle], index) => {
      const id = `execution-${index}`;
      const record: ExecutionRecord = {
        id,
        binding_key: id,
        candidate: { step_key: stepKey, context_id: "root", inputs: {}, complete_collection_id: null, each_collection_id: null, each_member_id: null, manual: true },
        outputs: [],
        parent_execution_ids: [],
        depth: 0,
        owner_session_id: `session-${index}`,
        previous_session_ids: [],
        launch: { harness: "omp", model: "default" },
        is_coding_step: false,
        start_requested: true,
        lifecycle,
        permission: { kind: "automatic" },
        receipt_id: null,
        exit_code: null,
        shutdown_confirmed: false,
        error: null,
      };
      return [id, record];
    }),
  );
  return {
    live: { status: "available" },
    definition: {
      version: 2,
      key: "superdevelop",
      title: "Retained workflow",
      description: "",
      default_model: "default",
      default_harness: "omp",
      step: steps,
      preamble: "",
      section_order: [],
    },
    state: {
      version: 2,
      revision: 1,
      creation: "ready",
      creation_error: null,
      owning_lane: "local",
      definition_identity: "retained",
      reference: { scope: "repo", key: "superdevelop" },
      max_live_sessions: 3,
      enabled_steps: steps.map(({ key }) => key),
      launch_defaults: { harness: "omp", model: "default" },
      executions,
      occurrences: {},
      contexts: {},
      collections: {},
    },
  };
}
const taskExecutions: Record<string, TaskExecutionReply> = {
  "/repo-a:build-api": retainedExecution(
    [step("research", "Research"), step("design", "Design"), step("implementation", "Implementation")],
    [
      ["research", "completed"],
      ["implementation", "running"],
    ],
  ),
  "/repo-b:review-queue": retainedExecution(
    [step("context", "Context"), step("findings", "Findings")],
    [
      ["context", "completed"],
      ["findings", "running"],
    ],
  ),
  "/repo-a:release-app": retainedExecution([step("queued", "Queued"), step("implementation", "Implementation"), step("pr", "PR")], [["pr", "running"]]),
};

const ipcMock = vi.hoisted(() => ({
  listBoardTasks: vi.fn(async (_allRepos: boolean): Promise<BoardTask[]> => []),
  listKanbanColumns: vi.fn(async (_allRepos: boolean): Promise<KanbanColumn[]> => []),
  getTaskExecution: vi.fn<(slug: string, repoPath?: string) => Promise<TaskExecutionReply>>(),
  readPlaybook: vi.fn<(reference: PlaybookRef, repoPath?: string) => Promise<ScopedPlaybook>>(),
  listTaskActivity: vi.fn(async (_refs: TaskActivityRef[]): Promise<TaskActivityMap> => ({})),
  listTaskPullRequests: vi.fn(async (_tasks: TaskActivityRef[]): Promise<Record<string, PullRequestSnapshot>> => ({})),
  openUrl: vi.fn(async (_url: string): Promise<void> => {}),
  archiveTaskForRepo: vi.fn(async (_repoPath: string, _slug: string): Promise<void> => {}),
  removeWorktreeForRepo: vi.fn(async (_repoPath: string, _slug: string): Promise<void> => {}),
}));
vi.mock("../ipc", () => ipcMock);
vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

const storedGridWorkspaces = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return storedGridWorkspaces.size;
  },
  clear: () => storedGridWorkspaces.clear(),
  getItem: (key) => storedGridWorkspaces.get(key) ?? null,
  key: (index) => [...storedGridWorkspaces.keys()][index] ?? null,
  removeItem: (key) => storedGridWorkspaces.delete(key),
  setItem: (key, value) => storedGridWorkspaces.set(key, value),
};
Object.defineProperty(window, "localStorage", { configurable: true, value: localStorageMock });

beforeEach(() => {
  window.localStorage.clear();
  ipcMock.listBoardTasks.mockResolvedValue(tasks);
  ipcMock.listKanbanColumns.mockResolvedValue(columns);
  ipcMock.listTaskPullRequests.mockImplementation(async (refs) => Object.fromEntries(refs.map((ref) => [`${ref.repoPath}:${ref.taskSlug}`, { pr: null, error: null }])));
  ipcMock.getTaskExecution.mockImplementation(async (slug, repoPath) => taskExecutions[`${repoPath}:${slug}`] ?? retainedExecution([step("implementation", "Implementation")]));
  ipcMock.readPlaybook.mockImplementation(async (reference) => ({
    source: { reference, path: null },
    definition: retainedExecution([step("research", "Research"), step("design", "Design"), step("implementation", "Implementation")]).definition,
    source_text: "",
    modified_at_ms: null,
  }));
  ipcMock.listTaskActivity.mockResolvedValue({
    "/repo-a:build-api": { status: "running", active_session: null },
    "/repo-b:review-queue": { status: "waiting_for_approval", active_session: null },
    "/repo-a:release-app": { status: null, active_session: null },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const columnNames = () =>
  screen.getAllByRole("button", { name: /^(Hide|Expand) .+ column$/ }).map((button) => button.getAttribute("aria-label")?.replace(/^(Hide|Expand) | column$/g, ""));
const laneStepNames = (lane: HTMLElement) => [...lane.querySelectorAll(".task-grid-lane-step")].map((cell) => cell.textContent);

describe("configurable task grid", () => {
  describe("default progress filter", () => {
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {}, storageKey: "progress-filter", initialPreset: "progress" as const };

    beforeEach(() => {
      ipcMock.listBoardTasks.mockResolvedValue([makeTask({ name: "Unfinished task", slug: "unfinished", current_phase: "research", current_step_title: "Research" })]);
      ipcMock.getTaskExecution.mockResolvedValue(
        retainedExecution(
          [step("research", "Research"), step("implementation", "Implementation")],
          [
            ["research", "completed"],
            ["implementation", "queued"],
          ],
        ),
      );
      ipcMock.listTaskActivity.mockResolvedValue({ "/repo-a:unfinished": { status: "completed", active_session: null } });
    });

    it("keeps an unread completed-step task visible by default across remount", async () => {
      const first = render(<Grid {...props} />);
      await screen.findByLabelText("Completed");
      expect(within(screen.getByRole("button", { name: /^Unfinished task, repo-a/ })).getByLabelText("Completed")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
      expect((screen.getByLabelText("Filter") as HTMLSelectElement).value).toBe("all");
      first.unmount();

      render(<Grid {...props} />);
      await screen.findByLabelText("Completed");
      expect(within(screen.getByRole("button", { name: /^Unfinished task, repo-a/ })).getByLabelText("Completed")).toBeDefined();
      expect((screen.getByLabelText("Filter") as HTMLSelectElement).value).toBe("all");
    });

    it("preserves an explicit Active only filter and restores the row under All tasks", async () => {
      const first = render(<Grid {...props} />);
      fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
      fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "all" } });
      await screen.findByLabelText("Completed");
      fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "active" } });
      await screen.findByText("No tasks match this grid configuration.");
      expect(screen.queryByRole("button", { name: /^Unfinished task, repo-a/ })).toBeNull();
      first.unmount();

      render(<Grid {...props} />);
      expect((screen.getByLabelText("Filter") as HTMLSelectElement).value).toBe("active");
      await screen.findByText("No tasks match this grid configuration.");
      expect(screen.queryByRole("button", { name: /^Unfinished task, repo-a/ })).toBeNull();
      fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "all" } });
      await screen.findByLabelText("Completed");
      expect(within(screen.getByRole("button", { name: /^Unfinished task, repo-a/ })).getByLabelText("Completed")).toBeDefined();
    });
  });

  it("preserves an existing workspace when the initial preset changes for new users", async () => {
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {}, storageKey: "existing-user" };
    const oldView = render(<Grid {...props} initialPreset="kanban" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "480" } });
    fireEvent.click(screen.getByLabelText("Show archived"));
    oldView.unmount();

    render(<Grid {...props} initialPreset="progress" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    expect((screen.getByLabelText("Position model") as HTMLSelectElement).value).toBe("packed");
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("480");
    expect((screen.getByLabelText("Show archived") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("pull request") as HTMLInputElement).checked).toBe(false);
  });

  it("saves named settings across repositories without changing the original preset", async () => {
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {} };
    const first = render(<Grid {...props} storageKey="repo-a:view:presets" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "960" } });
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    fireEvent.change(screen.getByLabelText("New preset name"), { target: { value: "Wide board" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new preset" }));
    const savedId = (screen.getByLabelText("Preset") as HTMLSelectElement).value;
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "480" } });
    fireEvent.change(screen.getByLabelText("New preset name"), { target: { value: "wide BOARD" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new preset" }));
    expect(screen.getByRole("alert").textContent).toContain("already exists");
    first.unmount();

    const other = render(<Grid {...props} storageKey="repo-b:view:presets" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("150");
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: savedId } });
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("960");
    expect((screen.getByLabelText("Show empty columns") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("New preset name"), { target: { value: "Another board" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new preset" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
    expect(screen.queryByRole("option", { name: "Another board" })).toBeNull();
    expect(screen.getByRole("option", { name: "Wide board" })).toBeDefined();
    other.unmount();

    render(<Grid {...props} storageKey="repo-a:view:presets" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("480");
    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("custom");
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: savedId } });
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("960");
  });

  it("keeps mounted views synchronized when a saved preset is deleted", async () => {
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {} };
    const first = render(<Grid {...props} storageKey="preset-first" />);
    const second = render(<Grid {...props} storageKey="preset-second" />);
    const a = within(first.container);
    const b = within(second.container);
    fireEvent.click(a.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(b.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(a.getByLabelText("New preset name"), { target: { value: "Shared" } });
    fireEvent.click(a.getByRole("button", { name: "Save as new preset" }));
    const id = (a.getByLabelText("Preset") as HTMLSelectElement).value;
    fireEvent.change(b.getByLabelText("Preset"), { target: { value: id } });
    fireEvent.click(a.getByRole("button", { name: "Delete preset" }));
    expect((b.getByLabelText("Preset") as HTMLSelectElement).value).toBe("custom");
    expect(b.queryByRole("option", { name: "Shared" })).toBeNull();
    await act(async () => {});
  });

  it("shows empty kanban and retained-step columns on demand and still permits collapse", async () => {
    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect(screen.queryByRole("button", { name: "Hide Research & Design column" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    fireEvent.click(screen.getByRole("button", { name: "Hide Research & Design column" }));
    expect(screen.getByRole("button", { name: "Expand Research & Design column" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Expand Research & Design column" }));
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "stage" } });
    expect(await screen.findByRole("button", { name: "Hide Research column" })).toBeDefined();
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    expect(screen.queryByRole("button", { name: "Hide Research column" })).toBeNull();
  });

  it("keeps declared empty columns in playbook order when the execution daemon is unavailable", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([tasks[0]]);
    ipcMock.getTaskExecution.mockRejectedValue(new Error("execution daemon unavailable"));
    ipcMock.readPlaybook.mockResolvedValue({
      source: { reference: { scope: "bundled", key: "superdevelop" }, path: null },
      definition: retainedExecution([step("replacement", "Library replacement")]).definition,
      source_text: "",
      modified_at_ms: null,
    });
    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} initialPreset="steps" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    expect((await screen.findByRole("alert")).textContent).toContain("execution daemon unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    expect(columnNames()).toEqual(["Research", "Design", "Implementation"]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Design column" }));
    expect(screen.getByRole("button", { name: "Expand Design column" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Expand Design column" }));
    expect(columnNames()).toEqual(["Research", "Design", "Implementation"]);
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    expect(columnNames()).toEqual(["Implementation"]);
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    expect(columnNames()).toEqual(["Research", "Design", "Implementation"]);
  });

  it.each([
    { label: "bundled fallback", reference: undefined, scope: "bundled" },
    { label: "repository reference", reference: { scope: "repo", key: "legacy-workflow" } as PlaybookRef, scope: "repo" },
  ])("resolves legacy $label steps without execution.json or duplicate raw phase columns", async ({ reference, scope }) => {
    const task = makeTask({
      name: "Legacy task",
      engine_version: 1,
      playbook: "legacy-workflow",
      playbook_ref: reference,
      playbook_steps: [],
      current_phase: "implementation",
      current_step_title: "implementation",
    });
    ipcMock.listBoardTasks.mockResolvedValue([task]);
    ipcMock.getTaskExecution.mockRejectedValue(new Error("execution.json not found"));
    ipcMock.readPlaybook.mockImplementation(async (requested, repoPath) => ({
      source: { reference: requested, path: null },
      definition: retainedExecution(
        requested.scope === scope && requested.key === "legacy-workflow" && repoPath === task.repo_path
          ? [step("research", "Research"), step("design", "Design"), step("implementation", "Implementation")]
          : [step("wrong", "Wrong library")],
      ).definition,
      source_text: "",
      modified_at_ms: null,
    }));
    const { container } = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} initialPreset="steps" />);
    await screen.findByRole("button", { name: /Legacy task, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    await waitFor(() => expect(columnNames()).toEqual(["Research", "Design", "Implementation"]));
    const implementation = screen.getByRole("button", { name: "Hide Implementation column" }).closest("section") as HTMLElement;
    expect(within(implementation).getByRole("button", { name: /Legacy task, repo-a/ })).toBeDefined();
    expect(container.querySelectorAll(".task-grid-card")).toHaveLength(1);
  });

  it("merges compatible playbooks without reversing either declared step sequence", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([tasks[2], tasks[0]]);
    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} initialPreset="steps" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    const names = columnNames();
    expect(names.filter((name) => ["Research", "Design", "Implementation"].includes(name ?? ""))).toEqual(["Research", "Design", "Implementation"]);
    expect(names.filter((name) => ["Queued", "Implementation", "PR"].includes(name ?? ""))).toEqual(["Queued", "Implementation", "PR"]);
    expect(names.filter((name) => name === "Implementation")).toHaveLength(1);
  });

  it("persists keyboard column orders per grouping and in presets, with reset restoring declaration order", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([tasks[0]]);
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {}, storageKey: "keyboard-column-order", initialPreset: "steps" as const };
    const first = render(<Grid {...props} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Research column; use left and right arrow keys" }), { key: "ArrowRight" });
    expect(columnNames()).toEqual(["Design", "Research", "Implementation"]);
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "column" } });
    expect(columnNames()).toEqual(["Research & Design", "Implementation", "Review"]);
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Review column; use left and right arrow keys" }), { key: "ArrowLeft" });
    expect(columnNames()).toEqual(["Research & Design", "Review", "Implementation"]);
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "stage" } });
    expect(columnNames()).toEqual(["Design", "Research", "Implementation"]);
    fireEvent.change(screen.getByLabelText("New preset name"), { target: { value: "Ordered columns" } });
    fireEvent.click(screen.getByRole("button", { name: "Save as new preset" }));
    const presetId = (screen.getByLabelText("Preset") as HTMLSelectElement).value;
    first.unmount();

    const second = render(<Grid {...props} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    expect(columnNames()).toEqual(["Design", "Research", "Implementation"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset column order" }));
    expect(columnNames()).toEqual(["Research", "Design", "Implementation"]);
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "column" } });
    expect(columnNames()).toEqual(["Research & Design", "Review", "Implementation"]);
    second.unmount();

    render(<Grid {...props} storageKey="another-column-order" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: presetId } });
    expect(columnNames()).toEqual(["Design", "Research", "Implementation"]);
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "column" } });
    expect(columnNames()).toEqual(["Research & Design", "Review", "Implementation"]);
  });

  it("reorders columns by pointer, ignores cancelled drags, and restores the saved order", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([tasks[0]]);
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {}, storageKey: "pointer-column-order", initialPreset: "steps" as const };
    const first = render(<Grid {...props} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show empty columns"));
    const target = screen.getByRole("button", { name: "Hide Implementation column" }).closest("[data-column-key]") as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 200,
      y: 0,
      width: 100,
      height: 300,
      top: 0,
      right: 300,
      bottom: 300,
      left: 200,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
    try {
      const handle = screen.getByRole("button", { name: "Reorder Research column; use left and right arrow keys" });
      fireEvent.pointerDown(handle, { button: 0, pointerId: 8, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 8, clientX: 290, clientY: 20 });
      fireEvent.pointerCancel(window, { pointerId: 8, clientX: 290, clientY: 20 });
      expect(columnNames()).toEqual(["Research", "Design", "Implementation"]);
      fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 20, clientY: 20 });
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 290, clientY: 20 });
      fireEvent.pointerUp(window, { pointerId: 9, clientX: 290, clientY: 20 });
      expect(columnNames()).toEqual(["Design", "Implementation", "Research"]);
      first.unmount();

      render(<Grid {...props} />);
      await screen.findByRole("button", { name: /Build API, repo-a/ });
      expect(columnNames()).toEqual(["Design", "Implementation", "Research"]);
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });

  it("surfaces newly saved drafts without treating their absent execution as an error", async () => {
    vi.useFakeTimers();
    const draft = makeTask({
      name: "Draft proposal",
      slug: "draft-proposal",
      draft: true,
      playbook_steps: [],
      session_count: 0,
      current_phase: "",
      current_step_title: "",
      current_column_key: "",
      current_column_title: "",
    });
    ipcMock.getTaskExecution.mockImplementation(async (slug, repoPath) => {
      if (slug === draft.slug) throw new Error("No execution state for draft");
      return taskExecutions[`${repoPath}:${slug}`];
    });
    const onOpen = vi.fn();
    render(<Grid allRepos={false} onOpen={onOpen} registerNav={() => {}} />);
    await act(async () => {});
    ipcMock.listBoardTasks.mockResolvedValue([...tasks, draft]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    fireEvent.click(screen.getByRole("button", { name: /Draft proposal, repo-a.*Draft/ }));
    expect(onOpen).toHaveBeenLastCalledWith(draft);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });
    const lane = screen.getByLabelText("Draft proposal retained steps");
    expect(within(lane).getByRole("button", { name: /Draft proposal/ })).toBeDefined();
  });

  it("renders every preset through the same real task projection", async () => {
    const onOpen = vi.fn();
    render(<Grid allRepos onOpen={onOpen} registerNav={() => {}} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    const preset = screen.getByLabelText("Preset");
    for (const value of ["kanban", "steps", "quadrants", "atlas", "age", "progress"]) {
      fireEvent.change(preset, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ }));
      expect(onOpen).toHaveBeenLastCalledWith(tasks[0]);
    }
  });
  it("assigns distinct palette slots to the first six repositories", async () => {
    ipcMock.listBoardTasks.mockResolvedValue(
      ["a", "b", "c", "d", "e", "f"].map((suffix) =>
        makeTask({
          name: `Repo ${suffix.toUpperCase()} task`,
          slug: `task-${suffix}`,
          repo_path: `/repo-${suffix}`,
        }),
      ),
    );
    render(<Grid allRepos onOpen={() => {}} registerNav={() => {}} />);

    await screen.findByRole("button", { name: /Repo A task, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    const borderLegend = screen.getByText("BORDER · Repository").closest(".task-grid-legend-row");
    const colors = [...(borderLegend?.querySelectorAll<HTMLElement>(".task-grid-legend-swatch") ?? [])].map((swatch) => swatch.style.getPropertyValue("--task-grid-key-color"));

    expect(new Set(colors).size).toBe(6);
  });

  it("sorts by exact task creation time in both directions", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([
      { ...tasks[0], created: now - 300 },
      { ...tasks[1], created: now - 200 },
      { ...tasks[2], created: now - 100 },
    ]);
    const { container } = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Group by"), { target: { value: "none" } });
    const sort = screen.getByLabelText("Sort by") as HTMLSelectElement;

    expect([...sort.options].map((option) => option.text)).toEqual(expect.arrayContaining(["Created at (asc)", "Created at (desc)"]));
    fireEvent.change(sort, { target: { value: "createdAtAsc" } });
    expect([...container.querySelectorAll(".task-grid-card")].map((card) => card.getAttribute("data-task-id"))).toEqual([
      "/repo-a:build-api",
      "/repo-b:review-queue",
      "/repo-a:release-app",
    ]);

    fireEvent.change(sort, { target: { value: "createdDays" } });
    expect([...container.querySelectorAll(".task-grid-card")].map((card) => card.getAttribute("data-task-id"))).toEqual([
      "/repo-a:release-app",
      "/repo-b:review-queue",
      "/repo-a:build-api",
    ]);
  });

  it("shows live session activity and sizes columns in card units", async () => {
    const { container } = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} />);

    const apiCard = await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));

    expect(within(apiCard).queryByRole("img", { name: "Running" })).toBeNull();
    fireEvent.click(screen.getByLabelText("session activity"));
    await waitFor(() => expect(within(apiCard).getByRole("img", { name: "Running" })).toBeDefined());

    const cardsPerColumn = screen.getByLabelText("Cards per column") as HTMLSelectElement;
    expect(cardsPerColumn.value).toBe("2");
    fireEvent.change(cardsPerColumn, { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "96" } });
    const grid = container.querySelector(".task-grid-view") as HTMLElement;
    expect(grid.style.getPropertyValue("--task-grid-column-cards")).toBe("1");
    expect(grid.style.getPropertyValue("--task-grid-tile-w")).toBe("96px");
    expect(grid.style.getPropertyValue("--task-grid-group-width")).toBe("114px");

    fireEvent.change(screen.getByLabelText("Column flow"), { target: { value: "scroll" } });
    expect(container.querySelector(".task-grid-groups")?.getAttribute("data-column-flow")).toBe("scroll");

    fireEvent.click(screen.getByRole("button", { name: "Hide Implementation column" }));
    expect(screen.getByRole("button", { name: "Expand Implementation column" })).toBeDefined();
    expect(container.querySelector('.task-grid-card[data-task-id="/repo-a:build-api"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand Implementation column" }));
    expect(container.querySelector('.task-grid-card[data-task-id="/repo-a:build-api"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(grid.style.getPropertyValue("--task-grid-group-width")).toBe("114px");
  });

  it("persists the optional PR property and opens its link independently in every card mode", async () => {
    const task = makeTask({ name: "PR task", slug: "grid-pr", repo_path: "/grid-pr" });
    const url = "https://github.com/example/project/pull/42";
    ipcMock.listBoardTasks.mockResolvedValue([task]);
    ipcMock.listTaskPullRequests.mockResolvedValue({ "/grid-pr:grid-pr": { pr: { number: 42, url, state: "open" }, error: null } });
    const onOpen = vi.fn();
    const first = render(<Grid allRepos={false} onOpen={onOpen} registerNav={() => {}} storageKey="pr-property" />);
    const card = await screen.findByRole("button", { name: /PR task, grid-pr/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect(ipcMock.listTaskPullRequests).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("pull request"));
    await screen.findByRole("link", { name: /PR #42.*Open/ });
    for (const mode of ["detail", "compact", "icon"]) {
      fireEvent.change(screen.getByLabelText("Card mode"), { target: { value: mode } });
      const link = within(card).getByRole("link", { name: /PR #42.*Open/ });
      fireEvent.click(link);
      fireEvent.keyDown(link, { key: "Enter" });
    }
    expect(ipcMock.openUrl).toHaveBeenCalledTimes(6);
    expect(ipcMock.openUrl).toHaveBeenLastCalledWith(url);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    expect(onOpen.mock.calls).toEqual([[task], [task]]);
    fireEvent.click(screen.getByRole("button", { name: "Hide Implementation column" }));
    expect(screen.queryByRole("link", { name: /PR #42/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Position model"), { target: { value: "lanes" } });
    expect(screen.getByRole("link", { name: /PR #42.*Open/ })).toBeDefined();
    first.unmount();

    render(<Grid allRepos={false} onOpen={onOpen} registerNav={() => {}} storageKey="pr-property" />);
    expect((screen.getByLabelText("pull request") as HTMLInputElement).checked).toBe(true);
    await screen.findByRole("link", { name: /PR #42.*Open/ });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("pull request"));
    expect(screen.queryByRole("link", { name: /PR #42/ })).toBeNull();
  });

  it("pauses PR refreshes for inactive grids and when the property is disabled", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([makeTask({ slug: "pr-poll", repo_path: "/grid-pr-poll" })]);
    const props = { allRepos: false, onOpen: () => {}, registerNav: () => {} };
    const view = render(<Grid {...props} />);
    await screen.findByRole("button", { name: /A task, grid-pr-poll/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    view.rerender(<Grid {...props} active={false} />);
    fireEvent.click(screen.getByLabelText("pull request"));
    await act(async () => {});
    expect(ipcMock.listTaskPullRequests).not.toHaveBeenCalled();
    view.rerender(<Grid {...props} active />);
    await waitFor(() => expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    view.rerender(<Grid {...props} active={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(1);
    view.rerender(<Grid {...props} active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByLabelText("pull request"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(ipcMock.listTaskPullRequests).toHaveBeenCalledTimes(2);
  });

  it("persists exact-width scrolling columns and collapsed group rails", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-columns" />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Cards per column"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Tile width/), { target: { value: "96" } });
    fireEvent.change(screen.getByLabelText("Column flow"), { target: { value: "scroll" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide Implementation column" }));
    expect(screen.getByRole("button", { name: "Expand Implementation column" })).toBeDefined();
    first.unmount();

    const second = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-columns" />);
    await screen.findByRole("button", { name: "Expand Implementation column" });
    expect((screen.getByLabelText("Cards per column") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText(/Tile width/) as HTMLInputElement).value).toBe("96");
    expect((screen.getByLabelText("Column flow") as HTMLSelectElement).value).toBe("scroll");
    expect(second.container.querySelector(".task-grid-groups")?.getAttribute("data-column-flow")).toBe("scroll");

    fireEvent.click(screen.getByRole("button", { name: "Expand Implementation column" }));
    expect(await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ })).toBeDefined();
  });

  it("pauses updates while inactive and refreshes the board on reactivation", async () => {
    vi.useFakeTimers();
    const registerNav = vi.fn();
    const onOpen = vi.fn();
    const grid = render(<Grid active={false} allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Build API, repo-a/ })).toBeNull();
    await act(async () => {
      grid.rerender(<Grid active allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    });
    expect(screen.getByRole("button", { name: /Build API, repo-a/ })).toBeDefined();
    grid.rerender(<Grid active={false} allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    ipcMock.listBoardTasks.mockResolvedValue([{ ...tasks[0], name: "Updated API" }]);
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(screen.queryByRole("button", { name: /Updated API, repo-a/ })).toBeNull();
    expect(registerNav.mock.lastCall?.[0]).toBeNull();
    await act(async () => {
      grid.rerender(<Grid active allRepos={false} onOpen={onOpen} registerNav={registerNav} />);
    });
    expect(screen.getByRole("button", { name: /Updated API, repo-a/ })).toBeDefined();
    act(() => requireNav(registerNav.mock.lastCall?.[0]).openSelected());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: "Updated API" }));
  });

  it("keeps legacy tasks and drafts browsable without requesting nonexistent execution state", async () => {
    const legacy = makeTask({ name: "Legacy", slug: "legacy", engine_version: undefined, playbook_steps: [] });
    const archived = makeTask({ name: "Archived legacy", slug: "archived", engine_version: 1, archived: true, playbook_steps: [] });
    const draft = makeTask({ name: "Draft", slug: "draft", draft: true, playbook_steps: [] });
    ipcMock.listBoardTasks.mockResolvedValue([legacy, archived, draft, tasks[0]]);
    ipcMock.getTaskExecution.mockImplementation(async (slug) => {
      if (slug !== "build-api") throw new Error("No execution state for this task");
      return taskExecutions["/repo-a:build-api"];
    });
    const onOpen = vi.fn();
    render(<Grid allRepos onOpen={onOpen} registerNav={() => {}} initialPreset="progress" />);

    await screen.findByRole("button", { name: /^Build API, repo-a/ });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Legacy, repo-a/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: /^Legacy, repo-a/ }), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(legacy);

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show archived"));
    await screen.findByRole("button", { name: /^Archived legacy, repo-a/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps saved progress browsable across offline and foreign owners, then clears warnings when live access returns", async () => {
    vi.useFakeTimers();
    let available = false;
    ipcMock.getTaskExecution.mockImplementation(async (slug, repoPath) => {
      const retained = taskExecutions[`${repoPath}:${slug}`];
      if (available || slug === "review-queue") return retained;
      return {
        ...retained,
        live: {
          status: slug === "build-api" ? "offline" : "foreign_owner",
          detail: `Private daemon diagnostic for ${repoPath}:${slug}`,
        },
      };
    });
    const onOpen = vi.fn();
    render(<Grid allRepos onOpen={onOpen} registerNav={() => {}} initialPreset="progress" />);
    await act(async () => {});

    expect(screen.queryByRole("alert")).toBeNull();
    expect(laneStepNames(screen.getByLabelText("Build API retained steps"))).toEqual(["Research", "Design", "Implementation"]);
    expect(laneStepNames(screen.getByLabelText("Release app retained steps"))).toEqual(["Queued", "Implementation", "PR"]);
    const summary = screen.getByText(/Showing saved progress for 2 tasks/);
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(summary);
    for (const slug of ["build-api", "release-app"]) {
      const diagnostic = screen.getByText(`Private daemon diagnostic for /repo-a:${slug}`);
      const detail = diagnostic.closest("details") as HTMLDetailsElement;
      expect(detail.open).toBe(false);
      fireEvent.click(within(detail).getByText("Technical details"));
      expect(detail.open).toBe(true);
    }
    fireEvent.keyDown(screen.getByRole("button", { name: /^Build API, repo-a/ }), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(tasks[0]);

    available = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByText(/Showing saved progress/)).toBeNull();
    expect(screen.queryByText(/Private daemon diagnostic/)).toBeNull();
    expect(laneStepNames(screen.getByLabelText("Build API retained steps"))).toEqual(["Research", "Design", "Implementation"]);
    expect(laneStepNames(screen.getByLabelText("Release app retained steps"))).toEqual(["Queued", "Implementation", "PR"]);
  });

  it("keeps availability notices dismissed across polling but resurfaces changed conditions without hiding storage errors", async () => {
    vi.useFakeTimers();
    let status: "offline" | "foreign_owner" | "available" = "offline";
    let unavailableSlug = "build-api";
    let diagnostic = 0;
    let corrupt = false;
    ipcMock.getTaskExecution.mockImplementation(async (slug, repoPath) => {
      if (corrupt && slug === "build-api") throw new Error("Saved state is corrupt");
      const retained = taskExecutions[`${repoPath}:${slug}`];
      return status === "available" || slug !== unavailableSlug ? retained : { ...retained, live: { status, detail: `Diagnostic ${diagnostic++}` } };
    });
    render(<Grid allRepos onOpen={() => {}} registerNav={() => {}} initialPreset="progress" />);
    await act(async () => {});
    const dismiss = () => fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    const poll = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
    };
    dismiss();
    await poll();
    await poll();
    expect(screen.queryByText(/Showing saved progress/)).toBeNull();
    expect(laneStepNames(screen.getByLabelText("Build API retained steps"))).toEqual(["Research", "Design", "Implementation"]);

    status = "foreign_owner";
    await poll();
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toBeDefined();
    dismiss();
    unavailableSlug = "release-app";
    await poll();
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toBeDefined();
    dismiss();

    status = "available";
    await poll();
    expect(screen.queryByText(/Showing saved progress/)).toBeNull();
    status = "offline";
    await poll();
    expect(screen.getByRole("button", { name: "Dismiss notice" })).toBeDefined();
    dismiss();

    corrupt = true;
    await poll();
    expect(screen.queryByText(/Showing saved progress/)).toBeNull();
    expect(within(screen.getByRole("alert")).getByText("Error: Saved state is corrupt")).toBeDefined();
  });

  it("reports execution refresh errors without fabricating or discarding other task states", async () => {
    vi.useFakeTimers();
    let failing = false;
    ipcMock.getTaskExecution.mockImplementation(async (slug, repoPath) => {
      if (failing && slug !== "review-queue") throw new Error(`Invalid execution.json for ${repoPath}:${slug}`);
      return taskExecutions[`${repoPath}:${slug}`];
    });
    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} initialPreset="progress" />);
    await act(async () => {});
    const lane = screen.getByLabelText("Build API retained steps");
    expect(laneStepNames(lane)).toEqual(["Research", "Design", "Implementation"]);
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Path labels"), { target: { value: "next" } });
    expect(laneStepNames(lane)).toEqual(["Implementation"]);
    failing = true;
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    const alert = screen.getByRole("alert");
    const details = within(alert)
      .getByText(/2 tasks/)
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(within(alert).getByText(/2 tasks/));
    expect(details.open).toBe(true);
    expect(within(alert).getByRole("list").textContent).toContain("Invalid execution.json for /repo-a:build-api");
    expect(within(alert).getByRole("list").textContent).toContain("Invalid execution.json for /repo-a:release-app");
    expect(laneStepNames(lane)).toEqual([]);
    expect(laneStepNames(screen.getByLabelText("Review queue retained steps"))).toEqual(["Findings"]);
    fireEvent.change(screen.getByLabelText("Path labels"), { target: { value: "all" } });
    expect(laneStepNames(lane)).toEqual(["Research", "Design", "Implementation"]);
    failing = false;
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(laneStepNames(lane)).toEqual(["Research", "Design", "Implementation"]);
    fireEvent.change(screen.getByLabelText("Path labels"), { target: { value: "next" } });
    expect(laneStepNames(lane)).toEqual(["Implementation"]);
  });

  it("shows legacy library steps in declaration order in row view without execution state", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([
      makeTask({ name: "Legacy row", engine_version: 1, playbook_steps: [], current_phase: "implementation", current_step_title: "implementation" }),
    ]);
    ipcMock.getTaskExecution.mockRejectedValue(new Error("execution.json not found"));
    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} initialPreset="progress" />);
    const lane = await screen.findByLabelText("Legacy row retained steps");
    await waitFor(() => expect(laneStepNames(lane)).toEqual(["Research", "Design", "Implementation"]));
    expect(within(lane).getByRole("button", { name: /Legacy row.*Implementation/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Display direction"), { target: { value: "rtl" } });
    expect(laneStepNames(lane)).toEqual(["Implementation", "Design", "Research"]);
  });

  it("uses each task's retained definition and concurrent states without projecting auxiliary activity or a linear execution history", async () => {
    ipcMock.listBoardTasks.mockResolvedValue([
      makeTask({ name: "Original", slug: "shared", current_phase: "work", current_step_title: "Original work", latest_session_title: "Auxiliary notes" }),
      makeTask({ name: "Revised", slug: "revised", current_phase: "work", current_step_title: "Revised work" }),
      makeTask({ name: "Other repo", slug: "shared", repo_path: "/repo-b", current_phase: "work", current_step_title: "Other work" }),
    ]);
    ipcMock.getTaskExecution.mockImplementation(async (slug, repoPath) => {
      if (repoPath === "/repo-b") return retainedExecution([step("work", "Other work")], [["work", "queued"]]);
      if (slug === "revised")
        return retainedExecution(
          [step("work", "Revised work"), step("audit", "New audit")],
          [
            ["work", "running"],
            ["audit", "completed"],
          ],
        );
      const original = retainedExecution(
        [step("untouched", "Untouched"), step("gated", "Gated"), step("work", "Original work"), step("parallel", "Parallel review")],
        [
          ["work", "running"],
          ["work", "completed"],
          ["parallel", "finishing"],
        ],
      );
      original.state.enabled_steps = original.state.enabled_steps.filter((key) => key !== "gated");
      return original;
    });
    render(<Grid allRepos onOpen={() => {}} registerNav={() => {}} initialPreset="progress" />);
    const original = await screen.findByLabelText("Original retained steps");
    await waitFor(() => expect(laneStepNames(original)).toEqual(["Untouched", "Gated", "Original work", "Parallel review"]));
    expect(laneStepNames(screen.getByLabelText("Revised retained steps"))).toEqual(["Revised work", "New audit"]);
    expect(laneStepNames(screen.getByLabelText("Other repo retained steps"))).toEqual(["Other work"]);
    expect(screen.queryByLabelText(/Moved forward|Moved backward|Previous position/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Path labels"), { target: { value: "next" } });
    expect(laneStepNames(original)).toEqual(["Original work", "Parallel review"]);
    expect(laneStepNames(screen.getByLabelText("Revised retained steps"))).toEqual(["Revised work"]);
    expect(laneStepNames(screen.getByLabelText("Other repo retained steps"))).toEqual([]);
  });

  it("archives the selected repository explicitly with or without worktree removal", async () => {
    const sameSlugTasks = [
      makeTask({ name: "Repo A task", slug: "shared-slug", repo_path: "/repo-a" }),
      makeTask({ name: "Repo B task", slug: "shared-slug", repo_path: "/repo-b" }),
    ];
    ipcMock.listBoardTasks.mockResolvedValue(sameSlugTasks);
    let boardNav: BoardNav | null = null;
    render(<Grid allRepos onOpen={() => {}} registerNav={(nav) => (boardNav = nav)} />);

    const repoBCard = await screen.findByRole("button", { name: /Repo B task, repo-b/ });
    fireEvent.focus(repoBCard);
    await act(async () => {});

    await navReady(() => boardNav);
    act(() => requireNav(boardNav).archiveSelected());
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    await waitFor(() => expect(ipcMock.archiveTaskForRepo).toHaveBeenCalledWith("/repo-b", "shared-slug"));
    expect(ipcMock.archiveTaskForRepo).toHaveBeenCalledTimes(1);
    expect(ipcMock.removeWorktreeForRepo).not.toHaveBeenCalled();

    act(() => requireNav(boardNav).archiveSelected());
    fireEvent.click(screen.getByLabelText("Also permanently remove the worktree (uncommitted changes are lost)"));
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    await waitFor(() => expect(ipcMock.removeWorktreeForRepo).toHaveBeenCalledWith("/repo-b", "shared-slug"));
    expect(ipcMock.archiveTaskForRepo).toHaveBeenCalledTimes(2);
    expect(ipcMock.removeWorktreeForRepo).toHaveBeenCalledTimes(1);
  });

  it("keeps row-local paths, focus state, lane priority, and compact settings state", async () => {
    const onOpen = vi.fn();
    let boardNav: BoardNav | null = null;
    const { container } = render(<Grid allRepos={false} onOpen={onOpen} registerNav={(nav) => (boardNav = nav)} />);

    const packedCard = await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(packedCard);
    expect(onOpen).toHaveBeenCalledWith(tasks[0]);
    expect(boardNav).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });

    const apiCard = () => container.querySelector('.task-grid-card[data-task-id="/repo-a:build-api"]') as HTMLElement;
    expect(within(screen.getByLabelText("Build API retained steps")).getByRole("button", { name: /Build API, repo-a/ })).toBeDefined();
    fireEvent.change(screen.getByLabelText("Display direction"), { target: { value: "rtl" } });

    const firstColumn = screen.getByLabelText(/First column width/) as HTMLInputElement;
    fireEvent.change(firstColumn, { target: { value: "300" } });
    const apiRow = container.querySelector('.task-grid-lane-row[data-task-id="/repo-a:build-api"]') as HTMLElement;
    expect(apiRow.style.getPropertyValue("--task-grid-lane-label")).toBe("300px");

    fireEvent.click(screen.getByRole("button", { name: "Hide Review queue" }));
    expect(container.querySelector('.task-grid-card[data-task-id="/repo-b:review-queue"]')).toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Build API; use arrow keys" }), { key: "ArrowDown" });
    expect([...container.querySelectorAll(".task-grid-lane-name")].map((node) => node.textContent)).toEqual(["Release app", "Review queue", "Build API"]);
    expect((container.querySelectorAll(".task-grid-lane-row")[1] as HTMLElement).dataset.hidden).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Hide all" }));
    expect([...container.querySelectorAll(".task-grid-lane-row")].every((row) => (row as HTMLElement).dataset.hidden === "true")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unhide all" }));
    expect([...container.querySelectorAll(".task-grid-lane-row")].every((row) => (row as HTMLElement).dataset.hidden === "false")).toBe(true);

    fireEvent.change(screen.getByLabelText("Border by"), { target: { value: "accent" } });
    expect(screen.getByText("BORDER · Accent color")).toBeDefined();
    expect(apiCard().style.getPropertyValue("--task-grid-border")).toBe("var(--accent)");
    const accentBorderLegend = screen.getByText("BORDER · Accent color").closest(".task-grid-legend-row");
    expect(accentBorderLegend?.querySelector<HTMLElement>(".task-grid-legend-swatch.border")?.style.getPropertyValue("--task-grid-key-color")).toBe("var(--accent)");

    fireEvent.change(screen.getByLabelText("Fill by"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Border by"), { target: { value: "none" } });
    expect(screen.getByText("FILL · None")).toBeDefined();
    expect(screen.getByText("BORDER · None")).toBeDefined();
    expect(container.querySelectorAll(".task-grid-legend-swatch")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText("title"));
    expect(within(apiCard()).queryByText("Build API")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(screen.queryByLabelText(/First column width/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/First column width/) as HTMLInputElement).value).toBe("300");
    expect((screen.getByLabelText("Display direction") as HTMLSelectElement).value).toBe("rtl");
    expect((screen.getByLabelText("Fill by") as HTMLSelectElement).value).toBe("none");
  });
  it("shows archived tasks on demand and persists the choice per saved Grid", async () => {
    const archivedTask = makeTask({ name: "Archived task", slug: "archived-task", archived: true });
    ipcMock.listBoardTasks.mockResolvedValue([...tasks, archivedTask]);
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="archived-visibility" />);

    await screen.findByRole("button", { name: /Build API, repo-a/ });
    expect(screen.queryByRole("button", { name: /Archived task, repo-a/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByRole("button", { name: /Archived task, repo-a/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    first.unmount();

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="archived-visibility" />);
    expect(await screen.findByRole("button", { name: /Archived task, repo-a/ })).toBeDefined();
  });

  it("keeps separate row and column spacing when settings collapse and after remount", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="grid-spacing" />);

    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText(/Row spacing/), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText(/Column spacing/), { target: { value: "18" } });
    const firstGrid = first.container.querySelector(".task-grid-view") as HTMLElement;
    expect(firstGrid.style.getPropertyValue("--task-grid-row-gap")).toBe("6px");
    expect(firstGrid.style.getPropertyValue("--task-grid-column-gap")).toBe("18px");
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(firstGrid.classList.contains("settings-collapsed")).toBe(true);
    expect(firstGrid.style.getPropertyValue("--task-grid-row-gap")).toBe("6px");
    expect(firstGrid.style.getPropertyValue("--task-grid-column-gap")).toBe("18px");
    first.unmount();

    const second = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="grid-spacing" />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    const secondGrid = second.container.querySelector(".task-grid-view") as HTMLElement;
    expect(secondGrid.style.getPropertyValue("--task-grid-row-gap")).toBe("6px");
    expect(secondGrid.style.getPropertyValue("--task-grid-column-gap")).toBe("18px");
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/Row spacing/) as HTMLInputElement).value).toBe("6");
    expect((screen.getByLabelText(/Column spacing/) as HTMLInputElement).value).toBe("18");
  });

  it("ignores obsolete unified spacing", async () => {
    const storageKey = "obsolete-unified-spacing";
    const seed = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey={storageKey} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    seed.unmount();
    const storageName = `alinery:grid:${storageKey}`;
    const saved = JSON.parse(window.localStorage.getItem(storageName) ?? "{}");
    saved.config.spacing = 13;
    delete saved.config.rowSpacing;
    delete saved.config.columnSpacing;
    window.localStorage.setItem(storageName, JSON.stringify(saved));

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey={storageKey} />);
    await screen.findByRole("button", { name: /Build API, repo-a/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText(/Row spacing/) as HTMLInputElement).value).not.toBe("13");
    expect((screen.getByLabelText(/Column spacing/) as HTMLInputElement).value).not.toBe("13");
  });

  it("restores the compact workspace after leaving and returning to Grid", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a" />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    expect(first.container.querySelector(".task-grid-toolbar")).toBeNull();
    expect(first.container.querySelector(".task-grid-selected")).toBeNull();
    expect(first.container.querySelector(".task-grid-plan")).toBeNull();
    expect(first.container.querySelector(".task-grid-legend")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });
    fireEvent.change(screen.getByLabelText(/First column width/), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide Review queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Close grid settings" }));
    expect(first.container.querySelector(".task-grid-view")?.classList.contains("settings-collapsed")).toBe(true);
    first.unmount();

    const second = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a" />);
    await screen.findByLabelText("Build API retained steps");
    const reviewRow = second.container.querySelector('.task-grid-lane-row[data-task-id="/repo-b:review-queue"]') as HTMLElement;
    expect(reviewRow.dataset.hidden).toBe("true");
    expect(second.container.querySelector(".task-grid-toolbar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("custom");
    expect((screen.getByLabelText(/First column width/) as HTMLInputElement).value).toBe("300");
  });

  it("reorders lanes with the drag handle and restores the persisted order", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="pointer-order" />);

    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "progress" } });

    const target = first.container.querySelector('.task-grid-lane-row[data-task-id="/repo-b:review-queue"]') as HTMLElement;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 100,
      width: 500,
      height: 60,
      top: 100,
      right: 500,
      bottom: 160,
      left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });

    const source = first.container.querySelector('.task-grid-lane-row[data-task-id="/repo-a:build-api"]') as HTMLElement;
    fireEvent.pointerDown(screen.getByRole("button", { name: "Reorder Build API; use arrow keys" }), { button: 0, pointerId: 7, clientX: 20, clientY: 20 });
    const preview = first.container.querySelector(".task-grid-drag-preview") as HTMLElement;
    expect(preview.textContent).toContain("Build API");
    expect(preview.textContent).toContain("Moving row");
    expect(source.classList.contains("dragging")).toBe(true);
    const initialPreviewTop = preview.style.top;

    fireEvent.pointerMove(window, { pointerId: 7, clientX: 20, clientY: 150 });
    expect(target.classList.contains("drop-target")).toBe(true);
    expect(preview.style.top).not.toBe(initialPreviewTop);
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 20, clientY: 150 });
    expect(first.container.querySelector(".task-grid-drag-preview")).toBeNull();
    expect(source.classList.contains("dragging")).toBe(false);

    const laneNames = () => [...document.querySelectorAll(".task-grid-lane-name")].map((node) => node.textContent);
    await waitFor(() => expect(laneNames()).toEqual(["Review queue", "Build API", "Release app"]));
    first.unmount();

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="pointer-order" />);
    await screen.findByLabelText("Build API retained steps");
    expect(laneNames()).toEqual(["Review queue", "Build API", "Release app"]);
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  it("keeps stable view IDs isolated and gives additional views a useful neutral preset", async () => {
    const first = render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a:view:first" initialPreset="kanban" />);
    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "quadrants" } });
    first.unmount();

    render(<Grid allRepos={false} onOpen={() => {}} registerNav={() => {}} storageKey="repo-a:view:second" initialPreset="steps" />);
    await screen.findByRole("button", { name: /Build API, repo-a, SuperDevelop, Implementation/ });
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));

    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("steps");
    expect(window.localStorage.getItem("alinery:grid:repo-a:view:first")).not.toBeNull();
    expect(window.localStorage.getItem("alinery:grid:repo-a:view:second")).not.toBeNull();
  });
});
