import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { DEFAULT_APPEARANCE } from "./appearance";
import * as ipc from "./ipc";
import { CURATED_PLAYBOOK_ARCHETYPES } from "./onboarding";
import type { SessionNoticeRow } from "./sessionAttention";
import type {
  AppConfig,
  AppearancePrefs,
  BoardTask,
  Config,
  CreateTaskResult,
  NotificationPrefs,
  PlaybookCatalog,
  PlaybookRef,
  ReviewHandoffResult,
  ScopedPlaybook,
  SessionListItem,
  SessionMeta,
  SessionTypeChoice,
  TaskActivitySession,
} from "./types";
import type * as CreateTaskModule from "./views/CreateTaskPage";
import { executionReply } from "./views/executionTestFixture";
import type * as ProviderSetupModule from "./views/ProviderSetupDialog";
import type { SessionsList as SessionsListComponent } from "./views/SessionsList";
import type { TaskDetail as TaskDetailComponent } from "./views/TaskDetail";
import type { TaskList as TaskListComponent } from "./views/TaskList";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  playbook_steps: [],
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

const actualCreation = vi.hoisted(() => ({ enabled: false }));
const actualProviders = vi.hoisted(() => ({ enabled: false }));
const namingScenario = vi.hoisted(() => ({ realSessions: false, realTaskDetail: false }));

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
    renameSession: vi.fn(),
    listBoardTasks: vi.fn(),
    renameTask: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    subtaskState: vi.fn(),
    listSessions: vi.fn(),
    getTaskExecution: vi.fn(),
    observeTaskExecutions: vi.fn(async (tasks: { repoPath: string; taskSlug: string }[]) =>
      Promise.all(
        tasks.map(async (task) => {
          try {
            return { repo_path: task.repoPath, task_slug: task.taskSlug, execution: await ipcMocks.getTaskExecution(task.taskSlug, task.repoPath) };
          } catch (error) {
            return { repo_path: task.repoPath, task_slug: task.taskSlug, error: String(error) };
          }
        }),
      ),
    ),
    listArtifactsWithMetadata: vi.fn(),
    listTaskArtifactTree: vi.fn(),
    listArtifactCommentDraftsForRepo: vi.fn(),
    worktreeExists: vi.fn(),
    clearSessionNotifications: vi.fn(),
    setDockBadgeCount: vi.fn(),
    readAppConfig: vi.fn(),
    setActiveRepo: vi.fn(),
    pickRepoDialog: vi.fn(),
    classifyPickedFolder: vi.fn(),
    initPickedFolder: vi.fn(),
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
  const isPrimaryTab = (kind: string) => ["list", "grid", "sessions", "chat", "notifications", "playbooks", "settings"].includes(kind);
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
    refresh: () => {},
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
const telemetryScenario = vi.hoisted(() => ({ ask: false }));
vi.mock("./telemetry-consent", () => ({
  shouldAskTelemetryConsent: () => telemetryScenario.ask,
  TELEMETRY_CONSENT_CHOICES: [{ key: "opt-out", label: "Don't share" }],
  telemetryConsentWrite: () => "later",
}));
vi.mock("./views/ProviderSetupDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderSetupModule>();
  return {
    ...actual,
    ProviderSetupDialog: (props: Parameters<typeof actual.ProviderSetupDialog>[0]) =>
      actualProviders.enabled ? <actual.ProviderSetupDialog {...props} /> : <div data-testid={`provider-setup:${props.mode}`} />,
  };
});
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
vi.mock("./views/ChatView", () => ({
  ChatView: ({ active }: { active?: boolean }) => {
    const [draft, setDraft] = useState("");
    return (
      <div data-testid="chat-view-mock" data-active={String(active)}>
        <input aria-label="Chat draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
    );
  },
}));
vi.mock("./views/TaskList", () => ({
  TaskList: ({ onOpen, onOpenActiveSession, onCreate, onReplayOnboarding }: Parameters<typeof TaskListComponent>[0]) => (
    <div>
      <button type="button" onClick={() => onOpen(task)}>
        open list task
      </button>
      <button type="button" onClick={() => onOpenActiveSession(task, activeSession)}>
        open active list session
      </button>
      <button type="button" onClick={() => onCreate(CURATED_PLAYBOOK_ARCHETYPES[1].reference)}>
        use list playbook
      </button>
      <button type="button" onClick={() => onCreate(CURATED_PLAYBOOK_ARCHETYPES[1].reference, CURATED_PLAYBOOK_ARCHETYPES[1].starterPreset)}>
        use list preset
      </button>
      <button type="button" onClick={onReplayOnboarding}>
        show list guide
      </button>
    </div>
  ),
}));
vi.mock("./views/SessionsList", async (importOriginal) => {
  const real = await importOriginal<{ SessionsList: typeof SessionsListComponent }>();
  return {
    SessionsList: (props: Parameters<typeof SessionsListComponent>[0]) =>
      namingScenario.realSessions ? (
        <real.SessionsList {...props} />
      ) : (
        <div>
          <span>global sort:{props.sessionSort?.field}</span>
          <button type="button" onClick={() => props.onSessionSortChange?.({ field: "updated", direction: "desc" })}>
            choose global updated
          </button>
          <button type="button" onClick={() => props.onOpen(globalSession)}>
            open global session
          </button>
        </div>
      ),
  };
});
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
vi.mock("./views/TaskDetail", async (importOriginal) => {
  const real = await importOriginal<{ TaskDetail: typeof TaskDetailComponent }>();
  return {
    TaskDetail: (props: Parameters<typeof TaskDetailComponent>[0]) =>
      namingScenario.realTaskDetail ? (
        <real.TaskDetail {...props} />
      ) : (
        <div>
          <span>task detail:{props.initialTask?.slug}</span>
          <span>task sort:{props.sessionSort?.field}</span>
          <button type="button" onClick={() => props.onSessionSortChange?.({ field: "started", direction: "desc" })}>
            choose task started
          </button>
          <button type="button" onClick={props.onBack}>
            back from task
          </button>
          <button type="button" onClick={() => props.onOpenSession(task.slug, "detail-design", task.worktree, "design", "omp", "", "superdevelop", false)}>
            open detail session
          </button>
          <button type="button" onClick={props.onNewSession}>
            new task session
          </button>
        </div>
      ),
  };
});
vi.mock("./views/CreateSessionPage", () => ({
  CreateSessionPage: ({ onCreated }: { onCreated: (task: BoardTask, choice: SessionTypeChoice, harness: string, model: string, prompt?: string) => Promise<void> }) => (
    <div>
      <button type="button" onClick={() => void onCreated(task, { kind: "primary", step_key: "implementation" }, "omp", "", "  edited\nlaunch prompt ✓  ")}>
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
vi.mock("./views/CreateTaskPage", async (importOriginal) => {
  const actual = await importOriginal<typeof CreateTaskModule>();
  const MockCreateTaskPage = ({
    initialDraft,
    initialPlaybook,
    initialPreset,
    onCreated,
    onOpened = () => {},
  }: {
    initialDraft?: BoardTask;
    initialPlaybook?: PlaybookRef;
    initialPreset?: Parameters<typeof actual.CreateTaskPage>[0]["initialPreset"];
    onCreated: (result: CreateTaskResult & { repoPath: string; selectedSessionId?: string }) => void;
    onOpened?: () => void;
  }) => {
    useEffect(() => onOpened(), [onOpened]);
    const result: CreateTaskResult & { repoPath: string } = {
      repoPath: task.repo_path,
      task,
      sessions: [session("root-a"), session("root-b")],
      executions: [],
      creation: "partial",
      start: "failed",
      errors: [{ stage: "launch", code: "launch_failed", message: "binary missing" }],
    };
    return (
      <div>
        <span>create task:{initialDraft?.slug}</span>
        <span>create playbook:{initialPlaybook?.key}</span>
        <span>create preset:{initialPreset?.name}</span>
        <button type="button" onClick={() => onCreated(result)}>
          open created task
        </button>
        <button type="button" onClick={() => onCreated({ ...result, selectedSessionId: "root-b" })}>
          open second created session
        </button>
        <button type="button" onClick={() => onCreated({ ...result, task: null, sessions: [] })}>
          report failed creation
        </button>
      </div>
    );
  };
  return {
    CreateTaskPage: (props: Parameters<typeof actual.CreateTaskPage>[0]) => (actualCreation.enabled ? <actual.CreateTaskPage {...props} /> : <MockCreateTaskPage {...props} />),
  };
});
vi.mock("./views/Settings", () => ({
  SECTIONS: [],
  Settings: ({
    appearance,
    onAppearanceChange,
    onNotificationsChange,
  }: {
    appearance: AppearancePrefs;
    onAppearanceChange: (next: AppearancePrefs) => void;
    onNotificationsChange: (next: NotificationPrefs) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onNotificationsChange({ ...notificationPrefs, dock_badge_failures: false })}>
        save notification settings
      </button>
      <button type="button" onClick={() => onAppearanceChange({ ...appearance, startup_view: "list" })}>
        save task list startup
      </button>
    </div>
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
  window.localStorage.setItem("alinery.onboardingCompleted.v1", "1");
  actualCreation.enabled = false;
  actualProviders.enabled = false;
  namingScenario.realSessions = false;
  namingScenario.realTaskDetail = false;
  Element.prototype.scrollIntoView = vi.fn();
  ipcMocks.listBoardTasks.mockReset().mockResolvedValue([task]);
  ipcMocks.renameSession.mockReset();
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
  vi.resetAllMocks();
  window.localStorage.clear();
});

it("opens Playbooks from the top tab after selecting a repository, without an intro shortcut", async () => {
  ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, active_repo: "" });
  render(<App />);
  await screen.findByRole("button", { name: "Add a repository" });
  expect(screen.queryByRole("button", { name: "Playbooks" })).toBeNull();

  fireEvent.click(screen.getByTitle(task.repo_path));
  fireEvent.click(await screen.findByRole("button", { name: "Playbooks" }));
  await screen.findByRole("table", { name: "Playbook library" });
});

describe("task list starter actions", () => {
  it.each([
    ["use list playbook", "create preset:"],
    ["use list preset", "create preset:Audit error handling and edge-case failure modes"],
  ])("passes %s into the new-task form", async (action, preset) => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: action }));
    await screen.findByText("create playbook:bug-hunting");
    expect(screen.getByText(preset)).toBeTruthy();
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
  });

  it("reopens the playbook guide from Tasks", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "show list guide" }));
    expect(await screen.findByRole("dialog", { name: "Alinery onboarding" })).toBeTruthy();
    expect(screen.getByTestId("onboarding-step-playbooks")).toBeTruthy();
  });
});

