import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DEFAULT_APPEARANCE } from "./appearance";
import type { SessionNoticeRow, SessionSort } from "./sessionAttention";
import type { AppConfig, BoardTask, CreateTaskResult, NotificationPrefs, PlaybookCatalog, ReviewHandoffResult, SessionListItem, SessionMeta, SessionTypeChoice, TaskActivitySession } from "./types";

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
  engine_version: 2,
  playbook_ref: { scope: "bundled", key: "superdevelop" },
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
    defaults: { harness: "claude", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
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
    createSessionForRepo: vi.fn(),
    startSession: vi.fn(),
    listPlaybookCatalog: vi.fn<() => Promise<PlaybookCatalog>>(),
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
  const isPrimaryTab = (kind: string) => ["kanban", "list", "grid", "sessions", "notifications", "playbooks", "settings"].includes(kind);
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
        onClick={() => void onCreated(task, { kind: "primary", step_key: "implementation" }, "omp", "", "  edited\nlaunch prompt ✓  ")}
      >
        finish create session
      </button>
      <button type="button" onClick={() => void onCreated(task, { kind: "auxiliary" }, "omp", "", "")}>
        finish empty-prompt session
      </button>
      <button type="button" onClick={() => void onCreated(task, { kind: "auxiliary" }, "no-harness", "")}>
        finish terminal session
      </button>
      <button type="button" onClick={() => void onCreated(task, { kind: "existing", session_id: "queued-design" }, "omp", "")}>
        start queued session
      </button>
    </div>
  ),
}));
vi.mock("./views/CreateTaskPage", () => ({
  CreateTaskPage: ({ initialDraft, onCreated }: { initialDraft?: BoardTask; onCreated: (result: CreateTaskResult & { repoPath: string; selectedSessionId?: string }) => void }) => {
    const result: CreateTaskResult & { repoPath: string } = {
      repoPath: task.repo_path, task, sessions: [session("root-a"), session("root-b")], executions: [],
      creation: "partial", start: "failed", errors: [{ stage: "launch", code: "launch_failed", message: "binary missing" }],
    };
    return <div>
      <span>create task:{initialDraft?.slug}</span>
      <button type="button" onClick={() => onCreated(result)}>open created task</button>
      <button type="button" onClick={() => onCreated({ ...result, selectedSessionId: "root-b" })}>open second created session</button>
      <button type="button" onClick={() => onCreated({ ...result, task: null, sessions: [] })}>report failed creation</button>
    </div>;
  },
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
    intent,
    onBack,
    onStartFresh,
    onStartReviewHandoff,
  }: {
    id: string;
    intent?: string;
    onBack: () => void;
    onStartFresh: () => void;
    onStartReviewHandoff: (source: { task: string; session: string; artifact: string }) => void;
  }) => {
    return (
      <div>
        <span>session:{id}</span>
        <span>session intent:{intent}</span>
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
  target_repo_path: task.repo_path,
  start: "not_requested",
  errors: [],
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
  ipcMocks.createSessionForRepo.mockResolvedValue({ session: session("created-implementation", "implementation"), execution: null, start: "started" });
  ipcMocks.startSession.mockResolvedValue({ session: session("queued-design"), execution: null, start: "started" });
  ipcMocks.listPlaybookCatalog.mockResolvedValue({ candidates: [], picker_preferences: { order: [], entries: [] }, diagnostics: [] });
  ipcMocks.markSessionNotificationRead.mockResolvedValue(undefined);
  ipcMocks.setActiveRepo.mockResolvedValue(appConfig);
  ipcMocks.listSessionItems.mockResolvedValue([]);
  ipcMocks.sessionListStatuses.mockResolvedValue({});
  ipcMocks.clearSessionNotifications.mockResolvedValue(undefined);
  ipcMocks.setDockBadgeCount.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

it("replaces the intro with Playbooks while retaining the global draft on return", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const style = document.createElement("style");
  style.textContent = readFileSync("src/theme.css", "utf8");
  document.head.append(style);
  try {
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, active_repo: "" });
    render(<App />);
    const introButton = await screen.findByRole("button", { name: "Playbooks" });
    const intro = introButton.closest(".view") as HTMLElement;
    expect(getComputedStyle(intro).display).toBe("flex");
    fireEvent.click(introButton);
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    expect(getComputedStyle(intro).display).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Paste source" }));
    const editor = await screen.findByRole("textbox", { name: "Playbook source" });
    fireEvent.change(editor, { target: { value: "Keep this global draft" } });
    expect(screen.queryByRole("button", { name: "Back to previous view" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(getComputedStyle(intro).display).toBe("flex");
    expect(getComputedStyle(editor.closest(".view") as HTMLElement).display).toBe("none");
    fireEvent.click(await screen.findByRole("button", { name: "Playbooks" }));
    expect(getComputedStyle(intro).display).toBe("none");
    expect(await screen.findByRole("textbox", { name: "Playbook source" })).toHaveProperty("value", "Keep this global draft");
  } finally {
    style.remove();
  }
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

describe("creation result navigation", () => {
  it("opens the task without selecting one of multiple returned sessions", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(await screen.findByRole("button", { name: "open created task" }));
    await screen.findByText("task detail:task");
    expect(screen.queryByText("session:root-a")).toBeNull();
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();
  });

  it("attaches only the session explicitly selected from the creation result", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(await screen.findByRole("button", { name: "open second created session" }));
    await screen.findByText("session:root-b");
    expect(screen.getByText("session intent:attach")).toBeTruthy();
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenCalledWith("/repo", "task", "root-b");
    expect(ipcMocks.createSessionForRepo).not.toHaveBeenCalled();
  });

  it("stays on creation when the result has no task", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    fireEvent.click(await screen.findByRole("button", { name: "report failed creation" }));
    expect(screen.getByRole("button", { name: "open created task" })).toBeTruthy();
    expect(screen.queryByText("task detail:task")).toBeNull();
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();
  });
});

describe("Playbooks navigation", () => {
  it("opens the library from a task and returns with the keyboard", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    await screen.findByText("task detail:task");
    fireEvent.click(screen.getByRole("button", { name: "Playbooks" }));
    await screen.findByRole("list", { name: "Playbook library" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await screen.findByText("task detail:task");
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
    expect(ipcMocks.createSessionForRepo).toHaveBeenLastCalledWith({
      repoPath: "/repo",
      request: {
        task_slug: "task",
        target: { kind: "primary", step_key: "implementation" },
        launch_override: { harness: "omp", model: "" },
        prompt_extra: "  edited\nlaunch prompt ✓  ",
        start: true,
      },
    });
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "created-implementation");
  });

  it("preserves an explicit empty prompt and omits terminal prompts", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "new task session" }));
    fireEvent.click(await screen.findByRole("button", { name: "finish empty-prompt session" }));
    await screen.findByText("session:created-implementation");
    expect(ipcMocks.createSessionForRepo).toHaveBeenLastCalledWith({
      repoPath: "/repo",
      request: { task_slug: "task", target: { kind: "auxiliary", harness: "omp", model: "", prompt: "" }, start: true },
    });

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "new task session" }));
    fireEvent.click(await screen.findByRole("button", { name: "finish terminal session" }));
    await screen.findByText("session:created-implementation");
    expect(ipcMocks.createSessionForRepo).toHaveBeenLastCalledWith({
      repoPath: "/repo",
      request: { task_slug: "task", target: { kind: "auxiliary", harness: "no-harness", model: "", prompt: undefined }, start: true },
    });
  });

  it("lets start-fresh choose an execution and acknowledges that target", async () => {
    await renderApp();
    await openGlobalSession();
    fireEvent.click(screen.getByRole("button", { name: "start fresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "start queued session" }));
    await screen.findByText("session:queued-design");
    expect(ipcMocks.startSession).toHaveBeenCalledWith("task", "queued-design", "/repo");
    expect(ipcMocks.createSessionForRepo).not.toHaveBeenCalled();
    expect(screen.getByText("session intent:attach")).toBeTruthy();
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "queued-design");

    fireEvent.click(screen.getByRole("button", { name: "review handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: "confirm review handoff" }));
    await screen.findByText("session:review-target");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "review-task", "review-target");
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
