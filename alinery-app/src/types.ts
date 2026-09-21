/** "system" follows the macOS appearance; explicit choices override it. */
export type AppearanceMode = "system" | "light" | "dark";
/** Journal spacing. Absent / unknown → normal. */
export type ChatRailDensity = "dense" | "normal" | "comfortable";
/** Centered Chat column max width. Absent → "900". */
export type ChatMaxWidth = "600" | "900" | "1200" | "none";
/** Preferred OMP hatch when starting a session. Absent → "chat". */
export type SessionDefaultView = "chat" | "terminal";
export type AppearancePrefs = {
  accent_color: string;
  ui_scale: number;
  terminal_font_size: number;
  artifact_font_size: number;
  /** Last drag-resized artifact pane width in px. Absent in older configs. */
  artifact_viewer_width?: number;
  /** Experimental composer visibility; absent in older configs. */
  /** Preferred composer content height in px; absent in older configs. */
  /** Chat journal: show thinking rails. Absent → false. */
  chat_show_thinking?: boolean;
  /** Chat journal: expand thinking by default. Absent → false. Live stream still opens. */
  chat_expand_thinking?: boolean;
  /** Chat journal: show tool call/result rails. Absent → false. */
  chat_show_tools?: boolean;
  /** Chat journal: expand tools by default. Absent → false. */
  chat_expand_tools?: boolean;
  /** Chat journal: harness notices. Absent → true. */
  chat_show_harness?: boolean;
  /** Chat journal: turn markers. Absent → false. */
  chat_show_turn_markers?: boolean;
  /** Chat journal: subagent_status / subagent-actor rows. Absent → true. */
  chat_show_subagent_rows?: boolean;
  /** Chat: live subagent drawer above the journal. Absent → true. */
  chat_show_subagent_drawer?: boolean;
  /** Collapse thinking when streaming ends unless expand-by-default is on. Absent → true. */
  chat_auto_collapse_thinking?: boolean;
  /** Push set_auto_compaction to OMP. Absent → true. */
  chat_auto_compaction?: boolean;
  /** Stick scroll to bottom on new entries. Absent → true. */
  chat_auto_scroll?: boolean;
  /** Rail / journal spacing. Absent → normal. */
  chat_rail_density?: ChatRailDensity;
  /** Chat body type size in px. Absent → 14. */
  chat_font_size?: number;
  /** Thinking / tool rail label size in px. Absent → 12. */
  chat_rail_font_size?: number;
  /** Session meta strip above the journal. Absent → true. */
  chat_show_meta?: boolean;
  /** Composer key-hint chips (stats stay). Absent → true. */
  chat_show_composer_hints?: boolean;
  /** Centered Chat column max width. Absent → "900". */
  chat_max_width?: ChatMaxWidth;
  /** Journal stamps: calendar date (e.g. Sep 5). Absent → true. */
  chat_show_date?: boolean;
  /** Journal stamps: clock time (e.g. 12:11). Absent → true. */
  chat_show_time?: boolean;
  /** You / Agent name + kind icon above message bubbles. Absent → true. */
  chat_show_actor_labels?: boolean;
  /** Filled bubble around agent text replies only. Absent → true. */
  chat_show_agent_bubbles?: boolean;
  /** Per-message copy icon inside chat bubbles. Absent → true. */
  chat_show_copy_buttons?: boolean;
  /** Preferred OMP session hatch (Chat vs Terminal) for new starts. Absent → "chat". */
  session_default_view?: SessionDefaultView;
  /** Absent in pre-reskin configs; normalizers default it to "system". */
  mode?: AppearanceMode;
};

