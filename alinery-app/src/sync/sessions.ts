// The session writes and reads (plan S4.4): create, start, rename, archive, kill, notification marks, the scrollback and
// the OMP journal. What `rename_session`, `archive_session`, `create_session_for_repo`, `kill_session_for_repo`,
// `read_session_history` and their neighbours answered is answered here from the daemon's SessionService; the shapes
// are the ones the views have always read.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { SessionRefSchema } from "alinery-proto/alinery/v1/entities_pb";
import { type SessionControls as SessionControlsMessage, SessionService, type SessionStarted } from "alinery-proto/alinery/v1/sessions_pb";
import type { SessionControls } from "../chatTranscript";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import type { CreateExecutionSessionReply, CreateExecutionSessionRequest, SessionMeta, SessionName, SessionNameSource, SessionNotificationClearRef } from "../types";
import { newMutationMeta } from "./mutation";

/** The client, replaceable by a test (a fake transport stands in for the daemon). */
export const sessionApi = {
  sessions: (repo: string) => createClient(SessionService, daemonTransport(repo)),
};

/** A write over a row that moved on: the view should show the newer values and say so. */
export class SessionConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConflict";
  }
}

export async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const err = ConnectError.from(e);
    if (err.code === Code.Aborted) throw new SessionConflict(err.rawMessage);
    throw new Error(err.rawMessage);
  }
}

const ref = (taskSlug: string, id: string) => create(SessionRefSchema, { taskSlug, id });

/** The reply the views read: the session's meta, its execution, how the start went. */
export function startedOf(started: SessionStarted | undefined): CreateExecutionSessionReply {
  if (!started) throw new Error("the daemon returned no session");
  return {
    session: started.session as unknown as CreateExecutionSessionReply["session"],
    execution: (started.execution ?? null) as unknown as CreateExecutionSessionReply["execution"],
    start: started.start,
    errors: started.errors.map((e) => ({ stage: e.stage, code: e.code, message: e.message })),
  };
}

export async function createSession(repo: string, request: CreateExecutionSessionRequest): Promise<CreateExecutionSessionReply> {
  const t = request.target;
  const reply = await call(() =>
    sessionApi.sessions(repo).createSession({
      meta: newMutationMeta(),
      taskSlug: request.task_slug,
      target:
        t.kind === "primary"
          ? {
              case: "primary",
              value: { stepKey: t.step_key, executionId: t.execution_id ?? undefined, inputOccurrences: t.input_occurrence_ids ? { ids: t.input_occurrence_ids } : undefined },
            }
          : { case: "auxiliary", value: { harness: t.harness, model: t.model ?? undefined, prompt: t.prompt ?? undefined } },
      launchOverride: request.launch_override ? { harness: request.launch_override.harness, model: request.launch_override.model } : undefined,
      promptExtra: request.prompt_extra ?? undefined,
      handoffArtifact: request.handoff_artifact ?? undefined,
      start: request.start,
    }),
  );
  return startedOf(reply.started);
}

export async function startSession(repo: string, taskSlug: string, sessionId: string): Promise<CreateExecutionSessionReply> {
  const reply = await call(() => sessionApi.sessions(repo).startSession({ meta: newMutationMeta(), taskSlug, sessionId }));
  return startedOf(reply.started);
}

export async function renameSession(a: { repoPath: string; taskSlug: string; sessionId: string; name: string }): Promise<SessionName> {
  const reply = await call(() =>
    sessionApi.sessions(a.repoPath).renameSession({ meta: newMutationMeta(), session: ref(a.taskSlug, a.sessionId), name: a.name, expectedRevision: 0n }),
  );
  return { name: reply.name, source: reply.source as SessionNameSource };
}

/** The archived stamp is written before the process is stopped, so a view sees `archived` before the exit. */
export async function archiveSession(repo: string, taskSlug: string, id: string): Promise<void> {
  await call(() => sessionApi.sessions(repo).archiveSession({ meta: newMutationMeta(), session: ref(taskSlug, id) }));
}

export async function killSession(repo: string, id: string, taskSlug: string): Promise<void> {
  await call(() => sessionApi.sessions(repo).killSession({ meta: newMutationMeta(), session: ref(taskSlug, id) }));
}

/** The completion and the failed-exit notification of one session, both marked read. */
export async function markSessionNotificationRead(repo: string, taskSlug: string, id: string): Promise<void> {
  await call(() => sessionApi.sessions(repo).clearNotifications({ meta: newMutationMeta(), sessions: [{ session: ref(taskSlug, id) }], exitOnly: false }));
}

/** Each ref is marked read in its own repo's daemon; the suppression a person chose is kept with it. */
export async function clearSessionNotifications(refs: SessionNotificationClearRef[]): Promise<void> {
  const byRepo = new Map<string, SessionNotificationClearRef[]>();
  for (const r of refs) byRepo.set(r.repo_path, [...(byRepo.get(r.repo_path) ?? []), r]);
  for (const [repo, group] of byRepo) {
    await call(() =>
      sessionApi.sessions(repo).clearNotifications({
        meta: newMutationMeta(),
        sessions: group.map((r) => ({
          session: ref(r.task_slug, r.id),
          suppression: r.notification_suppression ? { notice: r.notification_suppression.notice, occurrence: r.notification_suppression.occurrence } : undefined,
        })),
        exitOnly: false,
      }),
    );
  }
}

