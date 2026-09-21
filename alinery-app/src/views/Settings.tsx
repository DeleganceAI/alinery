import { AlertCircle, ArrowDown, ArrowUp, Check, ChevronRight, Circle, Copy, EllipsisVertical, ExternalLink, Minus, Monitor, Moon, Plus, Sun, Trash2 } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import {
  ARTIFACT_FONT_MAX,
  ARTIFACT_FONT_MIN,
  ARTIFACT_VIEWER_WIDTH_MAX,
  ARTIFACT_VIEWER_WIDTH_MIN,
  applyAppearance,
  CHAT_FONT_DEFAULT,
  CHAT_FONT_MAX,
  CHAT_FONT_MIN,
  CHAT_RAIL_FONT_DEFAULT,
  DEFAULT_APPEARANCE,
  normalizeArtifactViewerWidth,
  normalizeChatFontSize,
  normalizeChatMaxWidth,
  normalizeChatRailDensity,
  normalizeChatRailFontSize,
  normalizeSessionDefaultView,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  UI_SCALE_STEPS,
} from "../appearance";
import { copyTextToClipboard } from "../chat/CopyMessage";
import { confirmDanger } from "../confirm";
import { createGridViewId, gridViewShortcut, MAX_GRID_VIEWS, nextGridViewName, normalizeGridViews, withGridViewSlots } from "../gridViews";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { Checkbox, EmptyState, InlineStatus, LoadingState, ModelInput, ompDefaultModel, repoName } from "../shared";
import { type ToastLength, toast } from "../toast";
import type {
  AppearancePrefs,
  BackupListItem,
  ChatMaxWidth,
  ChatRailDensity,
  ChoiceProvenance,
  Config,
  ConnectionStatus,
  GlobalSettings,
  GridViewDefinition,
  HarnessChoice,
  PurgeFailure,
  RepoBackupOverrides,
  RepoOverrides,
  SessionDefaultView,
  SettingSource,
  SettingsSectionKey,
  StorageInfo,
  UpdateStatus,
} from "../types";
import { type McpStatus, type McpStatusHandle, mcpDotColor, mcpStatusLabel } from "../useMcpStatus";
import { useOmpUpdateStatus } from "../useOmpUpdateStatus";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { XaiKeyDialog } from "./XaiKeyDialog";

/** Kebab menu for a connected row: the actions that only make sense once a connection exists.
 *  Follows RepoSelect's dropdown idiom — outside click and Escape close it, Escape returns focus. */