// Mirrors the Rust structs.
export type RelatedTaskRef = { repo_path: string; slug: string; name: string };
export type Task = {
  name: string;
  slug: string;
  requested_slug?: string;
  parent_task?: string;
  active_subtask?: string;
  subtask_outcome?: "" | "killed" | "finished" | "merged";
  branch: string;
  worktree: string;
  has_worktree: boolean;
  created: number;
  archived: boolean;
  pr_url: string;
  linear_id: string;
  github_issue: string;
  playbook: string;
  auto_advance: string[];
  /** M6: true while still being drafted on CreateTaskPage. */
  draft: boolean;
  related_tasks?: RelatedTaskRef[];
};
export type BoardTask = Task & {
  repo_path: string;
  session_count: number;
  playbook_title: string;
  updated: number;
  current_phase: string;
  current_step_title: string;
  latest_session_title: string;
  latest_session_column_key: string;
  current_column_key: string;
  current_column_title: string;
  artifact_count: number;
  /** Live sessions, newest first. */
  sessions: BoardSession[];
};
/**
 * Durable session lifecycle as a card shows it (mirrors Rust `BoardSessionState`). Derived from
 * the meta, never from a live daemon: `running` means "launched and never stamped an end", which
 * a daemon boot sweep turns into `interrupted` if it actually crashed. Live/idle/waiting is the
 * separate `TaskActivityStatus` channel.
 */
