import type { AgentState, NotificationSuppression, SessionListItem, SessionMeta, SessionNotificationClearRef, SessionObservation, TaskPanelRow } from "./types";

export type ObservationDisplayKind =
  | "failed"
  | "stale"
  | "completed"
  | "ready_to_advance"
  | "exited"
  | "loading"
  | "unsupported"
  | "starting"
  | "waiting_for_input"
  | "waiting_for_approval"
  | "busy"
  | "idle"
  | "unknown";

export type SessionNotice = "waiting_for_input" | "waiting_for_approval" | "failure" | "unread_completion";
export type SessionNoticeRow = { item: SessionListItem; notice: SessionNotice };

export type SessionSort = { field: "priority" } | { field: "started" | "updated"; direction: "desc" | "asc" };
export const PRIORITY_SESSION_SORT: SessionSort = { field: "priority" };

export function selectSessionSort(current: SessionSort, field: SessionSort["field"]): SessionSort {
  if (field === "priority") return PRIORITY_SESSION_SORT;
  if (current.field !== field) return { field, direction: "desc" };
  return { field, direction: current.direction === "desc" ? "asc" : "desc" };
}

export function sessionSortArrow(sort: SessionSort, field: "started" | "updated"): "" | "↓" | "↑" {
  if (sort.field !== field) return "";
  return sort.direction === "desc" ? "↓" : "↑";
}

export function observationDisplayKind(observation: SessionObservation): ObservationDisplayKind {
  const { lifecycle, state } = observation;
  if (!state) {
    if (observation.checkpoint.phase_completed_at != null) return "completed";
    if (lifecycle.state === "live" || lifecycle.state === "live_exited") return "unknown";
    return "exited";
  }
  if (state.adapter === "unsupported") {
    if (state.process.state === "starting") return "starting";
    if (state.process.state === "exited") return "exited";
    return "unsupported";
  }
  if (state.playbook.state === "failed") {
    return state.playbook.reason === "StaleSource" ? "stale" : "failed";
  }
  const agent: AgentState = state.agent;
  const processLive = state.process.state === "starting" || state.process.state === "alive";
  if (processLive && agent.state === "waiting_for_input") return "waiting_for_input";
  if (processLive && agent.state === "waiting_for_approval") return "waiting_for_approval";
  if (processLive && agent.state === "busy") return "busy";
  if (state.playbook.state === "completed" || state.playbook.state === "ready_to_advance") {
    return state.playbook.state === "ready_to_advance" ? "ready_to_advance" : "completed";
  }
  if (state.process.state === "starting") return "starting";
  if (state.process.state === "exited") return "exited";
  if (agent.state === "unknown") return "loading";
  if (agent.state === "idle") return "idle";
  return "unknown";
}

export function sameSessionObservationMaps(left: Record<string, SessionObservation>, right: Record<string, SessionObservation>): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const l = left[key];
    const r = right[key];
    if (!r) return false;
    if (l.lifecycle.state !== r.lifecycle.state) return false;
    if (l.checkpoint.phase_completed_at !== r.checkpoint.phase_completed_at) return false;
    if (observationDisplayKind(l) !== observationDisplayKind(r)) return false;
    const ls = l.state;
    const rs = r.state;
    if ((ls === null) !== (rs === null)) return false;
    if (ls && rs) {
      if (ls.process.state !== rs.process.state) return false;
      if (ls.agent.state !== rs.agent.state) return false;
      if (ls.playbook.state !== rs.playbook.state) return false;
      if (ls.adapter !== rs.adapter) return false;
    }
    return true;
  });
}

function completionTimestamp(session: SessionMeta, observation?: SessionObservation): number | null {
  return observation?.checkpoint.phase_completed_at ?? session.semantic?.phase_completed_at ?? null;
}

function hasUnreadCompletion(session: SessionMeta, observation?: SessionObservation): boolean {
  const completedAt = completionTimestamp(session, observation);
  return completedAt !== null && completedAt > (session.notification_read_at ?? -1);
}

export function hasUnacknowledgedExit(session: SessionMeta): boolean {
  if (session.exit_code == null || session.exit_code === 0) return false;
  return session.ended_at == null || session.ended_at > (session.exit_notification_read_at ?? -1);
}

export function hasAcknowledgedExit(session: SessionMeta): boolean {
  return session.exit_code != null && session.exit_code !== 0 && session.ended_at != null && session.ended_at <= (session.exit_notification_read_at ?? -1);
}

export function sessionFailureNeedsAttention(session: SessionMeta, observation?: SessionObservation): boolean {
  if (hasUnacknowledgedExit(session)) return true;
  if (!observation || observationDisplayKind(observation) !== "failed") return false;
  return observation.state?.process.state !== "exited" || !hasAcknowledgedExit(session);
}

