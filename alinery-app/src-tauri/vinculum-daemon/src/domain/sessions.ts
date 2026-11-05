// The live half of the session entity and the daemon's status row (plan 2.2.8, S2.5). The meta file
// gives a Session its stored fields (parsers/sessionMeta.ts); this adds `status` and `wait`, which
// exist only while the daemon runs the session. The feed calls `withLive` on every Session it
// commits, so a watcher event for the meta file cannot overwrite the live state (the hazard
// recorded in 4.1 at S2.3).
import { clone, create } from "@bufbuild/protobuf";
import { DaemonStatusSchema, type Entity, EntitySchema, SessionStatusSchema, SessionWaitSchema } from "alinery-proto/alinery/v1/entities_pb";
import type { Feed } from "../sync/feed.ts";
import type { Store } from "../sync/store.ts";

export type LiveSession = {
  process: { state: string };
  agent: { state: string; correlation_id?: string; reason?: string };
  playbook: { state: string; reason?: string };
  adapter: string;
  message_adapter: string;
  transport?: string;
  wait?: null | { kind: string; correlationId: string; prompt?: string };
};

/** A Session entity with `status` and `wait` set from the live session, or cleared when there is none. */
export function withLive(entity: Entity, live: LiveSession | undefined): Entity {
  if (entity.value.case !== "session") return entity;
  const out = clone(EntitySchema, entity);
  if (out.value.case !== "session") return out;
  out.value.value.status = live
    ? create(SessionStatusSchema, {
        process: live.process.state,
        agent: live.agent.state,
        agentCorrelationId: live.agent.correlation_id ?? "",
        agentReason: live.agent.reason ?? "",
        playbook: live.playbook.state,
        playbookReason: live.playbook.reason ?? "",
        adapter: live.adapter,
        messageAdapter: live.message_adapter,
        transport: live.transport ?? "",
      })
    : undefined;
  out.value.value.wait = live?.wait ? create(SessionWaitSchema, { kind: live.wait.kind, correlationId: live.wait.correlationId, prompt: live.wait.prompt }) : undefined;
  return out;
}

export const daemonStatusKey = "daemon/_/status";

/** The daemon's half of `DaemonStatus`. The store drops a put equal to the stored row, so calling this on every session change costs nothing when the count held. */
export function commitDaemonStatus(store: Store, info: { protocol: number; buildId: string; liveSessions: number; hostGuardWarning?: string; watchExhausted?: boolean; busy?: number; waitingForInput?: number; waitingForApproval?: number }): void {
  store.commit([
    create(EntitySchema, {
      key: daemonStatusKey,
      value: { case: "daemonStatus", value: create(DaemonStatusSchema, { protocol: info.protocol, buildId: info.buildId, liveSessions: info.liveSessions, hostGuardWarning: info.hostGuardWarning ?? "", watchExhausted: info.watchExhausted ?? false, busy: info.busy ?? 0, waitingForInput: info.waitingForInput ?? 0, waitingForApproval: info.waitingForApproval ?? 0 }) },
    }),
  ]);
}

export type LiveRow = LiveSession & { id: string; taskSlug: string };

/**
 * The session-change hook (S2.5): the runner calls `changed` whenever a session row moves, and the
 * session's entity and the live count are recommitted. `liveRows` is the daemon's own table, read at
 * commit time, so what lands in the store is what `list` would answer at that moment.
 */
export class SessionPublisher {
  constructor(
    private readonly store: Store,
    private readonly feed: Feed,
    private readonly liveRows: () => Iterable<LiveRow>,
    private readonly info: { protocol: number; buildId: string; watchExhausted?: () => boolean },
    private readonly log: (line: string) => void = console.error,
  ) {}

  /** The Session entity the feed commits for a meta file: stored fields plus the live state of that session. */
  decorate = (entity: Entity): Entity => {
    const [, slug, id] = entity.key.split("/");
    for (const row of this.liveRows()) if (row.id === id && (row.taskSlug || "_") === slug) return withLive(entity, row);
    return withLive(entity, undefined);
  };

  changed(taskSlug: string, id: string): void {
    this.commitStatus();
    const rel = `${taskSlug ? `tasks/${taskSlug}/` : ""}sessions/${id}.meta.json`;
    void this.feed.refresh(rel).catch((e) => this.log(`session ${id}: ${(e as Error).message}`));
  }

  commitStatus(): void {
    let liveSessions = 0;
    let busy = 0;
    let waitingForInput = 0;
    let waitingForApproval = 0;
    for (const row of this.liveRows()) {
      if (row.process.state === "exited" || row.id === "__omp-setup__") continue;
      liveSessions += 1;
      if (row.agent.state === "busy") busy += 1;
      else if (row.agent.state === "waiting_for_input") waitingForInput += 1;
      else if (row.agent.state === "waiting_for_approval") waitingForApproval += 1;
    }
    commitDaemonStatus(this.store, { protocol: this.info.protocol, buildId: this.info.buildId, liveSessions, watchExhausted: this.info.watchExhausted?.(), busy, waitingForInput, waitingForApproval });
  }
}