export type BoardSessionState = "not_started" | "running" | "interrupted" | "exited" | "failed";
export type BoardSession = { id: string; title: string; harness: string; state: BoardSessionState; exit_code: number | null };
export type TaskActivityRef = { repoPath: string; taskSlug: string };
export type TaskActivitySession = {
  id: string;
  worktree: string;
  phase: string;
  harness: string;
  model: string;
  playbook: string;
  generic: boolean;
  step_title: string;
};
export type TaskActivityStatus = "running" | "waiting_for_input" | "waiting_for_approval" | "failed" | "completed";
export type TaskActivitySummary = {
  status: TaskActivityStatus | null;
  active_session: TaskActivitySession | null;
};
export type TaskActivityMap = Record<string, TaskActivitySummary>;
export type DraftOrigin = { repoPath: string; slug: string };
export type TargetedCreateResult = { repoPath: string; task: Task; session: SessionMeta; attachment_errors?: string[] };
export type NotificationPrefs = {
  enabled: boolean;
  sound: boolean;
  bounce: boolean;
  banner: boolean;
  dock_badge: boolean;
  dock_badge_input_waits: boolean;
  dock_badge_approval_waits: boolean;
  dock_badge_failures: boolean;
  dock_badge_completions: boolean;
};
export type NotificationSuppressionKind = "waiting_for_input" | "waiting_for_approval" | "failure";
export type NotificationSuppression = {
  notice: NotificationSuppressionKind;
  occurrence: string;
};
export type SessionNotificationClearRef = {
  repo_path: string;
  task_slug: string;
  id: string;
  notification_suppression?: NotificationSuppression | null;
};
export type HarnessChoice = { harness: string; model: string; playbook: string; draft_autosave: boolean };
export type RepoHarnessChoiceOverrides = {
  harness?: string | null;
  model?: string | null;
  playbook?: string | null;
  draft_autosave?: boolean | null;
};
export type BackupDefaults = {
  destination: string;
  enabled: boolean;
  retention: number;
  trigger_pre_archive: boolean;
  trigger_post_artifact_change: boolean;
  trigger_post_push_commit: boolean;
};
export type RepoBackupOverrides = {
  destination?: string | null;
  enabled?: boolean | null;
  retention?: number | null;
  trigger_pre_archive?: boolean | null;
  trigger_post_artifact_change?: boolean | null;
  trigger_post_push_commit?: boolean | null;
};
export type BackupTrigger = "manual" | "pre_archive" | "post_artifact_change" | "post_push_commit" | "mcp";
export type BackupMeta = {
  repo_name: string;
  repo_path: string;
  created_at: number;
  schema_version: number;
  alinery_version: string;
  trigger: BackupTrigger;
  included_dirs: string[];
};
export type BackupListItem = {
  id: string;
  path: string;
  created_at: number;
  trigger: string;
  size_bytes: number;
  alinery_version: string;
};
export type TelemetryPrefs = { enabled: boolean; prompted: boolean; install_id: string; endpoint: string };
export type UpdatePrefs = { check_enabled: boolean };
export type ExperimentalFeatures = {
  /** Classic Kanban tab (⌘3). Absent = enabled; false hides the tab. */
  show_original_kanban?: boolean;
};
export type GridViewDefinition = { id: string; name: string; slot: number };
export type UpdateRelease = { version: string; url: string; sha256: string; size: number; protocol_version: number; published_at: string };
export type UpdateStatus = { current: string; available: UpdateRelease | null; checked_at: number };
export type OmpRelease = { version: string; asset_url: string };
export type OmpUpdateStatus = { installed: string; available: OmpRelease | null; checked_at: number; binary_path: string; config_dir: string };
export type StagedUpdate = { version: string; app_path: string; scratch_dir: string };
export type GlobalSettings = {
  notifications: NotificationPrefs;
  github: { token: string };
  defaults: HarnessChoice;
  backup: BackupDefaults;
  harnesses: HarnessFile;
  model_favorites: Record<string, string[]>;
  telemetry: TelemetryPrefs;
  updates: UpdatePrefs;
  /** Optional for app configs written before experiments existed. */
  experiments?: ExperimentalFeatures;
  /** Optional for app configs written before named Grid-based views existed. */
  grid_views?: GridViewDefinition[];
};
export type RepoOverrides = {
  github: { token?: string | null };
  defaults: RepoHarnessChoiceOverrides;
  backup: RepoBackupOverrides;
};
export type ConnectionStatus = {
  provider: "github" | "linear";
  name: string;
  kind: string;
  connected: boolean;
  reconnect: boolean;
  available: boolean;
  /** Does this app hold a credential of its own that it can delete? Connected is not enough. */
  removable: boolean;
  account: string;
  detail: string;
};
/** account.rs — never carries access_token / refresh_token; the frontend never sees those. */
export type AccountStatus = {
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Entitlement id `founders` | `teams` (legacy plan labels still count). */
  paid: boolean;
  unavailable: boolean;
};
export type AccountSignOutResult = AccountStatus & { remoteRevoked: boolean };
/** account.rs / hosted.rs — GET /api/desktop/credits. Display only. */
export type DesktopCreditsView = {
  visible: boolean;
  signedOut: boolean;
  plan: string | null;
  paid: boolean;
  balanceCents: number | null;
  cutoff: boolean;
  upsell: "subscribe" | "buy-credits" | string | null;
  accountUrl: string | null;
  plansUrl: string | null;
};
/** hosted.rs — catalog for Providers/Models. Never includes `inf_…`. */
export type HostedModel = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /** UI cost band 0–5. Absent or out of range → hide the band, still list the model. */
  price?: number | null;
};
export type HostedCatalogView = {
  provider: string;
  defaultModel: string;
  baseUrl: string;
  plansUrl: string;
  models: HostedModel[];
  ready: boolean;
  upsell: "sign-in" | "subscribe" | "buy-credits" | string | null;
  source: string;
  /** Spendable USD cents when credits are visible. Absent when CREDITS_ENABLED is off. */
  balanceCents?: number | null;
};
export type SettingSource = "global" | "repository";
export type ChoiceProvenance = {
  harness: SettingSource;
  model: SettingSource;
  playbook: SettingSource;
  draft_autosave: SettingSource;
};
export type Config = {
  notifications: NotificationPrefs;
  github: { token: string };
  defaults: HarnessChoice;
  provenance: {
    github_token: SettingSource;
    defaults: ChoiceProvenance;
  };
  backup: BackupDefaults;
  telemetry: TelemetryPrefs;
};
export type ScopedSettings = { global: GlobalSettings; overrides: RepoOverrides; effective: Config };
export type HarnessResume = { enabled: boolean; id_source: string; launch_args: string[]; resume_args: string[] };
export type Harness = {
  key: string;
  name: string;
  binary: string;
  args: string[];
  model_arg: string[];
  prompt_arg: string[];
  env: Record<string, string>;
  prompt_injection: string;
  adapter: HarnessAdapter;
  message_adapter: MessageAdapter;
  models: string[];
  models_cmd: string;
  resume?: HarnessResume | null;
};
export type EffectiveHarness = Harness & { source: SettingSource };
export type HarnessFile = { harness: Harness[] };
export type AppConfig = {
  active_repo: string;
  known_repos: string[];
  mcp_enabled: boolean;
  appearance: AppearancePrefs;
  settings_version?: number;
  global?: GlobalSettings;
};
export type StorageInfo = {
  app_config_path: string;
  repo_path: string;
  alinery_dir: string;
  repo_config_path: string;
  harnesses_path: string;
  tasks_dir: string;
  worktrees_dir: string;
  alineryd_socket_path: string;
  alineryd_lock_path: string;
  mcp_socket_path: string;
  mcp_status_path: string;
  archived_task_count: number;
  archived_session_count: number;
  archived_bytes: number;
  active_bytes: number;
};
export type PurgeFailure = { target: string; error: string };
export type PurgeArchivedResult = {
  deleted_tasks: number;
  deleted_sessions: number;
  deleted_worktrees: number;
  errors: PurgeFailure[];
};
export type SessionMeta = {
  id: string;
  worktree: string;
  created: number;
  archived: boolean;
  phase: string;
  harness: string;
  model: string;
  playbook: string;
  generic: boolean;
  subtask_manager?: boolean;
  subtask_slug?: string;
  artifact?: string;
  handoff_artifact?: string;
  prompt_extra?: string;
  prompt?: string | null;
  // ---- session durability & resume (issue #24) ----
  started_at?: number | null;
  status_changed_at?: number | null;
  status_revision?: number;
  ended_at?: number | null;
  exit_code?: number | null;
  harness_resume_token: string;
  resume_of?: string | null;
  notification_read_at?: number | null;
  exit_notification_read_at?: number | null;
  notification_suppression?: NotificationSuppression | null;
  // ---- semantic checkpoint (daemon-owned, meta-persisted, Step 4) ----
  semantic?: SemanticCheckpoint | null;
};
export type TaskSummary = Pick<Task, "name" | "slug" | "branch" | "worktree" | "has_worktree" | "playbook" | "archived" | "draft" | "subtask_outcome">;
export type TaskRelationships = {
  parent_task: TaskSummary | null;
  active_subtask: TaskSummary | null;
};
export type SubtaskManagerState = {
  task: TaskSummary;
  parent_task: TaskSummary | null;
  active_subtask: TaskSummary | null;
  parent_manager_session: SessionMeta | null;
  parent_manager_owner_task_slug: string;
  manager_session: SessionMeta | null;
  manager_owner_task_slug: string;
  can_start: boolean;
  can_recover: boolean;
  disabled_reason: string;
};
export type TaskPanelRow =
  | { kind: "session"; session: SessionMeta }
  | { kind: "subtask_manager"; session: SessionMeta; owner_task_slug: string; child?: TaskSummary; active_child: boolean }
  | { kind: "subtask_history"; child: TaskSummary };