describe("onboarding gate", () => {
  it.each([
    { repository: "with existing tasks", tasks: [task] },
    { repository: "without tasks", tasks: [] },
  ])("opens the new-task form after finishing resumed onboarding $repository without executing a task", async ({ tasks }) => {
    ipcMocks.listBoardTasks.mockResolvedValue(tasks);
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    window.localStorage.setItem("alinery.onboardingStep.v1", "launch");
    render(<App />);
    await screen.findByTestId("onboarding-step-playbooks");
    expect(screen.queryByRole("tab", { name: /First task/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish onboarding" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Alinery onboarding" })).toBeNull());
    await screen.findByText("create playbook:superdevelop");
    expect(screen.getByText("create preset:")).toBeTruthy();
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBe("1");
    expect(window.localStorage.getItem("alinery.onboardingStep.v1")).toBeNull();
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
  });

  it("carries the selected playbook into the new-task form after onboarding", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    window.localStorage.setItem("alinery.onboardingStep.v1", "playbooks");
    render(<App />);
    fireEvent.click(await screen.findByRole("radio", { name: /Bug Hunting/i }));
    fireEvent.click(screen.getByRole("button", { name: "Finish onboarding" }));
    await screen.findByText("create playbook:bug-hunting");
    expect(screen.getByText("create preset:")).toBeTruthy();
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBe("1");
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
  });

  it("opens the existing task form for a custom playbook without executing it", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    window.localStorage.setItem("alinery.onboardingStep.v1", "playbooks");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Build a new playbook" }));
    await screen.findByText("create playbook:build-playbook");
    expect(screen.getByText("create preset:Design a custom playbook for this repository")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-flow")).toBeNull();
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBe("1");
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
  });

  it("offers a configured install the guide once at Models, then lands on the task list after Skip", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    render(<App />);
    await screen.findByTestId("onboarding-step-models");
    // With a repository the guide is a modal over the board, not a replacement for it.
    expect(screen.getByRole("dialog", { name: "Alinery onboarding" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip Onboarding" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Alinery onboarding" })).toBeNull());
    await screen.findByRole("button", { name: "open list task" });
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBe("1");

    cleanup();
    render(<App />);
    await screen.findByRole("button", { name: "open list task" });
    expect(screen.queryByTestId("onboarding-flow")).toBeNull();
  });

  it("keeps workspace shortcuts and focus inside the open guide", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    render(<App />);
    await screen.findByTestId("onboarding-step-models");
    const guide = screen.getByRole("dialog", { name: "Alinery onboarding" });
    const skip = within(guide).getByRole("button", { name: "Skip Onboarding" });
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(skip, { key: "n", metaKey: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(screen.queryByRole("button", { name: "open created task" })).toBeNull();
      fireEvent.keyDown(skip, { key: "k", metaKey: true });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(guide.contains(document.activeElement)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a nested provider dialog dismiss without completing the guide", async () => {
    actualProviders.enabled = true;
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    window.localStorage.setItem("alinery.onboardingStep.v1", "models");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^API keys/ }));
    const provider = await screen.findByRole("dialog", { name: /providers/i });
    const accounts = within(provider).getByRole("tab", { name: "Accounts" });
    accounts.focus();
    expect(fireEvent.keyDown(accounts, { key: "Escape" })).toBe(true);
    fireEvent(provider, new Event("cancel", { bubbles: true, cancelable: true }));
    const guide = screen.getByRole("dialog", { name: "Alinery onboarding" });
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBeNull();
    fireEvent(guide, new Event("cancel", { bubbles: true, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Alinery onboarding" })).toBeNull());
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBe("1");
  });

  it("resumes an interrupted first run at the saved step once a repository exists", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    window.localStorage.setItem("alinery.onboardingStep.v1", "models");
    render(<App />);
    await screen.findByTestId("onboarding-step-models");
  });

  it("opens the wizard on first run and keeps it open through the first repository pick", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, active_repo: "" });
    render(<App />);
    await screen.findByTestId("onboarding-step-workspace");
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBeNull();

    fireEvent.click(screen.getByTitle(task.repo_path));
    await screen.findByRole("button", { name: "Add another repository" });
    expect(screen.getByTestId("onboarding-step-workspace")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-step-playbooks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByTestId("onboarding-step-models");
    expect(screen.getByRole("dialog", { name: "Alinery onboarding" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skip Onboarding" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Alinery onboarding" })).toBeNull());
    await screen.findByRole("button", { name: "open list task" });
    expect(window.localStorage.getItem("alinery.onboardingCompleted.v1")).toBe("1");
  });

  it("asks about usage sharing only after onboarding finishes, and offers provider setup only after the answer", async () => {
    telemetryScenario.ask = true;
    try {
      window.localStorage.removeItem("alinery.onboardingCompleted.v1");
      render(<App />);
      await screen.findByTestId("onboarding-step-models");
      expect(screen.queryByRole("alertdialog", { name: "Share anonymous usage?" })).toBeNull();
      expect(screen.queryByTestId("provider-setup:auto")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Skip Onboarding" }));
      await screen.findByRole("button", { name: "open list task" });
      expect(screen.queryByRole("alertdialog", { name: "Share anonymous usage?" })).toBeNull();
      const dialog = await screen.findByRole("alertdialog", { name: "Share anonymous usage?" }, { timeout: 3000 });
      expect(screen.queryByTestId("provider-setup:auto")).toBeNull();

      fireEvent.click(within(dialog).getByRole("button", { name: "Don't share" }));
      await screen.findByTestId("provider-setup:auto");
    } finally {
      telemetryScenario.ask = false;
    }
  });
});

