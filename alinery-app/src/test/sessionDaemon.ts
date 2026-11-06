// A fake daemon that serves Session entities over a real connect router (plan 2.5), for view tests
// that need session status. A test states what a session looks like as the old `SessionObservation`
// and the helper writes the entity the daemon would hold; `show` after mount is a live delta.
import { create, fromJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl, Transport } from "@connectrpc/connect";
import { type Entity, EntitySchema, SessionSchema, TaskSchema } from "alinery-proto/alinery/v1/entities_pb";
import { type SessionService, type TranscriptPartSchema, WatchTranscriptResponseSchema } from "alinery-proto/alinery/v1/sessions_pb";
import type { SubscribeResponse } from "alinery-proto/alinery/v1/sync_pb";
import type { VinculumMessage, VinculumTranscript } from "../chatTranscript";
import { taskEntityKey } from "../sync/board";
import { sessionEntityKey } from "../sync/sessionObservation";
import type { SessionObservation } from "../types";
import { daemonHarness, put, scriptedSync, snapshot, untilAborted } from "./daemonHarness";

/** The Session entity for an observation: the inverse of `observationOf`. */
export function sessionEntity(taskSlug: string, id: string, o: SessionObservation, wait?: { kind: string; correlationId: string }): Entity {
  const live = o.lifecycle.state === "live" || o.lifecycle.state === "live_exited";
  const s = o.state;
  const exited = o.lifecycle.state === "exited" ? o.lifecycle.code : undefined;
  const corr = s && "correlation_id" in s.agent ? s.agent.correlation_id : "";
  const session = create(SessionSchema, {
    id,
    startedAt: o.lifecycle.state === "never_started" ? undefined : 1n,
    endedAt: ["interrupted", "exited"].includes(o.lifecycle.state) ? 2n : undefined,
    exitCode: exited,
    semantic: {
      phaseCompletedAt: o.checkpoint.phase_completed_at == null ? undefined : BigInt(o.checkpoint.phase_completed_at),
      ompSessionId: o.checkpoint.omp_session_id ?? undefined,
      ompTurnId: o.checkpoint.omp_turn_id == null ? undefined : BigInt(o.checkpoint.omp_turn_id),
    },
    status:
      s || live
        ? {
            process: s?.process.state ?? (o.lifecycle.state === "live_exited" ? "exited" : "alive"),
            agent: s?.agent.state ?? "unknown",
            agentCorrelationId: corr,
            playbook: s?.playbook.state ?? "in_progress",
            playbookReason: s?.playbook.state === "failed" ? s.playbook.reason : "",
            adapter: s?.adapter ?? "unsupported",
            messageAdapter: s?.message_adapter ?? "unsupported",
            transport: o.transport ?? "",
          }
        : undefined,
    wait,
  });
  return create(EntitySchema, { key: sessionEntityKey(taskSlug, id), value: { case: "session", value: session } });
}

/** The Task entity a repo daemon holds for `slug`, with the board fields it derives. */
export function taskEntity(slug: string, over: MessageInitShape<typeof TaskSchema> = {}): Entity {
  const task = create(TaskSchema, { slug, name: slug, branch: slug, playbook: "superdevelop", created: 1n, ...over });
  return create(EntitySchema, { key: taskEntityKey(slug), value: { case: "task", value: task } });
}

/** The WatchTranscript frame for a transcript the test states in the pane's own shape: every item, replacing the client's list. */
export function transcriptFrame(t: VinculumTranscript | VinculumMessage[]) {
  const reply = Array.isArray(t) ? { messages: t } : t;
  const part = (p: Record<string, unknown>): MessageInitShape<typeof TranscriptPartSchema> => {
    if (p.type === "thinking") return { kind: { case: "thinking" as const, value: String(p.thinking ?? "") } };
    if (p.type === "redactedThinking") return { kind: { case: "redactedThinking" as const, value: {} } };
    if (p.type === "toolCall")
      return {
        kind: {
          case: "toolCall" as const,
          value: {
            id: p.id as string | undefined,
            name: p.name as string | undefined,
            arguments: p.arguments === undefined ? undefined : fromJson(ValueSchema, p.arguments as JsonValue),
          },
        },
      };
    return { kind: { case: "text" as const, value: String(p.text ?? "") } };
  };
  return create(WatchTranscriptResponseSchema, {
    items: reply.messages.map((m) => ({
      id: m.id ?? "",
      role: m.role,
      streaming: m.streaming === true,
      content: ((m.content as Record<string, unknown>[] | undefined) ?? [{ type: "text", text: m.text ?? "" }]).map(part),
      toolName: m.toolName ?? "",
      toolCallId: m.toolCallId ?? "",
      isError: m.isError === true,
      runningToolIds: m.runningToolIds ?? [],
    })),
    nextItem: BigInt(reply.messages.length),
    replace: true,
    controls: reply.model === undefined ? undefined : { model: reply.model, thinking: reply.thinking ?? "", thinkingLevels: reply.thinking_levels ?? [] },
  });
}

