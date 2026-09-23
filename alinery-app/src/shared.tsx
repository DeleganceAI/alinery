import {
  ArrowRight,
  ArrowUpCircle,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  FolderOpen,
  FolderPlus,
  Info,
  Package,
  Plus,
  RotateCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { type OrbState, ThinkingOrb } from "thinking-orbs";
import { AccountMenu } from "./AccountMenu";
import type { ArchiveTaskPhase } from "./archiveTask";
import { pickEmptyStateArt } from "./emptyStateArt";
import { gridViewShortcut, gridViewShortcutDigit } from "./gridViews";
import { IdleDot, ORB_SPEED, ORB_STATE, RunningIndicator, StateIcon } from "./Indicators";
import * as ipc from "./ipc";
import { BrandMark } from "./Logo";
import { deriveModelRows } from "./modelFavorites";
import { type ObservationDisplayKind, observationDisplayKind } from "./sessionAttention";
import { useTabPill } from "./tabMotion";
import { toast } from "./toast";
import type {
  AppConfig,
  ArtifactListItem,
  ArtifactTreeNode,
  BoardTask,
  GridViewDefinition,
  KanbanColumn,
  LifecycleState,
  OmpUpdateStatus,
  PickerPreference,
  PickerPreferences,
  PlaybookCandidate,
  PlaybookRef,
  RepoScope,
  ReviewHandoffRecord,
  SessionMeta,
  SessionObservation,
  Tab,
  Task,
  TaskActivityMap,
  TaskActivityRef,
  TaskActivitySummary,
  UpdateStatus,
} from "./types";
import { WindowControls } from "./WindowChrome";

export const ALL_REPOS = "__all_repos__";

export function isDevelopmentProductName(name: string | null | undefined) {
  return name === "Alinery Dev";
}

export function repoName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
export function taskKey(t: BoardTask) {
  return `${t.repo_path}:${t.slug}`;
}

export const playbookRefKey = (reference: PlaybookRef) => `${reference.scope}/${reference.key}`;
export const samePlaybookRef = (left: PlaybookRef | null | undefined, right: PlaybookRef | null | undefined) =>
  left === right || (!!left && !!right && left.scope === right.scope && left.key === right.key);

export function orderPlaybookCandidates(candidates: PlaybookCandidate[], preferences: PickerPreferences): PlaybookCandidate[] {
  const ranks = new Map(preferences.order.map((reference, index) => [playbookRefKey(reference), index]));
  return [...candidates].sort((left, right) => {
    const a = playbookRefKey(left.source.reference);
    const b = playbookRefKey(right.source.reference);
    return (ranks.get(a) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b);
  });
}

export function playbookPickerAppearance(reference: PlaybookRef, preference?: PickerPreference) {
  const identity = playbookRefKey(reference);
  let hash = 0;
  for (let i = 0; i < identity.length; i++) hash = (Math.imul(hash, 31) + identity.charCodeAt(i)) | 0;
  const colors = ["#38459d", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#e94242"];
  return {
    badge: preference?.badge || `${reference.scope[0].toUpperCase()}·${reference.key.slice(0, 2).toUpperCase()}`,
    color: preference?.color || colors[(hash >>> 0) % colors.length],
  };
}

export function findOwnedArtifactNode(nodes: ArtifactTreeNode[], relativePath: string): ArtifactTreeNode | undefined {
  const visit = (items: ArtifactTreeNode[], parent: string): ArtifactTreeNode | undefined => {
    for (const node of items) {
      if (node.source !== "owned" || node.kind === "attachment" || node.kind === "referenced") continue;
      const path = parent ? `${parent}/${node.label}` : node.label;
      if (node.kind === "owned" && path === relativePath && node.children.length === 0) return node;
      const match = visit(node.children, path);
      if (match) return match;
    }
    return undefined;
  };
  return visit(nodes, "");
}

export function isAllowedLaunchHarness(key: string): boolean {
  return key === "omp" || key === "no-harness";
}

export function ompDefaultModel(defaults: { harness?: string; model?: string } | null | undefined): string {
  const harness = defaults?.harness?.trim() ?? "";
  if (harness === "" || isAllowedLaunchHarness(harness)) {
    return defaults?.model || "";
  }
  return "";
}

export function harnessDisplayName(harness: string) {
  if (harness === "no-harness") return "Terminal";
  if (harness === "omp") return "OMP CLI";
  return "Unsupported";
}

export function finalizedSubtaskNotice(task: Pick<Task, "archived" | "parent_task" | "subtask_outcome">, parent?: Pick<Task, "name" | "slug"> | null): string {
  if (!task.archived || !task.parent_task || !task.subtask_outcome) return "";
  const parentLabel = parent?.name || task.parent_task;
  return `Finalized into ${parentLabel} as ${task.subtask_outcome.toUpperCase()}. Any open session may be stale. Changes after finalization are not included in the parent snapshot or integrated result.`;
}

export function sameSessionMetas(left: SessionMeta[], right: SessionMeta[]) {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const other = right[index];
      return (
        session.id === other.id &&
        session.worktree === other.worktree &&
        session.created === other.created &&
        session.archived === other.archived &&
        session.phase === other.phase &&
        session.harness === other.harness &&
        session.model === other.model &&
        session.playbook === other.playbook &&
        session.execution_id === other.execution_id &&
        session.execution_revision === other.execution_revision &&
        session.generic === other.generic &&
        session.subtask_manager === other.subtask_manager &&
        session.subtask_slug === other.subtask_slug &&
        session.artifact === other.artifact &&
        session.handoff_artifact === other.handoff_artifact &&
        session.prompt_extra === other.prompt_extra &&
        session.prompt === other.prompt &&
        session.started_at === other.started_at &&
        session.status_changed_at === other.status_changed_at &&
        session.ended_at === other.ended_at &&
        session.exit_code === other.exit_code &&
        session.harness_resume_token === other.harness_resume_token &&
        session.resume_of === other.resume_of &&
        session.notification_read_at === other.notification_read_at &&
        session.exit_notification_read_at === other.exit_notification_read_at
      );
    })
  );
}

function sameHandoffRecords(left: ReviewHandoffRecord[], right: ReviewHandoffRecord[]) {
  return (
    left.length === right.length &&
    left.every((record, index) => {
      const other = right[index];
      return (
        record.version === other.version &&
        record.direction === other.direction &&
        record.source_task === other.source_task &&
        record.source_session === other.source_session &&
        record.source_artifact === other.source_artifact &&
        record.target_task === other.target_task &&
        record.target_artifact === other.target_artifact &&
        record.target_session === other.target_session &&
        record.target_phase === other.target_phase &&
        record.created_at_ms === other.created_at_ms
      );
    })
  );
}