export function classifySessionNotice(session: SessionMeta, observation?: SessionObservation): SessionNotice | null {
  if (session.archived) return null;
  const kind = observation ? observationDisplayKind(observation) : null;
  if (kind === "waiting_for_input") return "waiting_for_input";
  if (kind === "waiting_for_approval") return "waiting_for_approval";
  if (sessionFailureNeedsAttention(session, observation)) return "failure";
  if (hasUnreadCompletion(session, observation)) return "unread_completion";
  return null;
}

export function sessionAttentionTier(session: SessionMeta, observation?: SessionObservation): number {
  if (session.archived) return 4;
  const kind = observation ? observationDisplayKind(observation) : null;
  if (kind === "waiting_for_input" || kind === "waiting_for_approval") return 0;
  if (kind === "busy" || kind === "starting") return 1;
  if (sessionFailureNeedsAttention(session, observation) || hasUnreadCompletion(session, observation)) return 2;
  return 3;
}

export function sessionStartedAt(session: SessionMeta): number | null {
  return session.started_at ?? null;
}

export function sessionUpdatedAt(session: SessionMeta): number | null {
  return session.status_changed_at ?? session.semantic?.phase_completed_at ?? session.ended_at ?? session.started_at ?? session.created ?? null;
}

function compareOptionalTime(left: number | null, right: number | null, direction: "desc" | "asc"): number {
  if (!left) return !right ? 0 : 1;
  if (!right) return -1;
  return direction === "desc" ? right - left : left - right;
}
function sessionSortTime(session: SessionMeta, field: "started" | "updated"): number | null {
  return field === "started" ? sessionStartedAt(session) : sessionUpdatedAt(session);
}

function descendingCreatedAndId(left: SessionMeta, right: SessionMeta): number {
  return right.created - left.created || right.id.localeCompare(left.id);
}

export function taskDetailSessionComparator(
  observations: Record<string, SessionObservation>,
  hasExpectedArtifact: (session: SessionMeta) => boolean,
): (left: SessionMeta, right: SessionMeta) => number {
  return (left, right) => {
    const leftTier = sessionAttentionTier(left, observations[left.id]);
    const rightTier = sessionAttentionTier(right, observations[right.id]);
    if (leftTier !== rightTier) return leftTier - rightTier;
    if (leftTier === 3) {
      const artifactOrder = Number(hasExpectedArtifact(left)) - Number(hasExpectedArtifact(right));
      if (artifactOrder !== 0) return artifactOrder;
    }
    return descendingCreatedAndId(left, right);
  };
}

function taskPanelSession(row: TaskPanelRow): SessionMeta | null {
  return row.kind === "subtask_history" ? null : row.session;
}

function taskPanelRowKey(row: TaskPanelRow): string {
  if (row.kind === "session") return `session:${row.session.id}`;
  if (row.kind === "subtask_manager") return `manager:${row.owner_task_slug}:${row.session.id}`;
  return `history:${row.child.slug}`;
}

export function orderTaskPanelRows(
  rows: ReadonlyArray<TaskPanelRow>,
  observations: Record<string, SessionObservation>,
  hasExpectedArtifact: (session: SessionMeta) => boolean,
  sort: SessionSort = PRIORITY_SESSION_SORT,
): TaskPanelRow[] {
  return [...rows].sort((left, right) => {
    const leftSession = taskPanelSession(left);
    const rightSession = taskPanelSession(right);
    if (!leftSession || !rightSession) {
      if (leftSession) return -1;
      if (rightSession) return 1;
      return taskPanelRowKey(left).localeCompare(taskPanelRowKey(right));
    }
    if (sort.field === "priority") {
      const priority = taskDetailSessionComparator(observations, hasExpectedArtifact)(leftSession, rightSession);
      return priority || taskPanelRowKey(left).localeCompare(taskPanelRowKey(right));
    }
    const time = compareOptionalTime(sessionSortTime(leftSession, sort.field), sessionSortTime(rightSession, sort.field), sort.direction);
    return time || taskPanelRowKey(left).localeCompare(taskPanelRowKey(right));
  });
}

export function sessionListItemKey(item: SessionListItem): string {
  return `${item.repo_path}:${item.task_slug}:${item.id}`;
}

export function sessionListItemComparator(
  observations: Record<string, SessionObservation>,
  sort: SessionSort = PRIORITY_SESSION_SORT,
): (left: SessionListItem, right: SessionListItem) => number {
  return (left, right) => {
    if (sort.field !== "priority") {
      const time = compareOptionalTime(sessionSortTime(left, sort.field), sessionSortTime(right, sort.field), sort.direction);
      return time || left.repo_path.localeCompare(right.repo_path) || left.task_slug.localeCompare(right.task_slug) || left.id.localeCompare(right.id);
    }
    const leftTier = sessionAttentionTier(left, observations[sessionListItemKey(left)]);
    const rightTier = sessionAttentionTier(right, observations[sessionListItemKey(right)]);
    if (leftTier !== rightTier) return leftTier - rightTier;
    return right.created - left.created || left.repo_path.localeCompare(right.repo_path) || left.task_slug.localeCompare(right.task_slug) || right.id.localeCompare(left.id);
  };
}

