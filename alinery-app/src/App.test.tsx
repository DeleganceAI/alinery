import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DEFAULT_APPEARANCE } from "./appearance";
import type { SessionNoticeRow, SessionSort } from "./sessionAttention";
import type { AppConfig, BoardTask, NotificationPrefs, ReviewHandoffResult, SessionListItem, SessionMeta, SessionTypeChoice, TaskActivitySession } from "./types";

const task: BoardTask = {
  name: "Task",
  slug: "task",
  requested_slug: "task",
  branch: "task",
  worktree: "/repo/.alinery/worktrees/task",
  has_worktree: true,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "superdevelop",
  draft: false,
  auto_advance: [],
  repo_path: "/repo",
  session_count: 2,
  playbook_title: "SuperDevelop",
  updated: 2,
  current_phase: "tdd",
  current_step_title: "TDD",
  latest_session_title: "TDD",
  latest_session_column_key: "planning",
  current_column_key: "planning",
  current_column_title: "Planning",
};

const activeDraft: BoardTask = {
  ...task,
  name: "Active Draft",
  slug: "active-draft",
  requested_slug: "active-draft",
  draft: true,
};

const archivedDraft: BoardTask = {
  ...activeDraft,
  name: "Archived Draft",
  slug: "archived-draft",
  requested_slug: "archived-draft",
  archived: true,
};

const session = (id: string, phase = "design"): SessionMeta => ({
  id,
  worktree: task.worktree,
  created: 10,
  archived: false,
  phase,
  harness: "omp",
  model: "",
  playbook: "superdevelop",
  generic: false,
  artifact: "",
  handoff_artifact: "",
  prompt_extra: "",
  prompt: null,
  harness_resume_token: "token",
  resume_of: null,
  semantic: null,
});

const activeSession: TaskActivitySession = {
  id: "active-design",
  worktree: task.worktree,
  phase: "design",
  harness: "omp",
  model: "",
  playbook: "superdevelop",
  generic: false,
  step_title: "Design",
};

const globalSession: SessionListItem = {
  ...session("global-design"),
  task_slug: task.slug,
  task_name: task.name,
  task_worktree: task.worktree,
  repo_path: task.repo_path,
  playbook_title: "SuperDevelop",
  step_title: "Design",
  is_playbook_step: true,
};

const foreignSession: SessionListItem = {
  ...globalSession,
  id: "foreign-design",
  worktree: "/foreign/.alinery/worktrees/task",
  task_worktree: "/foreign/.alinery/worktrees/task",
  repo_path: "/foreign",
};

const notificationPrefs: NotificationPrefs = {
  enabled: true,
  sound: true,
  bounce: false,
  banner: true,
  dock_badge: true,
  dock_badge_input_waits: true,
  dock_badge_approval_waits: true,
  dock_badge_failures: true,
  dock_badge_completions: true,
};

const appConfig: AppConfig = {
  active_repo: task.repo_path,
  known_repos: [task.repo_path],
  mcp_enabled: true,
  appearance: DEFAULT_APPEARANCE,
  global: {
    notifications: notificationPrefs,

    github: { token: "" },
    defaults: { harness: "claude", model: "", playbook: "superdevelop", draft_autosave: true },
    backup: {
      destination: "",
      enabled: false,
      retention: 5,
      trigger_pre_archive: false,
      trigger_post_artifact_change: false,
      trigger_post_push_commit: false,
    },
    harnesses: { harness: [] },
    model_favorites: {},
    telemetry: { enabled: true, prompted: true, install_id: "", endpoint: "https://telemetry.alinery.ai" },
    updates: { check_enabled: true },
  },
};