export function sameArtifactListItems(left: ArtifactListItem[], right: ArtifactListItem[]) {
  return (
    left.length === right.length &&
    left.every((artifact, index) => {
      const other = right[index];
      return (
        artifact.name === other.name &&
        artifact.modified_at_ms === other.modified_at_ms &&
        artifact.playbook_step === other.playbook_step &&
        artifact.session_id === other.session_id &&
        !!artifact.attachment === !!other.attachment &&
        sameHandoffRecords(artifact.handoffs, other.handoffs)
      );
    })
  );
}

export function sameLifecycleMaps(left: Record<string, LifecycleState>, right: Record<string, LifecycleState>) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const previous = left[key];
      const next = right[key];
      if (!next || previous.state !== next.state) return false;
      if (previous.state === "exited" && next.state === "exited") return previous.code === next.code;
      return true;
    })
  );
}

export function sameTask(left: Task, right: Task): boolean {
  return (
    left.name === right.name &&
    left.slug === right.slug &&
    left.requested_slug === right.requested_slug &&
    left.branch === right.branch &&
    left.worktree === right.worktree &&
    left.has_worktree === right.has_worktree &&
    left.created === right.created &&
    left.archived === right.archived &&
    left.pr_url === right.pr_url &&
    left.linear_id === right.linear_id &&
    left.github_issue === right.github_issue &&
    left.playbook === right.playbook &&
    samePlaybookRef(left.playbook_ref, right.playbook_ref) &&
    left.max_live_sessions === right.max_live_sessions &&
    left.engine_version === right.engine_version &&
    left.launch_defaults?.harness === right.launch_defaults?.harness &&
    left.launch_defaults?.model === right.launch_defaults?.model &&
    left.draft === right.draft &&
    left.auto_advance.length === right.auto_advance.length &&
    left.auto_advance.every((edge, index) => edge === right.auto_advance[index]) &&
    (left.related_tasks ?? []).length === (right.related_tasks ?? []).length &&
    (left.related_tasks ?? []).every((tag, index) => {
      const other = (right.related_tasks ?? [])[index];
      return other && tag.repo_path === other.repo_path && tag.slug === other.slug && tag.name === other.name;
    })
  );
}

// #118 T0-5: board pollers rebuild fresh arrays every 3s. Gate their setState with these
// comparators so an idle board commits no new state (and running-indicator animations keep
// identity). Same shape as sameSessionMetas / sameArtifactListItems / sameLifecycleMaps.
export function sameBoardTasks(left: BoardTask[], right: BoardTask[]) {
  return (
    left.length === right.length &&
    left.every((task, index) => {
      const other = right[index];
      return (
        task.name === other.name &&
        task.slug === other.slug &&
        task.requested_slug === other.requested_slug &&
        task.parent_task === other.parent_task &&
        (task.active_subtask_slugs ?? []).length === (other.active_subtask_slugs ?? []).length &&
        (task.active_subtask_slugs ?? []).every((slug, i) => slug === (other.active_subtask_slugs ?? [])[i]) &&
        task.branch === other.branch &&
        task.worktree === other.worktree &&
        task.has_worktree === other.has_worktree &&
        task.created === other.created &&
        task.archived === other.archived &&
        task.pr_url === other.pr_url &&
        task.linear_id === other.linear_id &&
        task.github_issue === other.github_issue &&
        task.playbook === other.playbook &&
        samePlaybookRef(task.playbook_ref, other.playbook_ref) &&
        task.max_live_sessions === other.max_live_sessions &&
        task.engine_version === other.engine_version &&
        task.launch_defaults?.harness === other.launch_defaults?.harness &&
        task.launch_defaults?.model === other.launch_defaults?.model &&
        task.draft === other.draft &&
        task.auto_advance.length === other.auto_advance.length &&
        task.auto_advance.every((value, i) => value === other.auto_advance[i]) &&
        task.repo_path === other.repo_path &&
        task.session_count === other.session_count &&
        task.playbook_title === other.playbook_title &&
        task.updated === other.updated &&
        task.current_phase === other.current_phase &&
        task.current_step_title === other.current_step_title &&
        task.current_column_key === other.current_column_key &&
        task.current_column_title === other.current_column_title
      );
    })
  );
}

export function sameBoardBuckets(left: Record<string, BoardTask[]>, right: Record<string, BoardTask[]>) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const next = right[key];
      return next !== undefined && sameBoardTasks(left[key], next);
    })
  );
}

export function sameKanbanColumns(left: KanbanColumn[], right: KanbanColumn[]) {
  return (
    left.length === right.length &&
    left.every((column, index) => {
      const other = right[index];
      return column.key === other.key && column.title === other.title;
    })
  );
}

export function sameTaskActivityMaps(left: TaskActivityMap, right: TaskActivityMap) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      const previous = left[key];
      const next = right[key];
      if (!next || previous.status !== next.status) {
        return false;
      }
      const previousSession = previous.active_session;
      const nextSession = next.active_session;
      return (
        previousSession === nextSession ||
        (!!previousSession &&
          !!nextSession &&
          previousSession.id === nextSession.id &&
          previousSession.worktree === nextSession.worktree &&
          previousSession.phase === nextSession.phase &&
          previousSession.harness === nextSession.harness &&
          previousSession.model === nextSession.model &&
          previousSession.playbook === nextSession.playbook &&
          previousSession.generic === nextSession.generic &&
          previousSession.step_title === nextSession.step_title)
      );
    })
  );
}

// Shared age formatters (T0-6): used by TaskList's Updated/Created columns and Kanban's
// card age slot. No seconds unit — anything under a minute reads "now".
export function formatAge(epochSeconds: number | null | undefined, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!epochSeconds) return "—";
  const diff = Math.max(0, nowSeconds - epochSeconds);
  if (diff < 60) return "now";
  const units: [number, string][] = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  const unit = units.find(([seconds]) => diff >= seconds);
  return unit ? `${Math.floor(diff / unit[0])}${unit[1]}` : "now";
}

export function formatAbsolute(epochSeconds: number | null | undefined) {
  return epochSeconds ? new Date(epochSeconds * 1000).toLocaleString() : "";
}