/** The recorded scrollback: a window of raw bytes with `offset` and `limit`, else the tail the replay shows. */
export async function readSessionHistory(repo: string, a: { id: string; taskSlug?: string | null; offset?: number | null; limit?: number | null }): Promise<ArrayBuffer> {
  const reply = await call(() =>
    sessionApi.sessions(repo).readHistory({
      session: ref(a.taskSlug ?? "", a.id),
      offset: a.offset == null ? undefined : BigInt(a.offset),
      limit: a.limit == null ? undefined : BigInt(a.limit),
    }),
  );
  return reply.data.buffer.slice(reply.data.byteOffset, reply.data.byteOffset + reply.data.byteLength) as ArrayBuffer;
}

/** One backward page of the OMP journal in the framing `decodeOmpPage` reads: a JSON header line, then the window. */
export async function readSessionOmp(repo: string, a: { id: string; taskSlug?: string | null; end?: number | null; want?: number | null }): Promise<ArrayBuffer> {
  const w = await call(() =>
    sessionApi.sessions(repo).readOmpWindow({
      session: ref(a.taskSlug ?? "", a.id),
      end: a.end == null ? undefined : BigInt(a.end),
      want: a.want == null ? undefined : BigInt(a.want),
    }),
  );
  const header = new TextEncoder().encode(`${JSON.stringify({ start: Number(w.start), end: Number(w.end), length: Number(w.length) })}\n`);
  const out = new Uint8Array(header.length + w.data.length);
  out.set(header, 0);
  out.set(w.data, header.length);
  return out.buffer;
}

export async function sessionArtifactReady(repo: string, id: string, taskSlug: string): Promise<boolean> {
  return (await call(() => sessionApi.sessions(repo).artifactReady({ session: ref(taskSlug, id) }))).ready;
}

// ---- the turn controls and the process (S5.3) -------------------------------------------------------------------------

/** The model and thinking level the next turn will use, as the views read them. */
export const controlsOf = (c: SessionControlsMessage | undefined): SessionControls => ({
  model: c?.model ?? "",
  thinking: c?.thinking ?? "",
  thinking_levels: c?.thinkingLevels ?? [],
  context_tokens: c?.contextTokens ?? 0,
  context_window: c?.contextWindow ?? 0,
});

/** A message to the harness of a live session. */
export async function promptSession(repo: string, id: string, text: string): Promise<void> {
  await call(() => sessionApi.sessions(repo).promptSession({ meta: newMutationMeta(), sessionId: id, text }));
}

export async function abortSession(repo: string, id: string): Promise<void> {
  await call(() => sessionApi.sessions(repo).abortSession({ sessionId: id }));
}

export async function setSessionModel(repo: string, id: string, model: string): Promise<SessionControls> {
  return controlsOf((await call(() => sessionApi.sessions(repo).setSessionModel({ meta: newMutationMeta(), sessionId: id, model }))).controls);
}

export async function setSessionThinkingLevel(repo: string, id: string, level: string): Promise<SessionControls> {
  return controlsOf((await call(() => sessionApi.sessions(repo).setSessionThinkingLevel({ meta: newMutationMeta(), sessionId: id, level }))).controls);
}

export type OpenSessionArgs = {
  id: string;
  cwd: string;
  taskSlug?: string | null;
  phase?: string | null;
  model?: string | null;
  /** What the session runs, for the hosted-inference refresh only; the daemon gates the open from the session's own meta. */
  harness?: string | null;
  intent?: string | null;
  resumeToken?: string | null;
  cols?: number | null;
  rows?: number | null;
};

const INTENTS = ["attach", "spawn", "resume"];

/**
 * Start a session's process (spawn or resume) in `cwd`, or re-check that it runs (attach). The bytes are not this call's business:
 * the terminal attaches with TerminalService.Attach, so a session keeps running in the background and switching back shows the
 * same process at its current screen. Hosted-inference credentials are refreshed on this machine first (the daemon reads them at
 * spawn), for every intent that can start a process.
 */
export async function openSession(repo: string, a: OpenSessionArgs): Promise<void> {
  const intent = a.intent ?? "spawn";
  if (!INTENTS.includes(intent)) throw new Error(`unknown session intent '${intent}'`);
  if (intent !== "attach") await ipc.prepareHostedInference(a.model ?? "", a.harness ?? undefined);
  await call(() =>
    sessionApi.sessions(repo).resumeSession({
      meta: newMutationMeta(),
      session: ref((a.taskSlug ?? "").trim(), a.id),
      intent,
      cwd: a.cwd,
      phase: a.phase ?? undefined,
      model: a.model ?? undefined,
      resumeToken: a.resumeToken ?? undefined,
      cols: a.cols ?? undefined,
      rows: a.rows ?? undefined,
    }),
  );
}

/** A shell with no task, for the drawer: created in the repo's daemon, started when its terminal opens. */
export async function createDrawerTerminal(repo: string): Promise<SessionMeta> {
  return (await createSession(repo, { task_slug: "", target: { kind: "auxiliary", harness: "no-harness", model: null, prompt: null }, start: false })).session;
}
