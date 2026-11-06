// Ports `read_session_meta_full` (alinery-core shared.rs): the typed read of one `*.meta.json`. Rust's
// serde is strict, so this is too: a file serde would refuse (a wrong type, a null where a plain field
// is expected, a missing id, worktree or created) is no session, and both sides agree on it through
// the shared conformance cases. Unknown keys are ignored, as serde does.
import { create } from "@bufbuild/protobuf";
import { type Entity, EntitySchema, SessionSchema } from "alinery-proto/alinery/v1/entities_pb";
import { readFile } from "node:fs/promises";
import type { Parser } from "./index.ts";

type Obj = Record<string, unknown>;
class Refuse extends Error {}
const refuse = (): never => {
  throw new Refuse();
};

const NOTICES = new Set(["waiting_for_input", "waiting_for_approval", "failure"]);
const present = (o: Obj, k: string) => o[k] !== undefined;
const given = (o: Obj, k: string) => o[k] !== undefined && o[k] !== null;

const str = (o: Obj, k: string, fallback = ""): string => (present(o, k) ? (typeof o[k] === "string" ? (o[k] as string) : refuse()) : fallback);
const req = (o: Obj, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : refuse());
const bool = (o: Obj, k: string): boolean => (present(o, k) ? (typeof o[k] === "boolean" ? (o[k] as boolean) : refuse()) : false);
const u64Of = (v: unknown): bigint => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : refuse());
const u64 = (o: Obj, k: string): bigint => (present(o, k) ? u64Of(o[k]) : 0n);
const optU64 = (o: Obj, k: string): bigint | undefined => (given(o, k) ? u64Of(o[k]) : undefined);
const optStr = (o: Obj, k: string): string | undefined => (given(o, k) ? str(o, k) : undefined);
const optI32 = (o: Obj, k: string): number | undefined => {
  if (!given(o, k)) return undefined;
  const v = o[k];
  return typeof v === "number" && Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31 ? v : refuse();
};
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : refuse());

/** The entity for one meta.json's text; undefined when serde would refuse it. */
export function parseSessionMeta(text: string, taskSlug: string, id: string): Entity | undefined {
  try {
    const o = obj(JSON.parse(text));
    if (typeof o.id !== "string" || typeof o.worktree !== "string") refuse();
    const sem = present(o, "semantic") ? obj(o.semantic) : {};
    const sup = given(o, "notification_suppression") ? obj(o.notification_suppression) : undefined;
    const notice = sup ? req(sup, "notice") : "";
    if (sup && !NOTICES.has(notice)) refuse();
    return create(EntitySchema, {
      key: sessionKey(taskSlug, id),
      value: {
        case: "session",
        value: create(SessionSchema, {
          ref: { taskSlug, id },
          id: o.id as string,
          worktree: o.worktree as string,
          created: u64Of(o.created),
          archived: bool(o, "archived"),
          pinned: bool(o, "pinned"),
          phase: str(o, "phase"),
          harness: str(o, "harness"),
          model: str(o, "model"),
          playbook: str(o, "playbook"),
          executionId: str(o, "execution_id"),
          executionRevision: u64(o, "execution_revision"),
          generic: bool(o, "generic"),
          subtaskManager: bool(o, "subtask_manager"),
          subtaskSlug: str(o, "subtask_slug"),
          artifact: str(o, "artifact"),
          handoffArtifact: str(o, "handoff_artifact"),
          promptExtra: str(o, "prompt_extra"),
          prompt: optStr(o, "prompt"),
          startedAt: optU64(o, "started_at"),
          statusChangedAt: optU64(o, "status_changed_at"),
          activityAt: optU64(o, "activity_at"),
          statusRevision: u64(o, "status_revision"),
          endedAt: optU64(o, "ended_at"),
          exitCode: optI32(o, "exit_code"),
          harnessResumeToken: str(o, "harness_resume_token"),
          resumeOf: optStr(o, "resume_of"),
          daemonNamespace: str(o, "daemon_namespace"),
          notificationReadAt: optU64(o, "notification_read_at"),
          exitNotificationReadAt: optU64(o, "exit_notification_read_at"),
          notificationSuppression: sup ? { notice, occurrence: req(sup, "occurrence") } : undefined,
          semantic: { phaseCompletedAt: optU64(sem, "phase_completed_at"), ompSessionId: optStr(sem, "omp_session_id"), ompTurnId: optU64(sem, "omp_turn_id") },
          telemetryId: str(o, "telemetry_id"),
        }),
      },
    });
  } catch (e) {
    if (e instanceof Refuse || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** Taskless chat sessions have no task directory and key under `_` (2.2.6). */
export const sessionKey = (taskSlug: string, id: string) => `session/${taskSlug || "_"}/${id}`;

// `tasks/<slug>/sessions/<id>.meta.json`, or `sessions/<id>.meta.json` for a taskless session.
export const sessionMeta: Parser = {
  match: /^(?:tasks\/([^/]+)\/)?sessions\/([^/]+)\.meta\.json$/,
  key: (m) => sessionKey(m[1] ?? "", m[2]),
  async parse(absPath, m) {
    let text: string;
    try {
      text = await readFile(absPath, "utf8");
    } catch {
      return null;
    }
    return parseSessionMeta(text, m[1] ?? "", m[2]) ?? null;
  },
};