export function orderSessionListItems(
  items: ReadonlyArray<SessionListItem>,
  observations: Record<string, SessionObservation>,
  sort: SessionSort = PRIORITY_SESSION_SORT,
): SessionListItem[] {
  return [...items].sort(sessionListItemComparator(observations, sort));
}

export function sessionNoticeRows(items: ReadonlyArray<SessionListItem>, observations: Record<string, SessionObservation>): SessionNoticeRow[] {
  return items
    .flatMap((item) => {
      const notice = classifySessionNotice(item, observations[sessionListItemKey(item)]);
      if (!notice || (notice === "unread_completion" && !item.is_playbook_step)) return [];
      return [{ item, notice }];
    })
    .sort((left, right) => {
      const leftTier = left.notice === "waiting_for_input" || left.notice === "waiting_for_approval" ? 0 : 1;
      const rightTier = right.notice === "waiting_for_input" || right.notice === "waiting_for_approval" ? 0 : 1;
      return (
        leftTier - rightTier ||
        right.item.created - left.item.created ||
        left.item.repo_path.localeCompare(right.item.repo_path) ||
        left.item.task_slug.localeCompare(right.item.task_slug) ||
        right.item.id.localeCompare(left.item.id)
      );
    });
}

export function liveNoticeSuppression(item: SessionListItem, notice: SessionNotice, observation?: SessionObservation): NotificationSuppression | null {
  const agent = observation?.state?.agent;
  if (notice === "waiting_for_input" && agent?.state === "waiting_for_input") {
    return { notice, occurrence: agent.correlation_id };
  }
  if (notice === "waiting_for_approval" && agent?.state === "waiting_for_approval") {
    return { notice, occurrence: agent.correlation_id };
  }
  if (notice === "failure" && observation?.state?.playbook.state === "failed" && observationDisplayKind(observation) === "failed" && (item.status_revision ?? 0) > 0) {
    return { notice, occurrence: String(item.status_revision) };
  }
  return null;
}

export function isSessionNoticeSuppressed(row: SessionNoticeRow, observation?: SessionObservation): boolean {
  if (hasUnreadCompletion(row.item, observation) || hasUnacknowledgedExit(row.item)) return false;
  const current = liveNoticeSuppression(row.item, row.notice, observation);
  const persisted = row.item.notification_suppression;
  return current !== null && persisted?.notice === current.notice && persisted.occurrence === current.occurrence;
}

export function filterSuppressedNoticeRows(rows: ReadonlyArray<SessionNoticeRow>, observations: Record<string, SessionObservation>): SessionNoticeRow[] {
  return rows.filter((row) => !isSessionNoticeSuppressed(row, observations[sessionListItemKey(row.item)]));
}

export function notificationClearRefs(
  rows: ReadonlyArray<SessionNoticeRow>,
  observations: Record<string, SessionObservation>,
  suppressLive: boolean,
): SessionNotificationClearRef[] {
  return rows.map((row) => {
    const reference: SessionNotificationClearRef = {
      repo_path: row.item.repo_path,
      task_slug: row.item.task_slug,
      id: row.item.id,
    };
    const suppression = suppressLive ? liveNoticeSuppression(row.item, row.notice, observations[sessionListItemKey(row.item)]) : null;
    return suppression ? { ...reference, notification_suppression: suppression } : reference;
  });
}

export function applyNotificationClearProjection(
  items: ReadonlyArray<SessionListItem>,
  rows: ReadonlyArray<SessionNoticeRow>,
  observations: Record<string, SessionObservation>,
  suppressLive: boolean,
): SessionListItem[] {
  const notices = new Map(rows.map((row) => [sessionListItemKey(row.item), row]));
  return items.map((item) => {
    const key = sessionListItemKey(item);
    const row = notices.get(key);
    if (!row) return item;
    const observation = observations[key];
    const completion = completionTimestamp(item, observation);
    const exit = item.exit_code != null && item.exit_code !== 0 ? item.ended_at : null;
    const notificationReadAt = completion != null ? Math.max(item.notification_read_at ?? -1, completion) : item.notification_read_at;
    const exitNotificationReadAt = exit != null ? Math.max(item.exit_notification_read_at ?? -1, exit) : item.exit_notification_read_at;
    const suppression = suppressLive ? liveNoticeSuppression(item, row.notice, observation) : null;
    return {
      ...item,
      ...(notificationReadAt != null && { notification_read_at: notificationReadAt }),
      ...(exitNotificationReadAt != null && { exit_notification_read_at: exitNotificationReadAt }),
      ...(suppression && { notification_suppression: suppression }),
    };
  });
}