/** Serves every repo's sessions. `transport` is what `daemonTransport` should return. */
export function sessionDaemon() {
  const rows = new Map<string, Entity>(); // `${repo}\0${entity key}`
  const live = new Set<() => void>();
  const seq = { n: 1 };
  const version = { n: 0 };
  const matches = (scope: { kind: { case?: string; value?: unknown } }, key: string) => {
    const [k, slug, ...rest] = key.split("/");
    if (scope.kind.case === "session") {
      const ref = (scope.kind.value as { session?: { taskSlug: string; id: string } }).session;
      return k === "session" && slug === (ref?.taskSlug || "_") && rest.join("/") === ref?.id;
    }
    if (scope.kind.case === "task") return slug === (scope.kind.value as { slug: string }).slug;
    if (scope.kind.case === "repo") return ["task", "draft", "execution", "daemon", "job", "settings", "playbook"].includes(k);
    if (scope.kind.case === "chat") return k === "chat" || (k === "session" && slug === "_");
    return false;
  };
  // Sessions known by id alone, served under whatever task slug a subscription asks for: for tests that do not care which task or repo.
  const wild = new Map<string, SessionObservation>();
  const wildCache = new Map<string, Entity>();
  const wildRows = (scope: { kind: { case?: string; value?: unknown } }) => {
    const slug =
      scope.kind.case === "task"
        ? (scope.kind.value as { slug: string }).slug
        : scope.kind.case === "session"
          ? ((scope.kind.value as { session?: { taskSlug: string } }).session?.taskSlug ?? "")
          : "";
    return [...wild]
      .map(([id, o]) => {
        const key = `${slug}\u0000${id}`;
        const e = wildCache.get(key) ?? sessionEntity(slug, id, o);
        wildCache.set(key, e);
        return e;
      })
      .filter((e) => matches(scope, e.key));
  };
  // Transcripts by session id, in any repo. Setting one is a new frame for everyone watching it.
  const transcripts = new Map<string, VinculumTranscript | VinculumMessage[]>();
  const tver = { n: 0 };
  const transcriptCalls: string[] = []; // the session id of every WatchTranscript call
  const sessions: ServiceImpl<typeof SessionService> = {
    async *watchTranscript(req, ctx) {
      transcriptCalls.push(req.session?.id ?? "");
      let seen = -1;
      for (;;) {
        if (tver.n !== seen) {
          seen = tver.n;
          const t = transcripts.get(req.session?.id ?? "");
          if (t) yield transcriptFrame(t);
        }
        if (tver.n === seen) await Promise.race([untilAborted(ctx.signal), new Promise<void>((r) => live.add(r))]);
        if (ctx.signal.aborted) return;
      }
    },
  };
  const subscribed: { requests: number } = { requests: 0 };
  const down = new Set<string>(); // repos whose daemon does not answer
  const transports = new Map<string, Transport>();
  const transport = (repo: string): Transport => {
    let t = transports.get(repo);
    if (!t) {
      const { sync } = scriptedSync(async function* (req, _call, signal): AsyncGenerator<SubscribeResponse> {
        subscribed.requests += 1;
        if (down.has(repo)) throw new Error(`daemon for ${repo} is down`);
        const mine = () => {
          const own = [...rows].filter(([k, e]) => k.startsWith(`${repo}\u0000`) && matches(req.scope as never, e.key)).map(([, e]) => e);
          const have = new Set(own.map((e) => e.key));
          return [...own, ...wildRows(req.scope as never).filter((e) => !have.has(e.key))];
        };
        let known = new Map(mine().map((e) => [e.key, e]));
        yield snapshot([...known.values()], seq.n);
        let seen = version.n;
        for (;;) {
          if (version.n === seen) await Promise.race([untilAborted(signal), new Promise<void>((r) => live.add(r))]);
          if (signal.aborted) return;
          if (down.has(repo)) throw new Error(`daemon for ${repo} went down`);
          seen = version.n;
          for (const e of mine()) {
            if (known.get(e.key) !== e) yield put(e, ++seq.n);
          }
          known = new Map(mine().map((e) => [e.key, e]));
        }
      });
      t = daemonHarness({ sync, sessions }).transport as Transport;
      transports.set(repo, t);
    }
    return t;
  };
  const wake = () => {
    version.n += 1;
    const w = [...live];
    live.clear();
    for (const r of w) r();
  };
  return {
    transport,
    subscribed,
    transcriptCalls,
    /** What WatchTranscript serves for one session, in any repo. Calling it again is a change the watchers receive. */
    setTranscript(id: string, t: VinculumTranscript | VinculumMessage[]) {
      transcripts.set(id, t);
      tver.n += 1;
      const wake = [...live];
      live.clear();
      for (const r of wake) r();
    },
    /** One session by id alone, in any repo and under any task slug. */
    showId(id: string, o: SessionObservation) {
      wild.set(id, o);
      for (const k of [...wildCache.keys()]) if (k.endsWith(`\u0000${id}`)) wildCache.delete(k);
      version.n += 1;
      const wake = [...live];
      live.clear();
      for (const r of wake) r();
    },
    /** Set (or change, when subscribers already hold it) one task row of a repo. */
    showTask(repo: string, slug: string, over: MessageInitShape<typeof TaskSchema> = {}) {
      rows.set(`${repo}\u0000${taskEntityKey(slug)}`, taskEntity(slug, over));
      wake();
    },
    /** The repo's daemon stops answering: open streams error and new ones are refused until `up`. */
    drop(repo: string) {
      down.add(repo);
      wake();
    },
    up(repo: string) {
      down.delete(repo);
      wake();
    },
    /** Set (or change, when subscribers already hold it) one session. */
    show(repo: string, taskSlug: string, id: string, o: SessionObservation, wait?: { kind: string; correlationId: string }) {
      rows.set(`${repo}\u0000${sessionEntityKey(taskSlug, id)}`, sessionEntity(taskSlug, id, o, wait));
      version.n += 1;
      const wake = [...live];
      live.clear();
      for (const r of wake) r();
    },
  };
}