export type CreateSubtaskInput = {
  manager_session_id: string;
  name: string;
  slug: string;
  playbook: string;
  instructions: string;
};
export type CreateSubtaskResult = {
  parent_task: TaskSummary;
  child_task: TaskSummary;
  manager_session: SessionMeta;
};
export type SubtaskGitState = {
  parent_worktree_exists: boolean;
  child_worktree_exists: boolean;
  parent_worktree_clean: boolean;
  child_worktree_clean: boolean;
  child_only_commits: number;
  child_head_contained: boolean;
};
export type SubtaskArtifactState = {
  has_artifacts: boolean;
  snapshot_exists: boolean;
  snapshot_reusable: boolean;
  snapshot_path: string;
};
export type FinalizeMode = "artifacts_only" | "integrated_code" | "archive_without_code";
export type FinishInspection = {
  child_task: TaskSummary;
  code_state: SubtaskGitState;
  artifact_state: SubtaskArtifactState;
  observed_live_parent_sessions: string[];
  allowed_modes: FinalizeMode[];
  blockers: Record<string, string[]>;
};
export type FinalizeSubtaskResult = {
  parent_task: TaskSummary;
  archived_child: TaskSummary;
  snapshot_path: string;
};
export type SnapshotProvenance = {
  child_slug: string;
  branch: string;
  snapshot_time: number;
};
export type SessionListItem = SessionMeta & {
  task_slug: string;
  task_name: string;
  task_worktree: string;
  repo_path: string;
  playbook_title: string;
  step_title: string;
  is_playbook_step: boolean;
};
export type SessionStatusRef = {
  repo_path: string;
  task_slug: string;
  id: string;
};
// --- Structured session observation types (Step 4 / Phase 3 protocol) ---

