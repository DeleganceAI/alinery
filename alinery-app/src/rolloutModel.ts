import type { ExecutionRecord, NormalizedStep, SessionDisplayMeta, TaskExecutionState } from "./types";

// The rollout is a task's sessions in the order they ran: one row per moment, and a row holds more than one session
// only when their running times overlap (a fan-out, or an auxiliary session opened beside a running step). It is a
// projection for reading; the session view stays the ground truth.

export type RolloutArtifact = { path: string; pending: boolean };
export type RolloutEntry = {
  session: SessionDisplayMeta;
  execution?: ExecutionRecord;
  /** 1-based position of the step in the playbook. Absent for a session that is not a playbook step. */
  stepNumber?: number;
  title: string;
  auxiliary: boolean;
  start: number;
  /** Epoch seconds; null while the session is still running. */
  end: number | null;
  artifacts: RolloutArtifact[];
};
export type RolloutRow = RolloutEntry[];

const startOf = (session: SessionDisplayMeta) => session.started_at ?? session.created;

export function buildRollout(
  sessions: SessionDisplayMeta[],
  state: TaskExecutionState | null | undefined,
  steps: NormalizedStep[],
  isLive: (session: SessionDisplayMeta) => boolean,
  /** Whether a file is on disk. A step waiting for review has written its file before the engine records it as published. */
  exists: (path: string) => boolean = () => false,
): RolloutRow[] {
  const executions = Object.values(state?.executions ?? {});
  const occurrences = Object.values(state?.occurrences ?? {});
  const entries = [...sessions]
    .sort((left, right) => startOf(left) - startOf(right) || left.id.localeCompare(right.id))
    .map<RolloutEntry>((session) => {
      const execution = executions.find((record) => record.owner_session_id === session.id || record.previous_session_ids.includes(session.id));
      const stepKey = execution?.candidate.step_key ?? (session.generic ? "" : session.phase);
      const stepIndex = stepKey ? steps.findIndex((step) => step.key === stepKey) : -1;
      const auxiliary = !execution && (session.generic || session.subtask_manager === true || stepIndex < 0);
      const artifacts: RolloutArtifact[] = [];
      // A superseded attempt published nothing: the outputs belong to the session that owns the execution now.
      if (execution && execution.owner_session_id === session.id) {
        for (const occurrence of occurrences) {
          if (occurrence.producer_execution_id === execution.id && !artifacts.some((item) => item.path === occurrence.relative_path))
            artifacts.push({ path: occurrence.relative_path, pending: false });
        }
        if (!execution.receipt_id) {
          for (const output of execution.outputs) {
            if (!artifacts.some((item) => item.path === output.relative_path)) artifacts.push({ path: output.relative_path, pending: !exists(output.relative_path) });
          }
        }
      }
      const start = startOf(session);
      return {
        session,
        execution,
        stepNumber: stepIndex >= 0 ? stepIndex + 1 : undefined,
        title: session.subtask_manager ? "Sub-task manager" : (steps[stepIndex]?.title ?? (stepKey || (session.generic ? "Auxiliary" : "Session"))),
        auxiliary,
        start,
        end: session.ended_at ?? (isLive(session) ? null : (session.status_changed_at ?? session.activity_at ?? start)),
        artifacts,
      };
    });

  const rows: RolloutRow[] = [];
  let rowEnd = 0;
  for (const entry of entries) {
    const row = rows[rows.length - 1];
    // A step that consumed this row's work, or a retry of one of its sessions, came after it even when the
    // earlier session was still shutting down as it started.
    const follows = row?.some((other) => entry.session.resume_of === other.session.id || (other.execution && entry.execution?.parent_execution_ids.includes(other.execution.id)));
    if (row && !follows && entry.start < rowEnd) row.push(entry);
    else {
      rows.push([entry]);
      rowEnd = 0;
    }
    rowEnd = Math.max(rowEnd, entry.end ?? Number.POSITIVE_INFINITY);
  }
  return rows;
}

/** Which session of a parallel row is shown wide: one waiting on the user, else the newest playbook step, else the newest. */
export function defaultFocus(row: RolloutRow, needsUser: (entry: RolloutEntry) => boolean): string {
  return (row.find(needsUser) ?? [...row].reverse().find((entry) => !entry.auxiliary) ?? row[row.length - 1]).session.id;
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