async function renderApp() {
  render(<App />);
  await screen.findByRole("button", { name: "Search" });
}

describe("startup view", () => {
  it.each([undefined, "list"] as const)("opens the task list with startup preference %s despite a previously visited canvas", async (startupView) => {
    window.localStorage.setItem("alinery:navigation:active-grid-view", "default-kanban-plus");
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, appearance: { ...DEFAULT_APPEARANCE, startup_view: startupView } });

    await renderApp();

    expect(screen.getByRole("button", { name: "open list task" })).toBeTruthy();
    expect(screen.queryByTestId("grid:view:default-kanban-plus")).toBeNull();
  });

  it("opens the saved Sessions view at startup", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, appearance: { ...DEFAULT_APPEARANCE, startup_view: "sessions" } });

    await renderApp();

    expect(screen.getByRole("button", { name: "open global session" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "open list task" })).toBeNull();
  });

  it("opens the saved Playbooks library at startup", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, appearance: { ...DEFAULT_APPEARANCE, startup_view: "playbooks" } });

    await renderApp();

    expect(await screen.findByRole("table", { name: "Playbook library" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "open list task" })).toBeNull();
  });

  it("shows the repository chooser when Playbooks is saved but no repository is selected", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      active_repo: "",
      appearance: { ...DEFAULT_APPEARANCE, startup_view: "playbooks" },
    });

    render(<App />);

    expect(await screen.findByRole("button", { name: "Add a repository" })).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Playbook library" })).toBeNull();
  });

  it("keeps incomplete onboarding visible when Playbooks is saved", async () => {
    window.localStorage.removeItem("alinery.onboardingCompleted.v1");
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, appearance: { ...DEFAULT_APPEARANCE, startup_view: "playbooks" } });

    render(<App />);

    expect(await screen.findByRole("dialog", { name: "Alinery onboarding" })).toBeTruthy();
    expect(screen.getByTestId("onboarding-step-models")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Playbook library" })).toBeNull();
  });

  it("opens the saved configured canvas at startup", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      appearance: { ...DEFAULT_APPEARANCE, startup_view: "grid:research" },
      global: {
        ...appConfig.global,
        grid_views: [
          { id: "default-kanban-plus", name: "Canvas", slot: 1 },
          { id: "research", name: "Research", slot: 2 },
        ],
      },
    });

    await renderApp();

    expect(screen.getByTestId("grid:view:research")).toBeTruthy();
    expect(screen.queryByTestId("grid:view:default-kanban-plus")).toBeNull();
    expect(screen.queryByRole("button", { name: "open list task" })).toBeNull();
  });

  it("keeps the current page when preferences change after startup", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, appearance: { ...DEFAULT_APPEARANCE, startup_view: "sessions" } });
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));

    fireEvent.click(screen.getByRole("button", { name: "save notification settings" }));
    expect(screen.getByRole("button", { name: "save task list startup" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "save task list startup" }));
    expect(screen.getByRole("button", { name: "save notification settings" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "open list task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "open global session" })).toBeNull();
  });
});