// Mirrors alinery-core HarnessAdapter: "omp" | "unsupported"
export type HarnessAdapter = "omp" | "unsupported";
export type MessageAdapter = "omp_bracketed_paste" | "unsupported";

// Mirrors alinery-core ProcessState
export type ProcessState = { state: "starting" } | { state: "alive" } | { state: "exited"; code: number | null };

// Mirrors alinery-core AgentState
export type AgentState =
  | { state: "unknown" }
  | { state: "busy" }
  | { state: "waiting_for_input"; correlation_id: string }
  | { state: "waiting_for_approval"; correlation_id: string }
  | { state: "idle" };

// Mirrors alinery-core PlaybookState
export type PlaybookState = { state: "in_progress" } | { state: "ready_to_advance" } | { state: "completed" } | { state: "failed"; reason: string };

// Mirrors alinery-core SessionState (structured daemon-owned axes)
export type SessionState = {
  process: ProcessState;
  agent: AgentState;
  playbook: PlaybookState;
  adapter: HarnessAdapter;
  message_adapter: MessageAdapter;
};

// Mirrors alinery-core SemanticCheckpoint (daemon-written, meta-persisted)
export type SemanticCheckpoint = {
  phase_completed_at?: number | null;
  omp_session_id?: string | null;
  omp_turn_id?: number | null;
};

// The normalized app-facing observation returned by session_status / session_list_statuses
// after Phase 3. `state` is present only when the owning daemon holds the id;
// `checkpoint` comes from meta and survives daemon restarts.
export type SessionTransport = "pty" | "rpc";

export type SessionObservation = {
  lifecycle: LifecycleState;
  state: SessionState | null;
  checkpoint: SemanticCheckpoint;
  transport?: SessionTransport | null;
};

export type ChatPart =
  | { type: "thinking"; thinking: string; streaming?: boolean }
  | { type: "redactedThinking" }
  | { type: "text"; text: string; streaming?: boolean }
  | { type: "toolCall"; id?: string; name?: string; args?: unknown; streaming?: boolean }
  | { type: "toolResult"; body?: string }
  | { type: "image"; mimeType: string; data?: string };