const { ipcMocks, ipcModule } = vi.hoisted(() => {
  const ipcMocks = {
    createSession: vi.fn(),
    getCurrentWindow: vi.fn(() => ({
      destroy: vi.fn(),
      onCloseRequested: vi.fn(async () => () => {}),
    })),
    getName: vi.fn(async () => "Alinery"),
    getVersion: vi.fn(async () => "0.11.1"),
    markSessionNotificationRead: vi.fn(async () => {}),
    listSessionItems: vi.fn(),
    sessionListStatuses: vi.fn(),
    clearSessionNotifications: vi.fn(),
    setDockBadgeCount: vi.fn(),
    readAppConfig: vi.fn(),
    setActiveRepo: vi.fn(),
    accountStatus: vi.fn(async () => ({ signedIn: false, email: null, plan: null, paid: false, unavailable: false })),
    accountRefresh: vi.fn(async () => ({ signedIn: false, email: null, plan: null, paid: false, unavailable: false })),
  };
  const cache: Record<string, unknown> = {};
  const ipcModule = new Proxy(ipcMocks, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string" || ["then", "catch", "finally", "__esModule"].includes(prop)) return undefined;
      if (prop in target) return target[prop as keyof typeof target];
      if (!(prop in cache)) {
        cache[prop] = vi.fn(() => Promise.reject(new Error(`Unstubbed ipc.${prop} call`)));
      }
      return cache[prop];
    },
    has: () => true,
  });
  return { ipcMocks, ipcModule };
});

vi.mock("./ipc", () => ipcModule);
vi.mock("./tabMotion", () => {
  const isPrimaryTab = (kind: string) => ["kanban", "list", "grid", "sessions", "notifications", "settings"].includes(kind);
  return {
    isPrimaryTab,
    primaryTabOf: (view: { kind: string; from?: unknown }) => {
      let current = view;
      while (!isPrimaryTab(current.kind)) current = current.from as typeof current;
      return current.kind;
    },
    gridViewIdOf: (view: { kind: string; gridViewId?: string; from?: unknown }) => {
      let current = view;
      while (!isPrimaryTab(current.kind)) current = current.from as typeof current;
      return current.kind === "grid" ? current.gridViewId : undefined;
    },
    useTabPill: () => {},
    viewFadeClass: () => "",
  };
});
vi.mock("./useDaemonStatus", () => ({
  useDaemonStatus: () => ({
    reachable: false,
    mode: "local",
    alive: 0,
    busy: 0,
    waiting_for_input: 0,
    waiting_for_approval: 0,
    idle: 0,
    unknown: 0,
    exited: 0,
    total: 0,
    extra_lanes: 0,
    stale_lanes: 0,
    repo: "/repo",
    build_drift: false,
    conflict: null,
    repo_busy: false,
  }),
}));
vi.mock("./useMcpStatus", () => ({
  useMcpStatus: () => ({
    enabled: true,
    running: false,
    clients: 0,
    socket_reachable: false,
    binary_found: true,
    binary_path: "",
    repo: "/repo",
    socket_path: "",
    error: "",
    refresh: () => {},
  }),
  mcpFooterLabel: () => "",
}));
vi.mock("./useHotkeys", () => ({ useHotkeys: () => {} }));
vi.mock("./telemetry-consent", () => ({
  shouldAskTelemetryConsent: () => false,
  TELEMETRY_CONSENT_CHOICES: [],
  telemetryConsentWrite: () => "later",
}));
vi.mock("./WindowChrome", () => ({
  ResizeHandles: () => null,
  WindowControls: () => null,
  useWindowFullscreen: () => false,
}));
vi.mock("./TerminalDrawer", () => ({
  DRAWER_DEFAULT_WIDTH: 400,
  clampDrawerWidth: (value: number) => value,
  TerminalDrawer: () => null,
}));
vi.mock("./views/Kanban", () => ({
  Kanban: ({ onOpen, onOpenActiveSession }: { onOpen: (value: BoardTask) => void; onOpenActiveSession: (value: BoardTask, session: TaskActivitySession) => void }) => (
    <div>
      <button type="button" onClick={() => onOpen(task)}>
        open task
      </button>
      <button type="button" onClick={() => onOpen(activeDraft)}>
        open active draft
      </button>
      <button type="button" onClick={() => onOpen(archivedDraft)}>
        open archived draft
      </button>
      <button type="button" onClick={() => onOpenActiveSession(task, activeSession)}>
        open active card session
      </button>
    </div>
  ),
}));