export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function SessionTimestamp({ kind, value, now }: { kind: "started" | "updated"; value: number | null | undefined; now: number }) {
  const label = kind === "started" ? "Started" : "Updated";
  const descriptionPrefix = kind === "started" ? "Started" : "Status changed";
  const absolute = formatAbsolute(value);
  const description = absolute ? `${descriptionPrefix} ${absolute}` : `${descriptionPrefix} —`;
  return (
    <time className="session-time" dateTime={value ? new Date(value * 1000).toISOString() : undefined} title={absolute ? description : undefined}>
      <span className="session-time-label" aria-hidden="true">
        {label}
      </span>
      <span className="session-time-value" aria-hidden="true">
        {formatAge(value, now)}
      </span>
      <span className="sr-only">{description}</span>
    </time>
  );
}
export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  // A real <input> so the control is keyboard-operable and announced; the
  // native box stays visually hidden behind the styled .chk twin.
  return (
    <label className={`opt${disabled ? " disabled" : ""}`}>
      <input type="checkbox" className="chk-input" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={`chk${checked ? " on" : ""}`} aria-hidden="true">
        {checked ? <Check size={12} strokeWidth={2.5} /> : null}
      </span>
      <span className="opt-copy">{label}</span>
    </label>
  );
}

/** Visible indeterminate wait: a 20px Thinking Orb beside its static label —
 *  the app's only loader language (DESIGN.md §Loading). `state` picks the orb
 *  animation whose verb truthfully matches the operation. Pass `ORB_STATE` when
 *  the wait is the app fetching its own data, so the region resolves into the
 *  same orb the resulting rows carry; it is slowed to ORB_SPEED to match. Named
 *  verbs and the `working` default keep the package's baked speed — those waits
 *  are short, and a slow rate on a brief flash only shows a static frame. */