export type ChatMessage = {
  role: "user" | "assistant" | "toolResult";
  content: ChatPart[];
  stopReason?: string;
  customType?: string;
  /**
   * Id of the OMP journal row this message came from. Present only for messages read off disk;
   * live streamed messages have none. Entry ids derive from it so that paging older history in
   * cannot renumber rows that are already mounted.
   */
  rowId?: string;
  /** toolResult rows carry these; assistant toolCall parts carry their own copies. */
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

// Mirrors alinery-core's LifecycleState (serde tag = "state", snake_case). Derived by the
// session_status command from daemon status + persisted meta timestamps (issue #24).
// After Phase 3: the live shape no longer carries `idle` (agent state is a separate axis).
export type LifecycleState =
  | { state: "live" }
  | { state: "live_exited" }
  | { state: "never_started" }
  | { state: "orphaned" }
  | { state: "interrupted" }
  | { state: "exited"; code: number };
export type Phase = { key: string; title: string };
export type PlaybookKind = "linear" | "freeform";
export type AutoAdvanceSummary = { key: string; title: string; from: string; to: string; default_enabled: boolean };
export type PlaybookSummary = {
  key: string;
  title: string;
  description: string;
  kind: PlaybookKind;
  default_harness: string;
  steps: string[];
  auto_advance: AutoAdvanceSummary[];
};
export type PlaybookStepSummary = { key: string; title: string; short: string; artifact: string; column: string; harness: string };
export type SessionTypeChoice = { kind: "playbook-step"; playbook: string; phase: string } | { kind: "generic" };
export type KanbanColumn = { key: string; title: string };
export type RepoScope = "active" | "all";

export type ReviewHandoffRecord = {
  version: number;
  direction: string;
  source_task: string;
  source_session: string;
  source_artifact: string;
  target_task: string;
  target_artifact: string;
  target_session: string;
  target_phase: string;
  created_at_ms: number;
};

export type ReviewHandoffResult = {
  target_artifact: string;
  target_session: SessionMeta;
  source_record: ReviewHandoffRecord;
  target_record: ReviewHandoffRecord;
};

export type ArtifactListItem = {
  name: string;
  modified_at_ms?: number | null;
  playbook_step: string;
  session_id: string;
  handoffs: ReviewHandoffRecord[];
  attachment?: boolean;
};

export type ArtifactTreeNodeKind = "owned" | "attachment" | "subtask_folder" | "referenced";
export type ArtifactTreeSource = "owned" | "parent_context" | "active_child" | "snapshot";

export type ArtifactTreeNode = {
  id: string;
  kind: ArtifactTreeNodeKind;
  label: string;
  owner_task_slug: string;
  source: ArtifactTreeSource;
  children: ArtifactTreeNode[];
};

export type SessionMessageActionProvenance =
  | {
      type: "artifact_comments";
      items: Array<{ artifact: string; review: string; comments_hash: string }>;
    }
  | {
      type: "review_approval";
      review_artifact: string;
    };

export type PreparedSessionMessageAction = {
  text: string;
  provenance: SessionMessageActionProvenance;
};

export type ReviewHandoffSource = {
  source_slug: string;
  source_session: string;
  source_artifact: string;
};

export type ReviewHandoffDraft = ReviewHandoffSource & {
  target_slug: string;
  target_phase: string;
  harness: string;
  model: string;
  prompt_extra: string;
};

// ---- Orbitron View spatial sidecar (mirrors src-tauri/src/canvas.rs) ----------
// These live here rather than under views/ because ipc.ts imports them, and ipc.ts must
// not depend on the views it exists to serve.
//
// The join key is the task slug: `task.md` gains no field, so identity and position stay
// separable and a repo that never opens Orbitron never grows the sidecar.
export type TaskId = Task["slug"];

/** "same surface" in the UI is `surface` on disk. */
export type CanvasRelationKind = "blocks" | "surface" | "informs";

export type CanvasConcept = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Sized by hand: packing may grow this hull, never shrink it. */
  manual: boolean;
};

export type CanvasPlacement = {
  /** `concepts[0]` is the primary placement — which hull holds the card. The rest are chips. */
  concepts: string[];
  x: number;
  y: number;
  placed: boolean;
};

