// Session status from the daemon's Session entities (plan S3.2): what the `session_status` family of
// commands answered, read from a subscription instead of a poll. The mapping below is the same one
// `classify` and `observation_of` made in Rust, over the fields the entity carries.
import { create } from "@bufbuild/protobuf";
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { type Scope, ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { useEffect, useMemo, useState } from "react";
import type { LifecycleState, SessionObservation, SessionState, SessionStatusRef } from "../types";
import { acquireScope } from "./hooks";
import type { Replica } from "./replica";

/** `<repo>:<task slug>:<id>`, the key `session_list_statuses` answered with; "" is the slug of a chat session. */
export const sessionObservationKey = (repo: string, taskSlug: string, id: string) => `${repo}:${taskSlug}:${id}`;

export const sessionEntityKey = (taskSlug: string, id: string) => `session/${taskSlug || "_"}/${id}`;

const sessionScope = (taskSlug: string, id: string): Scope => create(ScopeSchema, { kind: { case: "session", value: { session: { taskSlug, id } } } });
/** Many sessions share a stream per task (or one for all chat sessions) instead of one each. */
const groupScope = (taskSlug: string): Scope => create(ScopeSchema, { kind: taskSlug ? { case: "task", value: { slug: taskSlug } } : { case: "chat", value: {} } });

function lifecycleOf(s: { startedAt?: bigint; endedAt?: bigint; exitCode?: number }, process: string | undefined): LifecycleState {
  if (process === "starting" || process === "alive") return { state: "live" };
  if (process === "exited") return { state: "live_exited" };
  if (s.startedAt === undefined) return { state: "never_started" };
  if (s.endedAt === undefined) return { state: "orphaned" };
  if (s.exitCode === undefined) return { state: "interrupted" };
  return { state: "exited", code: s.exitCode };
}

function stateOf(status: NonNullable<Extract<Entity["value"], { case: "session" }>["value"]["status"]>, correlationId: string): SessionState {
  const agent = status.agent;
  return {
    process: status.process === "exited" ? { state: "exited", code: null } : { state: status.process === "starting" ? "starting" : "alive" },
    agent: (agent === "waiting_for_input" || agent === "waiting_for_approval"
      ? { state: agent, correlation_id: correlationId }
      : { state: agent === "busy" || agent === "idle" ? agent : "unknown" }) as SessionState["agent"],
    playbook: (status.playbook === "failed" ? { state: "failed", reason: status.playbookReason } : { state: status.playbook || "in_progress" }) as SessionState["playbook"],
    adapter: status.adapter === "vinculum" ? "vinculum" : "unsupported",
    message_adapter: status.messageAdapter === "vinculum_bracketed_paste" ? "vinculum_bracketed_paste" : "unsupported",
  };
}

/** The observation for a Session entity; a session with no entity has never started. */
export function observationOf(entity: Entity | undefined): SessionObservation {
  const s = entity?.value.case === "session" ? entity.value.value : undefined;
  if (!s) return { lifecycle: { state: "never_started" }, state: null, checkpoint: {}, transport: null };
  const sem = s.semantic;
  return {
    lifecycle: lifecycleOf(s, s.status?.process),
    state: s.status ? stateOf(s.status, s.wait?.correlationId || s.status.agentCorrelationId) : null,
    checkpoint: {
      phase_completed_at: sem?.phaseCompletedAt === undefined ? null : Number(sem.phaseCompletedAt),
      vinculum_session_id: sem?.vinculumSessionId ?? null,
      vinculum_turn_id: sem?.vinculumTurnId === undefined ? null : Number(sem.vinculumTurnId),
    },
    transport: s.status?.transport === "pty" || s.status?.transport === "rpc" ? s.status.transport : null,
    attention_label: s.attentionLabel || undefined,
  };
}

/**
 * Observations for sessions, kept current by subscriptions. A session the daemon holds no entity for
 * (its repo has not sent a snapshot, or has not seen the meta file) is left out: its view shows "loading"
 * or "unknown", never "not started". One ref uses the session scope; several share a task or chat scope per group.
 */
export function useSessionObservations(refs: SessionStatusRef[], enabled = true): Record<string, SessionObservation> {
  const [observed, setObserved] = useState<Record<string, SessionObservation>>({});
  const refsKey = JSON.stringify(enabled ? refs.map((r) => [r.repo_path, r.task_slug, r.id]) : []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refsKey stands for refs
  useEffect(() => {
    const wanted: [string, string, string][] = JSON.parse(refsKey);
    if (!wanted.length) return setObserved((prev) => (Object.keys(prev).length ? {} : prev));
    const held = new Map<string, { replica: Replica; release: () => void }>();
    const via = (repo: string, slug: string, id: string) => {
      const scope = wanted.length === 1 ? sessionScope(slug, id) : groupScope(slug);
      const key = `${repo}\u0000${slug}\u0000${wanted.length === 1 ? id : ""}`;
      let h = held.get(key);
      if (!h) {
        h = acquireScope(repo, scope);
        held.set(key, h);
      }
      return h.replica;
    };
    const replicas = wanted.map(([repo, slug, id]) => via(repo, slug, id));
    const read = () =>
      setObserved((prev) => {
        const next: Record<string, SessionObservation> = {};
        wanted.forEach(([repo, slug, id], i) => {
          const entity = replicas[i].get(sessionEntityKey(slug, id));
          if (entity) next[sessionObservationKey(repo, slug, id)] = observationOf(entity);
        });
        return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
      });
    const offs = [...held.values()].map((h) => h.replica.listen(read));
    read();
    return () => {
      for (const off of offs) off();
      for (const h of held.values()) h.release();
    };
  }, [refsKey]);
  return useMemo(() => (enabled ? observed : {}), [enabled, observed]);
}

/** One session's observation: null until its repo's first snapshot has landed. */
export function useSessionObservation(repo: string | undefined, taskSlug: string, id: string): SessionObservation | null {
  const refs = useMemo(() => (repo && id ? [{ repo_path: repo, task_slug: taskSlug, id }] : []), [repo, taskSlug, id]);
  return useSessionObservations(refs)[sessionObservationKey(repo ?? "", taskSlug, id)] ?? null;
}

/** One-shot read for a handler (no view to hold a subscription): the session's observation once its snapshot lands; rejects if the daemon does not answer within `timeoutMs`. */
export function observationNow(repo: string, taskSlug: string, id: string, timeoutMs = 3000): Promise<SessionObservation> {
  const { replica, release } = acquireScope(repo, sessionScope(taskSlug, id));
  return new Promise<SessionObservation>((resolve, reject) => {
    let off = () => {};
    const finish = (then: () => void) => {
      clearTimeout(timer);
      off();
      release();
      then();
    };
    const read = () => (replica.ready ? finish(() => resolve(observationOf(replica.get(sessionEntityKey(taskSlug, id))))) : undefined);
    const timer = setTimeout(() => finish(() => reject(new Error("the daemon did not answer"))), timeoutMs);
    off = replica.listen(read);
    read();
  });
}