vi.mock("./views/Grid", () => ({
  Grid: ({ onOpen, storageKey }: { onOpen?: (value: BoardTask) => void; storageKey?: string }) => {
    const [layoutRevision, setLayoutRevision] = useState(0);
    return (
      <div data-testid={`grid:${storageKey}`}>
        <span>Grid layout revision {layoutRevision}</span>
        <button type="button" onClick={() => setLayoutRevision((revision) => revision + 1)}>
          Change Grid layout
        </button>
        <button type="button" onClick={() => onOpen?.(task)}>
          open task
        </button>
        <button type="button" onClick={() => onOpen?.(activeDraft)}>
          open active draft
        </button>
        <button type="button" onClick={() => onOpen?.(archivedDraft)}>
          open archived draft
        </button>
      </div>
    );
  },
}));
vi.mock("./views/TaskList", () => ({
  TaskList: ({ onOpen, onOpenActiveSession }: { onOpen: (value: BoardTask) => void; onOpenActiveSession: (value: BoardTask, session: TaskActivitySession) => void }) => (
    <div>
      <button type="button" onClick={() => onOpen(task)}>
        open list task
      </button>
      <button type="button" onClick={() => onOpenActiveSession(task, activeSession)}>
        open active list session
      </button>
    </div>
  ),
}));
vi.mock("./views/SessionsList", () => ({
  SessionsList: ({
    onOpen,
    sessionSort,
    onSessionSortChange,
  }: {
    onOpen: (value: SessionListItem) => void;
    sessionSort: SessionSort;
    onSessionSortChange: (sort: SessionSort) => void;
  }) => (
    <div>
      <span>global sort:{sessionSort.field}</span>
      <button type="button" onClick={() => onSessionSortChange({ field: "updated", direction: "desc" })}>
        choose global updated
      </button>
      <button type="button" onClick={() => onOpen(globalSession)}>
        open global session
      </button>
    </div>
  ),
}));
vi.mock("./views/NotificationsList", () => ({
  NotificationsList: ({
    allRepos,
    activeRepo,
    rows,
    onClear,
    onClearAll,
    onOpen,
    registerNav,
  }: {
    allRepos: boolean;
    activeRepo: string;
    rows: SessionNoticeRow[];
    onClear: () => Promise<void>;
    onClearAll: () => Promise<void>;
    onOpen: (value: SessionListItem) => void;
    registerNav: (nav: unknown) => void;
  }) => (
    <div data-scope={allRepos ? "all" : activeRepo} data-global-rows={rows.length} data-register-nav={typeof registerNav}>
      <button type="button" onClick={() => void onClear()}>
        clear shared notifications
      </button>
      <button type="button" onClick={() => void onClearAll()}>
        clear all shared notifications
      </button>
      <button type="button" onClick={() => onOpen(globalSession)}>
        open notification session
      </button>
      <button type="button" onClick={() => onOpen(foreignSession)}>
        open foreign notification
      </button>
    </div>
  ),
}));
vi.mock("./views/TaskDetail", () => ({
  TaskDetail: ({
    initialTask,
    onOpenSession,
    onNewSession,
    onBack,
    sessionSort,
    onSessionSortChange,
  }: {
    initialTask?: BoardTask;
    onOpenSession: (ownerTaskSlug: string, id: string, cwd: string, phase: string, harness: string, model: string, playbook: string, generic: boolean) => void;
    onNewSession: () => void;
    onBack: () => void;
    sessionSort: SessionSort;
    onSessionSortChange: (sort: SessionSort) => void;
  }) => (
    <div>
      <span>task detail:{initialTask?.slug}</span>
      <span>task sort:{sessionSort.field}</span>
      <button type="button" onClick={() => onSessionSortChange({ field: "started", direction: "desc" })}>
        choose task started
      </button>
      <button type="button" onClick={onBack}>
        back from task
      </button>
      <button type="button" onClick={() => onOpenSession(task.slug, "detail-design", task.worktree, "design", "omp", "", "superdevelop", false)}>
        open detail session
      </button>
      <button type="button" onClick={onNewSession}>
        new task session
      </button>
    </div>
  ),
}));
vi.mock("./views/CreateSessionPage", () => ({
  CreateSessionPage: ({ onCreated }: { onCreated: (task: BoardTask, choice: SessionTypeChoice, harness: string, model: string, prompt?: string) => Promise<void> }) => (
    <div>
      <button
        type="button"
        onClick={() => void onCreated(task, { kind: "playbook-step", playbook: "superdevelop", phase: "implementation" }, "omp", "", "  edited\nlaunch prompt ✓  ")}
      >
        finish create session
      </button>
      <button type="button" onClick={() => void onCreated(task, { kind: "generic" }, "omp", "", "")}>
        finish empty-prompt session
      </button>
      <button type="button" onClick={() => void onCreated(task, { kind: "generic" }, "no-harness", "", "stale prompt")}>
        finish terminal session
      </button>
    </div>
  ),
}));
vi.mock("./views/CreateTaskPage", () => ({
  CreateTaskPage: ({ initialDraft }: { initialDraft?: BoardTask }) => <div>create task:{initialDraft?.slug}</div>,
}));
vi.mock("./views/Settings", () => ({
  SECTIONS: [],
  Settings: ({ onNotificationsChange }: { onNotificationsChange: (next: NotificationPrefs) => void }) => (
    <button type="button" onClick={() => onNotificationsChange({ ...notificationPrefs, dock_badge_failures: false })}>
      save notification settings
    </button>
  ),
}));
vi.mock("./views/SessionView", () => ({
  SessionView: ({
    id,
    onBack,
    onStartFresh,
    onStartReviewHandoff,
  }: {
    id: string;
    onBack: () => void;
    onStartFresh: () => void;
    onStartReviewHandoff: (source: { task: string; session: string; artifact: string }) => void;
  }) => {
    return (
      <div>
        <span>session:{id}</span>
        <button type="button" onClick={onBack}>
          back from session
        </button>
        <button type="button" onClick={onStartFresh}>
          start fresh
        </button>
        <button type="button" onClick={() => onStartReviewHandoff({ task: task.slug, session: id, artifact: "06-implementation.md" })}>
          review handoff
        </button>
      </div>
    );
  },
}));