/** Undirected: endpoints are stored sorted, one kind per pair. */
export type CanvasRelation = { a: TaskId; b: TaskId; kind: CanvasRelationKind };
export type CanvasEditMode = "autoEdit" | "readOnly" | "requestApproval";

export type CanvasViewPrefs = {
  camX: number;
  camY: number;
  scale: number;
  autoArrange: boolean;
  canvasEditMode: CanvasEditMode;
};

export type CanvasDoc = {
  version: 1;
  concepts: CanvasConcept[];
  placements: Record<TaskId, CanvasPlacement>;
  relations: CanvasRelation[];
  view: CanvasViewPrefs;
};

export type HostToolName =
  | "board_get"
  | "concept_create"
  | "concept_rename"
  | "concept_delete"
  | "task_place"
  | "task_unplace"
  | "task_tag"
  | "task_untag"
  | "relation_upsert"
  | "relation_delete"
  | "board_arrange";

export type HostToolCall =
  | { toolName: "board_get"; arguments: Record<string, never> }
  | { toolName: "concept_create"; arguments: { name: string } }
  | { toolName: "concept_rename"; arguments: { id: string; name: string } }
  | { toolName: "concept_delete"; arguments: { id: string } }
  | { toolName: "task_place"; arguments: { slug: TaskId; conceptId?: string } }
  | { toolName: "task_unplace"; arguments: { slug: TaskId } }
  | { toolName: "task_tag"; arguments: { slug: TaskId; conceptId: string; primary?: boolean } }
  | { toolName: "task_untag"; arguments: { slug: TaskId; conceptId: string } }
  | { toolName: "relation_upsert"; arguments: { a: TaskId; b: TaskId; kind: CanvasRelationKind } }
  | { toolName: "relation_delete"; arguments: { a: TaskId; b: TaskId } }
  | { toolName: "board_arrange"; arguments: Record<string, never> };

export type OrbitronAgentStatus = "idle" | "thinking" | "updatingBoard" | "compacting";

export type OrbitronAgentEvent =
  | { type: "ready" }
  | { type: "status"; status: OrbitronAgentStatus }
  | { type: "message"; role: "user" | "assistant"; text: string; done: boolean }
  | { type: "hostToolCall"; id: string; toolCallId: string; toolName: HostToolName; arguments: unknown }
  | { type: "error"; message: string }
  | { type: "exited" };

export type OrbitronAgentAvailability = {
  ompFound: boolean;
  ompPath: string | null;
  keyPresent: boolean;
  mcpEnabled: boolean;
};

export type OrbitronXaiKeyStatus = { present: boolean };

/** The canvas's active tool: chosen in its toolbar, named in the footer. */
export type CanvasTool = "pan" | "draw" | "edit";

/**
 * What Orbitron tells the footer about itself. The mode and zoom tier used to be painted in
 * the canvas's own top-left chrome; they live in the status bar with every other "what state
 * am I in" fact, and only the view's name stays on the board.
 */
export type CanvasStatus = { tool: CanvasTool; tier: 0 | 1 | 2 };

export type SettingsSectionKey = "connections" | "notifications" | "telemetry" | "updates" | "storage" | "appearance" | "chat" | "gridViews" | "experimental" | "mcp" | "backup";

export type View =
  | { kind: "list" }
  | { kind: "grid"; gridViewId: string }
  | { kind: "kanban" }
  | { kind: "sessions" }
  | { kind: "notifications" }
  | { kind: "settings"; section?: SettingsSectionKey }
  // Orbitron View. Deliberately absent from `Tab`: this surface is hotkey-gated (⌘⇧O)
  // and must not grow a sixth top-bar tab.
  | { kind: "canvas" }
  | { kind: "create"; from: View; draft?: BoardTask }
  | { kind: "createSession"; from: View; initialTask?: { repo_path: string; slug: string } }
  | { kind: "task"; slug: string; from: View; repoPath?: string; initialTask?: Task }
  | {
      kind: "session";
      id: string;
      cwd: string;
      taskSlug: string;
      phase: string;
      harness: string;
      model: string;
      playbook?: string;
      generic: boolean;
      intent?: "attach" | "spawn" | "resume" | "history";
      resumeToken?: string;
      from: View;
    }
  | { kind: "reviewHandoff"; from: View; source: ReviewHandoffSource };