// Notifications lives in the account menu, above Settings, not in the top-bar tabs.
async function openNotifications() {
  fireEvent.click(await screen.findByRole("button", { name: "Account" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Notifications" }));
}

async function openGlobalSession() {
  fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
  fireEvent.click(await screen.findByRole("button", { name: "open global session" }));
  await screen.findByText("session:global-design");
}

describe("draft routing", () => {
  it("loads a saved draft selected through search while the real new-task form is open", async () => {
    actualCreation.enabled = true;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    ipcMocks.listBoardTasks.mockResolvedValue([activeDraft]);
    vi.mocked(ipc.readConfigForRepo).mockResolvedValue({ defaults: { playbook: activeDraft.playbook_ref, draft_autosave: false } } as Config);
    vi.mocked(ipc.taskSourceBranchesForRepo).mockResolvedValue({
      branches: [{ full_ref: "refs/heads/main", name: "main" }],
      head: { kind: "branch", full_ref: "refs/heads/main", name: "main" },
      selected: null,
    });
    vi.mocked(ipc.listHarnessModelsForRepo).mockResolvedValue([]);
    vi.mocked(ipc.getCurrentWebview, { partial: true }).mockReturnValue({ onDragDropEvent: async () => () => {} });
    vi.mocked(ipc.readArtifactForRepo).mockResolvedValue("# Active Draft\n\nSaved description.");
    vi.mocked(ipc.readDraftAttachmentsForRepo).mockResolvedValue({ entries: [], images: [] });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(await screen.findByPlaceholderText("New task name…")).toHaveProperty("value", "");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const search = screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" });
    fireEvent.change(search, { target: { value: "Active Draft" } });
    await within(screen.getByRole("listbox")).findByText("Active Draft");
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Active Draft"));
    expect(screen.getByPlaceholderText("task-slug")).toHaveProperty("value", "active-draft");
    await screen.findByDisplayValue("Saved description.");
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    expect(ipc.writeDraftForRepo).not.toHaveBeenCalled();
  });

  it("opens active drafts in Create Task and archived drafts in Task Detail", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
    fireEvent.click(screen.getByRole("button", { name: "open active draft" }));
    await screen.findByText("create task:active-draft");

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
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
  it("opens the real creation form with the selected scoped playbook and returns without creating a task", async () => {
    actualCreation.enabled = true;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const sources: ScopedPlaybook[] = (["bundled", "repo"] as const).map((scope) => ({
      source: { reference: { scope, key: "review" }, path: null },
      source_text: "saved definition",
      modified_at_ms: null,
      definition: {
        version: 2,
        key: "review",
        title: `${scope} review`,
        description: "",
        default_model: "",
        default_harness: "omp",
        preamble: "",
        section_order: ["inspect"],
        step: [
          {
            key: "inspect",
            title: "Inspect",
            short: "",
            inputs: [],
            outputs: [{ path: "result.md" }],
            model: "",
            harness: "",
            prompt: "Inspect the work.",
            is_coding_step: false,
            auto_advance_default: false,
          },
        ],
      },
    }));
    ipcMocks.listPlaybookCatalog.mockResolvedValue({
      candidates: sources.map((source) => ({ source: source.source, title: source.definition.title, description: "", modified_at_ms: null, diagnostics: [] })),
      picker_preferences: { order: [], entries: [] },
      diagnostics: [],
    });
    vi.mocked(ipc.readPlaybook).mockImplementation(async (reference) => {
      const source = sources.find((source) => source.source.reference.scope === reference.scope);
      if (!source) throw new Error("Unknown preview scope");
      return source;
    });
    vi.mocked(ipc.readConfigForRepo).mockResolvedValue({ defaults: { playbook: sources[0].source.reference, draft_autosave: false } } as Config);
    vi.mocked(ipc.taskSourceBranchesForRepo).mockResolvedValue({
      branches: [{ full_ref: "refs/heads/main", name: "main" }],
      head: { kind: "branch", full_ref: "refs/heads/main", name: "main" },
      selected: null,
    });
    vi.mocked(ipc.listHarnessModelsForRepo).mockResolvedValue([]);
    vi.mocked(ipc.getCurrentWebview, { partial: true }).mockReturnValue({ onDragDropEvent: async () => () => {} });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Playbooks" }));
    fireEvent.click(await screen.findByRole("button", { name: "repo review Repository" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create task from this playbook" }));
    expect(await screen.findByRole("radio", { name: /repo review/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /bundled review/ })).toHaveProperty("checked", false);
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "");
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    expect(ipc.writeDraftForRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Create task from this playbook" });
    expect(screen.queryByRole("radio", { name: /repo review/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(await screen.findByRole("radio", { name: /bundled review/ })).toHaveProperty("checked", true);
  });

  it("opens the library from a task and returns with the keyboard", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    await screen.findByText("task detail:task");
    fireEvent.click(screen.getByRole("button", { name: "Playbooks" }));
    await screen.findByRole("table", { name: "Playbook library" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    await screen.findByText("task detail:task");
  });
});

describe("session navigation acknowledgment", () => {
  it("does not acknowledge when opening only a task", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
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

  it("acknowledges task-list and global-list sessions before navigation", async () => {
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
    await openNotifications();
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
    await openNotifications();
    fireEvent.click(await screen.findByRole("button", { name: "open foreign notification" }));
    await screen.findByText("session:foreign-design");

    expect(ipcMocks.setActiveRepo).toHaveBeenCalledWith("/foreign", []);
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenCalledWith("/foreign", "task", "foreign-design");
    expect(ipcMocks.setActiveRepo.mock.invocationCallOrder[0]).toBeLessThan(ipcMocks.markSessionNotificationRead.mock.invocationCallOrder[0]);
  });

  it("acknowledges Task Detail and newly created sessions exactly", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
    fireEvent.click(screen.getByRole("button", { name: "open task" }));
    fireEvent.click(await screen.findByRole("button", { name: "open detail session" }));
    await screen.findByText("session:detail-design");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "detail-design");

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
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

  it("lists the remapped top-level actions in the command palette", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // One Grid view by default, so the bar reads ⌘1 Canvas, ⌘2 Tasks, ⌘3 Sessions.
    expect(screen.getByText("Go to Canvas").closest(".pitem")?.textContent).toContain("⌘1");
    expect((await screen.findByText("Go to Tasks")).closest(".pitem")?.textContent).toContain("⌘2");
    expect(screen.getByText("Go to Sessions").closest(".pitem")?.textContent).toContain("⌘3");
    expect(screen.queryByText("Go to Kanban")).toBeNull();
    expect(screen.getByText("Go to Notifications").closest(".pitem")?.textContent).toContain("⌘8");
    expect(screen.queryByText("Go to Wiki")).toBeNull();
    expect(screen.getByText("Open Settings").closest(".pitem")?.textContent).toContain("⌘9");
  });

  it.each([undefined, false, true])("opens Tasks for legacy Kanban startup with flag %s", async (show_original_kanban) => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      appearance: { ...DEFAULT_APPEARANCE, startup_view: "kanban" },
      global: { ...appConfig.global, experiments: { show_original_kanban } },
    });
    await renderApp();
    expect(await screen.findByRole("button", { name: "open list task" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Kanban/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Go to Canvas")).toBeTruthy();
    expect(screen.queryByText("Go to Kanban")).toBeNull();
  });

  it("shows the Chat tab and palette entry only when the experimental flag is on", async () => {
    await renderApp();
    expect(screen.queryByRole("button", { name: /^Chat\d/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Go to Canvas");
    expect(screen.queryByText("Go to Chat")).toBeNull();
    cleanup();

    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      global: { ...appConfig.global, experiments: { show_original_kanban: true, show_chat: true } },
    });
    await renderApp();
    expect(screen.getByRole("button", { name: /^Chat\d/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByText("Go to Chat")).closest(".pitem")?.textContent).toContain("⌘4");
  });

  it("keeps the Chat view mounted, and paused, while another tab is open", async () => {
    ipcMocks.readAppConfig.mockResolvedValue({
      ...appConfig,
      global: { ...appConfig.global, experiments: { show_original_kanban: true, show_chat: true } },
    });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /^Chat\d/ }));
    fireEvent.change(await screen.findByLabelText("Chat draft"), { target: { value: "half a thought" } });
    expect(screen.getByTestId("chat-view-mock").dataset.active).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.getByTestId("chat-view-mock").dataset.active).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /^Chat\d/ }));
    expect((screen.getByLabelText("Chat draft") as HTMLInputElement).value).toBe("half a thought");
    expect(screen.getByTestId("chat-view-mock").dataset.active).toBe("true");
  });

  it("keeps a visited Grid mounted while navigating away and back", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Change Grid layout" }));
    expect(screen.getByText("Grid layout revision 1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));

    expect(await screen.findByText("Grid layout revision 1")).toBeTruthy();
  });
});

describe("session sort lifetime", () => {
  it("defaults Task Detail to updated descending and remembers that choice across launches", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(await screen.findByText("global sort:priority")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "choose global updated" }));
    expect(await screen.findByText("global sort:updated")).toBeDefined();
    expect(window.localStorage.getItem("alinery.taskSessionSort")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    expect(await screen.findByText("task sort:updated")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "choose task started" }));
    expect(await screen.findByText("task sort:started")).toBeDefined();
    expect(window.localStorage.getItem("alinery.taskSessionSort")).toBe("started:desc");

    fireEvent.click(screen.getByRole("button", { name: "back from task" }));
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(await screen.findByText("global sort:updated")).toBeDefined();

    cleanup();
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    expect(await screen.findByText("global sort:priority")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    expect(await screen.findByText("task sort:started")).toBeDefined();
  });

  it("ignores a corrupt remembered task sort", async () => {
    window.localStorage.setItem("alinery.taskSessionSort", "nope");
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    expect(await screen.findByText("task sort:updated")).toBeDefined();
  });
});

describe("global notification owner", () => {
  it("polls outside Notifications and does not add a view-local owner", async () => {
    await renderApp();
    await waitFor(() => expect(ipcMocks.listSessionItems).toHaveBeenCalledWith(true, false));
    expect(ipcMocks.sessionListStatuses).toHaveBeenCalledWith([]);
    const calls = ipcMocks.listSessionItems.mock.calls.length;

    await openNotifications();
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

    await openNotifications();
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

describe("collection filter shortcuts", () => {
  it("keeps global search and view shortcuts available without opening a row from filter confirmation", async () => {
    namingScenario.realSessions = true;
    ipcMocks.listSessionItems.mockResolvedValue([{ ...globalSession, name: "Keyboard work" }]);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    await screen.findByText("Keyboard work");
    const status = screen.getByRole("combobox", { name: "Status" });
    status.focus();
    fireEvent.keyDown(status, { key: "Enter", metaKey: true });
    await act(async () => {});
    expect(screen.queryByText("session:global-design")).toBeNull();
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();

    fireEvent.keyDown(status, { key: "k", metaKey: true });
    const search = await screen.findByRole("combobox", { name: "Search actions, tasks, and sessions" });
    fireEvent.keyDown(search, { key: "Escape" });
    status.focus();
    fireEvent.keyDown(status, { key: "2", metaKey: true });
    expect(await screen.findByRole("button", { name: "open list task" })).toBeDefined();
  });
});

describe("session work names", () => {
  it("keyboard activation of a real session Rename does not open the selected session", async () => {
    namingScenario.realSessions = true;
    ipcMocks.listSessionItems.mockResolvedValue([{ ...globalSession, name: "Keyboard work" }]);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    const rename = await screen.findByRole("button", { name: "Rename session" });
    rename.focus();
    // jsdom does not synthesize the native button click; dispatch it after
    // proving the key was not consumed by App's selected-session navigation.
    expect(fireEvent.keyDown(rename, { key: "Enter" })).toBe(true);
    await act(async () => {});
    expect(screen.queryByText("session:global-design")).toBeNull();
    expect(ipcMocks.markSessionNotificationRead).not.toHaveBeenCalled();
    fireEvent.click(rename);
    expect(screen.getByRole("textbox", { name: "Session name" })).toHaveProperty("value", "Keyboard work");
  });

  it("open_search_keeps_committed_name_when_old_results_arrive", async () => {
    namingScenario.realSessions = true;
    const original = { ...globalSession, name: "Original work", subtask_manager: true, subtask_slug: "child", subtask_name: "Current child" };
    ipcMocks.listSessionItems.mockResolvedValue([original]);
    await renderApp();
    await waitFor(() => expect(ipcMocks.sessionListStatuses).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Sessions/ }));
    await screen.findByText("Original work");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" }), { target: { value: "Current child" } });
    await waitFor(() => expect(within(screen.getByRole("listbox")).getByText("Original work")).toBeDefined());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" }), { key: "Escape" });
    const commit = deferred<{ name: string; source: string }>();
    ipcMocks.renameSession.mockReturnValue(commit.promise);
    fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed work" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    const oldRead = deferred<SessionListItem[]>();
    ipcMocks.listSessionItems.mockReturnValueOnce(oldRead.promise);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" }), { target: { value: "Current child" } });
    const committed = { ...original, name: "Committed work", name_source: "user" as const };
    const freshRead = deferred<SessionListItem[]>();
    ipcMocks.listSessionItems.mockReturnValue(freshRead.promise);
    await act(async () => {
      commit.resolve({ name: "Committed work", source: "user" });
    });
    const palette = screen.getByRole("listbox");
    expect(within(palette).getByText("Committed work")).toBeDefined();
    expect(within(palette).getByText(/Current child/)).toBeDefined();
    await act(async () => {
      oldRead.resolve([original]);
    });
    expect(within(palette).getByText("Committed work")).toBeDefined();
    expect(within(palette).queryByText("Original work")).toBeNull();
    await act(async () => {
      freshRead.resolve([{ ...committed, name: "External work" }]);
    });
    fireEvent.click(within(palette).getByText("External work"));
    await screen.findByText("session:global-design");
    expect(ipcMocks.markSessionNotificationRead).toHaveBeenLastCalledWith("/repo", "task", "global-design");
  });

  it("a real child rename patches task and manager search names without replacing manager work names", async () => {
    namingScenario.realTaskDetail = true;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const child = { ...task, name: "Original child", parent_task: "parent" };
    const parent = { ...task, slug: "parent", name: "Parent" };
    const manager = { ...globalSession, task_slug: "parent", task_name: "Parent", name: "Coordinate work", subtask_manager: true, subtask_slug: "task", subtask_name: child.name };
    ipcMocks.getTask.mockResolvedValue(child);
    ipcMocks.listTasks.mockResolvedValue([child, parent]);
    ipcMocks.listBoardTasks.mockResolvedValue([child, parent]);
    ipcMocks.subtaskState.mockResolvedValue({
      task: child,
      parent_task: parent,
      active_subtask: null,
      parent_manager_session: null,
      parent_manager_owner_task_slug: "",
      manager_session: null,
      manager_owner_task_slug: "task",
      can_start: true,
      can_recover: false,
      disabled_reason: "",
    });
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.getTaskExecution.mockResolvedValue(executionReply([]));
    ipcMocks.listArtifactsWithMetadata.mockResolvedValue([]);
    ipcMocks.listTaskArtifactTree.mockResolvedValue([]);
    ipcMocks.listArtifactCommentDraftsForRepo.mockResolvedValue([]);
    ipcMocks.worktreeExists.mockResolvedValue(true);
    ipcMocks.listSessionItems.mockResolvedValue([manager]);
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    await screen.findByRole("heading", { name: "Original child" });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" }), { target: { value: "Original child" } });
    await within(screen.getByRole("listbox")).findByText("Coordinate work");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" }), { key: "Escape" });
    const committed = { ...child, name: "Renamed child" };
    const commit = deferred<typeof child>();
    ipcMocks.renameTask.mockReturnValue(commit.promise);
    fireEvent.click(screen.getByRole("button", { name: "Rename task" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Task name" }), { target: { value: committed.name } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Task name" }), { key: "Enter" });
    const pending = deferred<SessionListItem[]>();
    ipcMocks.listSessionItems.mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search actions, tasks, and sessions" }), { target: { value: "Renamed child" } });
    await act(async () => {
      commit.resolve(committed);
    });
    expect(within(screen.getByRole("listbox")).getByText("Renamed child")).toBeDefined();
    expect(within(screen.getByRole("listbox")).getByText("Coordinate work")).toBeDefined();
    expect(ipcMocks.renameTask).toHaveBeenCalledWith("/repo", "task", "Renamed child");
  });
});

describe("repository switch keeps the current page", () => {
  const repos = { ...appConfig, known_repos: ["/repo", "/other"] };

  beforeEach(() => {
    ipcMocks.readAppConfig.mockResolvedValue(repos);
    ipcMocks.setActiveRepo.mockImplementation(async (path: string) => ({ ...repos, active_repo: path }));
  });

  async function chooseRepo(path: string) {
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle(path));
    await waitFor(() => expect(screen.getByRole("button", { name: "Repository" })).toHaveProperty("title", path));
  }

  async function chooseAllRepos() {
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByRole("button", { name: "All repos" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Repository" })).toHaveProperty("title", "All repos"));
  }

  it("keeps the selected repository and shows owner details when connection is refused", async () => {
    await renderApp();
    ipcMocks.setActiveRepo.mockRejectedValueOnce({
      repo: "/other",
      app_protocol: 19,
      app_config_identity: "current-config",
      owners: [
        {
          lane: "old",
          pid: 66765,
          protocol: 17,
          build_id: "old-build",
          app_config_identity: "other-config",
          impact: { status: "known", sessions: [{ id: "live-session", name: null }] },
          takeover_unavailable: "Shutdown compatibility is not established for this daemon.",
        },
      ],
      issues: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByTitle("/other"));
    const dialog = await screen.findByRole("alertdialog", { name: "Couldn't open other" });
    expect(dialog.textContent).toContain("protocol 17");
    expect(dialog.textContent).toContain("live-session");
    expect(dialog.textContent).toContain("Shutdown compatibility is not established");
    expect(screen.getByRole("button", { name: "Repository" })).toHaveProperty("title", "/repo");
    expect(within(dialog).queryByRole("button", { name: /take over/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Repository" })).toHaveProperty("title", "/repo");
  });

  it("stays on canvas, settings, and notifications instead of bouncing to the task list", async () => {
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
    expect(await screen.findByRole("button", { name: "open task" })).toBeTruthy();
    await chooseRepo("/other");
    expect(screen.getByRole("button", { name: "open task" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "open list task" })).toBeNull();
    await chooseAllRepos();
    expect(screen.getByRole("button", { name: "open task" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(await screen.findByRole("button", { name: "save notification settings" })).toBeTruthy();
    await chooseRepo("/repo");
    expect(screen.getByRole("button", { name: "save notification settings" })).toBeTruthy();

    await openNotifications();
    expect((await screen.findByRole("button", { name: "clear shared notifications" })).closest("[data-scope]")?.getAttribute("data-scope")).toBe("/repo");
    await chooseAllRepos();
    expect(screen.getByRole("button", { name: "clear shared notifications" }).closest("[data-scope]")?.getAttribute("data-scope")).toBe("all");
  });

  it("zooms a task or session out to the task list", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(await screen.findByRole("button", { name: "open list task" }));
    expect(await screen.findByText(/task detail:/)).toBeTruthy();

    await chooseRepo("/other");
    expect(screen.getByRole("button", { name: "open list task" })).toBeTruthy();
    expect(screen.queryByText(/task detail:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "open list task" }));
    fireEvent.click(await screen.findByRole("button", { name: "open detail session" }));
    expect(await screen.findByText(/session:/)).toBeTruthy();
    await chooseAllRepos();
    expect(screen.getByRole("button", { name: "open list task" })).toBeTruthy();
    expect(screen.queryByText(/session:/)).toBeNull();
  });

  it("keeps one grid workspace across repositories and all-repos", async () => {
    const legacy = JSON.stringify({ config: { tileWidth: 480 } });
    window.localStorage.setItem("alinery:grid:/repo:view:default-kanban-plus", legacy);
    window.localStorage.setItem("alinery:grid:all-repositories:view:default-kanban-plus", JSON.stringify({ config: { tileWidth: 96 } }));
    await renderApp();

    fireEvent.click(screen.getByRole("button", { name: /Canvas/ }));
    const grid = () => screen.getByTestId("grid:view:default-kanban-plus");
    expect(grid()).toBeTruthy();
    expect(window.localStorage.getItem("alinery:grid:view:default-kanban-plus")).toBe(legacy);

    await chooseRepo("/other");
    expect(grid()).toBeTruthy();
    await chooseAllRepos();
    expect(grid()).toBeTruthy();
    expect(window.localStorage.getItem("alinery:grid:view:default-kanban-plus")).toBe(legacy);
  });
});

describe("removeRepo", () => {
  const repos = { ...appConfig, known_repos: ["/repo", "/other"] };

  beforeEach(() => {
    ipcMocks.readAppConfig.mockResolvedValue(repos);
    vi.mocked(ipc.removeRepo).mockResolvedValue(appConfig);
  });

  function closeOther() {
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    fireEvent.click(screen.getByRole("button", { name: "Close other" }));
  }

  it("shows a cancellable confirmation immediately and waits for an informed explicit choice", async () => {
    const count = deferred<number>();
    const removal = deferred<AppConfig>();
    vi.mocked(ipc.repoLiveSessions).mockReturnValue(count.promise);
    vi.mocked(ipc.removeRepo).mockReturnValue(removal.promise);
    await renderApp();
    closeOther();
    const dialog = screen.getByRole("alertdialog", { name: "Remove other?" });
    const accept = within(dialog).getByRole("button", { name: "Remove repository" });
    expect(within(dialog).getByRole("status").textContent).toContain("Checking live sessions");
    expect(accept).toHaveProperty("disabled", true);
    expect(dialog.querySelector("[data-autofocus]")?.textContent).toBe("Cancel");
    fireEvent.click(accept);
    expect(ipc.removeRepo).not.toHaveBeenCalled();
    closeOther();
    expect(ipc.repoLiveSessions).toHaveBeenCalledTimes(1);
    await act(async () => count.resolve(2));
    expect(dialog.textContent).toContain("2 live sessions are killed");
    expect(accept).toHaveProperty("disabled", false);
    expect(ipc.removeRepo).not.toHaveBeenCalled();
    fireEvent.click(accept);
    await waitFor(() => expect(ipc.removeRepo).toHaveBeenCalledWith("/other"));
    closeOther();
    expect(screen.queryByRole("alertdialog", { name: "Remove other?" })).toBeNull();
    expect(ipc.removeRepo).toHaveBeenCalledTimes(1);
    await act(async () => removal.resolve(appConfig));
    fireEvent.click(screen.getByRole("button", { name: "Repository" }));
    expect(screen.queryByRole("button", { name: "Close other" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close repo" })).toBeTruthy();
  });

  it("cancels while counting and ignores the old result after another confirmation opens", async () => {
    const oldCount = deferred<number>();
    const newCount = deferred<number>();
    vi.mocked(ipc.repoLiveSessions).mockReturnValueOnce(oldCount.promise).mockReturnValueOnce(newCount.promise);
    await renderApp();
    closeOther();
    let dialog = screen.getByRole("alertdialog", { name: "Remove other?" });
    fireEvent.click(dialog.querySelector("[data-autofocus]") as HTMLElement);
    await act(async () => {});
    expect(screen.queryByRole("alertdialog", { name: "Remove other?" })).toBeNull();
    closeOther();
    dialog = screen.getByRole("alertdialog", { name: "Remove other?" });
    await act(async () => oldCount.resolve(0));
    expect(within(dialog).getByRole("button", { name: "Remove repository" })).toHaveProperty("disabled", true);
    expect(ipc.removeRepo).not.toHaveBeenCalled();
    fireEvent.click(dialog.querySelector("[data-autofocus]") as HTMLElement);
    await act(async () => newCount.resolve(3));
    expect(screen.queryByRole("alertdialog", { name: "Remove other?" })).toBeNull();
    expect(ipc.removeRepo).not.toHaveBeenCalled();
  });

  it("warns when the count is unknown and requires explicit confirmation even after a count failure", async () => {
    const count = deferred<number>();
    vi.mocked(ipc.repoLiveSessions).mockReturnValue(count.promise);
    await renderApp();
    closeOther();
    await act(async () => count.reject(new Error("daemon unavailable")));
    const dialog = screen.getByRole("alertdialog", { name: "Remove other?" });
    expect(within(dialog).getByRole("alert").textContent).toContain("daemon unavailable");
    expect(within(dialog).getByRole("alert").textContent).toContain("may kill running sessions");
    expect(within(dialog).queryByText("No live sessions.")).toBeNull();
    expect(dialog.querySelector("[data-autofocus]")?.textContent).toBe("Cancel");
    expect(within(dialog).getByRole("button", { name: "Remove repository" })).toHaveProperty("disabled", false);
    expect(ipc.removeRepo).not.toHaveBeenCalled();
    fireEvent.click(dialog.querySelector("[data-autofocus]") as HTMLElement);
    await act(async () => {});
    expect(screen.queryByRole("alertdialog", { name: "Remove other?" })).toBeNull();
    expect(ipc.removeRepo).not.toHaveBeenCalled();
    closeOther();
    const accept = screen.getByRole("button", { name: "Remove repository" });
    await waitFor(() => expect(accept).toHaveProperty("disabled", false));
    expect(ipc.removeRepo).not.toHaveBeenCalled();
    fireEvent.click(accept);
    await waitFor(() => expect(ipc.removeRepo).toHaveBeenCalledWith("/other"));
    expect(ipc.removeRepo).toHaveBeenCalledTimes(1);
  });

  it("keeps removal failures visible and releases the duplicate-operation guard", async () => {
    vi.mocked(ipc.repoLiveSessions).mockResolvedValue(0);
    vi.mocked(ipc.removeRepo).mockRejectedValue(new Error("shutdown refused"));
    await renderApp();
    closeOther();
    const accept = screen.getByRole("button", { name: "Remove repository" });
    await waitFor(() => expect(accept).toHaveProperty("disabled", false));
    fireEvent.click(accept);
    await waitFor(() => expect(screen.getAllByText(/shutdown refused/).length).toBeGreaterThan(0));
    closeOther();
    expect(screen.getByRole("alertdialog", { name: "Remove other?" })).toBeTruthy();
    expect(ipc.removeRepo).toHaveBeenCalledTimes(1);
  });
});

describe("addRepo", () => {
  async function openPicker() {
    ipcMocks.readAppConfig.mockResolvedValue({ ...appConfig, active_repo: "" });
    render(<App />);
    return screen.findByRole("button", { name: "Add a repository" });
  }

  beforeEach(() => {
    ipcMocks.pickRepoDialog.mockReset();
    ipcMocks.classifyPickedFolder.mockReset();
    ipcMocks.initPickedFolder.mockReset();
    ipcMocks.setActiveRepo.mockReset().mockImplementation(async (path: string) => ({ ...appConfig, active_repo: path, known_repos: [path] }));
  });

  it("stops when the folder picker is cancelled", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue(null);
    fireEvent.click(add);
    await waitFor(() => expect(ipcMocks.pickRepoDialog).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(ipcMocks.classifyPickedFolder).not.toHaveBeenCalled();
    expect(ipcMocks.initPickedFolder).not.toHaveBeenCalled();
    expect(ipcMocks.setActiveRepo).not.toHaveBeenCalled();
  });

  it("opens a checkout without asking or initializing", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue("/raw");
    ipcMocks.classifyPickedFolder.mockResolvedValue({ kind: "checkout", root: "/canonical" });
    fireEvent.click(add);
    await waitFor(() => expect(ipcMocks.setActiveRepo).toHaveBeenCalledWith("/canonical", []));
    expect(ipcMocks.initPickedFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "Initialize Git?" })).toBeNull();
  });

  it("keeps the workspace unopened when its first daemon connection fails", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue("/unavailable");
    ipcMocks.classifyPickedFolder.mockResolvedValue({ kind: "checkout", root: "/unavailable" });
    ipcMocks.setActiveRepo.mockRejectedValueOnce("daemon did not start");
    fireEvent.click(add);
    const dialog = await screen.findByRole("alertdialog", { name: "Couldn't open unavailable" });
    expect(within(dialog).getByText("daemon did not start")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("button", { name: "Add a repository" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repository" })).toBeNull();
  });

  it("leaves an absent folder unchanged when initialize is cancelled", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue("/raw");
    ipcMocks.classifyPickedFolder.mockResolvedValue({ kind: "absent", path: "/canon" });
    fireEvent.click(add);
    const dialog = await screen.findByRole("alertdialog", { name: "Initialize Git?" });
    const focused = dialog.querySelector("[data-autofocus]");
    expect(focused?.textContent).toBe("Cancel");
    fireEvent.click(focused as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Initialize Git?" })).toBeNull());
    expect(ipcMocks.initPickedFolder).not.toHaveBeenCalled();
    expect(ipcMocks.setActiveRepo).not.toHaveBeenCalled();
  });

  it("initializes an absent folder and opens the returned root", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue("/raw");
    ipcMocks.classifyPickedFolder.mockResolvedValue({ kind: "absent", path: "/canon" });
    ipcMocks.initPickedFolder.mockResolvedValue({ kind: "initialized", root: "/inited" });
    fireEvent.click(add);
    const dialog = await screen.findByRole("alertdialog", { name: "Initialize Git?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Initialize Git" }));
    await waitFor(() => expect(ipcMocks.initPickedFolder).toHaveBeenCalledWith("/canon"));
    await waitFor(() => expect(ipcMocks.setActiveRepo).toHaveBeenCalledWith("/inited", []));
    expect(ipcMocks.initPickedFolder.mock.invocationCallOrder[0]).toBeLessThan(ipcMocks.setActiveRepo.mock.invocationCallOrder[0]);
  });

  it("shows a named refusal without opening", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue("/raw");
    ipcMocks.classifyPickedFolder.mockResolvedValue({
      kind: "refused",
      message: "This folder is a Git repository, but not a working tree. Alinery will not initialize a new repository here.\nfatal: this operation must be run in a work tree",
    });
    fireEvent.click(add);
    expect(await screen.findByText(/fatal: this operation must be run in a work tree/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog", { name: "Initialize Git?" })).toBeNull();
    expect(ipcMocks.initPickedFolder).not.toHaveBeenCalled();
    expect(ipcMocks.setActiveRepo).not.toHaveBeenCalled();
  });

  it("shows an init failure without opening", async () => {
    const add = await openPicker();
    ipcMocks.pickRepoDialog.mockResolvedValue("/raw");
    ipcMocks.classifyPickedFolder.mockResolvedValue({ kind: "absent", path: "/canon" });
    ipcMocks.initPickedFolder.mockRejectedValue("Couldn't initialize Git in /canon.\nPermission denied");
    fireEvent.click(add);
    fireEvent.click(await screen.findByRole("button", { name: "Initialize Git" }));
    expect(await screen.findByText(/Permission denied/)).toBeTruthy();
    expect(ipcMocks.setActiveRepo).not.toHaveBeenCalled();
  });
});
