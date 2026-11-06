// The daemon's entities in the JSON shapes `alinery-mcp` answered with, built from the Rust structs (`Task`, `SessionMeta`,
// `ArtifactListing`) before they moved. Where an entity carries more than the struct did (a board projection, a live status), it is left out.
import { type JsonValue } from "@bufbuild/protobuf";
import { type Artifact, ArtifactSchema, type Session, SessionSchema, type Task, TaskSchema } from "alinery-proto/alinery/v1/entities_pb";
import { plain } from "./plain.ts";

type Row = Record<string, unknown>;

const present = (value: unknown) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0) && !(typeof value === "object" && !Array.isArray(value) && Object.keys(value as Row).length === 0) && value !== "";

/** `Task` as `task.md` holds it: what the board and the live activity add is not a field of the file, and the fields a task rarely has are absent until set. */
export function taskJson(task: Task): Row {
  const row = plain(TaskSchema, task);
  delete row.board;
  delete row.activity;
  for (const key of ["requested_slug", "step_models", "parent_task", "active_subtask", "subtask_outcome", "draft_base_ref", "related_tasks"]) if (!present(row[key])) delete row[key];
  for (const key of Object.keys(row)) if (row[key] === null) delete row[key];
  return row;
}

const SESSION_ONLY_WHEN_SET = ["subtask_manager", "subtask_slug", "notification_suppression"];
const NOT_IN_META = ["ref", "status", "name", "name_source", "name_error", "attention_label", "telemetry_id", "wait", "activity_at"];

/** `SessionMeta`, the meta file's fields, from a session entity. */
export function sessionMeta(session: Session): Row {
  const row = plain(SessionSchema, session);
  for (const key of NOT_IN_META) delete row[key];
  for (const key of SESSION_ONLY_WHEN_SET) if (!row[key]) delete row[key];
  return row;
}

/** `SessionState`, as the live daemon reported it, from the entity's status. */
export function sessionState(session: Session, exitCode: number | null): Row | undefined {
  const status = session.status;
  if (!status) return undefined;
  const agent: Row = { state: status.agent || "unknown" };
  if (status.agentCorrelationId) agent.correlation_id = status.agentCorrelationId;
  const playbook: Row = { state: status.playbook || "in_progress" };
  if (status.playbookReason) playbook.reason = status.playbookReason;
  const process: Row = { state: status.process };
  if (status.process === "exited" && exitCode !== null) process.code = exitCode;
  return { process, agent, playbook, adapter: status.adapter, message_adapter: status.messageAdapter };
}

/** The lifecycle `classify` gave: the daemon's process state wins; persisted timestamps classify a session it does not know. */
export function lifecycle(session: Session): Row {
  const process = session.status?.process;
  if (process === "starting" || process === "alive") return { state: "live" };
  if (process === "exited") return { state: "live_exited" };
  if (session.startedAt === undefined) return { state: "never_started" };
  if (session.endedAt === undefined) return { state: "orphaned" };
  if (session.exitCode === undefined) return { state: "interrupted" };
  return { state: "exited", code: session.exitCode };
}

/** One row of the artifact listing. Attachments are their own entities and never a row here. */
export function artifactRow(artifact: Artifact): Row {
  const row = plain(ArtifactSchema, artifact);
  return {
    name: row.name,
    modified_at_ms: row.modified_at_ms,
    playbook_step: row.playbook_step,
    session_id: row.session_id,
    handoffs: row.handoffs,
    attachment: false,
    execution_id: row.execution_id,
    step_key: row.step_key,
    logical_path: row.logical_path,
    depth: row.depth,
    discriminator: row.discriminator,
    accepted: row.accepted,
  };
}

export const asJson = (value: unknown): JsonValue => value as JsonValue;