export type Tab = "list" | "kanban" | "grid" | "sessions" | "notifications" | "settings";

export type BoardNav = {
  moveRow: (d: number) => void;
  moveCol: (d: number) => void;
  openSelected: () => void;
  duplicateSelected: () => void;
  archiveSelected: () => void;
};

// ---- wire types that used to live beside their consumers ----------------------
// These mirror Rust structs exactly like everything above, but were declared inside
// the components and hooks that happened to call the command. That put them out of
// reach of ipc.ts (importing them there would have made ipc.ts depend on the views it
// exists to serve), and two of them had drifted into duplicate declarations.

/** Mirrors Rust `ArtifactComment` (src/artifacts.rs). */
export type ArtifactComment = {
  id: string;
  artifact: string;
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
  body: string;
  created_at_ms: number;
};

/** The anchor half of a comment — where in the rendered artifact it points. */
export type ArtifactCommentAnchor = {
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
};

/** Mirrors Rust `ArtifactCommentDraft` (src/artifacts.rs). */
export type ArtifactCommentDraft = ArtifactCommentAnchor & {
  artifact: string;
  body: string;
  artifact_hash: string;
  updated_at_ms: number;
  stale: boolean;
};

/** Was declared identically in both TaskDetail.tsx and SessionView.tsx. */
export type ArtifactReviewPendingStatus = {
  artifact: string;
  review: string;
};

// Mirrors Rust `DaemonConflict`: a responding daemon failed a hard reuse gate.
// Nothing was killed to discover this.
export type DaemonConflict = {
  repo: string;
  reason: "protocol" | "app_config";
  /** null when the running daemon predates protocol versioning. */
  daemon_protocol: number | null;
  app_protocol: number;
  daemon_app_config_identity: string | null;
  app_config_identity: string | null;
  live_sessions: number;
};

export type DaemonStatus = {
  reachable: boolean;
  mode: string; // "local" today; "remote" reserved for a future remote daemon
  // Independent process-level count (alive PTY processes).
  alive: number;
  // Agent-state counts (OMP-only; unsupported/unknown sessions excluded from agent counts).
  busy: number;
  waiting_for_input: number;
  waiting_for_approval: number;
  idle: number;
  unknown: number;
  exited: number;
  // Total session count across all states.
  total: number;
  extra_lanes: number;
  stale_lanes: number;
  repo: string;
  /** A6: same protocol, different alineryd build. Informational only — never a kill. */
  build_drift: boolean;
  conflict: DaemonConflict | null;
  /** B6: another live alinery holds this repo's `.alinery/.alinery-app.lock`. */
  repo_busy: boolean;
  /** The selected daemon lacks a canonical executable for dynamic host screening. */
  host_guard_warning: boolean;
};

export type McpStatus = {
  enabled: boolean;
  running: boolean;
  clients: number;
  socket_reachable: boolean;
  binary_found: boolean;
  binary_path: string;
  repo: string;
  socket_path: string;
  error: string;
};

/** Mirrors Rust `CreateTaskResult` (src/task.rs). */
export type CreateTaskResult = {
  task: Task;
  session: SessionMeta;
  attachment_errors: string[];
};

/** Mirrors Rust `LinearTicket` (src/imports.rs). Was an inline literal at the call site. */
export type LinearTicket = {
  identifier: string;
  title: string;
  description: string;
};

/** Mirrors Rust `GitHubIssue` (src/imports.rs). Was an inline literal at the call site. */
export type GitHubIssue = {
  reference: string;
  title: string;
  description: string;
};