function ConnectionMenu({ label, busy, onReconnect, onRemove }: { label: string; busy: boolean; onReconnect: () => void; onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    // Tabbing out has to close it too. Without this the popup stays mounted over the row below,
    // and since Enter fires click rather than mousedown, a keyboard user can leave two menus open.
    const onFocusOut = (e: FocusEvent) => {
      if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    box.current?.addEventListener("focusout", onFocusOut);
    const boxEl = box.current;
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      boxEl?.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  // Arrow keys, because aria-haspopup promises a menu and RepoSelect's idiom has them.
  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>("button") ?? []);
    if (items.length === 0) return;
    const at = items.findIndex((el) => el === document.activeElement);
    const next = e.key === "ArrowDown" ? (at + 1 + items.length) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  // Focus goes back to the trigger, which is why the trigger must not be the thing `busy` disables:
  // focusing a button that this same commit disables drops focus to <body> for the whole OAuth wait.
  const run = (action: () => void) => () => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };

  return (
    <div className="connection-menu" ref={box}>
      <button
        type="button"
        ref={trigger}
        className="connection-menu-trigger"
        aria-label={`${label} connection actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <EllipsisVertical size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: a menu of buttons is the pattern RepoSelect uses.
        <div className="repo-menu connection-menu-list" role="menu" ref={menu} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" className="repo-opt-main" disabled={busy} onClick={run(onReconnect)}>
            Reconnect
          </button>
          {/* The backend marks credentials Alinery owns as removable; GitHub belongs to gh. */}
          {onRemove && (
            <button type="button" role="menuitem" className="repo-opt-main danger" disabled={busy} onClick={run(onRemove)}>
              Remove connection
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const SECTIONS: { key: SettingsSectionKey; label: string }[] = [
  { key: "connections", label: "Connections" },
  { key: "notifications", label: "Notifications" },
  { key: "telemetry", label: "Telemetry" },
  { key: "updates", label: "Updates" },
  { key: "storage", label: "Storage" },
  { key: "appearance", label: "Appearance" },
  { key: "chat", label: "Chat" },
  { key: "experimental", label: "Experimental" },
  { key: "gridViews", label: "Grid views" },
  { key: "mcp", label: "MCP Server" },
  { key: "backup", label: "Backup" },
];

type SettingsScope = { kind: "global" } | { kind: "repo"; repoPath: string };
type ChoiceKey = "defaults";
type ChoiceBoolField = "draft_autosave";

const SETTINGS_SCOPE_EMPTY_TITLE = "Select a settings scope to see these settings";
const GLOBAL_SOURCE: SettingSource = "global";
const REPO_SOURCE: SettingSource = "repository";

const SCALE_MIN = UI_SCALE_STEPS[0];
const SCALE_MAX = UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1];

/** Range inputs can't paint their own filled portion; .scale-slider reads this. */
const sliderPos = (value: number, min: number, max: number): CSSProperties => ({ "--slider-pos": (value - min) / (max - min) }) as CSSProperties;

const EMPTY_OVERRIDES: RepoOverrides = {
  github: {},
  defaults: {},
  backup: {},
};

/** Full host mcpServers envelope for Claude Desktop / Cursor / other command+args hosts.
 *  No `args`: one process now serves every repo, and `repo` is a per-call tool argument
 *  (a path from `alinery_list_repos`), not a launch flag. */
function stdioHostConfigJson(binaryPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        alinery: {
          command: binaryPath,
        },
      },
    },
    null,
    2,
  );
}

/** True when the binary is known for Copy config (repo is a per-call tool argument now,
 *  not an install prerequisite; managed toggle is irrelevant). */
function mcpInstallReady(mcp: Pick<McpStatus, "binary_found" | "binary_path">): boolean {
  return mcp.binary_found && !!mcp.binary_path;
}

const allGlobalChoiceSource: ChoiceProvenance = {
  harness: GLOBAL_SOURCE,
  model: GLOBAL_SOURCE,
  playbook: GLOBAL_SOURCE,
  draft_autosave: GLOBAL_SOURCE,
};

function globalAsConfig(global: GlobalSettings): Config {
  return {
    notifications: global.notifications,
    github: global.github,
    defaults: global.defaults,
    provenance: {
      github_token: GLOBAL_SOURCE,
      defaults: allGlobalChoiceSource,
    },
    backup: global.backup,
    telemetry: global.telemetry,
  };
}

// MiB, always two fraction digits — sub-MB must read "0.00 MB", never "0 MB".
// Mirrors alinery-core's `format_mb`; keep the divisor and precision identical.
const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

export function Settings({
  mcp,
  activeRepo,
  knownRepos,
  appearance,
  onAppearanceChange,
  onGlobalSettingsChange,
  onNotificationsChange,
  initialSection,
  update = null,
  updateChecking = false,
  updating = false,
  onCheckNow,
  onUpgrade,
  onClearUpdateOffer,
}: {
  // No `daemon` prop: the Sessions section is scope-driven and probes each repo itself.
  mcp: McpStatusHandle;
  activeRepo: string;
  knownRepos: string[];
  appearance: AppearancePrefs;
  onAppearanceChange: (next: AppearancePrefs) => void;
  onGlobalSettingsChange?: (next: GlobalSettings) => void;
  onNotificationsChange: (next: GlobalSettings["notifications"]) => void;
  initialSection?: SettingsSectionKey;
  update?: UpdateStatus | null;
  updateChecking?: boolean;
  updating?: boolean;
  onCheckNow?: () => Promise<UpdateStatus>;
  onUpgrade?: () => void;
  onClearUpdateOffer?: () => void;
}) {
  const [scope, setScope] = useState<SettingsScope>({ kind: "global" });
  const [global, setGlobal] = useState<GlobalSettings | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [gridViewDrafts, setGridViewDrafts] = useState<Record<string, string>>({});
  const [gridViewErrors, setGridViewErrors] = useState<Record<string, string>>({});
  const [focusGridViewId, setFocusGridViewId] = useState("");
  const globalSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const [overrides, setOverrides] = useState<RepoOverrides>(EMPTY_OVERRIDES);
  const report = (text: string, length?: ToastLength) => toast.success(text, length);
  const reportError = (e: unknown, what = "The action failed") => toast.error(`${what}: ${String(e)}`);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [storageErr, setStorageErr] = useState("");
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeErrors, setPurgeErrors] = useState<PurgeFailure[]>([]);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(initialSection ?? "notifications");
  const [backups, setBackups] = useState<BackupListItem[]>([]);
  const [backupsErr, setBackupsErr] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [connections, setConnections] = useState<ConnectionStatus[] | null>(null);
  const [connecting, setConnecting] = useState<ConnectionStatus["provider"] | "">("");
  const [xaiKey, setXaiKey] = useState<{ present: boolean } | null>(null);
  const [xaiDialog, setXaiDialog] = useState(false);
  // Local while dragging so the slider does not write config.toml on every step.
  const [retentionDraft, setRetentionDraft] = useState<number | null>(null);
  const [scaleDraft, setScaleDraft] = useState<number | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [localUpdate, setLocalUpdate] = useState<UpdateStatus | null>(null);
  const [localChecking, setLocalChecking] = useState(false);
  const [updateCheckFailed, setUpdateCheckFailed] = useState(false);
  const displayedUpdate = update ?? localUpdate;
  const checkingUpdates = onCheckNow ? updateChecking : localChecking;
  const ompUpdate = useOmpUpdateStatus();
  const [ompUpdating, setOmpUpdating] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  // Keyed by the choice row that opened it, so one hosted dialog serves every default-model field.
  const [pickModelFor, setPickModelFor] = useState<string | null>(null);
  const [ompError, setOmpError] = useState("");

  const repoOptions = useMemo(() => {
    const seen = new Set<string>();
    return [activeRepo, ...knownRepos].filter((repo) => {
      const key = repo.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeRepo, knownRepos]);

  const selectedRepo = scope.kind === "repo" ? scope.repoPath : activeRepo;
  const effective = cfg;

  // Chat → Harness subsection acts on the SETTINGS scope — the repo picked in the scope bar,
  // or every open repository under "All repositories". The footer's daemon poll only knows
  // the ACTIVE repo, so the loss-of-work numbers come from a per-repo probe instead.
  const sessionTargets = useMemo(() => (scope.kind === "repo" ? (scope.repoPath ? [scope.repoPath] : []) : repoOptions), [scope, repoOptions]);
  const [liveByRepo, setLiveByRepo] = useState<Record<string, number>>({});
  const [sessionsBusy, setSessionsBusy] = useState(false);

  // Unreachable daemon ⇒ 0 (the command swallows that), so a repo never disappears from the list.
  const probeLiveSessions = (targets: string[]) =>
    Promise.all(targets.map((repo) => ipc.repoLiveSessions(repo).then((live) => [repo, live] as const))).then((pairs) => Object.fromEntries(pairs));

  useEffect(() => {
    if (activeSection !== "chat") return;
    let alive = true;
    const tick = () =>
      probeLiveSessions(sessionTargets)
        .then((next) => alive && setLiveByRepo(next))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, sessionTargets]);

  useEffect(() => {
    ipc
      .getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const checkForUpdatesNow = () => {
    setUpdateCheckFailed(false);
    if (onCheckNow) {
      onCheckNow().catch(() => setUpdateCheckFailed(true));
      return;
    }
    setLocalChecking(true);
    ipc
      .checkUpdate()
      .then(setLocalUpdate)
      .catch(() => setUpdateCheckFailed(true))
      .finally(() => setLocalChecking(false));
  };

  // Entering the section refreshes the shared hook so a hit also reveals the TopBar
  // button. Tests that do not pass onCheckNow keep the local ipc path.
  useEffect(() => {
    if (activeSection !== "updates") return;
    if (onCheckNow) {
      onCheckNow().catch(() => {});
      return;
    }
    ipc
      .checkUpdate()
      .then(setLocalUpdate)
      .catch(() => {});
  }, [activeSection, onCheckNow]);

  useEffect(() => {
    if (activeSection !== "chat") return;
    void ompUpdate.checkNow();
  }, [activeSection, ompUpdate.checkNow]);

  const loadScope = (nextScope: SettingsScope) => {
    if (nextScope.kind === "global") {
      ipc
        .readGlobalSettings()
        .then((loaded) => {
          setGlobal(loaded);
          setCfg(globalAsConfig(loaded));
          setOverrides(EMPTY_OVERRIDES);
        })
        .catch((e) => reportError(e, "Couldn't load settings"));
      return;
    }

    ipc
      .readScopedSettingsForRepo(nextScope.repoPath)
      .then((payload) => {
        setGlobal(payload.global);
        setCfg(payload.effective);
        setOverrides(payload.overrides);
      })
      .catch((e) => reportError(e, "Couldn't load settings"));
  };

  const loadStorage = (repoPath: string) =>
    ipc
      .storageInfo(repoPath)
      .then((info) => {
        setStorage(info);
        setStorageErr("");
      })
      .catch((e) => setStorageErr(String(e)));

  useEffect(() => {
    loadScope(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind, scope.kind === "repo" ? scope.repoPath : "global"]);

  // storageInfo walks disk — load it lazily when Storage is opened on a repository
  // chip. All repositories skips the walk; the panel shows the shared empty placeholder.
  useEffect(() => {
    if (activeSection !== "storage") return;
    if (scope.kind !== "repo") {
      setStorage(null);
      setStorageErr("");
      return;
    }
    const repoPath = scope.repoPath;
    let alive = true;
    setStorage(null);
    setStorageErr("");
    ipc
      .storageInfo(repoPath)
      .then((info) => {
        if (alive) {
          setStorage(info);
          setStorageErr("");
        }
      })
      .catch((e) => {
        if (alive) setStorageErr(String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, scope.kind, scope.kind === "repo" ? scope.repoPath : "global"]);
  useEffect(() => {
    if (activeSection !== "connections") return;
    let alive = true;
    setConnections(null);
    setXaiKey(null);
    ipc
      .connectionStatuses()
      .then((loaded) => {
        if (alive) setConnections(loaded);
      })
      .catch((e) => {
        if (alive) reportError(e, "Couldn't load connections");
      });
    ipc
      .orbitronXaiKeyStatus()
      .then((loaded) => {
        if (alive) setXaiKey(loaded);
      })
      .catch((e) => {
        if (alive) reportError(e, "Couldn't load the xAI key status");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  // The list needs a valid destination, so load it lazily when the section is opened
  // rather than on every settings mount.
  useEffect(() => {
    if (activeSection !== "backup" || scope.kind !== "repo") return;
    refreshBackups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, scope.kind, scope.kind === "repo" ? scope.repoPath : "global", cfg?.backup.destination]);

  // A backup outlives this view: the zip runs in the backend, so `backupBusy` alone would forget
  // an in-flight run the moment you navigate away. Poll the queue instead — it is the one place
  // that knows about a manual BACKUP NOW, a restore, and a trigger-driven run alike.
  useEffect(() => {
    if (activeSection !== "backup" || scope.kind !== "repo") return;
    const repoPath = scope.repoPath;
    let alive = true;
    // Only a run we actually observed may be declared finished: the poll can otherwise land in
    // the gap between clicking BACKUP NOW and the backend claiming the slot, and re-enable the
    // button mid-zip.
    let observed = false;
    const poll = () => {
      ipc
        .backupBusy(repoPath)
        .then((busy) => {
          if (!alive) return;
          if (busy) {
            observed = true;
            setBackupBusy(true);
          } else if (observed) {
            observed = false;
            setBackupBusy(false);
            refreshBackups();
          }
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, scope.kind, scope.kind === "repo" ? scope.repoPath : "global"]);

  const saveGlobal = (next: GlobalSettings, message = "Saved") => {
    const notificationsChanged = next.notifications !== global?.notifications;
    setGlobal(next);
    setCfg(globalAsConfig(next));
    globalSaveQueue.current = globalSaveQueue.current
      .catch(() => {})
      .then(() => ipc.writeGlobalSettings(next))
      .then((saved) => {
        setGlobal(saved);
        setCfg(globalAsConfig(saved));
        onGlobalSettingsChange?.(saved);
        report(message);
        if (notificationsChanged) onNotificationsChange(saved.notifications);
      })
      .catch((e) => reportError(e, "Couldn't save settings"));
  };

  const saveRepoOverrides = (next: RepoOverrides, message = "Saved") => {
    if (scope.kind !== "repo") return;
    setOverrides(next);
    ipc
      .writeRepoOverridesForRepo(scope.repoPath, next)
      .then((payload) => {
        setGlobal(payload.global);
        setOverrides(payload.overrides);
        setCfg(payload.effective);
        report(message);
      })
      .catch((e) => reportError(e, "Couldn't save repository overrides"));
  };

  const clearRepoField = (field: string) => {
    if (scope.kind !== "repo") return;
    ipc
      .clearRepoOverrideForRepo(scope.repoPath, field)
      .then((payload) => {
        setGlobal(payload.global);
        setOverrides(payload.overrides);
        setCfg(payload.effective);
        report("Using the global value");
      })
      .catch((e) => reportError(e, "Couldn't clear the override"));
  };

  // ---- Backup (issue #79) ----
  // Per-repository. All repositories shows the same empty placeholder as Storage;
  // controls write through saveRepoOverrides immediately.

  const refreshBackups = () => {
    if (scope.kind !== "repo") return;
    ipc
      .listBackups(scope.repoPath)
      .then((items) => {
        setBackups(items);
        setBackupsErr("");
      })
      .catch((e) => {
        setBackups([]);
        setBackupsErr(String(e));
      });
  };

  const setBackupOverride = (patch: RepoBackupOverrides, message = "saved") => {
    saveRepoOverrides({ ...overrides, backup: { ...overrides.backup, ...patch } }, message);
  };

  const chooseBackupFolder = () => {
    if (scope.kind !== "repo") return;
    ipc
      .pickBackupDestinationDialog(scope.repoPath)
      .then((picked) => {
        if (!picked) return;
        setBackupOverride({ destination: picked }, "Backup destination set");
      })
      .catch((e) => reportError(e));
  };

  const clearBackupFolder = () => {
    // No destination means no feature: turn it off rather than leaving a dead toggle on.
    setBackupOverride({ destination: "", enabled: false }, "Backup destination cleared");
    setBackups([]);
    setBackupsErr("");
  };

  const runBackupNow = () => {
    if (scope.kind !== "repo" || backupBusy) return;
    setBackupBusy(true);
    ipc
      .backupNow(scope.repoPath)
      .then((meta) => {
        report(`Backup created — ${meta.repo_name} @ ${new Date(meta.created_at * 1000).toLocaleString()}`);
        refreshBackups();
      })
      .catch((e) => reportError(e, "Backup failed"))
      .finally(() => setBackupBusy(false));
  };

  const restoreBackup = async (item: BackupListItem) => {
    if (scope.kind !== "repo" || backupBusy) return;
    const ok = await confirmDanger(
      "Restore this backup?",
      <ul className="confirm-list">
        <li>Background processes for this repo will be stopped (daemon shut down).</li>
        <li className="confirm-loss">Current Alinery data (tasks, settings, artifacts, sessions) will be CLEARED and replaced.</li>
        <li>This does not merge. Worktrees, locks, and sockets are left alone.</li>
        <li>Make a backup of the current state first if you want to keep it.</li>
      </ul>,
      "Restore",
    );
    if (!ok) return;
    setBackupBusy(true);
    ipc
      .restoreBackup(scope.repoPath, item.path)
      .then(() => {
        report(`Restored ${item.id}`);
        loadScope(scope);
        refreshBackups();
      })
      .catch((e) => reportError(e, "Restore failed"))
      .finally(() => setBackupBusy(false));
  };

  const setGlobalNotif = (key: keyof GlobalSettings["notifications"], value: boolean) => {
    if (!global) return;
    saveGlobal({ ...global, notifications: { ...global.notifications, [key]: value } });
  };

  const setGlobalTelemetryEnabled = (value: boolean) => {
    if (!global) return;
    saveGlobal({ ...global, telemetry: { ...global.telemetry, enabled: value, prompted: true } });
  };

  const setGlobalUpdatesEnabled = (value: boolean) => {
    if (!global) return;
    if (!value) onClearUpdateOffer?.();
    saveGlobal({ ...global, updates: { ...global.updates, check_enabled: value } });
  };

  const setShowOriginalKanban = (value: boolean) => {
    if (!global) return;
    saveGlobal({ ...global, experiments: { ...global.experiments, show_original_kanban: value } }, value ? "Original Kanban tab shown" : "Original Kanban tab hidden");
  };

  const updateGlobalChoice = (key: ChoiceKey, patch: Partial<GlobalSettings[ChoiceKey]>) => {
    if (!global) return;
    saveGlobal({ ...global, [key]: { ...global[key], ...patch } });
  };

  const setRepoChoice = (key: ChoiceKey, patch: Partial<HarnessChoice>) => {
    if (!effective) return;
    const nextOverrides: RepoOverrides = { ...overrides, [key]: { ...overrides[key], ...patch } };
    setOverrides(nextOverrides);
    const nextProvenance = { ...effective.provenance[key] };
    for (const field of Object.keys(patch) as (keyof HarnessChoice)[]) {
      nextProvenance[field] = REPO_SOURCE;
    }
    setCfg({
      ...effective,
      [key]: { ...effective[key], ...patch },
      provenance: { ...effective.provenance, [key]: nextProvenance },
    });
  };

  const setRepoChoiceBool = (key: ChoiceKey, field: ChoiceBoolField, value: boolean) => {
    if (!effective) return;
    const nextOverrides: RepoOverrides = { ...overrides, [key]: { ...overrides[key], [field]: value } };
    setOverrides(nextOverrides);
    setCfg({
      ...effective,
      [key]: { ...effective[key], [field]: value },
      provenance: {
        ...effective.provenance,
        [key]: { ...effective.provenance[key], [field]: REPO_SOURCE },
      },
    });
    saveRepoOverrides(nextOverrides);
  };

  const saveAppearance = (next: AppearancePrefs) => {
    const normalized = applyAppearance(next);
    onAppearanceChange(normalized);
    ipc
      .writeAppearance(normalized)
      .then((appCfg) => {
        const applied = applyAppearance(appCfg.appearance);
        onAppearanceChange(applied);
        // No toast: theme, accent, scale, and text size all apply live, so the change
        // is its own confirmation. Only a failed write is worth interrupting for.
      })
      .catch((e) => reportError(e, "Couldn't save appearance"));
  };

  // Scale previews on every drag step but persists once, on release. Writing per step
  // also raced: six in-flight writes can resolve out of order and snap the slider back.
  const uiScale = scaleDraft ?? appearance.ui_scale;
  const previewScale = (next: number) => {
    setScaleDraft(next);
    onAppearanceChange(applyAppearance({ ...appearance, ui_scale: next }));
  };
  const commitScale = () => {
    if (scaleDraft === null) return;
    setScaleDraft(null);
    saveAppearance({ ...appearance, ui_scale: scaleDraft });
  };

  const copyStoragePath = (value: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => report("Path copied", "short"))
      .catch((e) => reportError(e, "Couldn't copy the path"));
  const revealStoragePath = (value: string) =>
    ipc
      .revealItemInDir(value)
      .then(() => report("Opened in Finder"))
      .catch((e) => reportError(e, "Couldn't open Finder"));

  // Irreversible: archived tasks, archived sessions and the worktrees of archived tasks.
  // Reload the numbers even on failure — a partial purge already changed the disk.
  const purgeArchived = async () => {
    if (scope.kind !== "repo" || !storage) return;
    const n = storage.archived_task_count;
    const m = storage.archived_session_count;
    const ok = await confirmDanger(
      "Delete archived storage?",
      <>
        <p>
          Permanently delete {n} archived task{n === 1 ? "" : "s"} and {m} archived session
          {m === 1 ? "" : "s"} — {formatMb(storage.archived_bytes)}. Worktrees for those tasks are removed too.
        </p>
        <p className="confirm-loss">This cannot be undone.</p>
      </>,
      "Delete",
    );
    if (!ok) return;
    setPurgeBusy(true);
    setPurgeErrors([]);
    try {
      const res = await ipc.deleteAllArchivedStorage(scope.repoPath);
      setPurgeErrors(res.errors);
      if (res.errors.length) {
        toast.error(`Deleted ${res.deleted_tasks} task(s), ${res.deleted_sessions} session(s) — ${res.errors.length} failed (listed below)`);
      } else {
        report(`Deleted ${res.deleted_tasks} task(s), ${res.deleted_sessions} session(s), ${res.deleted_worktrees} worktree(s)`);
      }
    } catch (e) {
      reportError(e, "Delete failed");
    } finally {
      await loadStorage(scope.repoPath);
      setPurgeBusy(false);
    }
  };

  // DELIBERATE TEARDOWN ORIGIN (B1), one `stop_daemon` per repo in scope — the backend
  // restarts each daemon it stops. A repo whose daemon is unreachable or conflicted is
  // reported, never silently counted as stopped.
  const stopScopedSessions = async (repos: string[], label: string) => {
    setSessionsBusy(true);
    const problems: string[] = [];
    for (const repo of repos) {
      try {
        await ipc.stopDaemon(repo);
      } catch (e) {
        problems.push(`${repoName(repo)}: ${String(e)}`);
      }
    }
    setSessionsBusy(false);
    probeLiveSessions(repos)
      .then(setLiveByRepo)
      .catch(() => {});
    const stopped = repos.length - problems.length;
    if (problems.length === 0) {
      report(`Sessions stopped for ${label}; daemon${repos.length === 1 ? "" : "s"} restarted`);
    } else {
      toast.error(`${stopped === 0 ? "No sessions were stopped" : `Stopped ${stopped} of ${repos.length} repositories`}: ${problems.join("; ")}`);
    }
  };

  if (!global || !effective) return <LoadingState label="Loading settings…" state={ORB_STATE} />;

  const isGlobal = scope.kind === "global";
  const selectedScopeLabel = isGlobal ? "All repositories" : repoName(selectedRepo || "Repository");
  const selectedScopeDetail = isGlobal ? "Default settings used by every repository unless that repository overrides them." : selectedRepo;
  const gridViews = normalizeGridViews(global.grid_views);
  const visibleSections = SECTIONS;
  const visibleActiveSection = activeSection;

  const saveGridViews = (next: GridViewDefinition[], message: string) => {
    setGridViewDrafts({});
    setGridViewErrors({});
    saveGlobal({ ...global, grid_views: withGridViewSlots(next) }, message);
  };

  const gridViewNameError = (id: string, value: string) => {
    const name = value.trim();
    if (name.length === 0) return "Enter a name.";
    const duplicate = gridViews.some((view) => view.id !== id && (gridViewDrafts[view.id] ?? view.name).trim().toLowerCase() === name.toLowerCase());
    return duplicate ? "Names must be unique." : "";
  };

  const commitGridViewName = (view: GridViewDefinition) => {
    const value = gridViewDrafts[view.id] ?? view.name;
    const error = gridViewNameError(view.id, value);
    setGridViewErrors((current) => ({ ...current, [view.id]: error }));
    if (error) return;
    const name = value.trim();
    setGridViewDrafts((current) => {
      const next = { ...current };
      delete next[view.id];
      return next;
    });
    if (name === view.name) return;
    saveGridViews(
      gridViews.map((candidate) => (candidate.id === view.id ? { ...candidate, name } : candidate)),
      `Renamed Grid view to ${name}`,
    );
  };

  const gridViewsIncludingDrafts = (): GridViewDefinition[] | null => {
    const errors: Record<string, string> = {};
    const prepared = gridViews.map((view) => {
      const value = gridViewDrafts[view.id] ?? view.name;
      const error = gridViewNameError(view.id, value);
      if (error) errors[view.id] = error;
      return { ...view, name: error ? view.name : value.trim() };
    });
    if (Object.keys(errors).length > 0) {
      setGridViewErrors(errors);
      return null;
    }
    return prepared;
  };

  const addGridView = () => {
    const prepared = gridViewsIncludingDrafts();
    if (prepared === null || prepared.length >= MAX_GRID_VIEWS) return;
    const id = createGridViewId();
    const name = nextGridViewName(prepared);
    setFocusGridViewId(id);
    saveGridViews([...prepared, { id, name, slot: prepared.length + 1 }], `${name} added`);
  };

  const moveGridView = (index: number, direction: -1 | 1) => {
    const prepared = gridViewsIncludingDrafts();
    if (prepared === null) return;
    const target = index + direction;
    if (target < 0 || target >= prepared.length) return;
    const next = [...prepared];
    [next[index], next[target]] = [next[target], next[index]];
    saveGridViews(next, `${next[target].name} moved to shortcut ${gridViewShortcut(target)}`);
  };

  const deleteGridView = async (view: GridViewDefinition) => {
    const prepared = gridViewsIncludingDrafts();
    if (prepared === null || prepared.length <= 1) return;
    const preparedView = prepared.find((candidate) => candidate.id === view.id) ?? view;
    const confirmed = await confirmDanger(
      `Delete ${preparedView.name}?`,
      <p>This removes the view from navigation. Its Grid presentation and ordering settings will no longer be used.</p>,
      "Delete view",
    );
    if (confirmed === false) return;
    saveGridViews(
      prepared.filter((candidate) => candidate.id !== view.id),
      `${preparedView.name} deleted`,
    );
  };

  const sourceBadge = (source: SettingSource, field?: string) => (
    <span className="pill" style={{ marginLeft: 8 }}>
      {source === "repository" ? "Repository override" : "Global"}
      {scope.kind === "repo" && source === "repository" && field && (
        <button className="btn ghost small" type="button" style={{ marginLeft: 8 }} onClick={() => clearRepoField(field)}>
          Use global value
        </button>
      )}
    </span>
  );

  const globalOnly = (label: string) => (
    <div className="dim" style={{ marginBottom: 12 }}>
      {label} are global-only. Switch to{" "}
      <button type="button" className="btn ghost small" onClick={() => setScope({ kind: "global" })}>
        Global
      </button>{" "}
      to edit them.
    </div>
  );

  const check = (key: keyof GlobalSettings["notifications"], label: string, hint: string) => (
    <Checkbox
      checked={global.notifications[key]}
      disabled={!isGlobal}
      onChange={(v) => setGlobalNotif(key, v)}
      label={
        <>
          {label} <span className="dsc">— {hint}</span>
        </>
      }
    />
  );

  const telemetryCheck = (label: string, hint: string) => (
    <Checkbox
      checked={global.telemetry.enabled}
      disabled={!isGlobal}
      onChange={(v) => setGlobalTelemetryEnabled(v)}
      label={
        <>
          {label} <span className="dsc">— {hint}</span>
        </>
      }
    />
  );

  const updatesCheck = (label: string) => <Checkbox checked={global.updates.check_enabled} disabled={!isGlobal} onChange={(v) => setGlobalUpdatesEnabled(v)} label={label} />;

  const storageRow = (label: string, value: string) => (
    <div key={label} className="storage-path-row">
      <div className="storage-path-head">
        <h4>{label}</h4>
        <div className="storage-actions">
          <button
            className="btn ghost small icon"
            type="button"
            title={`Reveal ${label} in Finder`}
            aria-label={`Reveal ${label} in Finder`}
            onClick={() => revealStoragePath(value)}
          >
            <ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button className="btn ghost small icon" type="button" title={`Copy ${label} path`} aria-label={`Copy ${label} path`} onClick={() => copyStoragePath(value)}>
            <Copy size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </div>
      <pre>{value}</pre>
    </div>
  );

  const connect = (provider: ConnectionStatus["provider"]) => {
    setConnecting(provider);
    const request = provider === "github" ? ipc.connectGithub() : ipc.connectLinear();
    request
      .then((updated) => {
        setConnections((current) => current?.map((item) => (item.provider === provider ? updated : item)) ?? [updated]);
        report(`${updated.name} connected`);
      })
      .catch((e) => reportError(e, `Couldn't connect ${provider === "github" ? "GitHub" : "Linear"}`))
      .finally(() => setConnecting(""));
  };

  const disconnect = async (connection: ConnectionStatus) => {
    const ok = await confirmDanger(
      `Remove ${connection.name} connection?`,
      // Every Alinery build shares one Keychain item, so this reaches the other ones too. Said here
      // because the row cannot show it: status is per-build, the credential is not.
      "Alinery deletes its Linear tokens from the macOS Keychain. This affects every Alinery build on this Mac, and browser imports stop working until you connect again.",
      "Remove",
    );
    if (!ok) return;
    setConnecting(connection.provider);
    ipc
      .disconnectLinear()
      .then((updated) => {
        setConnections((current) => current?.map((item) => (item.provider === connection.provider ? updated : item)) ?? [updated]);
        report(`${updated.name} connection removed`);
      })
      .catch((e) => reportError(e, `Couldn't remove the ${connection.name} connection`))
      .finally(() => setConnecting(""));
  };

  const connectionsSection = () => (
    <section className="connections" aria-label="Provider connections">
      <div className="connections-head" aria-hidden="true">
        <span>Connector</span>
        <span>Type</span>
        <span>Status</span>
      </div>
      {connections === null ? (
        <LoadingState label="Loading connections…" state="connecting" />
      ) : (
        <ul className="connections-list">
          {connections.map((connection) => (
            <li className="connection-row" key={connection.provider}>
              <div className="connection-name">
                <span className={`connection-icon ${connection.provider}`} aria-hidden="true">
                  <span className="connection-logo" />
                </span>
                <span>
                  <strong>{connection.name}</strong>
                  {connection.account && <small>{connection.account}</small>}
                </span>
              </div>
              <span className="connection-kind">{connection.kind}</span>
              <div className="connection-status">
                {connection.connected ? (
                  <>
                    <span className="connection-ok" title={connection.detail}>
                      <Check size={16} strokeWidth={2} aria-hidden="true" /> <span>Connected</span>
                    </span>
                    {/* Every connected row carries the same two actions. Reconnect is no longer gated on
                        the backend flagging trouble: a credential can be unusable while the status path
                        still reads Connected, and that row needs a way out too. */}
                    <ConnectionMenu
                      label={connection.name}
                      busy={!!connecting}
                      onReconnect={() => connect(connection.provider)}
                      onRemove={connection.removable ? () => disconnect(connection) : undefined}
                    />
                  </>
                ) : !connection.available ? (
                  <span className="connection-unavailable" title={connection.detail}>
                    <AlertCircle size={16} strokeWidth={2} aria-hidden="true" /> <span>{connection.detail}</span>
                  </span>
                ) : (
                  <button
                    className="btn small"
                    type="button"
                    disabled={!!connecting}
                    title={connection.detail}
                    aria-label={`${connection.reconnect ? "Reconnect" : "Connect"} ${connection.name}`}
                    onClick={() => connect(connection.provider)}
                  >
                    {connecting === connection.provider ? "Connecting…" : connection.reconnect ? "Reconnect" : "Connect"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="connections-xai">
        <h3>xAI (Orbitron agent)</h3>
        <p className="dim">{xaiKey === null ? "…" : xaiKey.present ? "Saved" : "Not set"}</p>
        <div className="connection-status">
          {xaiKey?.present ? (
            <>
              <button type="button" className="btn small" onClick={() => setXaiDialog(true)}>
                Replace
              </button>
              <button
                type="button"
                className="btn ghost small"
                onClick={async () => {
                  const ok = await confirmDanger("Clear xAI key", "The Orbitron agent will not start until a key is saved again.", "Clear");
                  if (!ok) return;
                  ipc
                    .clearOrbitronXaiKey()
                    .then((status) => setXaiKey(status))
                    .catch((e) => reportError(e, "Couldn't save the xAI key."));
                }}
              >
                Clear
              </button>
            </>
          ) : (
            <button type="button" className="btn small" disabled={xaiKey === null} onClick={() => setXaiDialog(true)}>
              Set
            </button>
          )}
        </div>
      </div>
      <p className="dim connections-note">
        Connections are shared across all repositories. GitHub uses the <span className="mono">gh</span> CLI store; only Linear OAuth tokens go in the macOS Keychain.
      </p>
      {xaiDialog && (
        <XaiKeyDialog
          onClose={() => setXaiDialog(false)}
          onSaved={() => {
            setXaiDialog(false);
            ipc
              .orbitronXaiKeyStatus()
              .then(setXaiKey)
              .catch((e) => reportError(e, "Couldn't load the xAI key status"));
          }}
        />
      )}
    </section>
  );

  const choiceSection = (key: ChoiceKey, title: string) => {
    const value = isGlobal ? global[key] : effective[key];
    const provenance = effective.provenance[key];
    const repoPath = scope.kind === "repo" ? scope.repoPath : selectedRepo;
    return (
      <>
        <div className="field">
          <label>
            {title} model · optional override
            {!isGlobal && sourceBadge(provenance.model, `${key}.model`)}
          </label>
          <ModelInput
            harness="omp"
            repoPath={repoPath || undefined}
            value={ompDefaultModel(value)}
            onChange={(v) => {
              if (isGlobal) setGlobal({ ...global, [key]: { ...global[key], harness: "omp", model: v } });
              else setRepoChoice(key, { harness: "omp", model: v });
            }}
            onCommit={(v) => {
              if (isGlobal) updateGlobalChoice(key, { harness: "omp", model: v });
              else saveRepoOverrides({ ...overrides, [key]: { ...overrides[key], harness: "omp", model: v } });
            }}
            onOpenPicker={() => setPickModelFor(key)}
          />
          {pickModelFor === key && (
            <ProviderSetupDialog
              mode="manual"
              initialTab="models"
              onPick={(v) => {
                if (isGlobal) {
                  setGlobal({ ...global, [key]: { ...global[key], harness: "omp", model: v } });
                  updateGlobalChoice(key, { harness: "omp", model: v });
                } else {
                  setRepoChoice(key, { harness: "omp", model: v });
                  saveRepoOverrides({ ...overrides, [key]: { ...overrides[key], harness: "omp", model: v } });
                }
              }}
              onClose={() => setPickModelFor(null)}
            />
          )}
          {!isGlobal && <div className="hint">Blank can be a repository override; use the button above to inherit.</div>}
        </div>
        <Checkbox
          checked={value.draft_autosave}
          onChange={(v) => {
            if (isGlobal) updateGlobalChoice(key, { draft_autosave: v });
            else setRepoChoiceBool(key, "draft_autosave", v);
          }}
          label={
            <div>
              <div>
                Autosave drafts
                {!isGlobal && sourceBadge(provenance.draft_autosave, `${key}.draft_autosave`)}
              </div>
              <div className="hint">Save Create Task fields as draft tasks while typing (default on)</div>
            </div>
          }
        />
      </>
    );
  };

  /* One size row: name, a sample rendered at the size being set, and a ± stepper. */
  const sizeRow = (row: {
    id: string;
    name: string;
    noun: string;
    sample: ReactNode;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (next: number) => void;
  }) => (
    <div className="sizing-row">
      <div className="sizing-copy">
        <span className="sizing-name" id={`${row.id}-label`}>
          {row.name}
        </span>
        <span className="sizing-sample" aria-hidden="true">
          {row.sample}
        </span>
      </div>
      <div className="stepper" role="group" aria-labelledby={`${row.id}-label`}>
        <button
          className="stepper-btn"
          type="button"
          title={`Decrease ${row.noun}`}
          aria-label={`Decrease ${row.noun}`}
          disabled={!isGlobal || row.value <= row.min}
          onClick={() => row.onChange(Math.max(row.min, row.value - (row.step ?? 1)))}
        >
          <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <span className="stepper-value" aria-live="polite">
          {row.value}px
        </span>
        <button
          className="stepper-btn"
          type="button"
          title={`Increase ${row.noun}`}
          aria-label={`Increase ${row.noun}`}
          disabled={!isGlobal || row.value >= row.max}
          onClick={() => row.onChange(Math.min(row.max, row.value + (row.step ?? 1)))}
        >
          <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  );

  const renderHarness = () => {
    // Acts on the SETTINGS scope — the repo picked in the scope bar, or every open
    // repository under "All repositories". Live counts come from a per-repo probe.
    const targets = sessionTargets.map((repo) => ({ repo, live: liveByRepo[repo] ?? 0 }));
    const live = targets.reduce((sum, target) => sum + target.live, 0);
    const plural = (n: number) => (n === 1 ? "" : "s");
    const scopeName = isGlobal ? (targets.length ? `all ${targets.length} open repositor${targets.length === 1 ? "y" : "ies"}` : "") : repoName(selectedRepo);
    const hitsActiveRepo = targets.some((target) => target.repo === activeRepo);
    return (
      <>
        <div className="field" style={{ marginBottom: 16 }}>
          {/* A version alone cannot answer "which install is this", which is the question anyone
              reading this panel is actually asking. Paths wrap rather than truncate: one you
              cannot read in full is one you retype wrong. */}
          <div className="dim" style={{ fontSize: "calc(12px * var(--ui-scale))", marginBottom: 6, display: "grid", gap: 2, overflowWrap: "anywhere" }}>
            <div>Installed: {ompUpdate.status.installed || "not found"}</div>
            {ompUpdate.status.binary_path && <div>Binary: {ompUpdate.status.binary_path}</div>}
            {ompUpdate.status.config_dir && <div>Config: {ompUpdate.status.config_dir}</div>}
          </div>
          {/* Until now the accounts dialog was only reachable by being broken -- it opened when
              setup was missing, or from a slash command inside a live chat. This is the way in
              that is not an error state. */}
          <button type="button" className="btn small" style={{ marginBottom: 12 }} onClick={() => setProvidersOpen(true)}>
            Providers &amp; accounts
          </button>
          {providersOpen && <ProviderSetupDialog mode="manual" onClose={() => setProvidersOpen(false)} />}
          {ompUpdate.status.available && (
            <div className="field">
              <div style={{ marginBottom: 8 }}>Update available: {ompUpdate.status.available.version}</div>
              <button
                type="button"
                className="btn small"
                disabled={ompUpdating}
                onClick={() => {
                  void (async () => {
                    const ok = await confirmDanger(
                      `Update OMP to ${ompUpdate.status.available?.version}?`,
                      <p>Live sessions keep running on the current binary. New sessions use the updated one.</p>,
                      "Update OMP",
                    );
                    if (!ok) return;
                    setOmpUpdating(true);
                    setOmpError("");
                    try {
                      await ipc.updateOmp();
                      ompUpdate.clearOffer();
                      await ompUpdate.checkNow();
                    } catch (e) {
                      setOmpError(String(e));
                    } finally {
                      setOmpUpdating(false);
                    }
                  })();
                }}
              >
                {ompUpdating ? "Updating…" : "Update OMP"}
              </button>
              {ompError ? (
                <div className="dim" style={{ color: "var(--danger)", marginTop: 6 }}>
                  {ompError}
                </div>
              ) : null}
            </div>
          )}
        </div>
        {choiceSection("defaults", "Default")}
        <div className="dim" style={{ fontSize: "calc(12px * var(--ui-scale))", marginBottom: 10 }}>
          Sessions run in a background daemon that survives app quit. Stopping them affects <strong>{scopeName || "the selected repository"}</strong>
          {isGlobal ? "" : " only"}
          {hitsActiveRepo ? ", and also restarts the MCP server" : ""}. A fresh daemon is started immediately afterwards.
        </div>
        <div className="dim" style={{ fontSize: "calc(12px * var(--ui-scale))", marginBottom: 10, color: live > 0 ? "var(--danger)" : undefined }}>
          {live > 0 ? `${live} live session${plural(live)} will be killed. Any unsaved, in-flight harness work is lost.` : "No live sessions."}
        </div>
        {isGlobal && targets.length > 1 && (
          <div className="dim" style={{ fontSize: "calc(12px * var(--ui-scale))", marginBottom: 10 }}>
            {targets.map((target) => (
              <div key={target.repo} title={target.repo} style={{ color: target.live > 0 ? "var(--danger)" : undefined }}>
                {repoName(target.repo)} — {target.live} live session{plural(target.live)}
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn danger"
          disabled={!targets.length || sessionsBusy}
          onClick={() => {
            void (async () => {
              const breakdown = isGlobal && targets.length > 1 && (
                <ul className="confirm-list">
                  {targets.map((t) => (
                    <li key={t.repo}>
                      <span className="confirm-repo">{repoName(t.repo)}</span>
                      <span className="dim">
                        {t.live} live session{plural(t.live)}
                      </span>
                    </li>
                  ))}
                </ul>
              );
              const ok = await confirmDanger(
                live > 0 ? `Stop ${live} live session${plural(live)} in ${scopeName}?` : `Restart the session daemon${plural(targets.length)} for ${scopeName}?`,
                <>
                  {breakdown}
                  {live > 0 ? (
                    <p className="confirm-loss">In-flight harness work is lost. This cannot be undone.</p>
                  ) : (
                    <p>No live sessions — the daemon is replaced with a fresh one.</p>
                  )}
                </>,
                live > 0 ? "Stop sessions" : "Restart daemon",
              );
              if (!ok) return;
              await stopScopedSessions(
                targets.map((target) => target.repo),
                scopeName,
              );
            })();
          }}
        >
          Stop all sessions in {scopeName || "this repo"}
        </button>
      </>
    );
  };

  const renderAppearance = () => (
    <>
      {!isGlobal && globalOnly("Appearance settings")}
      <div className="field">
        <label id="appearance-theme-label">Theme</label>
        <div className="theme-cards" role="group" aria-labelledby="appearance-theme-label" aria-describedby="appearance-theme-hint">
          <button
            type="button"
            className={`theme-card ${appearance.mode === "system" ? "active" : ""}`}
            disabled={!isGlobal}
            aria-pressed={appearance.mode === "system"}
            onClick={() => saveAppearance({ ...appearance, mode: "system" })}
          >
            <Monitor size={24} strokeWidth={1.5} />
            <span>System</span>
          </button>
          <button
            type="button"
            className={`theme-card ${appearance.mode === "light" ? "active" : ""}`}
            disabled={!isGlobal}
            aria-pressed={appearance.mode === "light"}
            onClick={() => saveAppearance({ ...appearance, mode: "light" })}
          >
            <Sun size={24} strokeWidth={1.5} />
            <span>Light</span>
          </button>
          <button
            type="button"
            className={`theme-card ${appearance.mode === "dark" ? "active" : ""}`}
            disabled={!isGlobal}
            aria-pressed={appearance.mode === "dark"}
            onClick={() => saveAppearance({ ...appearance, mode: "dark" })}
          >
            <Moon size={24} strokeWidth={1.5} />
            <span>Dark</span>
          </button>
        </div>
        <span id="appearance-theme-hint" className="dsc">
          System follows macOS. ⌘G cycles System, Light, and Dark anywhere.
        </span>
      </div>
      <div className="field">
        <label id="appearance-accent-label">Accent color</label>
        <div className="accent-swatches" role="group" aria-labelledby="appearance-accent-label" aria-describedby="appearance-accent-hint">
          {["#38459D", "#10B981", "#3B82F6", "#8B5CF6", "#EC4899", "#F59E0B", "#E94242"].map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch ${appearance.accent_color.toUpperCase() === c.toUpperCase() ? "active" : ""}`}
              style={{ backgroundColor: c }}
              disabled={!isGlobal}
              aria-label={`Set accent color to ${c}`}
              onClick={() => saveAppearance({ ...appearance, accent_color: c })}
            />
          ))}
          <div className="swatch-custom" title="Custom color">
            <div className="swatch-custom-inner" style={{ backgroundColor: appearance.accent_color }}>
              <input
                id="appearance-accent"
                type="color"
                disabled={!isGlobal}
                aria-label="Custom accent color"
                value={appearance.accent_color}
                onChange={(e) => saveAppearance({ ...appearance, accent_color: e.target.value })}
              />
            </div>
          </div>
        </div>
        <span id="appearance-accent-hint" className="dsc">
          Used for active controls, selection, and focus. Contrast is adjusted automatically.
        </span>
      </div>
      <div className="field">
        <label id="appearance-sizing-label">Sizing</label>
        <div className="sizing" role="group" aria-labelledby="appearance-sizing-label">
          <div className="sizing-row">
            <div className="sizing-copy">
              <span className="sizing-name" id="appearance-scale-label">
                Interface scale
              </span>
              <span className="dsc" id="appearance-scale-hint">
                Sizes every label, control, and row in the app.
              </span>
            </div>
            <div className="scale-control">
              <div className="scale-track">
                <input
                  className="scale-slider"
                  type="range"
                  min={SCALE_MIN}
                  max={SCALE_MAX}
                  step="0.125"
                  value={uiScale}
                  disabled={!isGlobal}
                  aria-labelledby="appearance-scale-label"
                  aria-describedby="appearance-scale-hint"
                  aria-valuetext={`${uiScale}×`}
                  style={sliderPos(uiScale, SCALE_MIN, SCALE_MAX)}
                  onChange={(e) => previewScale(Number(e.target.value))}
                  onPointerUp={commitScale}
                  onPointerCancel={commitScale}
                  onKeyUp={commitScale}
                  // Commit fallback: an assistive-tech change can fire `change`
                  // without a pointer/key event ever starting, so the only
                  // guaranteed commit point left is losing focus.
                  onBlur={commitScale}
                />
                <div className="scale-ticks" aria-hidden="true">
                  {UI_SCALE_STEPS.map((step) => (
                    <span key={step} className={`scale-tick ${step === uiScale ? "on" : ""}`} />
                  ))}
                </div>
              </div>
              <span className="scale-readout" aria-hidden="true">
                {uiScale}×
              </span>
            </div>
          </div>
          {sizeRow({
            id: "terminal-font",
            name: "Terminal text",
            noun: "terminal font size",
            // Terminals take this size literally; interface scale never touches it.
            sample: <span style={{ fontFamily: "var(--font-mono)", fontSize: `${appearance.terminal_font_size}px` }}>$ omp</span>,
            value: appearance.terminal_font_size,
            min: TERMINAL_FONT_MIN,
            max: TERMINAL_FONT_MAX,
            onChange: (terminal_font_size) => saveAppearance({ ...appearance, terminal_font_size }),
          })}
          {sizeRow({
            id: "artifact-font",
            name: "Artifact text",
            noun: "artifact font size",
            // Mirrors the artifact reader, which multiplies this by the interface scale.
            sample: <span style={{ fontSize: `calc(${appearance.artifact_font_size}px * var(--ui-scale))` }}>Plans, diffs, and documents read at this size.</span>,
            value: appearance.artifact_font_size,
            min: ARTIFACT_FONT_MIN,
            max: ARTIFACT_FONT_MAX,
            onChange: (artifact_font_size) => saveAppearance({ ...appearance, artifact_font_size }),
          })}
          {sizeRow({
            id: "artifact-width",
            name: "Artifact viewer",
            noun: "artifact viewer width",
            sample: <span>Opens at this width, never more than 60% of the window.</span>,
            value: normalizeArtifactViewerWidth(appearance.artifact_viewer_width),
            min: ARTIFACT_VIEWER_WIDTH_MIN,
            max: ARTIFACT_VIEWER_WIDTH_MAX,
            step: 20,
            onChange: (artifact_viewer_width) => saveAppearance({ ...appearance, artifact_viewer_width }),
          })}
        </div>
      </div>
      <button type="button" className="btn ghost small" style={{ marginTop: 12 }} disabled={!isGlobal} onClick={() => saveAppearance(DEFAULT_APPEARANCE)}>
        Reset appearance
      </button>
    </>
  );

  const renderBackup = () => {
    if (scope.kind !== "repo") return <EmptyState title={SETTINGS_SCOPE_EMPTY_TITLE} />;
    const backup = effective.backup;
    const hasDest = backup.destination.trim() !== "";
    const retention = retentionDraft ?? backup.retention;
    const commitRetention = () => {
      if (retentionDraft === null || retentionDraft === backup.retention) {
        setRetentionDraft(null);
        return;
      }
      setBackupOverride({ retention: retentionDraft }, `Keeping the newest ${retentionDraft} backups`);
      setRetentionDraft(null);
    };
    const trigger = (key: "trigger_pre_archive" | "trigger_post_artifact_change" | "trigger_post_push_commit", label: string) => (
      <Checkbox checked={backup[key]} disabled={!hasDest} onChange={(v) => setBackupOverride({ [key]: v })} label={label} />
    );

    return (
      <>
        <div className="field">
          <label>Destination folder</label>
          <input className="field-input mono" type="text" value={backup.destination} placeholder="Choose a folder outside this repository" readOnly />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn ghost small" type="button" onClick={chooseBackupFolder}>
              Choose folder…
            </button>
            {hasDest && (
              <button className="btn ghost small" type="button" onClick={clearBackupFolder}>
                Clear
              </button>
            )}
          </div>
          <div className="dim" style={{ fontSize: "calc(12px * var(--ui-scale))", marginTop: 6 }}>
            Must be outside this repository's <span className="mono">.alinery/</span> folder. Backup stays off until a destination is set.
          </div>
        </div>

        <Checkbox
          checked={backup.enabled}
          disabled={!hasDest}
          onChange={(v) => setBackupOverride({ enabled: v })}
          label={
            <>
              Enabled <span className="dsc">— allow backups for this repository</span>
            </>
          }
        />

        <div className="field" style={{ marginTop: 16 }}>
          <label>
            Keep the newest {retention} backup{retention === 1 ? "" : "s"}
          </label>
          <input
            className="scale-slider"
            type="range"
            min={1}
            max={100}
            value={retention}
            disabled={!hasDest}
            style={sliderPos(retention, 1, 100)}
            onChange={(e) => setRetentionDraft(Number(e.target.value))}
            onPointerUp={commitRetention}
            onKeyUp={commitRetention}
          />
        </div>

        <div className="field" style={{ marginTop: 16 }}>
          <label>Automatic backups</label>
          {trigger("trigger_pre_archive", "When a task is archived (best-effort)")}
          {trigger("trigger_post_artifact_change", "On Alinery-managed artifact saves")}
          {trigger("trigger_post_push_commit", "After commit or push")}
        </div>

        <button className="btn" type="button" style={{ marginTop: 16 }} disabled={backupBusy || !hasDest || !backup.enabled} onClick={runBackupNow}>
          {backupBusy ? (
            <span className="ind-wrap" style={{ gap: 8 }}>
              <ThinkingOrb state="working" size={20} className="ind-orb" aria-hidden="true" />
              Backing up…
            </span>
          ) : (
            "Back up now"
          )}
        </button>

        <div className="field" style={{ marginTop: 20 }}>
          <label>Restore</label>
          {backupsErr ? (
            <InlineStatus tone="error" detail={backupsErr}>
              Couldn't list backups in the destination folder.
            </InlineStatus>
          ) : backups.length === 0 ? (
            <EmptyState title="No backups yet." hint="Backups appear here after the first run — use Back up now above, or enable an automatic trigger." />
          ) : (
            backups.map((item) => (
              <div key={item.id} className="storage-path-row">
                <div className="storage-path-head">
                  <h4>{new Date(item.created_at * 1000).toLocaleString()}</h4>
                  <div className="storage-actions">
                    <span className="pill">{item.trigger}</span>
                    <span className="pill">
                      {item.size_bytes >= 1024 * 1024 ? `${(item.size_bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(item.size_bytes / 1024))} KB`}
                    </span>
                    <button className="btn ghost small" type="button" disabled={backupBusy} onClick={() => restoreBackup(item)}>
                      Restore
                    </button>
                  </div>
                </div>
                <pre>{item.id}</pre>
              </div>
            ))
          )}
        </div>
      </>
    );
  };

  const renderSection = (key: string): ReactNode => {
    switch (key) {
      case "connections":
        return connectionsSection();
      case "notifications":
        return (
          <>
            {!isGlobal && globalOnly("Notifications")}
            {check("enabled", "Enabled", "master switch")}
            {check("banner", "Banner", "native notification")}
            {check("sound", "Sound", "notification sound")}
            {check("bounce", "Dock bounce", "off by default")}
            {check("dock_badge", "Dock badge", "show the current notice count on the macOS Dock icon")}
            <div className="dock-badge-options" role="group" aria-label="Dock badge categories">
              {check("dock_badge_input_waits", "Input waits", "include sessions waiting for input")}
              {check("dock_badge_approval_waits", "Approval waits", "include sessions waiting for approval")}
              {check("dock_badge_failures", "Failures", "include failed sessions")}
              {check("dock_badge_completions", "Unread playbook completions", "include completed playbook steps")}
            </div>
            <button
              type="button"
              className="btn ghost small"
              style={{ marginTop: 10 }}
              onClick={() =>
                ipc
                  .notifyTest()
                  .then(() => report("Test notification sent"))
                  .catch((e) => reportError(e))
              }
            >
              Send test notification
            </button>
          </>
        );
      case "telemetry":
        return (
          <>
            {!isGlobal && globalOnly("Telemetry")}
            {telemetryCheck("Share anonymous usage", "state changes only — no paths, prompts, or artifact text")}
          </>
        );
      case "updates": {
        const lastCheck = updateCheckFailed
          ? "Couldn't check"
          : !displayedUpdate || displayedUpdate.checked_at === 0
            ? "Not checked"
            : displayedUpdate.available
              ? `${displayedUpdate.available.version} available`
              : "Up to date";
        return (
          <>
            {!isGlobal && globalOnly("Updates")}
            <div className="field">
              <label>Current version</label>
              <input className="field-input mono" type="text" value={appVersion} readOnly />
            </div>
            <div className="field" style={{ marginTop: 16 }}>
              <label>Last check</label>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="dim">{checkingUpdates ? "Checking…" : lastCheck}</span>
                <button type="button" className="btn ghost small" disabled={checkingUpdates} onClick={checkForUpdatesNow}>
                  Check now
                </button>
              </div>
            </div>
            {displayedUpdate?.available && onUpgrade && (
              <div className="field" style={{ marginTop: 16 }}>
                <button type="button" className="btn small" disabled={updating} onClick={onUpgrade}>
                  Upgrade to {displayedUpdate.available.version}
                </button>
              </div>
            )}
            <div className="field" style={{ marginTop: 16 }}>
              {updatesCheck("Check for updates")}
            </div>
          </>
        );
      }
      case "storage":
        if (isGlobal) {
          return <EmptyState title={SETTINGS_SCOPE_EMPTY_TITLE} />;
        }
        return (
          <div className="mcp-guide">
            {storageErr ? (
              <InlineStatus tone="error" detail={storageErr}>
                Couldn't read storage information.
              </InlineStatus>
            ) : !storage ? (
              <LoadingState label="Loading storage paths…" state="searching" />
            ) : (
              <>
                <div className="storage-usage">
                  <div className="storage-usage-row">
                    <span>Active data (read-only)</span>
                    <b>{formatMb(storage.active_bytes)}</b>
                  </div>
                  <div className="storage-usage-row">
                    <span>Archived (reclaimable)</span>
                    <b>
                      {storage.archived_task_count} tasks · {storage.archived_session_count} sessions · {formatMb(storage.archived_bytes)}
                    </b>
                  </div>
                  <div className="storage-usage-row">
                    <span>Total measured</span>
                    <b>{formatMb(storage.active_bytes + storage.archived_bytes)}</b>
                  </div>
                  <button className="btn danger" type="button" disabled={purgeBusy || storage.archived_task_count + storage.archived_session_count === 0} onClick={purgeArchived}>
                    {purgeBusy ? "Deleting…" : "Delete all archived data…"}
                  </button>
                  {purgeErrors.length > 0 && (
                    <ul className="storage-purge-errors">
                      {purgeErrors.map((f) => (
                        <li key={f.target}>
                          <code>{f.target}</code> — {f.error}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {storageRow("App config", storage.app_config_path)}
                {storageRow("Repository", storage.repo_path)}
                {storageRow(".alinery", storage.alinery_dir)}
                {storageRow("Repo config", storage.repo_config_path)}
                {storageRow("Harnesses", storage.harnesses_path)}
                {storageRow("Tasks", storage.tasks_dir)}
                {storageRow("Worktrees", storage.worktrees_dir)}
                {storageRow("Daemon socket", storage.alineryd_socket_path)}
                {storageRow("Daemon lock", storage.alineryd_lock_path)}
                {storageRow("MCP socket", storage.mcp_socket_path)}
                {storageRow("MCP status", storage.mcp_status_path)}
                <p style={{ margin: "6px 0 0" }}>Settings Global scope reads app.toml; repository scope reads partial .alinery/config.toml overrides.</p>
              </>
            )}
          </div>
        );
      case "appearance":
        return renderAppearance();
      case "chat":
        return (
          <>
            <div className="settings-subsection">
              <h2>Harness</h2>
              <p>OMP version, default model, and session daemon controls for the current settings scope.</p>
              {renderHarness()}
              <div className="field" style={{ marginTop: 16 }}>
                <label id="session-default-view-label">Default session view</label>
                {!isGlobal && globalOnly("Default session view")}
                <div className="theme-cards" role="group" aria-labelledby="session-default-view-label">
                  {(["chat", "terminal"] as const satisfies readonly SessionDefaultView[]).map((view) => {
                    const active = normalizeSessionDefaultView(appearance.session_default_view) === view;
                    return (
                      <button
                        key={view}
                        type="button"
                        className={`theme-card ${active ? "active" : ""}`}
                        disabled={!isGlobal}
                        aria-pressed={active}
                        onClick={() => {
                          if (isGlobal) saveAppearance({ ...appearance, session_default_view: view });
                        }}
                      >
                        <span>{view === "chat" ? "Chat" : "Terminal"}</span>
                      </button>
                    );
                  })}
                </div>
                <span className="dsc">Preferred hatch when starting an OMP session. Chat is the default.</span>
              </div>
            </div>
            <div className="settings-subsection">
              <h2>Journal</h2>
              <p>Which Chat journal rows appear. Global-only.</p>
              {!isGlobal && globalOnly("Chat journal settings")}
              <Checkbox
                checked={appearance.chat_show_thinking === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) {
                    saveAppearance({
                      ...appearance,
                      chat_show_thinking: enabled,
                      chat_expand_thinking: enabled ? appearance.chat_expand_thinking === true : false,
                    });
                  }
                }}
                label={
                  <>
                    Show thinking <span className="dsc">— agent reasoning rails in the Chat journal</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_expand_thinking === true}
                disabled={!isGlobal || appearance.chat_show_thinking !== true}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_expand_thinking: enabled });
                }}
                label={
                  <>
                    Expand thinking by default <span className="dsc">— live streaming still opens automatically</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_tools === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) {
                    saveAppearance({
                      ...appearance,
                      chat_show_tools: enabled,
                      chat_expand_tools: enabled ? appearance.chat_expand_tools === true : false,
                    });
                  }
                }}
                label={
                  <>
                    Show tool use <span className="dsc">— tool call and result rails</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_expand_tools === true}
                disabled={!isGlobal || appearance.chat_show_tools !== true}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_expand_tools: enabled });
                }}
                label={
                  <>
                    Expand tools by default <span className="dsc">— in-flight tool calls still open automatically</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_harness !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_harness: enabled });
                }}
                label={
                  <>
                    Show harness events <span className="dsc">— model changes, compact, and similar notices</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_turn_markers === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_turn_markers: enabled });
                }}
                label={
                  <>
                    Show turn markers <span className="dsc">— turn start and end dividers</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_subagent_rows === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_subagent_rows: enabled });
                }}
                label={
                  <>
                    Show subagent rows <span className="dsc">— subagent status and messages in the journal</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_subagent_drawer !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_subagent_drawer: enabled });
                }}
                label={
                  <>
                    Show subagent drawer <span className="dsc">— live subagent strip above the journal</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_date === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_date: enabled });
                }}
                label={
                  <>
                    Show date <span className="dsc">— calendar day on journal stamps (e.g. Sep 5)</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_time === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_time: enabled });
                }}
                label={
                  <>
                    Show time <span className="dsc">— clock on journal stamps (e.g. 12:11)</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_actor_labels === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_actor_labels: enabled });
                }}
                label={
                  <>
                    Show You / Agent labels <span className="dsc">— name and kind icon above message bubbles</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_agent_bubbles === true}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_agent_bubbles: enabled });
                }}
                label={
                  <>
                    Show agent reply bubbles <span className="dsc">— filled bubble around agent text replies only</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_copy_buttons !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_copy_buttons: enabled });
                }}
                label={
                  <>
                    Show copy buttons <span className="dsc">— per-message copy icon inside chat bubbles</span>
                  </>
                }
              />
            </div>
            <div className="settings-subsection">
              <h2>Density</h2>
              <p>How Chat feels and behaves. Global-only.</p>
              {!isGlobal && globalOnly("Chat density settings")}
              <Checkbox
                checked={appearance.chat_auto_collapse_thinking !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_auto_collapse_thinking: enabled });
                }}
                label={
                  <>
                    Auto-collapse thinking <span className="dsc">— close rails when streaming ends; expand-by-default wins if both are on</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_auto_compaction !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_auto_compaction: enabled });
                }}
                label={
                  <>
                    Auto-compaction <span className="dsc">— ask OMP to compact context when the session fills up</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_auto_scroll !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_auto_scroll: enabled });
                }}
                label={
                  <>
                    Auto-scroll <span className="dsc">— stick to the bottom while following new journal rows</span>
                  </>
                }
              />
              <div className="field">
                <label id="chat-rail-density-label">Rail density</label>
                <div className="theme-cards" role="group" aria-labelledby="chat-rail-density-label">
                  {(["dense", "normal", "comfortable"] as const satisfies readonly ChatRailDensity[]).map((density) => {
                    const active = normalizeChatRailDensity(appearance.chat_rail_density) === density;
                    const label = density === "dense" ? "Dense" : density === "normal" ? "Normal" : "Comfortable";
                    return (
                      <button
                        key={density}
                        type="button"
                        className={`theme-card ${active ? "active" : ""}`}
                        disabled={!isGlobal}
                        aria-pressed={active}
                        onClick={() => {
                          if (isGlobal) saveAppearance({ ...appearance, chat_rail_density: density });
                        }}
                      >
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
                <span className="dsc">Journal and rail spacing. Dense matches the previous compact look.</span>
              </div>
              <div className="field">
                <label id="chat-max-width-label">Chat column width</label>
                <div className="theme-cards" role="group" aria-labelledby="chat-max-width-label">
                  {(["600", "900", "1200", "none"] as const satisfies readonly ChatMaxWidth[]).map((width) => {
                    const active = normalizeChatMaxWidth(appearance.chat_max_width) === width;
                    return (
                      <button
                        key={width}
                        type="button"
                        className={`theme-card ${active ? "active" : ""}`}
                        disabled={!isGlobal}
                        aria-pressed={active}
                        onClick={() => {
                          if (isGlobal) saveAppearance({ ...appearance, chat_max_width: width });
                        }}
                      >
                        <span>{width === "none" ? "None" : `${width}px`}</span>
                      </button>
                    );
                  })}
                </div>
                <span className="dsc">Limits journal thread width; meta and composer stay full width.</span>
              </div>
              {sizeRow({
                id: "chat-font-size",
                name: "Chat text",
                noun: "chat font size",
                sample: <span style={{ fontSize: `${normalizeChatFontSize(appearance.chat_font_size ?? CHAT_FONT_DEFAULT)}px` }}>Replies and expanded rail bodies</span>,
                value: normalizeChatFontSize(appearance.chat_font_size ?? CHAT_FONT_DEFAULT),
                min: CHAT_FONT_MIN,
                max: CHAT_FONT_MAX,
                onChange: (chat_font_size) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_font_size });
                },
              })}
              {sizeRow({
                id: "chat-rail-font-size",
                name: "Rail text",
                noun: "rail font size",
                sample: <span style={{ fontSize: `${normalizeChatRailFontSize(appearance.chat_rail_font_size ?? CHAT_RAIL_FONT_DEFAULT)}px` }}>Thinking and tool labels</span>,
                value: normalizeChatRailFontSize(appearance.chat_rail_font_size ?? CHAT_RAIL_FONT_DEFAULT),
                min: CHAT_FONT_MIN,
                max: CHAT_FONT_MAX,
                onChange: (chat_rail_font_size) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_rail_font_size });
                },
              })}
              <Checkbox
                checked={appearance.chat_show_meta !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_meta: enabled });
                }}
                label={
                  <>
                    Show meta strip <span className="dsc">— model · thinking · event count · context above Chat</span>
                  </>
                }
              />
              <Checkbox
                checked={appearance.chat_show_composer_hints !== false}
                disabled={!isGlobal}
                onChange={(enabled) => {
                  if (isGlobal) saveAppearance({ ...appearance, chat_show_composer_hints: enabled });
                }}
                label={
                  <>
                    Show composer key hints <span className="dsc">— Enter / Shift+Enter row; char count stays</span>
                  </>
                }
              />
            </div>
          </>
        );
      case "gridViews": {
        const controlsDisabled = isGlobal === false;
        const disabledReason = isGlobal === false ? "Grid-based views are global settings." : "";
        return (
          <>
            {isGlobal === false && globalOnly("Grid-based views")}
            <div className="grid-view-settings-intro">
              <h2>Grid-based views</h2>
              <p>Configure up to three named Grid views. Their order assigns the fixed shortcuts ⌘2, ⌘4, and ⌘5 (⌘3 is reserved for classic Kanban).</p>
            </div>
            <ol className="grid-view-settings-list">
              {gridViews.map((view, index) => {
                const value = gridViewDrafts[view.id] ?? view.name;
                const error = gridViewErrors[view.id] ?? "";
                const inputId = `grid-view-name-${view.id}`;
                const errorId = `${inputId}-error`;
                const deleteHelpId = `${inputId}-delete-help`;
                return (
                  <li className="grid-view-settings-row" key={view.id}>
                    <div className="grid-view-slot" aria-label={`Shortcut ${gridViewShortcut(index)}`}>
                      <span>View {index + 1}</span>
                      <kbd>{gridViewShortcut(index)}</kbd>
                    </div>
                    <div className="grid-view-name-field">
                      <label htmlFor={inputId}>Display name</label>
                      <input
                        ref={(input) => {
                          if (input && focusGridViewId === view.id) {
                            input.focus();
                            input.select();
                            queueMicrotask(() => setFocusGridViewId(""));
                          }
                        }}
                        id={inputId}
                        className="field-input"
                        type="text"
                        value={value}
                        disabled={controlsDisabled}
                        title={controlsDisabled ? disabledReason : undefined}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? errorId : undefined}
                        onChange={(event) => {
                          const nextValue = event.currentTarget.value;
                          setGridViewDrafts((current) => ({ ...current, [view.id]: nextValue }));
                          setGridViewErrors((current) => ({ ...current, [view.id]: gridViewNameError(view.id, nextValue) }));
                        }}
                        onBlur={() => commitGridViewName(view)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            setGridViewDrafts((current) => ({ ...current, [view.id]: view.name }));
                            setGridViewErrors((current) => ({ ...current, [view.id]: "" }));
                          }
                        }}
                      />
                      {error && (
                        <span className="field-error" id={errorId} role="alert">
                          {error}
                        </span>
                      )}
                    </div>
                    <div className="grid-view-row-actions">
                      <button
                        type="button"
                        className="btn ghost small icon"
                        aria-label={`Move ${view.name} up`}
                        title={controlsDisabled ? disabledReason : index === 0 ? "Already first" : `Assign ${gridViewShortcut(index - 1)}`}
                        disabled={controlsDisabled || index === 0}
                        onClick={() => moveGridView(index, -1)}
                      >
                        <ArrowUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn ghost small icon"
                        aria-label={`Move ${view.name} down`}
                        title={controlsDisabled ? disabledReason : index === gridViews.length - 1 ? "Already last" : `Assign ${gridViewShortcut(index + 1)}`}
                        disabled={controlsDisabled || index === gridViews.length - 1}
                        onClick={() => moveGridView(index, 1)}
                      >
                        <ArrowDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn ghost small icon danger"
                        aria-label={`Delete ${view.name}`}
                        aria-describedby={gridViews.length === 1 ? deleteHelpId : undefined}
                        title={controlsDisabled ? disabledReason : gridViews.length === 1 ? "At least one Grid-based view is required" : `Delete ${view.name}`}
                        disabled={controlsDisabled || gridViews.length === 1}
                        onClick={() => void deleteGridView(view)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                      {gridViews.length === 1 && (
                        <span className="sr-only" id={deleteHelpId}>
                          At least one Grid-based view is required.
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="grid-view-add-row">
              <button
                type="button"
                className="btn secondary"
                disabled={controlsDisabled || gridViews.length >= MAX_GRID_VIEWS}
                aria-describedby="grid-view-count"
                title={controlsDisabled ? disabledReason : gridViews.length >= MAX_GRID_VIEWS ? `Maximum of ${MAX_GRID_VIEWS} Grid-based views reached` : "Add Grid-based View"}
                onClick={addGridView}
              >
                <Plus size={15} aria-hidden="true" /> Add Grid-based View
              </button>
              <span className="hint" id="grid-view-count">
                {gridViews.length >= MAX_GRID_VIEWS ? `Maximum of ${MAX_GRID_VIEWS} views configured` : `${gridViews.length} of ${MAX_GRID_VIEWS} views configured`}
              </span>
            </div>
          </>
        );
      }
      case "experimental":
        return (
          <>
            {!isGlobal && globalOnly("Experimental settings")}
            <Checkbox
              checked={global.experiments?.show_original_kanban ?? true}
              disabled={!isGlobal}
              onChange={setShowOriginalKanban}
              label={
                <div>
                  <div>Original Kanban</div>
                  <div className="hint">Show the classic Kanban board in the top bar as ⌘3.</div>
                </div>
              }
            />
          </>
        );
      case "mcp": {
        const installReady = mcpInstallReady(mcp);
        const hostConfigJson = stdioHostConfigJson(installReady ? mcp.binary_path : "/path/to/alinery-mcp");
        const copyHostConfig = () => {
          if (!installReady) return;
          copyTextToClipboard(stdioHostConfigJson(mcp.binary_path))
            .then(() => report("Config copied", "short"))
            .catch((e) => reportError(e, "Couldn't copy the config"));
        };
        const checkRow = (ok: boolean, label: string, value: string, hint: string) => (
          <div className={`mcp-check${ok ? " ok" : ""}`}>
            {ok ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Circle size={10} strokeWidth={1.5} aria-hidden="true" />}
            <span className="mcp-check-label">{label}</span>
            {value ? (
              <>
                <span className="mono mcp-check-value" title={value}>
                  {value}
                </span>
                <button className="btn ghost small icon" type="button" title={`Copy ${label} path`} aria-label={`Copy ${label} path`} onClick={() => copyStoragePath(value)}>
                  <Copy size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </>
            ) : (
              <span className="mcp-check-hint">{hint}</span>
            )}
          </div>
        );
        // One derivation per prerequisite: the icon and the label must never disagree.
        // The offline fallback in useMcpStatus reports binary_found with no path, so
        // testing binary_found alone would caption a not-ready chip "Binary ready".
        const binaryReady = mcp.binary_found && !!mcp.binary_path;
        // Chips confirm what is satisfied. The status label already names the first thing
        // that is not — captioning a chip with the same words printed "No repo" twice in a
        // row, and the unmet hints below say what to do about it.
        const metChip = (label: string, detail: string) => (
          <span className="mcp-chip ok" title={detail || undefined}>
            <Check size={12} strokeWidth={2} aria-hidden="true" />
            {label}
          </span>
        );
        // The section configures the active repository whatever the scope bar says, so a
        // scope pointing elsewhere means the config on screen is not for the repo named
        // above it. Name the real target, in full, rather than let it be pasted blind.
        const scopeMismatch = !isGlobal && !!mcp.repo && selectedRepo !== mcp.repo;
        // A disabled toggle owes the user the reason next to it. The same sentences appear
        // on the Advanced rows, but Advanced is closed by default and the one user who
        // cannot start the server is the one who should not have to go looking.
        const unmet = [!mcp.repo && "Select a repo first.", !binaryReady && "alinery-mcp binary not found next to the app — rebuild."].filter(
          (hint): hint is string => typeof hint === "string",
        );
        return (
          <div className="mcp-page">
            <div className="mcp-hero">
              <div className="mcp-hero-status">
                <span className="statusdot">
                  <span className="d" style={{ background: mcpDotColor(mcp) }} />
                  {mcpStatusLabel(mcp)}
                </span>
                <div className="mcp-chips">
                  {mcp.repo && metChip(repoName(mcp.repo), mcp.repo)}
                  {binaryReady && metChip("Binary ready", mcp.binary_path)}
                </div>
              </div>
              <Checkbox
                checked={mcp.enabled}
                disabled={mcpBusy || !mcp.repo || !mcp.binary_found}
                onChange={() => {
                  setMcpBusy(true);
                  const wasEnabled = mcp.enabled;
                  (wasEnabled ? ipc.stopMcpServer() : ipc.startMcpServer())
                    .then(() => {
                      mcp.refresh();
                      report(wasEnabled ? "MCP server stopped" : "MCP server started");
                    })
                    .catch((e) => reportError(e, wasEnabled ? "Couldn't stop the MCP server" : "Couldn't start the MCP server"))
                    .finally(() => setMcpBusy(false));
                }}
                label={
                  <>
                    App-managed server <span className="dsc">— optional for Desktop hosts</span>
                  </>
                }
              />
            </div>
            {unmet.length > 0 && (
              <div className="mcp-unmet">
                {unmet.map((hint) => (
                  <p key={hint}>{hint}</p>
                ))}
              </div>
            )}
            {scopeMismatch && (
              <InlineStatus tone="warning" detail={mcp.repo}>
                This section always configures the active repository, not the <strong>{repoName(selectedRepo)}</strong> scope selected above. The config below is for:
              </InlineStatus>
            )}
            {mcp.enabled && !mcp.running && mcp.error && (
              <InlineStatus tone="error" detail={mcp.error}>
                The MCP server is enabled but not running.
              </InlineStatus>
            )}
            <section className="mcp-section">
              <div className="mcp-section-head">
                <div>
                  <h4 className="mcp-section-title">Host config</h4>
                  <p className="mcp-caption">
                    Add Alinery MCP to Claude Desktop, Cursor, or any host that runs a command with args. Merge the <span className="mono">alinery</span> entry — do not overwrite
                    the whole file. Restart the host after editing config. One process serves every repo; pass <span className="mono">repo</span> as a per-call tool argument (a
                    path from <span className="mono">alinery_list_repos</span>).
                  </p>
                </div>
                <button
                  className="btn ghost mcp-copy-btn"
                  type="button"
                  disabled={!installReady}
                  title={installReady ? "Copy full mcpServers config" : "Ensure alinery-mcp is found"}
                  onClick={copyHostConfig}
                >
                  Copy config
                </button>
              </div>
              <pre className="mcp-config">{hostConfigJson}</pre>
            </section>
            <details className="mcp-advanced">
              <summary>
                <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
                Advanced
              </summary>
              <div className="mcp-advanced-body">
                <p className="mcp-caption">
                  Stdio FS/task tools work without the Alinery window open. There is <strong>no live PTY control</strong> over MCP. Host config file paths are in the README.
                </p>
                {checkRow(binaryReady, "Binary path", mcp.binary_path, "alinery-mcp binary not found next to the app — rebuild.")}
                <h4 className="mcp-section-title">Managed socket</h4>
                <p className="mcp-caption">
                  App-local <span className="mono">alinery-mcp --serve</span> child while Alinery is open. Not the Desktop install path; dies when you quit or switch repos. Useful
                  for same-machine debugging only.
                </p>
                {checkRow(!!mcp.socket_path, "Socket path", mcp.socket_path, "Select a repo to see the socket path.")}
              </div>
            </details>
          </div>
        );
      }
      case "backup":
        return renderBackup();
      default:
        return null;
    }
  };

  return (
    <div className="settings-layout">
      <div className="settings-scopebar" aria-label="Settings scope">
        <div className="settings-scope-summary">
          <div className="settings-scope-eyebrow">Settings scope</div>
          <div className="settings-scope-title">{selectedScopeLabel}</div>
          <div className="settings-scope-detail">{selectedScopeDetail}</div>
        </div>
        <div className="settings-scope-actions" role="group" aria-label="Choose settings scope">
          <button className={`scope-chip${isGlobal ? " on" : ""}`} type="button" onClick={() => setScope({ kind: "global" })}>
            All repositories
          </button>
          {repoOptions.map((repo) => (
            <button
              key={repo}
              className={`scope-chip${!isGlobal && selectedRepo === repo ? " on" : ""}`}
              type="button"
              title={repo}
              onClick={() => setScope({ kind: "repo", repoPath: repo })}
            >
              {repoName(repo)}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-shell">
        <nav className="settings-nav">
          {visibleSections.map((s) => (
            <button
              type="button"
              key={s.key}
              className={`settings-navitem${visibleActiveSection === s.key ? " on" : ""}`}
              onClick={() => {
                setActiveSection(s.key);
              }}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-panel">{renderSection(visibleActiveSection)}</div>
      </div>
    </div>
  );
}