const handoffResult: ReviewHandoffResult = {
  target_artifact: "07-review.md",
  target_session: session("review-target", "review-findings"),
  source_record: {
    version: 1,
    direction: "source",
    source_task: task.slug,
    source_session: "global-design",
    source_artifact: "06-implementation.md",
    target_task: "review-task",
    target_artifact: "07-review.md",
    target_session: "review-target",
    target_phase: "review-findings",
    created_at_ms: 1,
  },
  target_record: {
    version: 1,
    direction: "target",
    source_task: task.slug,
    source_session: "global-design",
    source_artifact: "06-implementation.md",
    target_task: "review-task",
    target_artifact: "07-review.md",
    target_session: "review-target",
    target_phase: "review-findings",
    created_at_ms: 1,
  },
};

vi.mock("./views/ReviewHandoffPage", () => ({
  ReviewHandoffPage: ({ onConfirmed }: { onConfirmed: (result: ReviewHandoffResult) => Promise<void> }) => (
    <button type="button" onClick={() => void onConfirmed(handoffResult)}>
      confirm review handoff
    </button>
  ),
}));

beforeEach(() => {
  ipcMocks.readAppConfig.mockResolvedValue(appConfig);
  ipcMocks.createSession.mockResolvedValue(session("created-implementation", "implementation"));
  ipcMocks.markSessionNotificationRead.mockResolvedValue(undefined);
  ipcMocks.setActiveRepo.mockResolvedValue(appConfig);
  ipcMocks.listSessionItems.mockResolvedValue([]);
  ipcMocks.sessionListStatuses.mockResolvedValue({});
  ipcMocks.clearSessionNotifications.mockResolvedValue(undefined);
  ipcMocks.setDockBadgeCount.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

async function renderApp() {
  render(<App />);
  await screen.findByRole("button", { name: "Search" });
}

async function openGlobalSession() {
  fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
  fireEvent.click(await screen.findByRole("button", { name: "open global session" }));
  await screen.findByText("session:global-design");
}

describe("draft routing", () => {
  it("opens active drafts in Create Task and archived drafts in Task Detail", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open active draft" }));
    await screen.findByText("create task:active-draft");

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open archived draft" }));
    await screen.findByText("task detail:archived-draft");
  });
});

describe("session navigation acknowledgment", () => {
  it("does not acknowledge when opening only a task", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    await screen.findByRole("button", { name: "open detail session" });
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    await screen.findByRole("button", { name: "open detail session" });
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();
  });

  it("acknowledges task-card and global-list sessions before navigation", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      global: { ...appConfig.global, experiments: { show_original_kanban: true } },
    });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Kanban3" }));
    fireEvent.click(await screen.findByRole("button", { name: "open active card session" }));
    await screen.findByText("session:active-design");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "active-design");

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open active list session" }));
    await screen.findByText("session:active-design");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "active-design");

    cleanup();

    await renderApp();
    let release: (() => void) | undefined;
    ipcMocks.markSessionNotificationRead.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open global session" }));
    expect(screen.queryByText("session:global-design")).toBeNull();
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "global-design");
    await act(async () => release?.());
    await screen.findByText("session:global-design");
  });
  it("opens the session when notification acknowledgment fails", async () => {
    ipcMocks.markSessionNotificationRead.mockRejectedValueOnce(new Error("acknowledgment failed"));
    await renderApp();

    await openGlobalSession();

    expect(ipcMocks.markSessionNotificationRead).toHaveBeenCalledWith("/repo", "task", "global-design");
  });
  it("renders the scoped Notifications tab and routes its exact session through acknowledgment", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    const row = await screen.findByRole("button", { name: "open notification session" });
    const notificationView = row.closest("[data-scope]");
    expect(notificationView?.getAttribute("data-scope")).toBe("/repo");
    expect(notificationView?.getAttribute("data-register-nav")).toBe("function");
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();

    fireEvent.click(row);
    await screen.findByText("session:global-design");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenCalledOnce();
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenCalledWith("/repo", "task", "global-design");
  });

  it("switches repositories before acknowledging a foreign notification row", async () => {
    ipcMocks.setActiveRepo.mockResolvedValueOnce({
      ...appConfig,
      active_repo: "/foreign",
      known_repos: ["/repo", "/foreign"],
    });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open foreign notification" }));
    await screen.findByText("session:foreign-design");

    expect(ipcMocks.setActiveRepo).toHaveBeenCalledWith("/foreign", null);
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenCalledWith("/foreign", "task", "foreign-design");
    expect(ipcMocks.setActiveRepo.mock.invocationCallOrder[0]).toBeLessThan(ipcMocks.markSessionNotificationRead.mock.invocationCallOrder[0]);
  });

  it("acknowledges Task Detail and newly created sessions exactly", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "open detail session" }));
    await screen.findByText("session:detail-design");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "detail-design");

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "new task session" }));
    fireEvent.click(await screen.findByRole("button", { name: "finish create session" }));
    await screen.findByText("session:created-implementation");
    expect(ipcMocks.createSession).toHaveBeenLastCalledWith({
      taskSlug: "task",
      playbook: "superdevelop",
      phase: "implementation",
      generic: false,
      harness: "omp",
      model: "",
      prompt: "  edited\nlaunch prompt ✓  ",
    });
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "created-implementation");
  });

  it("preserves an explicit empty prompt and omits terminal prompts", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "new task session" }));
    fireEvent.click(await screen.findByRole("button", { name: "finish empty-prompt session" }));
    await screen.findByText("session:created-implementation");
    expect(ipcMocks.createSession).toHaveBeenLastCalledWith({
      taskSlug: "task",
      playbook: "",
      phase: "",
      generic: true,
      harness: "omp",
      model: "",
      prompt: "",
    });

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "new task session" }));
    fireEvent.click(await screen.findByRole("button", { name: "finish terminal session" }));
    await screen.findByText("session:created-implementation");
    expect(ipcMocks.createSession).toHaveBeenLastCalledWith({
      taskSlug: "task",
      playbook: "",
      phase: "",
      generic: true,
      harness: "no-harness",
      model: "",
    });
  });

  it("acknowledges start-fresh and review-handoff targets exactly", async () => {
    await renderApp();
    await openGlobalSession();
    ipcMocks.createSession.mockResolvedValueOnce(session("fresh-design"));
    fireEvent.click(screen.getByRole("button", { name: "start fresh" }));
    await screen.findByText("session:fresh-design");
    expect(ipcMocks.createSession).toHaveBeenLastCalledWith({
      taskSlug: "task",
      playbook: "superdevelop",
      phase: "design",
      generic: false,
      harness: "omp",
      model: "",
    });
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "fresh-design");

    fireEvent.click(screen.getByRole("button", { name: "review handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm review handoff" }));
    await screen.findByText("session:review-target");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "review-task", "review-target");
  });

  it("lists the remapped top-level actions in the command palette", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect((await screen.findByText("Go to Tasks")).closest(".pitem")?.textContent).toContain("⌘1");
    expect(screen.getByText("Go to Kanban+").closest(".pitem")?.textContent).toContain("⌘2");
    expect(screen.getByText("Go to Kanban").closest(".pitem")?.textContent).toContain("⌘3");
    expect(screen.getByText("Go to Sessions").closest(".pitem")?.textContent).toContain("⌘7");
    expect(screen.getByText("Go to Notifications").closest(".pitem")?.textContent).toContain("⌘8");
    expect(screen.queryByText("Go to Wiki")).toBeNull();
    expect(screen.getByText("Open Settings").closest(".pitem")?.textContent).toContain("⌘9");
  });

  it("exposes both boards by default and opens classic Kanban", async () => {
    await renderApp();

    expect(screen.getByRole("button", { name: /Kanban\+/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Kanban3" }));
    expect(await screen.findByRole("button", { name: "open active card session" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Go to Kanban+")).toBeTruthy();
    expect(screen.getByText("Go to Kanban")).toBeTruthy();
  });

  it("lists classic Kanban at ⌘3 when the experimental tab is enabled", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      global: { ...appConfig.global, experiments: { show_original_kanban: true } },
    });
    await renderApp();

    expect(screen.getByRole("button", { name: "Kanban3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByText("Go to Kanban")).closest(".pitem")?.textContent).toContain("⌘3");
  });

  it("keeps a visited Grid mounted while navigating away and back", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Kanban\+/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Change Grid layout" }));
    expect(screen.getByText("Grid layout revision 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(screen.getByRole("button", { name: /Kanban\+/ }));

    expect(await screen.findByText("Grid layout revision 1")).toBeTruthy();
  });

  it("renders configured Grid views in order and falls into the first when original Kanban is hidden", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      global: {
        ...appConfig.global,
        experiments: { show_original_kanban: false },
        grid_views: [
          { id: "planning", name: "Planning", slot: 1 },
          { id: "triage", name: "Triage", slot: 2 },
          { id: "archive", name: "Archive map", slot: 3 },
        ],
      },
    });
    await renderApp();

    // First paint can still be default-kanban-plus until appConfig reconciles onto
    // the first configured Grid view; wait for that, not merely for the tab to exist.
    const planning = await screen.findByRole("button", { name: "Planning2", current: "page" });
    expect(planning.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Tasks1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Kanban3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Triage4" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive map5" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByText("Go to Planning")).closest(".pitem")?.textContent).toContain("⌘2");
    expect(screen.getByText("Go to Triage").closest(".pitem")?.textContent).toContain("⌘4");
    expect(screen.queryByText("Go to Kanban")).toBeNull();
  });
});

describe("session sort lifetime", () => {
  it("keeps independent Task Detail and Sessions sorts across navigation for the current launch", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(await screen.findByText("global sort:priority")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "choose global updated" }));
    expect(await screen.findByText("global sort:updated")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    expect(await screen.findByText("task sort:priority")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "choose task started" }));
    expect(await screen.findByText("task sort:started")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "back from task" }));
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(await screen.findByText("global sort:updated")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    expect(await screen.findByText("task sort:started")).toBeDefined();
  });
});