export function LoadingState({ label, state = "working" }: { label: string; state?: OrbState }) {
  return (
    <div className="loading-state">
      <ThinkingOrb state={state} speed={state === ORB_STATE ? ORB_SPEED : undefined} size={20} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Inline status line (DESIGN.md §Error/§Success): plain-language message with
 *  tone icon; optional exact technical detail (copyable) and recovery action.
 *  Errors are announced; other tones are polite status. */
export function InlineStatus({ tone, children, detail, action }: { tone: "error" | "warning" | "success" | "info"; children: ReactNode; detail?: string; action?: ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : tone === "warning" ? TriangleAlert : tone === "success" ? CircleCheck : Info;
  return (
    <div className={`inline-status ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <div className="inline-status-body">
        <div className="inline-status-msg">{children}</div>
        {detail && <pre className="inline-status-detail">{detail}</pre>}
        {action && <div className="inline-status-action">{action}</div>}
      </div>
    </div>
  );
}

/** Empty surface (DESIGN.md §Empty): say what belongs here, why it is empty
 *  when known, and offer one next action when the user can resolve it.
 *
 *  `art` is for major empty states only — one surface, one piece, plenty of
 *  room. Decorative, so it carries an empty alt and never replaces the title:
 *  the words still have to work with images off. `true` picks a catalog plate
 *  on mount; a string is an explicit URL (tests). */
export function EmptyState({ title, hint, action, art }: { title: string; hint?: ReactNode; action?: ReactNode; art?: string | true }) {
  return (
    <div className="empty-state">
      {art ? <EmptyStateArt src={art} /> : null}
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/** The plate is held at opacity 0 until it decodes, so a half-painted image never
 *  shows. That gate needs an exit for the failure case too: the image's box is now
 *  reserved from its 900:510 ratio, so one that never loads would hold an empty mat
 *  open forever. On error, drop the frame and let the words stand on their own. */
function EmptyStateArt({ src }: { src: string | true }) {
  const [url] = useState(() => (src === true ? pickEmptyStateArt() : src));
  const [state, setState] = useState<"pending" | "ready" | "failed">("pending");
  if (state === "failed") return null;
  return (
    <div className="empty-state-art-frame">
      <img className={`empty-state-art${state === "ready" ? " on" : ""}`} src={url} alt="" draggable={false} onLoad={() => setState("ready")} onError={() => setState("failed")} />
    </div>
  );
}

/**
 * The shared alinery dialog: native <dialog> + showModal() for real modality —
 * inert background, native Esc (forwarded to onClose via the cancel event) and
 * top-layer stacking — plus explicit focus restoration to the opener on close.
 * Mount it conditionally ({open && <Dialog …>}). Initial focus goes to the
 * element marked data-autofocus (React's autoFocus fires while the dialog is
 * still display:none, so it cannot be used here); confirm.tsx keeps its tested
 * safe-default-focus contract through that attribute.
 */
export function Dialog({
  onClose,
  className,
  role,
  ariaLabel,
  children,
}: {
  onClose: () => void;
  className?: string;
  role?: "dialog" | "alertdialog";
  ariaLabel?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // jsdom (tests) has no dialog methods; the attribute fallback still renders
    // the content so behaviour around the dialog stays testable.
    if (typeof el.showModal === "function") el.showModal();
    else el.setAttribute("open", "");
    const target = el.querySelector<HTMLElement>("[data-autofocus]");
    (target ?? el).focus();
    return () => {
      if (typeof el.close === "function" && el.open) el.close();
      opener.current?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal${className ? ` ${className}` : ""}`}
      role={role}
      aria-label={ariaLabel}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click outside the dialog box lands on the element itself (backdrop
        // clicks are dispatched to it); geometry separates that from content.
        const el = ref.current;
        if (!el || e.target !== el) return;
        const r = el.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

export function TopBar({
  isDev,
  active,
  activeGridViewId,
  scope,
  appConfig,
  gridViews = [],
  showOriginalKanban = false,
  onSwitch,
  onSwitchGrid,
  onSelectRepo,
  onRemoveRepo,
  onAddRepo,
  onBrand,
  onSearch,
  onCreate,
  instant = false,
  update,
  onUpgrade,
  updating,
  ompUpdate,
  onOmpUpdateClick,
}: {
  isDev: boolean;
  active: Tab;
  activeGridViewId?: string;
  scope: RepoScope;
  appConfig: AppConfig;
  gridViews?: GridViewDefinition[];
  showOriginalKanban?: boolean;
  instant?: boolean;
  onSwitch: (k: Tab) => void;
  onSwitchGrid: (gridViewId: string) => void;
  onSelectRepo: (path: string) => void;
  onRemoveRepo: (path: string) => void;
  onAddRepo: () => void;
  onBrand: () => void;
  onSearch: () => void;
  onCreate: () => void;
  update?: UpdateStatus | null;
  onUpgrade?: () => void;
  ompUpdate?: OmpUpdateStatus | null;
  onOmpUpdateClick?: () => void;
  updating?: boolean;
}) {
  const includeAll = active !== "settings";
  const value = includeAll && scope === "all" ? ALL_REPOS : appConfig.active_repo;
  const tabsRef = useRef<HTMLElement>(null);
  const activeKey = active === "grid" && activeGridViewId ? `grid:${activeGridViewId}` : String(active);
  useTabPill(tabsRef, activeKey, instant);
  const tab = (k: Tab, label: string, digit?: string) => (
    <button type="button" className={`tab${active === k ? " on" : ""}`} aria-current={active === k ? "page" : undefined} data-tab={k} onClick={() => onSwitch(k)}>
      {label}
      {digit && <span className="k">{digit}</span>}
    </button>
  );
  const gridTab = (gridView: GridViewDefinition, index: number) => {
    const selected = active === "grid" && activeGridViewId === gridView.id;
    const key = `grid:${gridView.id}`;
    return (
      <button
        type="button"
        key={gridView.id}
        className={`tab${selected ? " on" : ""}`}
        aria-current={selected ? "page" : undefined}
        data-tab={key}
        title={`${gridView.name} (${gridViewShortcut(index)})`}
        onClick={() => onSwitchGrid(gridView.id)}
      >
        <span className="tab-label">{gridView.name}</span>
        <span className="k">{gridViewShortcutDigit(index)}</span>
      </button>
    );
  };
  const firstGridView = gridViews[0];
  const extraGridViews = gridViews.slice(1);
  return (
    <header data-tauri-drag-region="">
      <WindowControls />
      <div className="brand" onClick={onBrand}>
        <BrandMark />
        {isDev && (
          <span className="dev-badge" aria-label="Development build">
            DEV
          </span>
        )}
        {update?.available && (
          <button
            type="button"
            className="iconbtn upgrade"
            title={`Upgrade to ${update.available.version}`}
            aria-label={`Upgrade to ${update.available.version}`}
            disabled={updating}
            onClick={(e) => {
              e.stopPropagation();
              onUpgrade?.();
            }}
          >
            <ArrowUpCircle size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
        {ompUpdate?.available && (
          <button
            type="button"
            className="iconbtn omp-update"
            title={`OMP update ${ompUpdate.available.version}`}
            aria-label={`OMP update ${ompUpdate.available.version}`}
            onClick={(e) => {
              e.stopPropagation();
              onOmpUpdateClick?.();
            }}
          >
            <Package size={16} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="tabs" ref={tabsRef}>
        <span className="tab-indicator" aria-hidden="true" />
        {tab("list", "Tasks", "1")}
        {firstGridView && gridTab(firstGridView, 0)}
        {showOriginalKanban && tab("kanban", "Kanban", "3")}
        {extraGridViews.map((gridView, index) => gridTab(gridView, index + 1))}
        {tab("sessions", "Sessions", "7")}
        {tab("notifications", "Notifications", "8")}
        {tab("playbooks", "Playbooks")}
      </nav>
      <div className="spacer" />
      <button type="button" className="iconbtn new-task" title="New task (⌘N)" aria-label="New task" onClick={onCreate}>
        <Plus size={18} strokeWidth={1.5} aria-hidden="true" />
        <span className="k" aria-hidden="true">
          N
        </span>
      </button>
      <div className="repo-switcher">
        <RepoSelect value={value} includeAll={includeAll} knownRepos={appConfig.known_repos} onSelect={onSelectRepo} onRemove={onRemoveRepo} />
        <button type="button" className="iconbtn repo-add" title="Add repo" aria-label="Add repository" onClick={onAddRepo}>
          <FolderPlus size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="iconbtn search" title="Search (⌘K)" aria-label="Search" onClick={onSearch}>
        <Search size={15} strokeWidth={1.5} aria-hidden="true" />
        <span className="k" aria-hidden="true">
          K
        </span>
      </button>
      <AccountMenu onOpenSettings={() => onSwitch("settings")} />
    </header>
  );
}

/** Repo switcher: custom dropdown so each known repo can carry its own remove (X) button,
 *  which a native <select> cannot render. */
function RepoSelect({
  value,
  includeAll,
  knownRepos,
  onSelect,
  onRemove,
}: {
  value: string;
  includeAll: boolean;
  knownRepos: string[];
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // Keyboard users need focus inside the menu the moment it opens; start on
    // the current selection so Enter re-confirms rather than surprises.
    const first = menu.current?.querySelector<HTMLElement>(".repo-opt.on .repo-opt-main") ?? menu.current?.querySelector<HTMLElement>(".repo-opt-main");
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const options = Array.from(menu.current?.querySelectorAll<HTMLElement>(".repo-opt-main") ?? []);
    if (options.length === 0) return;
    const at = options.findIndex((el) => el === document.activeElement || el.parentElement?.contains(document.activeElement));
    const next = e.key === "ArrowDown" ? (at + 1 + options.length) % options.length : (at - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  const all = value === ALL_REPOS;
  return (
    <div className="repo-select" ref={box}>
      <button
        type="button"
        ref={trigger}
        className="repo"
        aria-label="Repository"
        aria-haspopup="true"
        aria-expanded={open}
        title={all ? "All repos" : value}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dot" />
        <span className="repo-label">{all ? "All repos" : repoName(value)}</span>
        <span className="repo-caret" aria-hidden="true">
          <ChevronDown size={14} strokeWidth={1.5} />
        </span>
      </button>
      {open && (
        <div className="repo-menu" ref={menu} onKeyDown={onMenuKey}>
          {includeAll && (
            <div className={`repo-opt${all ? " on" : ""}`}>
              <button
                type="button"
                className="repo-opt-main"
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onSelect(ALL_REPOS);
                }}
              >
                <span className="repo-opt-name">All repos</span>
              </button>
            </div>
          )}
          {knownRepos.map((repo) => (
            <div key={repo} className={`repo-opt${repo === value ? " on" : ""}`}>
              <button
                type="button"
                className="repo-opt-main"
                title={repo}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onSelect(repo);
                }}
              >
                <span className="repo-opt-name">{repoName(repo)}</span>
                <span className="repo-opt-path">{repo}</span>
              </button>
              <button
                type="button"
                className="repo-opt-x"
                title={`Close ${repoName(repo)} — stops its session daemon (killing live sessions) and drops it from the list; repo files are untouched`}
                aria-label={`Close ${repoName(repo)}`}
                onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onRemove(repo);
                }}
              >
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type ContextAction = {
  key: string;
  label: string;
  title?: string;
  disabled?: boolean;
  busy?: boolean;
  tone?: "normal" | "warning" | "danger" | "ok";
  icon?: "warning";
  badge?: string | number;
  onClick: () => void;
};

export function ContextActionBar({ actions }: { actions: ContextAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="context-action-strip">
      {actions.map((action) => (
        <button
          type="button"
          key={action.key}
          className={`context-action-pill${action.tone && action.tone !== "normal" ? ` ${action.tone}` : ""}${action.busy ? " busy" : ""}`}
          disabled={action.disabled || action.busy}
          title={action.title}
          aria-label={action.title || action.label}
          onClick={action.onClick}
        >
          {action.icon === "warning" && <WarningGlyph />}
          <span>{action.label}</span>
          {action.badge !== undefined && <span className="context-action-badge">{action.badge}</span>}
        </button>
      ))}
    </div>
  );
}

function WarningGlyph() {
  return <TriangleAlert className="context-action-icon warning" aria-hidden="true" focusable="false" />;
}

function HandoffGlyph({ kind }: { kind: "inbound" | "outbound" | "open" }) {
  if (kind === "inbound") {
    return (
      <svg className="artifact-provenance-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.5 3.5h9v9h-9z" />
        <path d="M8 2.5v6.7" />
        <path d="M5.6 6.9 8 9.3l2.4-2.4" />
      </svg>
    );
  }
  if (kind === "outbound") {
    return (
      <svg className="artifact-provenance-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.5 6.5v6h9v-6" />
        <path d="M6.2 9.8 12 4" />
        <path d="M8.3 4H12v3.7" />
      </svg>
    );
  }
  return (
    <svg className="artifact-provenance-svg" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.7 11.3 11.6 4.4" />
      <path d="M7.4 4.4h4.2v4.2" />
    </svg>
  );
}

export function ArtifactProvenanceBadges({ handoffs, onOpenRelatedTask }: { handoffs?: ReviewHandoffRecord[]; onOpenRelatedTask?: (slug: string) => void }) {
  if (!handoffs || handoffs.length === 0) return null;
  return (
    <span className="artifact-provenance-badges">
      {handoffs.map((record, index) => {
        const inbound = record.direction === "inbound";
        const relatedTask = inbound ? record.source_task : record.target_task;
        const indicatorLabel = inbound ? `Incoming review from ${relatedTask}` : `Review sent to ${relatedTask}`;
        const openLabel = inbound ? `Open source review task ${relatedTask}` : `Open target task ${relatedTask}`;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: composite key of four record fields; index is only a tiebreaker for duplicate handoff records, which the backend does not forbid — dropping it would collide
            key={`${record.direction}:${record.source_task}:${record.target_task}:${record.target_artifact}:${index}`}
            className={`artifact-provenance-icons ${inbound ? "inbound" : "outbound"}`}
          >
            <span className="artifact-provenance-indicator" title={indicatorLabel} aria-label={indicatorLabel}>
              <HandoffGlyph kind={inbound ? "inbound" : "outbound"} />
            </span>
            <button
              type="button"
              className="artifact-provenance-open"
              title={openLabel}
              aria-label={openLabel}
              disabled={!relatedTask}
              onClick={(ev) => {
                ev.stopPropagation();
                if (relatedTask) onOpenRelatedTask?.(relatedTask);
              }}
            >
              <HandoffGlyph kind="open" />
            </button>
          </span>
        );
      })}
    </span>
  );
}

// Visible status vocabulary — DESIGN.md §Agent lifecycle canonical labels,
// compacted only where a row badge cannot carry the full phrase.
function obsLabel(kind: ObservationDisplayKind): string {
  switch (kind) {
    case "failed":
      return "Failed";
    case "stale":
      return "Stale";
    case "completed":
      return "Completed";
    case "ready_to_advance":
      return "Ready to advance";
    case "exited":
      return "Exited";
    case "loading":
      return "Loading";
    case "unsupported":
      return "Running";
    case "starting":
      return "Starting";
    case "waiting_for_input":
      return "Needs input";
    case "waiting_for_approval":
      return "Needs approval";
    case "busy":
      return "Running";
    case "idle":
      return "Idle";
    case "unknown":
      return "Unknown";
  }
}

function obsTooltip(kind: ObservationDisplayKind): string {
  switch (kind) {
    case "failed":
      return "Playbook failed";
    case "stale":
      return "A newer session owns completion for this phase";
    case "completed":
      return "Phase completed — checkpoint accepted";
    case "ready_to_advance":
      return "Phase completed — ready to advance to the next step";
    case "exited":
      return "Session is not live in the current daemon";
    case "loading":
      return "Waiting for the first semantic adapter event";
    case "unsupported":
      return "Harness has no semantic adapter — process lifecycle only";
    case "starting":
      return "Process is starting";
    case "waiting_for_input":
      return "Agent is waiting for human input (ask)";
    case "waiting_for_approval":
      return "Agent is waiting for tool-call approval";
    case "busy":
      return "Agent is processing — in progress";
    case "idle":
      return "Agent turn complete — idle";
    case "unknown":
      return "Agent state unknown";
  }
}

// Attention reason to pass to notify_session_attention, or null if no notification.
// Unsupported/unknown never notify.
function attentionReason(kind: ObservationDisplayKind): "idle" | "waiting_for_input" | "waiting_for_approval" | null {
  if (kind === "idle") return "idle";
  if (kind === "waiting_for_input") return "waiting_for_input";
  if (kind === "waiting_for_approval") return "waiting_for_approval";
  return null;
}

// Whether this kind should suppress the dot in minimal mode (only show for notable states).
function obsMinimalHide(kind: ObservationDisplayKind): boolean {
  return kind === "exited" || kind === "unknown";
}

export function StatusDot({
  id,
  slug,
  repoPath,
  minimal,
  observation,
  superseded = false,
  unreadCompletion = false,
  exitCode = null,
  exitAcknowledged = false,
  notifyTransitions = true,
}: {
  id: string;
  slug?: string;
  repoPath?: string;
  minimal?: boolean;
  // When provided by a parent that already polls, the dot is fully controlled.
  // When absent, the dot polls session_status itself.
  observation?: SessionObservation | null;
  superseded?: boolean;
  unreadCompletion?: boolean;
  exitCode?: number | null;
  exitAcknowledged?: boolean;
  notifyTransitions?: boolean;
}) {
  const pollKey = `${slug ?? ""}\u0000${id}`;
  const [polledObs, setPolledObs] = useState<{ key: string; observation: SessionObservation } | null>(null);
  const prevKind = useRef<{ key: string; kind: ObservationDisplayKind } | null>(null);
  const controlled = observation !== undefined;

  // Self-polling path: used by standalone dots that don't have a parent batcher.
  useEffect(() => {
    if (controlled) return;
    let alive = true;
    const tick = () =>
      ipc
        .sessionStatus(id, slug ?? null)
        .then((obs) => {
          if (alive) setPolledObs({ key: pollKey, observation: obs });
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, slug, controlled, pollKey]);

  // A SessionView can retain this component while navigating between session ids.
  // Never render the previous session's observation during the first poll for the new id.
  const currentPolledObs = polledObs?.key === pollKey ? polledObs.observation : null;
  const obs = observation ?? currentPolledObs;
  const observedKind: ObservationDisplayKind = obs ? observationDisplayKind(obs) : "loading";
  const acknowledgedTerminalExit = exitAcknowledged && (!obs?.state || obs.state.process.state === "exited");
  const kind: ObservationDisplayKind = acknowledgedTerminalExit ? "exited" : superseded && (observedKind === "idle" || observedKind === "exited") ? "stale" : observedKind;
  const label = obsLabel(kind);
  const title = obsTooltip(kind);

  // Attention notifications: fire on transitions into idle/waiting states.
  // Never notify for unsupported/unknown; artifact presence never triggers.
  useEffect(() => {
    const prev = prevKind.current?.key === pollKey ? prevKind.current.kind : null;
    prevKind.current = { key: pollKey, kind: observedKind };
    if (!notifyTransitions || !slug || !repoPath || prev === null || prev === observedKind) return;
    const wasBusy = prev === "busy";
    const reason = attentionReason(observedKind);
    if (wasBusy && reason !== null) {
      ipc.notifySessionAttention(repoPath, slug, reason).catch(() => {});
    }
  }, [observedKind, notifyTransitions, pollKey, repoPath, slug]);

  if (!exitAcknowledged && exitCode != null && exitCode !== 0 && kind !== "busy" && kind !== "starting" && kind !== "waiting_for_input" && kind !== "waiting_for_approval") {
    return (
      <span
        className="statusdot statusdot-badge statusdot-failed"
        title={`Process exited with code ${exitCode}`}
        role="img"
        aria-label={`Failed: process exited with code ${exitCode}`}
      >
        <StateIcon state="failed" />
      </span>
    );
  }

  if (unreadCompletion && kind !== "busy" && kind !== "starting" && kind !== "waiting_for_input" && kind !== "waiting_for_approval" && kind !== "failed") {
    return (
      <span className="statusdot" title="Completed — not yet opened">
        <span className="ind-wrap" role="img" aria-label="Unread completion">
          <IdleDot />
        </span>
        Completed
      </span>
    );
  }

  if (kind === "busy" || kind === "starting" || kind === "loading") {
    // When minimal mode suppresses the visible label, the accessible name keeps
    // the state text-readable (state never lives in motion alone). All three
    // kinds share the one activity orb; only its rate differs, because `busy`
    // is work actually moving while starting and loading are still warming up.
    // The visible label ("Running", "Starting", "Loading") carries the state.
    return (
      <span className="statusdot running" title={title} aria-label={minimal ? label : undefined}>
        <span className="ind-wrap">
          <RunningIndicator running={kind === "busy"} />
        </span>
        {minimal ? null : label}
      </span>
    );
  }

  // Compact badges for waits and failures.
  if (kind === "waiting_for_input" || kind === "waiting_for_approval" || kind === "failed" || kind === "unknown") {
    return (
      <span className={`statusdot statusdot-badge statusdot-${kind}`} title={title}>
        <StateIcon state={kind} />
        {label}
      </span>
    );
  }

  // Quiet dot states: stale, idle, completed, ready_to_advance, exited.
  if (minimal && obsMinimalHide(kind)) return null;
  const color = kind === "idle" || kind === "completed" || kind === "ready_to_advance" || kind === "unsupported" ? "var(--success)" : "var(--text-faint)";
  const showLabel = !(minimal && kind !== "completed" && kind !== "ready_to_advance");
  return (
    <span className="statusdot" title={title} aria-label={showLabel ? undefined : label}>
      <span className="d" style={{ background: color }} />
      {showLabel ? label : null}
    </span>
  );
}

// A per-session [Kill] affordance for rows the running daemon still owns (live process).
// Gated on lifecycle.state === "live" — agent idle/waiting/completed never blocks kill.
// A parent that already batches status may provide `live`; standalone uses retain their poller.
// `repoPath` makes the kill repository-explicit; omitting it (the drawer's root session, which
// has no per-repo identity) falls back to the active-repo command — same idiom as
// listHarnessModelsForRepo below.
export function KillButton({
  id,
  slug,
  repoPath,
  onKilled,
  live,
  danger = false,
}: {
  id: string;
  slug?: string;
  repoPath?: string;
  onKilled?: () => void;
  live?: boolean;
  danger?: boolean;
}) {
  const [polledLive, setPolledLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const controlled = live !== undefined;
  useEffect(() => {
    if (controlled) return;
    let alive = true;
    const tick = () =>
      ipc
        .sessionStatus(id, slug ?? null)
        .then((obs) => {
          if (alive) setPolledLive(obs.lifecycle.state === "live");
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, slug, controlled]);
  if (!(live ?? polledLive)) return null;
  return (
    <button
      type="button"
      className={danger ? "btn danger small" : "btn ghost small"}
      disabled={busy}
      title="Terminate this session's harness (and its child processes) now"
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        (repoPath ? ipc.killSessionForRepo(repoPath, id, slug ?? "") : ipc.killSession(id, slug ?? ""))
          .then(() => {
            toast("Session killed", "success");
            onKilled?.();
          })
          .catch((err) => toast(String(err), "error"))
          .finally(() => setBusy(false));
      }}
    >
      Kill
    </button>
  );
}

export function useBoardTaskActivity(tasks: BoardTask[], active = true) {
  const [activity, setActivity] = useState<TaskActivityMap>({});
  const taskSignature = tasks.map(taskKey).sort().join("\u0000");

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: number | undefined;
    const refs: TaskActivityRef[] = tasks.map((task) => ({
      repoPath: task.repo_path,
      taskSlug: task.slug,
    }));
    const load = async () => {
      try {
        const next = refs.length ? await ipc.listTaskActivity(refs) : {};
        if (alive) setActivity((current) => (sameTaskActivityMaps(current, next) ? current : next));
      } catch {
        if (alive) setActivity((current) => (sameTaskActivityMaps(current, {}) ? current : {}));
      } finally {
        if (alive) timer = window.setTimeout(load, 3000);
      }
    };

    void load();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, taskSignature]);

  return activity;
}

export const EMPTY_TASK_ACTIVITY: TaskActivitySummary = {
  status: null,
  active_session: null,
};

export function TaskActivityIndicators({ activity }: { activity: TaskActivitySummary }) {
  let indicator: ReactNode;
  switch (activity.status) {
    case "running":
      indicator = (
        <span className="ind-wrap task-state-indicator task-status-icon" title="Highest-priority session is running" role="img" aria-label="Running">
          <RunningIndicator />
        </span>
      );
      break;
    case "waiting_for_input":
      indicator = (
        <span
          className="task-state-indicator task-status-icon statusdot-badge statusdot-waiting_for_input"
          title="Highest-priority session is waiting for user input"
          role="img"
          aria-label="Needs input"
        >
          <StateIcon state="waiting_for_input" />
        </span>
      );
      break;
    case "waiting_for_approval":
      indicator = (
        <span
          className="task-state-indicator task-status-icon statusdot-badge statusdot-waiting_for_approval"
          title="Highest-priority session is waiting for user approval"
          role="img"
          aria-label="Needs approval"
        >
          <StateIcon state="waiting_for_approval" />
        </span>
      );
      break;
    case "failed":
      indicator = (
        <span className="task-state-indicator task-status-icon statusdot-badge statusdot-failed" title="Highest-priority session failed" role="img" aria-label="Failed">
          <StateIcon state="failed" />
        </span>
      );
      break;
    case "completed":
      indicator = (
        <span
          className="task-state-indicator task-status-icon statusdot-badge statusdot-completed"
          title="Highest-priority session completed and has not been opened"
          role="img"
          aria-label="Completed"
        >
          <IdleDot />
        </span>
      );
      break;
    default:
      return null;
  }
  return <span className="task-activity-indicators">{indicator}</span>;
}

export function RepoPicker({
  appConfig,
  error,
  onSelect,
  onRemove,
  onAdd,
}: {
  appConfig: AppConfig;
  error: string;
  onSelect: (path: string) => void;
  onRemove: (path: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="picker">
      <div className="picker-mark" aria-hidden="true">
        <FolderOpen size={22} strokeWidth={1.7} />
      </div>
      <p className="picker-eyebrow">Welcome to Alinery</p>
      <h2>Bring a repository into focus</h2>
      <p className="picker-lede">Choose a local Git repository to organize tasks, sessions, and project context in one place.</p>
      {appConfig.known_repos.length > 0 && (
        <div className="picker-repos">
          <p className="picker-label">Your repositories</p>
          <div className="picker-repo-list">
            {appConfig.known_repos.map((repo) => (
              <div key={repo} className="repobtn-row">
                <button type="button" className="repobtn" title={repo} onClick={() => onSelect(repo)}>
                  <span className="repobtn-copy">
                    <strong>{repoName(repo)}</strong>
                    <span>{repo}</span>
                  </span>
                  <ArrowRight size={16} strokeWidth={1.6} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="repobtn-x"
                  title={`Remove ${repoName(repo)} from Alinery (repo files are untouched)`}
                  aria-label={`Remove ${repoName(repo)}`}
                  onClick={() => onRemove(repo)}
                >
                  <X size={16} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <button type="button" className="btn picker-action" onClick={onAdd}>
        <FolderPlus size={16} strokeWidth={1.6} aria-hidden="true" />
        Add a repository
      </button>
      <p className="picker-footnote">Your repository stays on this Mac. Alinery only adds it to your workspace.</p>
      {error && (
        <InlineStatus tone="error" detail={error}>
          Couldn't open the repository. Pick another, or add one below.
        </InlineStatus>
      )}
    </div>
  );
}

const rememberedModelKey = (harness: string, repoPath?: string) => (repoPath ? `alinery.lastmodel.${repoPath}:${harness}` : `alinery.lastmodel.${harness}`);

export function ModelInput({
  harness,
  value,
  onChange,
  onCommit,
  style,
  repoPath,
  prefillRemembered = true,
  onOpenPicker,
  ariaLabel = "Model",
}: {
  harness: string;
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  style?: CSSProperties;
  repoPath?: string;
  prefillRemembered?: boolean;
  ariaLabel?: string;
  /**
   * Host the providers/models dialog instead of this component's own picker.
   *
   * Model picking now lives in one place across the app, and it is the surface that also knows
   * about accounts -- so a model you cannot reach because you are not signed in tells you so.
   * `shared` cannot import it directly (that would cycle through `views`), so the page opens it
   * and this becomes a plain trigger.
   */
  onOpenPicker?: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [pendingFavorites, setPendingFavorites] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLUListElement>(null);
  const favoriteContextRef = useRef(0);
  const favoriteReadRequestRef = useRef(0);
  const discoveryRequestRef = useRef(0);
  const favoritesReadyRef = useRef(false);
  const waitingDiscoveryRef = useRef<number | null>(null);
  const lastKey = rememberedModelKey(harness, repoPath);

  // Prefill from the last model remembered for this provider, if the field is empty.
  useEffect(() => {
    if (prefillRemembered && !value) {
      const last = harness && localStorage.getItem(lastKey);
      if (last) onChange(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harness, repoPath, prefillRemembered]);

  useEffect(() => {
    const context = ++favoriteContextRef.current;
    const request = ++favoriteReadRequestRef.current;
    favoritesReadyRef.current = !harness.trim();
    waitingDiscoveryRef.current = null;
    setFavorites([]);
    setPendingFavorites(new Set());

    const finish = (next?: string[]) => {
      if (favoriteContextRef.current !== context) return;
      if (favoriteReadRequestRef.current === request && next) setFavorites(next);
      favoritesReadyRef.current = true;
      if (waitingDiscoveryRef.current === discoveryRequestRef.current) {
        waitingDiscoveryRef.current = null;
        setPickerOpen(true);
        setBusy(false);
      }
    };

    if (harness.trim()) {
      ipc
        .readModelFavorites(harness)
        .then(finish)
        .catch(() => finish());
    }

    return () => {
      if (favoriteContextRef.current === context) favoriteContextRef.current++;
      if (favoriteReadRequestRef.current === request) favoriteReadRequestRef.current++;
    };
  }, [harness]);

  useEffect(() => {
    const request = ++discoveryRequestRef.current;
    setModels([]);
    setPickerOpen(false);
    setBusy(false);
    waitingDiscoveryRef.current = null;

    return () => {
      if (discoveryRequestRef.current === request) discoveryRequestRef.current++;
    };
  }, [harness, repoPath]);

  useEffect(() => {
    if (pickerOpen) {
      setQ("");
      setIdx(0);
      const t = setTimeout(() => searchRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
  }, [pickerOpen]);

  const refresh = () => {
    if (!harness) {
      setModels([]);
      setPickerOpen(false);
      return;
    }
    const request = ++discoveryRequestRef.current;
    waitingDiscoveryRef.current = null;
    setBusy(true);
    // Was a runtime-selected command name plus a matching payload shape. Neither the
    // command nor its arguments were reachable by any static check that way.
    (repoPath ? ipc.listHarnessModelsForRepo(repoPath, harness) : ipc.listHarnessModels(harness))
      .then((next) => {
        if (discoveryRequestRef.current !== request) return;
        setModels(next);
        if (next.length && favoritesReadyRef.current) {
          setPickerOpen(true);
          setBusy(false);
        } else if (next.length) {
          waitingDiscoveryRef.current = request;
        } else {
          setPickerOpen(false);
          setBusy(false);
          toast("No models found");
        }
      })
      .catch(() => {
        if (discoveryRequestRef.current !== request) return;
        waitingDiscoveryRef.current = null;
        setModels([]);
        setPickerOpen(false);
        setBusy(false);
      });
  };

  const pick = (model: string) => {
    onChange(model);
    if (harness) localStorage.setItem(lastKey, model);
    setPickerOpen(false);
    onCommit?.(model);
  };

  const toggleFavorite = (model: string, favorite: boolean) => {
    if (!harness.trim() || !model.trim() || pendingFavorites.has(model)) return;
    const context = favoriteContextRef.current;
    favoriteReadRequestRef.current++;
    setPendingFavorites((pending) => new Set(pending).add(model));
    ipc
      .setModelFavorite(harness, model, !favorite)
      .then((next) => {
        if (favoriteContextRef.current === context) setFavorites(next);
      })
      .catch((error) => {
        if (favoriteContextRef.current === context) {
          toast.error(`Couldn't ${favorite ? "remove" : "add"} favorite ${model}: ${String(error)}`);
        }
      })
      .finally(() => {
        if (favoriteContextRef.current !== context) return;
        setPendingFavorites((pending) => {
          const next = new Set(pending);
          next.delete(model);
          return next;
        });
      });
  };

  const visible = deriveModelRows(models, favorites, q);
  const sel = Math.min(idx, Math.max(0, visible.length - 1));
  const occurrenceByModel = new Map<string, number>();

  return (
    <div className="model-input" style={style}>
      <input
        className="field-input"
        aria-label={ariaLabel}
        value={value}
        placeholder="Model (empty = harness default)"
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit?.(value)}
      />
      <button
        type="button"
        className="btn ghost small"
        title={onOpenPicker ? "Browse models" : "Refresh model list"}
        aria-label={onOpenPicker ? "Browse models" : "Refresh model list"}
        disabled={busy}
        onClick={onOpenPicker ?? refresh}
      >
        {busy ? "…" : <RotateCw size={14} strokeWidth={1.5} aria-hidden="true" />}
      </button>
      {!onOpenPicker && pickerOpen && (
        <Dialog onClose={() => setPickerOpen(false)} ariaLabel={`Select model — ${harness}`}>
          <div className="mh">
            <span className="mt">Select model — {harness}</span>
            <button type="button" className="x" aria-label="Close" title="Close" onClick={() => setPickerOpen(false)}>
              <X size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>
          <div className="mb">
            <input
              ref={searchRef}
              className="field-input"
              aria-label="Filter models"
              value={q}
              placeholder="Filter models…"
              autoComplete="off"
              data-autofocus=""
              style={{ marginBottom: 8 }}
              onChange={(e) => {
                setQ(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                const moveTo = (next: number) => {
                  setIdx(next);
                  modelListRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
                };
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  moveTo(Math.min(sel + 1, visible.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  moveTo(Math.max(sel - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (visible[sel]) pick(visible[sel].model);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setPickerOpen(false);
                }
              }}
            />
            <ul className="list" aria-label="Models" ref={modelListRef} style={{ maxHeight: "50vh", overflowY: "auto" }}>
              {visible.length === 0 && <li className="row disabled">No matching models</li>}
              {visible.map((row, i) => {
                const action = row.favorite ? "Remove" : "Add";
                const label = `${action} ${row.model} ${row.favorite ? "from" : "to"} favorites`;
                const occurrence = occurrenceByModel.get(row.model) ?? 0;
                occurrenceByModel.set(row.model, occurrence + 1);
                return (
                  <li key={JSON.stringify([row.model, occurrence])} className={`row${i === sel ? " sel" : ""}`} onMouseEnter={() => setIdx(i)}>
                    <button type="button" className="model-selection-button" aria-label={`Select ${row.model}`} onClick={() => pick(row.model)}>
                      <div className="rt">
                        <div className="rtt">{row.model}</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="model-favorite-button"
                      title={label}
                      aria-label={label}
                      aria-pressed={row.favorite}
                      disabled={!harness.trim() || !row.model.trim() || pendingFavorites.has(row.model)}
                      onClick={() => toggleFavorite(row.model, row.favorite)}
                    >
                      {row.favorite ? "★" : "☆"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function ArchiveTaskModal({
  task,
  onCancel,
  onConfirm,
}: {
  task: { slug: string; name: string; has_worktree: boolean } | null;
  onCancel: () => void;
  onConfirm: (removeWorktree: boolean, onPhase: (phase: ArchiveTaskPhase) => void) => Promise<void>;
}) {
  const [removeWt, setRemoveWt] = useState(false);
  const [phase, setPhase] = useState<ArchiveTaskPhase | null>(null);
  const pending = useRef(false);
  const cancel = () => {
    if (!pending.current) onCancel();
  };
  const confirmArchive = async () => {
    if (pending.current) return;
    pending.current = true;
    setPhase("archiving");
    try {
      await onConfirm(removeWt, setPhase);
    } finally {
      pending.current = false;
      setPhase(null);
    }
  };
  useEffect(() => setRemoveWt(false), [task?.slug]);
  const progressLabel = phase === "archiving" ? "Archiving…" : phase === "removing-worktree" ? "Removing worktree…" : "";
  if (!task) return null;
  return (
    <Dialog onClose={cancel} role="alertdialog" ariaLabel="Archive task">
      <div className="mh">
        <span className="mt">Archive task</span>
        <button type="button" className="x" aria-label="Close" title="Close" disabled={phase !== null} onClick={cancel}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb">
        <p>Archive "{task.name}"? It becomes read-only — no new sessions, no commits, no push.</p>
        {task.has_worktree && (
          <div>
            <Checkbox checked={removeWt} onChange={setRemoveWt} disabled={phase !== null} label="Also permanently remove the worktree (uncommitted changes are lost)" />
            {removeWt && (
              <p className="dim">
                Restoring later keeps this task available for history and related-task links, but it does not recreate the worktree. New sessions, commits, and pushes remain
                unavailable; create a new task and tag this one as related to continue the work.
              </p>
            )}
          </div>
        )}
      </div>
      <div className="sr-only" role="status">
        {progressLabel}
      </div>
      <div className="mfoot">
        <button type="button" className="btn danger small" disabled={phase !== null} onClick={() => void confirmArchive()}>
          {progressLabel || "Archive task"}
        </button>
        {/* Safe default focus: Enter must never archive (same contract as confirm-focus.ts). */}
        <button type="button" className="btn ghost small" data-autofocus="" disabled={phase !== null} onClick={cancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
