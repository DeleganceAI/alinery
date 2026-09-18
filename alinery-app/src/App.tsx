import {
  Archive,
  Bell,
  ChevronRight,
  Copy,
  FolderPlus,
  Grid3X3,
  List,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  SquareKanban,
  SquareTerminal,
  SunMoon,
  Terminal,
  X,
} from "lucide-react";
import { type CSSProperties, lazy, type ReactNode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { applyAppearance, DEFAULT_APPEARANCE } from "./appearance";
import alineryIcon from "./assets/alinery-icon-white-plain.png";
import { GlobalSearch, type SearchItem } from "./CommandPalette";
import type { QueuedFollowUp } from "./chat/queue";
import { askConfirm, ConfirmHost, confirmDanger } from "./confirm";
import { DaemonConflictBanner, HostGuardWarning, RepoBusyBanner } from "./DaemonConflictBanner";
import { ACTIVE_GRID_VIEW_STORAGE_KEY, DEFAULT_GRID_VIEW_ID, gridViewShortcut, normalizeGridViews, resolveGridTopLevelRoute } from "./gridViews";
import { HotkeyBar } from "./HotkeyBar";
import { ORB_SPEED } from "./Indicators";
import * as ipc from "./ipc";
import { LaunchSourceBar } from "./LaunchSourceBar";
import { BrandMark } from "./Logo";
import { PRIORITY_SESSION_SORT, type SessionSort } from "./sessionAttention";
import { EMPTY_SESSION_MESSAGE_DRAFT, type SessionMessageDraft, sessionMessageDraftKey } from "./sessionMessage";
import { ALL_REPOS, isDevelopmentProductName, LoadingState, RepoPicker, repoName, TopBar } from "./shared";
import { clampDrawerWidth, DRAWER_DEFAULT_WIDTH, TerminalDrawer } from "./TerminalDrawer";
import { gridViewIdOf, isPrimaryTab, primaryTabOf, viewFadeClass } from "./tabMotion";
import { shouldAskTelemetryConsent, TELEMETRY_CONSENT_CHOICES, telemetryConsentWrite } from "./telemetry-consent";
import { Toast, toast } from "./toast";
import type {
  AppConfig,
  AppearanceMode,
  AppearancePrefs,
  BoardNav,
  BoardTask,
  CreateTaskResult,
  NotificationPrefs,
  RepoScope,
  SessionListItem,
  SessionMeta,
  SessionTypeChoice,
  SettingsSectionKey,
  Tab,
  TaskActivitySession,
  View,
} from "./types";
import { useDaemonStatus } from "./useDaemonStatus";
import { useDockBadgeCount } from "./useDockBadgeCount";
import { useHotkeys } from "./useHotkeys";
import { useMcpStatus } from "./useMcpStatus";
import { useOmpUpdateStatus } from "./useOmpUpdateStatus";
import { useSessionNoticeSnapshot } from "./useSessionNoticeSnapshot";
import { useUpdateStatus } from "./useUpdateStatus";
import { CreateSessionPage } from "./views/CreateSessionPage";
import { CreateTaskPage } from "./views/CreateTaskPage";
import { Grid } from "./views/Grid";
import { Kanban } from "./views/Kanban";
import { NotificationsList } from "./views/NotificationsList";
import { ProviderSetupDialog } from "./views/ProviderSetupDialog";
import { SessionsList } from "./views/SessionsList";
import { SECTIONS as SETTINGS_SECTIONS, Settings } from "./views/Settings";
import { TaskList } from "./views/TaskList";
import { ResizeHandles, useWindowFullscreen, WindowControls } from "./WindowChrome";

/** Per-install: asked once, then the Settings button is the way back. */
const OMP_SETUP_DISMISSED_KEY = "alinery.ompSetupDismissed";

// Resolve and apply the appearance before first paint; the stored config
// re-applies as soon as it loads.
applyAppearance(DEFAULT_APPEARANCE);

const DEV_LAUNCH_ROOT = import.meta.env.VITE_ALINERY_DEV_LAUNCH_ROOT ?? "";

// Deferred: mermaid (via ArtifactMarkdown) is only needed once a task/session is opened,
// so keep it out of the eagerly-evaluated boot chunk.
const TaskDetail = lazy(() => import("./views/TaskDetail").then((m) => ({ default: m.TaskDetail })));
const SessionView = lazy(() => import("./views/SessionView").then((m) => ({ default: m.SessionView })));
const ReviewHandoffPage = lazy(() => import("./views/ReviewHandoffPage").then((m) => ({ default: m.ReviewHandoffPage })));

// Live (running + idle) sessions on a repo's daemon — the number every loss-of-work
// warning is about. Unreachable daemon ⇒ 0: there is nothing running to lose.
const liveSessions = (repo: string) => ipc.repoLiveSessions(repo).catch(() => 0);

type SearchData = { tasks: BoardTask[]; sessions: SessionListItem[] };
const EMPTY_SEARCH_DATA: SearchData = { tasks: [], sessions: [] };

function initialView(): View {
  try {
    const gridViewId = window.localStorage.getItem(ACTIVE_GRID_VIEW_STORAGE_KEY)?.trim();
    if (gridViewId) return { kind: "grid", gridViewId };
  } catch {
    // Navigation persistence is optional; settings reconciliation below still chooses a safe view.
  }
  return { kind: "grid", gridViewId: DEFAULT_GRID_VIEW_ID };
}

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [navInstant, setNavInstant] = useState(true);
  const [scope, setScope] = useState<RepoScope>("active");
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  // Repo open is the first moment we can ask whether this install can actually run an agent:
  // before then there is no daemon to ask, which is why the empty state deliberately does
  // nothing. Dismissal is persisted so someone deliberately running unauthenticated is asked
  // once; Settings -> Chat is the way back in.
  const [setupOffer, setSetupOffer] = useState(false);
  useEffect(() => {
    if (!appConfig?.active_repo) return;
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(OMP_SETUP_DISMISSED_KEY) === "1";
    } catch {
      /* private mode or blocked storage: offer rather than stay silent */
    }
    if (!dismissed) setSetupOffer(true);
  }, [appConfig?.active_repo]);
  const [repoErr, setRepoErr] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchData, setSearchData] = useState<SearchData>(EMPTY_SEARCH_DATA);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [diagramZoomOpen, setDiagramZoomOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [sessionMessageDrafts, setSessionMessageDrafts] = useState<Map<string, SessionMessageDraft>>(() => new Map());
  const [sessionQueuedFollowUps, setSessionQueuedFollowUps] = useState<Map<string, QueuedFollowUp[]>>(() => new Map());
  const [productName, setProductName] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const duplicatingRef = useRef(false);
  const [duplicating, setDuplicating] = useState(false);
  const [updating, setUpdating] = useState(false);
  // Presentation preferences live for this app process only. Each surface keeps its own
  // choice while navigation unmounts and remounts the list.
  const [globalSessionSort, setGlobalSessionSort] = useState<SessionSort>(PRIORITY_SESSION_SORT);
  const [taskSessionSort, setTaskSessionSort] = useState<SessionSort>(PRIORITY_SESSION_SORT);
  // Global left terminal drawer — ephemeral; not persisted.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_DEFAULT_WIDTH);
  const [drawerSession, setDrawerSession] = useState<{ id: string; cwd: string } | null>(null);
  // Keep kill/clear handlers stable for TerminalDrawer EOF poll without stale closures.
  const drawerSessionRef = useRef(drawerSession);
  drawerSessionRef.current = drawerSession;
  // Same reason for the close-requested handler: it is registered once, but must see the
  // repo list as it is at quit time.
  const appConfigRef = useRef(appConfig);
  appConfigRef.current = appConfig;
  const gridViews = useMemo(() => normalizeGridViews(appConfig?.global?.grid_views), [appConfig?.global?.grid_views]);
  const showOriginalKanban = appConfig?.global?.experiments?.show_original_kanban ?? true;
  const repoKey = appConfig?.active_repo ? `${scope}:${appConfig.active_repo}:${appConfig.known_repos.join("|")}:${reloadNonce}` : "";
  const activeGridViewId = view.kind === "grid" && gridViews.some((gridView) => gridView.id === view.gridViewId) ? view.gridViewId : undefined;
  const [mountedGridViews, setMountedGridViews] = useState<{ repoKey: string; ids: string[] }>({ repoKey: "", ids: [] });
  useLayoutEffect(() => {
    if (!repoKey || !activeGridViewId) return;
    setMountedGridViews((current) => {
      const ids = current.repoKey === repoKey ? current.ids : [];
      if (ids.includes(activeGridViewId)) return current.repoKey === repoKey ? current : { repoKey, ids };
      return { repoKey, ids: [...ids, activeGridViewId] };
    });
  }, [activeGridViewId, repoKey]);
  const mountedGridViewIds = mountedGridViews.repoKey === repoKey ? mountedGridViews.ids : [];
  const keptGridViews = gridViews.filter((gridView) => gridView.id === activeGridViewId || mountedGridViewIds.includes(gridView.id));

  useEffect(() => {
    if (!appConfig) return;
    setView((current) => {
      if (current.kind !== "grid" && current.kind !== "kanban") return current;
      return resolveGridTopLevelRoute(current, showOriginalKanban, gridViews);
    });
  }, [appConfig, gridViews, showOriginalKanban]);

  const selectedGridViewId = gridViewIdOf(view);
  useEffect(() => {
    if (!appConfig) return;
    try {
      if (selectedGridViewId && gridViews.some((gridView) => gridView.id === selectedGridViewId)) {
        window.localStorage.setItem(ACTIVE_GRID_VIEW_STORAGE_KEY, selectedGridViewId);
      } else {
        window.localStorage.removeItem(ACTIVE_GRID_VIEW_STORAGE_KEY);
      }
    } catch {
      // The in-memory route still works when browser storage is unavailable.
    }
  }, [appConfig, gridViews, selectedGridViewId]);
  const knownReposRef = useRef<string | null>(null);

  const navRef = useRef<BoardNav | null>(null);
  const registerNav = useCallback((n: BoardNav | null) => {
    navRef.current = n;
  }, []);

  const daemon = useDaemonStatus();
  const mcp = useMcpStatus();
  const noticeSnapshot = useSessionNoticeSnapshot(Boolean(appConfig?.active_repo));
  useDockBadgeCount(noticeSnapshot.rows, appConfig?.global?.notifications, noticeSnapshot.loaded);
  const isFullscreen = useWindowFullscreen();

  const clearDrawerUi = useCallback(() => {
    setDrawerOpen(false);
    setDrawerSession(null);
  }, []);

  const killDrawer = useCallback(async () => {
    const sess = drawerSessionRef.current;
    clearDrawerUi();
    if (sess) {
      try {
        await ipc.killSession(sess.id, "");
      } catch {
        // Idempotent — already exited / daemon offline.
      }
    }
  }, [clearDrawerUi]);

  useEffect(() => {
    ipc
      .getName()
      .then(setProductName)
      .catch(() => {});
    ipc
      .getVersion()
      .then(setAppVersion)
      .catch(() => {});
    ipc
      .readAppConfig()
      .then((cfg) => {
        const normalized = applyAppearance(cfg.appearance);
        setAppConfig({ ...cfg, appearance: normalized });
        if (shouldAskTelemetryConsent(cfg.global?.telemetry)) {
          void askConfirm({
            title: "Share anonymous usage?",
            body: "Alinery can send anonymized product-usage events (app open, tasks, sessions, settings). Never paths, task names, prompts, artifacts, or tokens. Change anytime in Settings → Telemetry.",
            choices: TELEMETRY_CONSENT_CHOICES,
            defaultKey: "opt-out",
            cancelKey: "later",
          }).then((answer) => {
            if (answer === "later") return;
            ipc
              .readGlobalSettings()
              .then((global) => {
                const result = telemetryConsentWrite(global.telemetry, answer);
                if (result === "later") return;
                return ipc.writeGlobalSettings({ ...global, telemetry: result.next });
              })
              .catch(() => {});
          });
        }
      })
      .catch((e) => {
        setRepoErr(String(e));
        const appearance = applyAppearance(DEFAULT_APPEARANCE);
        setAppConfig({ active_repo: "", known_repos: [], mcp_enabled: true, appearance });
      });
  }, []);

  useEffect(() => {
    if (!appConfig?.active_repo) {
      knownReposRef.current = null;
      return;
    }
    const key = appConfig.known_repos.join("\u0000");
    if (knownReposRef.current === null) {
      knownReposRef.current = key;
      return;
    }
    if (knownReposRef.current !== key) {
      knownReposRef.current = key;
      noticeSnapshot.requestRefresh();
    }
  }, [appConfig?.active_repo, appConfig?.known_repos, noticeSnapshot.requestRefresh]);

  useEffect(() => {
    if (!searchOpen || !appConfig?.active_repo) return;
    let cancelled = false;
    setSearchData(EMPTY_SEARCH_DATA);
    setSearchLoading(true);
    setSearchError("");
    Promise.all([ipc.listBoardTasks(true), ipc.listSessionItems(true, false)])
      .then(([tasks, sessions]) => {
        if (!cancelled) setSearchData({ tasks, sessions });
      })
      .catch((error) => {
        if (!cancelled) setSearchError(String(error));
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchOpen, appConfig?.active_repo]);

  const refreshBoards = () => setReloadNonce((n) => n + 1);

  const appearance = appConfig?.appearance ?? DEFAULT_APPEARANCE;
  const isDev = isDevelopmentProductName(productName);
  const update = useUpdateStatus({ enabled: !isDev });
  const ompUpdate = useOmpUpdateStatus();
  const onAppearanceChange = (next: AppearancePrefs) => {
    const normalized = applyAppearance(next);
    setAppConfig((cfg) => (cfg ? { ...cfg, appearance: normalized } : { active_repo: "", known_repos: [], mcp_enabled: true, appearance: normalized }));
  };
  const onNotificationsChange = useCallback(
    (notifications: NotificationPrefs) => {
      setAppConfig((cfg) => (cfg?.global ? { ...cfg, global: { ...cfg.global, notifications } } : cfg));
      noticeSnapshot.requestRefresh();
    },
    [noticeSnapshot.requestRefresh],
  );

  // The backend reserves the candidate before it kills the old repo's drawer session.
  // Clear the drawer UI only after that transactional switch succeeds.
  const switchActiveRepo = async (path: string): Promise<AppConfig> => {
    const previousRepo = appConfigRef.current?.active_repo;
    const drawerSessionId = drawerSessionRef.current?.id ?? null;
    const cfg = await ipc.setActiveRepo(path, drawerSessionId);
    if (cfg.active_repo !== previousRepo) clearDrawerUi();
    return { ...cfg, appearance: applyAppearance(cfg.appearance) };
  };

  const viewAfterScopeChange = (current: View): View => {
    const gridViewId = gridViewIdOf(current);
    return gridViewId && gridViews.some((gridView) => gridView.id === gridViewId) ? { kind: "grid", gridViewId } : { kind: "list" };
  };

  const setRepo = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    setRepoErr("");
    try {
      const cfg = await switchActiveRepo(p);
      setAppConfig(cfg);
      setScope("active");
      setView(viewAfterScopeChange);
    } catch (e) {
      setRepoErr(String(e));
    }
  };

  const selectRepoValue = (value: string) => {
    if (value === ALL_REPOS) {
      // Scope-only change: active_repo unchanged → do not kill drawer.
      setRepoErr("");
      setScope("all");
      setView(viewAfterScopeChange);
      return;
    }
    setRepo(value);
  };

  const toggleTerminalDrawer = async () => {
    if (!appConfig?.active_repo) return;
    if (drawerOpen) {
      setDrawerOpen(false); // CSS hide only — no kill, no clear
      return;
    }
    try {
      let sess = drawerSession;
      if (!sess) {
        const meta = await ipc.ensureDrawerTerminal();
        sess = { id: meta.id, cwd: meta.worktree || appConfig.active_repo };
        setDrawerSession(sess);
      }
      setDrawerOpen(true);
    } catch (e) {
      toast(String(e), "error");
    }
  };

  const switchTop = (kind: Tab, opts?: { instant?: boolean; gridViewId?: string }) => {
    setNavInstant(Boolean(opts?.instant));
    if (kind === "grid") {
      const gridViewId = opts?.gridViewId ?? gridViews[0].id;
      if (!gridViews.some((gridView) => gridView.id === gridViewId)) return;
      setView({ kind: "grid", gridViewId });
      return;
    }
    if (kind === "kanban" && !showOriginalKanban) {
      setView({ kind: "grid", gridViewId: gridViews[0].id });
      return;
    }
    if (kind === "settings") setScope("active");
    setView({ kind });
  };

  const openSettings = (section?: SettingsSectionKey, opts?: { instant?: boolean }) => {
    setNavInstant(Boolean(opts?.instant));
    setScope("active");
    setView({ kind: "settings", section });
  };

  const openBoardTask = async (task: BoardTask) => {
    if (!appConfig) return;
    setRepoErr("");
    try {
      if (task.repo_path !== appConfig.active_repo) {
        setAppConfig(await switchActiveRepo(task.repo_path));
      }

      if (task.draft && !task.archived) {
        setView({ kind: "create", from: view, draft: task });
      } else {
        setView({ kind: "task", slug: task.slug, repoPath: task.repo_path, from: view, initialTask: task });
      }
    } catch (e) {
      setRepoErr(String(e));
    }
  };

  const openRelatedTask = async (relatedSlug: string, relatedRepoPath?: string) => {
    if (!appConfig) return;
    const target = relatedRepoPath || appConfig.active_repo;
    setRepoErr("");
    try {
      if (target !== appConfig.active_repo) {
        setAppConfig(await switchActiveRepo(target));
      }
      setView({
        kind: "task",
        slug: relatedSlug,
        repoPath: target,
        from: view.kind === "task" ? { ...view, repoPath: view.repoPath || appConfig.active_repo } : view,
      });
    } catch (e) {
      setRepoErr(String(e));
    }
  };

  const openTaskSession = async ({
    repoPath,
    taskSlug,
    session,
    from,
    intent,
    resumeToken,
  }: {
    repoPath: string;
    taskSlug: string;
    session: Pick<SessionMeta, "id" | "worktree" | "phase" | "harness" | "model" | "playbook" | "generic">;
    from: View;
    intent?: "attach" | "spawn" | "resume" | "history";
    resumeToken?: string;
  }) => {
    if (!appConfig || !session.worktree) return;
    setRepoErr("");
    try {
      if (repoPath !== appConfig.active_repo) {
        setAppConfig(await switchActiveRepo(repoPath));
      }
      try {
        await ipc.markSessionNotificationRead(repoPath, taskSlug, session.id);
      } catch (error) {
        setRepoErr(String(error));
      } finally {
        noticeSnapshot.requestRefresh();
      }
      setView({
        kind: "session",
        id: session.id,
        cwd: session.worktree,
        taskSlug,
        phase: session.phase,
        harness: session.harness,
        model: session.model,
        playbook: session.playbook,
        generic: session.generic,
        intent,
        resumeToken,
        from,
      });
    } catch (error) {
      setRepoErr(String(error));
    }
  };

  const openActiveTaskSession = (task: BoardTask, session: TaskActivitySession) => {
    void openTaskSession({ repoPath: task.repo_path, taskSlug: task.slug, session, from: view });
  };

  const openSessionItem = (item: SessionListItem) => {
    void openTaskSession({
      repoPath: item.repo_path,
      taskSlug: item.task_slug,
      session: item,
      from: view,
    });
  };

  const createSessionFromTask = async (task: BoardTask, choice: SessionTypeChoice, harness: string, model: string, prompt?: string) => {
    if (!appConfig || !task.worktree) return;
    setRepoErr("");
    if (task.repo_path !== appConfig.active_repo) {
      setAppConfig(await switchActiveRepo(task.repo_path));
    }
    const playbook = choice.kind === "playbook-step" ? choice.playbook : "";
    const phase = choice.kind === "playbook-step" ? choice.phase : "";
    const generic = choice.kind === "generic";
    const m = await ipc.createSession({
      taskSlug: task.slug,
      playbook,
      phase,
      generic,
      harness,
      model: harness === "no-harness" ? "" : model,
      ...(harness !== "no-harness" && prompt !== undefined ? { prompt } : {}),
    });
    const targetTaskView: View = view.kind === "createSession" ? { kind: "task", slug: task.slug, repoPath: task.repo_path, from: view.from } : view;
    await openTaskSession({
      repoPath: task.repo_path,
      taskSlug: task.slug,
      session: m,
      from: targetTaskView,
      intent: "spawn",
    });
  };

  const addRepo = async () => {
    setRepoErr("");
    try {
      const path = await ipc.pickRepoDialog();
      if (path) await setRepo(path);
    } catch (e) {
      setRepoErr(String(e));
    }
  };

  // B4 / #132: closing a repo releases ownership — its daemon is stopped, its alineryd lock
  // and its GUI lock are dropped, so a closed repo can never keep serving with no UI left
  // to reach it. That ends live sessions, so it is confirmed here with the count first;
  // cancel changes nothing at all (no config write, no daemon call).
  const removeRepo = async (path: string) => {
    setRepoErr("");
    const wasActive = path === appConfig?.active_repo;
    const live = await liveSessions(path);
    const ok = await confirmDanger(
      `Close ${repoName(path)}?`,
      <>
        <p>Its session daemon is stopped and the repo is removed from the list. Files on disk are untouched.</p>
        {live > 0 && (
          <p className="confirm-loss">
            {live} live session{live === 1 ? "" : "s"} {live === 1 ? "is" : "are"} killed. In-flight harness work is lost and cannot be recovered.
          </p>
        )}
      </>,
      "Close repo",
    );
    if (!ok) return;
    try {
      if (wasActive) await killDrawer();
      const cfg = await ipc.removeRepo(path);
      setAppConfig({ ...cfg, appearance: applyAppearance(cfg.appearance) });
      if (wasActive) {
        setScope("active");
        setView({ kind: "list" });
        if (cfg.known_repos.length > 0) await setRepo(cfg.known_repos[0]);
      }
      toast(`Closed ${repoName(path)}`, "success");
    } catch (e) {
      setRepoErr(String(e));
    }
  };

  // Quitting alinery is the other way to strand work. `alineryd` deliberately outlives the app,
  // which is right for "I'll be back in a minute" and wrong for "I'm done" — a daemon with
  // no UI left to reach it is exactly the orphan this ticket is about. So the close button
  // asks, once, and both answers are legitimate: leaving them running is still the default
  // and calls nothing.
  //
  // Registering a `tauri://close-requested` listener makes tauri prevent the close for us
  // (manager/window.rs: `has_js_listener` ⇒ `prevent_close`), so this handler owns the
  // window's fate and must `destroy()` — `close()` would just re-enter here.
  //
  // Cmd+Q is NOT covered: macOS `applicationWillTerminate` reaches tao after the decision
  // is made (there is no `applicationShouldTerminate` hook), so it keeps the old behaviour
  // — leave everything running, which is the safe direction.
  useEffect(() => {
    const win = ipc.getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      event.preventDefault();
      const repos = appConfigRef.current?.known_repos ?? [];
      if (repos.length > 0) {
        const counts = await Promise.all(repos.map(liveSessions));
        const total = counts.reduce((a, b) => a + b, 0);
        const choice = await askConfirm({
          title: "Quit Alinery",
          body: (
            <>
              <p>Session daemons keep running after Alinery quits, so harnesses stay alive and reattach on the next launch.</p>
              <ul className="confirm-list">
                {repos.map((repo, i) => (
                  <li key={repo}>
                    <span className="confirm-repo">{repoName(repo)}</span>
                    <span className="dim">
                      {counts[i]} live session{counts[i] === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="dim">
                Closing every repo stops each daemon and releases its locks — nothing is left running in the background.
                {total > 0 && (
                  <span className="confirm-loss">
                    {" "}
                    {total} live session{total === 1 ? "" : "s"} would be killed and in-flight work lost.
                  </span>
                )}
              </p>
            </>
          ),
          choices: [
            { key: "leave", label: "Quit, leave sessions running" },
            { key: "stop", label: "Quit & close all repos", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
          // Never autoFocus the destructive "close all" path — Enter leaves sessions running.
          defaultKey: "leave",
        });
        if (choice === "cancel") return;
        if (choice === "stop") {
          try {
            await ipc.closeAllRepos();
          } catch (e) {
            // close_all_repos is fail-closed per repo: a daemon that would not stop is
            // still running, and quitting silently would leave the user believing they
            // had torn everything down. Say so, and let them decide — cancelling here is
            // the only way back to a window that can still stop those sessions.
            console.error("close_all_repos", e);
            const quitAnyway = await confirmDanger(
              "Some repositories did not close",
              <>
                <p>{String(e)}</p>
                <p className="dim">
                  Those daemons and their sessions are still running. Quitting now leaves them with no window to reach them — you can stop them from Settings → Chat instead.
                </p>
              </>,
              "Quit anyway",
            );
            if (!quitAnyway) {
              // Back to the window — so lift the quit latch close_all_repos set. It
              // suppresses daemon attach and the 5s poller, and leaving it on would hand
              // them a window that cannot reopen the repos that did close, nor recover
              // the surviving daemons this dialog just told them to go stop by hand.
              await ipc.cancelQuit().catch((err) => console.error("cancel_quit", err));
              return;
            }
          }
        }
      }
      await win.destroy();
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, []);

  // ⌘G cycles the appearance mode; the persisted config keeps it across launches.
  const cycleAppearance = () => {
    const order: AppearanceMode[] = ["system", "light", "dark"];
    const mode = order[(order.indexOf(appearance.mode ?? "system") + 1) % order.length];
    const next = { ...appearance, mode };
    onAppearanceChange(next);
    // No success toast: the theme changes on screen, which is the confirmation.
    // A failed write is the one case the screen and disk disagree, so it reports.
    ipc.writeAppearance(next).catch((e) => toast(`Couldn't save appearance: ${String(e)}`, "error"));
  };

  // The in-app upgrader stops every session daemon on purpose — the running bundle has
  // to be dead before it can be replaced (docs/architecture/self-update.md) — so it warns
  // with the same loss-of-work grammar as the quit dialog above before doing anything.
  // "Not now" is the default answer; Enter never starts an upgrade.
  const onUpgrade = async () => {
    const release = update.status.available;
    if (!release) return;
    const repos = appConfig?.known_repos ?? [];
    const counts = await Promise.all(repos.map(liveSessions));
    const total = counts.reduce((a, b) => a + b, 0);
    const choice = await askConfirm({
      title: `Upgrade to ${release.version}?`,
      body: (
        <>
          <p>Upgrading quits Alinery and stops every session daemon — siblings too, via the installer's own quiet-machine gate — so the app bundle can be replaced.</p>
          {repos.length > 0 && (
            <ul className="confirm-list">
              {repos.map((repo, i) => (
                <li key={repo}>
                  <span className="confirm-repo">{repoName(repo)}</span>
                  <span className="dim">
                    {counts[i]} live session{counts[i] === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {total > 0 && (
            <p className="confirm-loss">
              {total} live session{total === 1 ? "" : "s"} would be killed and in-flight work lost.
            </p>
          )}
        </>
      ),
      choices: [
        { key: "upgrade", label: `Upgrade to ${release.version} & restart`, tone: "danger" },
        { key: "download", label: "Download only" },
        { key: "cancel", label: "Not now", tone: "ghost" },
      ],
      defaultKey: "cancel",
    });
    if (choice === "cancel") return;
    setUpdating(true);
    try {
      const staged = await ipc.downloadUpdate(release.version);
      if (choice === "download") {
        toast.success(`Downloaded to ${staged.scratch_dir}`);
        try {
          await ipc.revealItemInDir(staged.scratch_dir);
        } catch (e) {
          toast.error(`Couldn't reveal ${staged.scratch_dir}: ${String(e)}`);
        }
      } else {
        await ipc.applyUpdate(release.version);
        await ipc.getCurrentWindow().destroy();
      }
    } catch (e) {
      toast.error(`Couldn't update: ${String(e)}`);
    } finally {
      setUpdating(false);
    }
  };

  const goBack = () => {
    if (searchOpen) {
      setSearchOpen(false);
      return;
    }
    if (!("from" in view)) return;
    setNavInstant(true);
    const dest = view.from;
    const destRepo = dest.kind === "task" ? dest.repoPath : undefined;
    if (destRepo && appConfig && destRepo !== appConfig.active_repo) {
      void (async () => {
        setRepoErr("");
        try {
          setAppConfig(await switchActiveRepo(destRepo));
          setView(dest);
        } catch (e) {
          setRepoErr(String(e));
        }
      })();
      return;
    }
    setView(dest);
  };

  const openCreate = () => {
    setSearchOpen(false);
    setView({ kind: "create", from: view });
  };

  const duplicateTask = async ({ repoPath, sourceSlug }: { repoPath: string; sourceSlug: string }) => {
    if (!appConfigRef.current || duplicatingRef.current) return;
    const invocationView = view;
    duplicatingRef.current = true;
    setDuplicating(true);
    try {
      let created: CreateTaskResult;
      try {
        created = await ipc.duplicateTaskForRepo(repoPath, sourceSlug);
      } catch (e) {
        toast(`TASK DUPLICATION FAILED: ${e}`);
        return;
      }

      const { task, session } = created;
      try {
        if (repoPath !== appConfigRef.current?.active_repo) {
          const config = await switchActiveRepo(repoPath);
          if (config.active_repo !== repoPath) throw new Error(`repository switch returned ${config.active_repo}`);
          appConfigRef.current = config;
          setAppConfig(config);
        }
        setScope("active");
        refreshBoards();
        toast("TASK DUPLICATED");
        if (session.harness !== "no-harness") {
          ipc.spawnSessionDetachedForRepo(repoPath, task.slug, session.id).catch((e) => toast(`SESSION NOT STARTED: ${e}`));
        }
        setView({ kind: "task", slug: task.slug, from: invocationView });
      } catch (e) {
        toast(`TASK DUPLICATED BUT NOT OPENED: ${repoPath}/${task.slug}: ${e}`);
      }
    } finally {
      duplicatingRef.current = false;
      setDuplicating(false);
    }
  };

  const overlayOpen = searchOpen || diagramZoomOpen;
  // Avoid stuck overlayOpen after leaving task/session with zoom still flagged open.
  useEffect(() => {
    if (view.kind !== "task" && view.kind !== "session") setDiagramZoomOpen(false);
  }, [view.kind]);
  const board: "kanban" | "grid" | "list" | "sessions" | "notifications" | null =
    view.kind === "kanban"
      ? "kanban"
      : view.kind === "grid"
        ? "grid"
        : view.kind === "list"
          ? "list"
          : view.kind === "sessions"
            ? "sessions"
            : view.kind === "notifications"
              ? "notifications"
              : null;

  const hasRepo = Boolean(appConfig?.active_repo);

  useHotkeys({
    overlayOpen,
    isFullscreen,
    board,
    toggleSearch: () => {
      if (!hasRepo) return;
      setSearchOpen((open) => !open);
    },
    openCreate: () => {
      if (hasRepo) openCreate();
    },
    goList: () => {
      if (hasRepo) switchTop("list", { instant: true });
    },
    goKanban: () => {
      if (hasRepo) switchTop("kanban", { instant: true });
    },
    goGrid: (slot) => {
      const gridView = gridViews[slot];
      if (hasRepo && gridView) switchTop("grid", { instant: true, gridViewId: gridView.id });
    },
    goSessions: () => {
      if (hasRepo) switchTop("sessions", { instant: true });
    },
    goNotifications: () => {
      if (hasRepo) switchTop("notifications", { instant: true });
    },
    goSettings: () => {
      if (hasRepo) openSettings(undefined, { instant: true });
    },
    archiveSelected: () => navRef.current?.archiveSelected(),
    duplicateSelected: () => navRef.current?.duplicateSelected(),
    openSelected: () => navRef.current?.openSelected(),
    toggleGlow: cycleAppearance,
    sync: () => {
      refreshBoards();
      toast("Syncing…");
    },
    back: goBack,
    moveRow: (d) => navRef.current?.moveRow(d),
    moveCol: (d) => navRef.current?.moveCol(d),
    toggleTerminalDrawer: () => {
      void toggleTerminalDrawer();
    },
    killTerminalDrawer: () => {
      void killDrawer();
    },
  });

  // Actions call the same callbacks as their direct shortcuts.
  const pi = (Icon: typeof Play) => <Icon size={16} strokeWidth={1.5} aria-hidden="true" />;
  const action = (id: string, icon: ReactNode, title: string, hint: string, run: () => void): SearchItem => ({
    id: `action:${id}`,
    kind: "action",
    icon,
    title,
    detail: "",
    searchText: title,
    hint,
    run,
  });
  const actions: SearchItem[] = [
    ...(hasRepo
      ? [
          action("run", pi(Play), "Run session on selected", "⌘↵", () => navRef.current?.openSelected()),
          action("new-task", pi(Plus), "New task", "⌘N", openCreate),
          action("tasks", pi(List), "Go to Tasks", "⌘1", () => switchTop("list", { instant: true })),
          ...gridViews.map((gridView, index) =>
            action(`grid-${gridView.id}`, pi(Grid3X3), `Go to ${gridView.name}`, gridViewShortcut(index), () => switchTop("grid", { instant: true, gridViewId: gridView.id })),
          ),
          ...(showOriginalKanban ? [action("kanban", pi(SquareKanban), "Go to Kanban", "⌘3", () => switchTop("kanban", { instant: true }))] : []),
          action("sessions", pi(SquareTerminal), "Go to Sessions", "⌘7", () => switchTop("sessions", { instant: true })),
          action("notifications", pi(Bell), "Go to Notifications", "⌘8", () => switchTop("notifications", { instant: true })),
          action("settings", pi(SettingsIcon), "Open Settings", "⌘9", () => openSettings(undefined, { instant: true })),
          ...SETTINGS_SECTIONS.map((section) =>
            action(`settings-${section.key}`, pi(ChevronRight), `Settings — ${section.label}`, "", () => openSettings(section.key, { instant: true })),
          ),
          action("archive", pi(Archive), "Archive selected", "⌘E", () => navRef.current?.archiveSelected()),
          action("duplicate", pi(Copy), "Duplicate selected", "⌘D", () => navRef.current?.duplicateSelected()),
          action("sync", pi(RefreshCw), "Sync repo", "⌘⇧R", () => {
            refreshBoards();
            toast("Syncing…");
          }),
          action("terminal", pi(Terminal), "Toggle terminal drawer", "⌘`", () => void toggleTerminalDrawer()),
          action("kill-terminal", pi(X), "Kill terminal drawer", "⌘⇧`", () => void killDrawer()),
        ]
      : []),
    action("appearance", pi(SunMoon), "Appearance: cycle system / light / dark", "⌘G", cycleAppearance),
    action("add-repo", pi(FolderPlus), "Add repo", "", addRepo),
  ];

  const searchItems: SearchItem[] = [
    ...actions,
    ...searchData.tasks.map((task) => ({
      id: `task:${task.repo_path}:${task.slug}`,
      kind: "task" as const,
      title: task.name,
      detail: [repoName(task.repo_path), task.branch, task.archived ? "Archived" : task.draft ? "Draft" : task.current_step_title].filter(Boolean).join(" · "),
      searchText: [task.slug, task.playbook, task.playbook_title, task.current_phase, task.current_column_title, task.linear_id, task.github_issue].join(" "),
      run: () => void openBoardTask(task),
    })),
    ...searchData.sessions
      .filter((session) => Boolean(session.task_worktree))
      .map((session) => ({
        id: `session:${session.repo_path}:${session.task_slug}:${session.id}`,
        kind: "session" as const,
        title: session.task_name,
        detail: [repoName(session.repo_path), session.step_title || session.phase || "Session", session.harness, session.model, session.id].filter(Boolean).join(" · "),
        searchText: [session.task_slug, session.playbook, session.playbook_title, session.phase, session.step_title, session.harness, session.model, session.id].join(" "),
        run: () => void openSessionItem(session),
      })),
  ];

  const chrome = (content: ReactNode, header?: ReactNode) => (
    <>
      {setupOffer && (
        <ProviderSetupDialog
          mode="auto"
          onClose={(reason) => {
            setSetupOffer(false);
            // Only a real dismissal is remembered. Self-closing because the install is already
            // set up must not suppress the offer if those credentials later go away.
            if (reason === "dismissed") {
              try {
                localStorage.setItem(OMP_SETUP_DISMISSED_KEY, "1");
              } catch {
                /* nothing to do: the offer simply comes back next launch */
              }
            }
          }}
        />
      )}
      <ResizeHandles />
      <div className="app-shell">
        <div className={drawerOpen ? "app app-with-drawer" : "app"} style={drawerOpen ? ({ ["--drawer-width" as string]: `${drawerWidth}px` } as CSSProperties) : undefined}>
          {(drawerOpen || drawerSession) && (
            <TerminalDrawer
              open={drawerOpen}
              width={drawerWidth}
              onWidthChange={(w) => setDrawerWidth(clampDrawerWidth(w))}
              session={drawerSession}
              terminalFontSize={appearance.terminal_font_size}
              onKilled={clearDrawerUi}
              onExited={() => {
                void killDrawer();
              }}
              view={view}
              scope={scope}
              activeRepo={appConfig?.active_repo}
            />
          )}
          <div className={drawerOpen ? "app-main-column" : undefined} style={drawerOpen ? undefined : { display: "contents" }}>
            {daemon.repo_busy && appConfig?.active_repo && <RepoBusyBanner repo={appConfig.active_repo} onPickRepo={() => void addRepo()} />}
            <DaemonConflictBanner conflict={daemon.conflict} onReclaimed={() => setReloadNonce((n) => n + 1)} />
            <HostGuardWarning visible={daemon.host_guard_warning} />
            {repoErr && appConfig?.active_repo && (
              <div className="daemon-conflict" role="alert">
                <strong>{repoErr}</strong>
                <button type="button" className="daemon-conflict-dismiss" aria-label="Dismiss error" title="Dismiss" onClick={() => setRepoErr("")}>
                  <X size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>
            )}
            {header}
            {/* Backend ownership gate is the source of truth; blank main so the busy
              banner is the only actionable surface (defense-in-depth). */}
            <main>{daemon.repo_busy ? null : content}</main>
            <HotkeyBar
              view={view.kind}
              daemon={daemon}
              mcp={mcp}
              showHints={Boolean(appConfig?.active_repo)}
              version={appVersion}
              gridViewName={view.kind === "grid" ? gridViews.find((gridView) => gridView.id === view.gridViewId)?.name : undefined}
              gridViewShortcut={
                view.kind === "grid" && gridViews.some((gridView) => gridView.id === view.gridViewId)
                  ? gridViewShortcut(gridViews.findIndex((gridView) => gridView.id === view.gridViewId))
                  : undefined
              }
            />
          </div>
        </div>
        {isDev && <LaunchSourceBar sourceRoot={DEV_LAUNCH_ROOT} />}
      </div>
      <GlobalSearch open={searchOpen && hasRepo} items={searchItems} loading={searchLoading} error={searchError} onClose={() => setSearchOpen(false)} />
      <Toast />
      <ConfirmHost />
    </>
  );

  const minimalHeader = (
    <header data-tauri-drag-region="">
      <WindowControls />
      <div className="brand">
        <BrandMark />
      </div>
      <div className="spacer" />
    </header>
  );

  // Real wait behind the old boot screen: the app config load. A single centered
  // 64px orb + static label is the DESIGN.md treatment for this state. `searching`
  // rather than the inline activity orb: at 64px it is the one state that reads as
  // a whole form instead of a scatter of dots, and it appears alone, so it does not
  // have to match the board. It shares ORB_SPEED so the app opens at the same
  // unhurried rate the board keeps.
  if (!appConfig)
    return chrome(
      <div className="view">
        <div className="boot-wait">
          <ThinkingOrb state="searching" speed={ORB_SPEED} size={64} aria-hidden="true" />
          <span>Starting Alinery</span>
        </div>
      </div>,
      minimalHeader,
    );
  if (!appConfig.active_repo)
    return chrome(
      <div className="view scroll first-run-view">
        <img className="first-run-logo" src={alineryIcon} alt="Alinery" />
        <p className="first-run-tagline">
          Increase your <span>token:attention</span> ratio.
        </p>
        <RepoPicker appConfig={appConfig} error={repoErr} onSelect={setRepo} onRemove={removeRepo} onAdd={addRepo} />
      </div>,
      minimalHeader,
    );

  const gridStorageScopeKey = scope === "all" ? "all-repositories" : appConfig.active_repo;

  const header = (
    <TopBar
      isDev={isDev}
      active={primaryTabOf(view)}
      activeGridViewId={gridViewIdOf(view)}
      scope={scope}
      appConfig={appConfig}
      gridViews={gridViews}
      showOriginalKanban={showOriginalKanban}
      instant={navInstant}
      onSwitch={switchTop}
      onSwitchGrid={(gridViewId) => switchTop("grid", { gridViewId })}
      onSelectRepo={selectRepoValue}
      onAddRepo={addRepo}
      onRemoveRepo={removeRepo}
      onBrand={() => switchTop("grid", { gridViewId: gridViews[0].id })}
      onSearch={() => setSearchOpen(true)}
      onCreate={openCreate}
      update={update.status}
      onUpgrade={onUpgrade}
      updating={updating}
      ompUpdate={ompUpdate.status}
      onOmpUpdateClick={() => openSettings("chat")}
    />
  );

  const content = (
    <>
      {view.kind !== "grid" && (
        <div key={isPrimaryTab(view.kind) ? view.kind : "nested"} className={isPrimaryTab(view.kind) ? viewFadeClass(navInstant) : undefined}>
          {view.kind === "list" && (
            <div className="view">
              <TaskList
                key={`list:${repoKey}`}
                allRepos={scope === "all"}
                onOpen={openBoardTask}
                onDuplicate={(task) => duplicateTask({ repoPath: task.repo_path, sourceSlug: task.slug })}
                onOpenActiveSession={openActiveTaskSession}
                registerNav={registerNav}
                onCreate={openCreate}
              />
            </div>
          )}
          {view.kind === "create" && (
            <div className="view scroll">
              <CreateTaskPage
                initialDraft={view.kind === "create" ? view.draft : undefined}
                activeRepo={appConfig.active_repo}
                knownRepos={appConfig.known_repos}
                onCancel={goBack}
                onCreated={async ({ repoPath, task, session }) => {
                  try {
                    if (repoPath !== appConfig.active_repo) {
                      setAppConfig(await switchActiveRepo(repoPath));
                      setScope("active");
                    }
                    refreshBoards();
                    toast("Task created", "success");
                    if (session.harness !== "no-harness") {
                      ipc.spawnSessionDetached(task.slug, session.id).catch((e) => toast(`Session not started: ${e}`, "error"));
                    }
                    setView({ kind: "task", slug: task.slug, repoPath, from: view.from, initialTask: task });
                  } catch (e) {
                    setRepoErr(String(e));
                  }
                }}
              />
            </div>
          )}
          {view.kind === "kanban" && (
            <div className="view">
              <Kanban
                key={`kanban:${repoKey}`}
                allRepos={scope === "all"}
                onOpen={openBoardTask}
                onDuplicate={(task) => duplicateTask({ repoPath: task.repo_path, sourceSlug: task.slug })}
                onOpenActiveSession={openActiveTaskSession}
                registerNav={registerNav}
                onCreate={openCreate}
              />
            </div>
          )}
          {view.kind === "sessions" && (
            <div className="view">
              <SessionsList
                key={`sessions:${repoKey}`}
                allRepos={scope === "all"}
                activeRepo={appConfig.active_repo}
                onOpen={openSessionItem}
                registerNav={registerNav}
                onCreateSession={() => setView({ kind: "createSession", from: view })}
                onCreateTask={openCreate}
                sessionSort={globalSessionSort}
                onSessionSortChange={setGlobalSessionSort}
              />
            </div>
          )}
          {view.kind === "notifications" && (
            <div className="view">
              <NotificationsList
                key={`notifications:${repoKey}`}
                allRepos={scope === "all"}
                activeRepo={appConfig.active_repo}
                rows={noticeSnapshot.rows}
                loaded={noticeSnapshot.loaded}
                error={noticeSnapshot.error}
                busy={noticeSnapshot.clearing}
                onClear={noticeSnapshot.clear}
                onClearAll={noticeSnapshot.clearAll}
                onOpen={openSessionItem}
                registerNav={registerNav}
              />
            </div>
          )}
          {view.kind === "createSession" && (
            <div className="view scroll">
              <CreateSessionPage allRepos={scope === "all"} activeRepo={appConfig.active_repo} initialTask={view.initialTask} onCancel={goBack} onCreated={createSessionFromTask} />
            </div>
          )}
          {view.kind === "settings" && (
            <div className="view scroll">
              <Settings
                key={`settings:${repoKey}:${view.section ?? ""}`}
                mcp={mcp}
                activeRepo={appConfig.active_repo}
                knownRepos={appConfig.known_repos}
                appearance={appearance}
                onAppearanceChange={onAppearanceChange}
                onGlobalSettingsChange={(global) => setAppConfig((current) => (current ? { ...current, global } : current))}
                onNotificationsChange={onNotificationsChange}
                initialSection={view.section}
                update={update.status}
                updateChecking={update.checking}
                updating={updating}
                onCheckNow={update.checkNow}
                onUpgrade={onUpgrade}
                onClearUpdateOffer={update.clearOffer}
              />
            </div>
          )}
          {view.kind === "task" && (
            <div className="view">
              <Suspense
                fallback={
                  <div className="view">
                    <LoadingState label="Loading…" />
                  </div>
                }
              >
                <TaskDetail
                  key={`task:${view.repoPath || appConfig.active_repo}:${view.slug}`}
                  slug={view.slug}
                  initialTask={view.initialTask}
                  repoPath={view.repoPath || appConfig.active_repo}
                  knownRepos={appConfig.known_repos}
                  sessionSort={taskSessionSort}
                  onSessionSortChange={setTaskSessionSort}
                  onBack={goBack}
                  onOpenSession={(ownerTaskSlug, id, cwd, phase, harness, model, playbook, generic, intent) => {
                    void openTaskSession({
                      repoPath: appConfig.active_repo,
                      taskSlug: ownerTaskSlug,
                      session: { id, worktree: cwd, phase, harness, model, playbook, generic },
                      intent,
                      from: view,
                    });
                  }}
                  onNewSession={() =>
                    setView({
                      kind: "createSession",
                      from: view,
                      initialTask: { repo_path: view.repoPath || appConfig.active_repo, slug: view.slug },
                    })
                  }
                  onOpenRelatedTask={openRelatedTask}
                  onDuplicate={(task) => duplicateTask({ repoPath: appConfig.active_repo, sourceSlug: task.slug })}
                  duplicating={duplicating}
                  registerNav={registerNav}
                  appearance={appearance}
                  onAppearanceChange={onAppearanceChange}
                  onDiagramZoomOpenChange={setDiagramZoomOpen}
                />
              </Suspense>
            </div>
          )}
          {view.kind === "reviewHandoff" && (
            <div className="view scroll">
              <Suspense
                fallback={
                  <div className="view">
                    <LoadingState label="Loading…" />
                  </div>
                }
              >
                <ReviewHandoffPage
                  source={view.source}
                  allRepos={false}
                  activeRepo={appConfig.active_repo}
                  onCancel={goBack}
                  onConfirmed={async (result) => {
                    refreshBoards();
                    toast("Handoff sent", "success");
                    await openTaskSession({
                      repoPath: appConfig.active_repo,
                      taskSlug: result.target_record.target_task,
                      session: result.target_session,
                      intent: "spawn",
                      from: view.from,
                    });
                  }}
                />
              </Suspense>
            </div>
          )}
          {view.kind === "session" && (
            <div className="view nopad">
              <Suspense
                fallback={
                  <div className="view">
                    <LoadingState label="Loading…" />
                  </div>
                }
              >
                <SessionView
                  id={view.id}
                  cwd={view.cwd}
                  taskSlug={view.taskSlug}
                  repoPath={appConfig.active_repo}
                  phase={view.phase}
                  harness={view.harness}
                  model={view.model}
                  playbook={view.playbook}
                  intent={view.intent}
                  resumeToken={view.resumeToken}
                  messageDraft={sessionMessageDrafts.get(sessionMessageDraftKey(appConfig.active_repo, view.taskSlug, view.id)) ?? EMPTY_SESSION_MESSAGE_DRAFT}
                  onMessageDraftChange={(draft) => {
                    const key = sessionMessageDraftKey(appConfig.active_repo, view.taskSlug, view.id);
                    setSessionMessageDrafts((current) => {
                      const next = new Map(current);
                      next.set(key, draft);
                      return next;
                    });
                  }}
                  queuedFollowUps={sessionQueuedFollowUps.get(sessionMessageDraftKey(appConfig.active_repo, view.taskSlug, view.id)) ?? []}
                  onQueuedFollowUpsChange={(items) => {
                    const key = sessionMessageDraftKey(appConfig.active_repo, view.taskSlug, view.id);
                    setSessionQueuedFollowUps((current) => {
                      const next = new Map(current);
                      if (items.length === 0) next.delete(key);
                      else next.set(key, items);
                      return next;
                    });
                  }}
                  onStartReviewHandoff={(source) => setView({ kind: "reviewHandoff", from: view, source })}
                  onOpenRelatedTask={openRelatedTask}
                  appearance={appearance}
                  onAppearanceChange={onAppearanceChange}
                  onDiagramZoomOpenChange={setDiagramZoomOpen}
                  onBack={goBack}
                  onStartFresh={async () => {
                    try {
                      const m = await ipc.createSession({
                        taskSlug: view.taskSlug,
                        playbook: view.playbook ?? "",
                        phase: view.phase,
                        generic: view.generic,
                        harness: view.harness,
                        model: view.model,
                      });
                      await openTaskSession({
                        repoPath: appConfig.active_repo,
                        taskSlug: view.taskSlug,
                        session: m,
                        intent: "spawn",
                        from: view,
                      });
                    } catch (e) {
                      setRepoErr(String(e));
                    }
                  }}
                />
              </Suspense>
            </div>
          )}
        </div>
      )}
      {keptGridViews.map((gridView) => {
        const active = view.kind === "grid" && view.gridViewId === gridView.id;
        return (
          <div key={`grid:${repoKey}:${gridView.id}`} className="view grid-view-shell" hidden={!active}>
            <Grid
              active={active}
              allRepos={scope === "all"}
              onOpen={openBoardTask}
              onDuplicate={(task) => duplicateTask({ repoPath: task.repo_path, sourceSlug: task.slug })}
              registerNav={registerNav}
              storageKey={`${gridStorageScopeKey}:view:${gridView.id}`}
              initialPreset={gridView.id === DEFAULT_GRID_VIEW_ID ? "kanban" : "steps"}
            />
          </div>
        );
      })}
    </>
  );

  return chrome(content, header);
}