describe("global notification owner", () => {
  it("polls outside Notifications and does not add a view-local owner", async () => {
    await renderApp();
    await waitFor(() => expect(ipcMocks.listSessionItems).toHaveBeenCalledWith(true, false));
    expect(ipcMocks.sessionListStatuses).toHaveBeenCalledWith([]);
    const calls = ipcMocks.listSessionItems.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    await screen.findByRole("button", { name: "open notification session" });
    expect(ipcMocks.listSessionItems).toHaveBeenCalledTimes(calls);
  });

  it("refreshes after acknowledgment settles on both success and failure", async () => {
    await renderApp();
    await waitFor(() => expect(ipcMocks.listSessionItems).toHaveBeenCalled());
    ipcMocks.listSessionItems.mockClear();
    await openGlobalSession();
    await waitFor(() => expect(ipcMocks.listSessionItems).toHaveBeenCalledWith(true, false));

    cleanup();
    ipcMocks.listSessionItems.mockClear();
    ipcMocks.markSessionNotificationRead.mockRejectedValueOnce(new Error("acknowledgment failed"));
    await renderApp();
    await waitFor(() => expect(ipcMocks.listSessionItems).toHaveBeenCalled());
    ipcMocks.listSessionItems.mockClear();
    await openGlobalSession();
    await waitFor(() => expect(ipcMocks.listSessionItems).toHaveBeenCalledWith(true, false));
  });

  it("applies saved badge preferences immediately and requests a refresh", async () => {
    const failure = { ...globalSession, id: "failure", ended_at: 20, exit_code: 2 };
    ipcMocks.listSessionItems.mockResolvedValue([failure]);
    await renderApp();
    await waitFor(() => expect(ipcMocks.setDockBadgeCount).toHaveBeenCalledWith(1));
    ipcMocks.listSessionItems.mockClear();

    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "save notification settings" }));
    await waitFor(() => expect(ipcMocks.setDockBadgeCount).toHaveBeenLastCalledWith(0));
    expect(ipcMocks.listSessionItems).toHaveBeenCalledWith(true, false);
  });

  it("keeps badge and clear sources global while active scope filters presentation", async () => {
    const active = { ...globalSession, id: "active-completion", semantic: { phase_completed_at: 20 } };
    const foreign = { ...foreignSession, id: "foreign-completion", semantic: { phase_completed_at: 21 } };
    ipcMocks.listSessionItems.mockResolvedValue([active, foreign]);
    await renderApp();
    await waitFor(() => expect(ipcMocks.setDockBadgeCount).toHaveBeenCalledWith(2));

    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    const notificationView = (await screen.findByRole("button", { name: "clear shared notifications" })).closest("[data-scope]");
    expect(notificationView?.getAttribute("data-scope")).toBe("/repo");
    expect(notificationView?.getAttribute("data-global-rows")).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "clear shared notifications" }));
    await waitFor(() => expect(ipcMocks.clearSessionNotifications).toHaveBeenCalled());
    const refs = ipcMocks.clearSessionNotifications.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(2);
    expect(refs).toEqual(
      expect.arrayContaining([
        { repo_path: "/repo", task_slug: "task", id: "active-completion" },
        { repo_path: "/foreign", task_slug: "task", id: "foreign-completion" },
      ]),
    );
  });
});
