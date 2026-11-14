import { fromJson, type JsonObject, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { CreateSessionRequest, SessionStartedSchema } from "alinery-proto/alinery/v1/sessions_pb";
import type { DraftImage } from "alinery-proto/alinery/v1/tasks_pb";
import { type SessionService, type TranscriptItemSchema, type WatchTranscriptResponseSchema } from "alinery-proto/alinery/v1/sessions_pb";
import type { ChatPublisher, ChatSessions } from "../domain/chat.ts";
import { readHistory, readVinculumWindow, sessionArtifactReady } from "../domain/history.ts";
import { clearSessionNotifications, type Json, setSessionName, stampSessionArchived } from "../domain/sessionOps.ts";
import { DomainError } from "../platform/lock.ts";
import type { Sender } from "../platform/telemetry.ts";
import { watchTranscript, type TranscriptFrame, type TranscriptFeed } from "../runtime/transcript.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import { sessionKey } from "../sync/parsers/sessionMeta.ts";
import type { Store } from "../sync/store.ts";
import type { TranscriptPart, TranscriptReply } from "../transcript.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

/** The session's transcript source, or undefined when it is not open in this daemon. */
export type Transcripts = (taskSlug: string, id: string) => Promise<TranscriptFeed | undefined>;

type Item = MessageInitShape<typeof TranscriptItemSchema>;

function part(p: TranscriptPart): NonNullable<Item["content"]>[number] {
  switch (p.type) {
    case "text":
      return { kind: { case: "text", value: p.text } };
    case "thinking":
      return { kind: { case: "thinking", value: p.thinking } };
    case "redactedThinking":
      return { kind: { case: "redactedThinking", value: {} } };
    case "toolCall":
      return {
        kind: {
          case: "toolCall",
          value: { id: p.id, name: p.name, ...(p.arguments === undefined ? {} : { arguments: fromJson(ValueSchema, p.arguments as JsonValue) }) },
        },
      };
  }
}

export function toItem(item: TranscriptReply): Item {
  return {
    id: item.id,
    role: item.role,
    streaming: item.streaming === true,
    content: item.content.map(part),
    toolName: item.toolName ?? "",
    toolCallId: item.toolCallId ?? "",
    isError: item.isError === true,
    runningToolIds: item.runningToolIds ?? [],
  };
}

export function toResponse(frame: TranscriptFrame): MessageInitShape<typeof WatchTranscriptResponseSchema> {
  return {
    items: frame.items.map(toItem),
    nextItem: BigInt(frame.nextItem),
    replace: frame.replace,
    ...(frame.controls ? controlsOf(frame.controls) : {}),
  };
}

/** An image part of a user message, as Pi takes it. */
export type PromptImage = { type: "image"; data: string; mimeType: string };

const PROMPT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// The composer's own limits (MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES); an image past them never left a composer.
const MAX_PROMPT_IMAGES = 4;
const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;

/** A prompt's images, checked: the four web image types, at most 4, each at most 5 MB. */
export function promptImages(images: readonly DraftImage[]): PromptImage[] {
  if (images.length > MAX_PROMPT_IMAGES) throw new DomainError("invalid_argument", `at most ${MAX_PROMPT_IMAGES} images`);
  return images.map((image) => {
    if (!PROMPT_IMAGE_TYPES.has(image.mimeType)) throw new DomainError("invalid_argument", `${image.name || "image"}: not a png, jpeg, gif or webp image`);
    if (image.bytes.length === 0 || image.bytes.length > MAX_PROMPT_IMAGE_BYTES) throw new DomainError("invalid_argument", `${image.name || "image"}: empty or larger than 5 MB`);
    return { type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType };
  });
}

/** The turn controls of a live harness session, the same for a task session and a chat thread. A refusal is a `DomainError`. */
export type TurnControl = {
  prompt(id: string, text: string, images?: PromptImage[]): Promise<void>;
  abort(id: string): Promise<void>;
  setModel(id: string, model: string): Promise<Controls>;
  setThinkingLevel(id: string, level: string): Promise<Controls>;
};
export type Controls = { model: string; thinking: string; thinking_levels: string[]; context_tokens?: number; context_window?: number };
export const controlsOf = (c: Controls) => ({
  controls: { model: c.model, thinking: c.thinking, thinkingLevels: c.thinking_levels, contextTokens: c.context_tokens ?? 0, contextWindow: c.context_window ?? 0 },
});

/** What the session writes need from the daemon: the files, the store, and the runner that owns the processes. */
export type SessionControl = {
  repo: string;
  /** Re-reads one file into the store, so a cursor read after the write covers it. */
  refresh: (rel: string) => Promise<void>;
  telemetry: Sender;
  /** Discarding a sub-task queues the automatic backup (S4.9). */
  backups?: { publish(trigger: "pre_archive"): void };
  chat: ChatPublisher;
  runner: ChatSessions;
  turns: TurnControl;
  /** Where the session's `telemetry_id` and its task's are. */
  telemetryIds: (slug: string, id: string) => { session: string; task: string };
};

export const metaRel = (slug: string, id: string) => `${slug ? `tasks/${slug}/` : ""}sessions/${id}.meta.json`;
export const nameRel = (slug: string, id: string) => `${slug ? `tasks/${slug}/` : ""}sessions/${id}.name.json`;

/** A runner reply that carries `error` is a refusal, not an answer. */
export function ranOrFail(reply: Json): Json {
  if (typeof reply.error === "string") throw new DomainError("failed_precondition", reply.error);
  return reply;
}

export function started(reply: Json): MessageInitShape<typeof SessionStartedSchema> {
  return {
    session: reply.session as JsonObject,
    ...(reply.execution ? { execution: reply.execution as JsonObject } : {}),
    start: String(reply.start ?? ""),
    errors: ((reply.errors ?? []) as { stage: string; code: string; message: string }[]).map((e) => ({ stage: e.stage, code: e.code, message: e.message })),
  };
}

/** The engine's JSON request for a `CreateSessionRequest` (alinery-core's `CreateExecutionSessionRequest`). */
export function createRequestJson(req: CreateSessionRequest): Json {
  const t = req.target;
  const target =
    t.case === "primary"
      ? { kind: "primary", step_key: t.value.stepKey, execution_id: t.value.executionId ?? null, input_occurrence_ids: t.value.inputOccurrences ? t.value.inputOccurrences.ids : null }
      : t.case === "auxiliary"
        ? { kind: "auxiliary", harness: t.value.harness, model: t.value.model ?? null, prompt: t.value.prompt ?? null }
        : t.case === "subtaskManager"
          ? { kind: "subtask_manager", subtask_slug: t.value.subtaskSlug ?? null, recover: t.value.recover, harness: t.value.harness, model: t.value.model ?? null }
          : undefined;
  if (!target) throw new DomainError("invalid_argument", "a session needs a target");
  return {
    task_slug: req.taskSlug,
    target,
    launch_override: req.launchOverride ? { harness: req.launchOverride.harness, model: req.launchOverride.model } : null,
    prompt_extra: req.promptExtra ?? null,
    handoff_artifact: req.handoffArtifact ?? null,
    start: req.start,
  };
}

export function sessionService(transcripts: Transcripts, control?: SessionControl, dedupe?: Dedupe, store?: Store): ServiceImpl<typeof SessionService> {
  const c = (): SessionControl => {
    if (!control || !dedupe || !store) throw fail(Code.Unimplemented, "unimplemented", "this daemon does not serve session writes");
    return control;
  };
  const applied = () => ({ cursor: (store as Store).cursor() });
  const once = <T>(meta: Parameters<typeof metaOf>[0], fn: () => Promise<T>) => (dedupe as Dedupe).once(metaOf(meta), () => domain(fn));
  const refSlug = (ref: { taskSlug: string } | undefined) => (ref?.taskSlug ?? "").trim();
  return {
    ...transcriptHandlers(transcripts),
    createSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const reply = ranOrFail(await c().runner.create(createRequestJson(req)));
        await c().refresh(metaRel(req.taskSlug, String((reply.session as Json).id)));
        if (req.taskSlug) await c().refresh(`tasks/${req.taskSlug}/execution.json`);
        return { applied: applied(), started: started(reply) };
      });
    },
    startSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const reply = ranOrFail(await c().runner.start({ task_slug: req.taskSlug, session_id: req.sessionId }));
        await c().refresh(metaRel(req.taskSlug, req.sessionId));
        if (req.taskSlug) await c().refresh(`tasks/${req.taskSlug}/execution.json`);
        return { applied: applied(), started: started(reply) };
      });
    },
    resumeSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const slug = refSlug(req.session);
        await c().runner.open({ op: req.intent, id: req.session?.id, cwd: req.cwd, task_slug: slug, phase: req.phase, model: req.model, resume_token: req.resumeToken, cols: req.cols, rows: req.rows });
        return { applied: applied() };
      });
    },
    renameSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const slug = refSlug(req.session);
        const id = req.session?.id ?? "";
        if (req.expectedRevision !== 0n) {
          await c().refresh(metaRel(slug, id));
          const row = (store as Store).get(sessionKey(slug, id));
          if (row?.revision !== req.expectedRevision) throw fail(Code.Aborted, "aborted", `session ${id} changed since revision ${req.expectedRevision} (now ${row?.revision ?? 0n})`);
        }
        const out = await setSessionName(c().repo, slug, id, req.name, "user");
        await c().refresh(nameRel(slug, id));
        await c().refresh(metaRel(slug, id));
        return { applied: applied(), name: out.value.name, source: out.value.source };
      });
    },
    archiveSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const slug = refSlug(req.session);
        const id = req.session?.id ?? "";
        if (!slug) throw new DomainError("invalid_argument", "sessions must be attached to a task");
        const live = c().runner.isRunning(id);
        const ids = c().telemetryIds(slug, id);
        // The stamp first and in the store before the process goes, so a subscriber sees `archived` before the exit.
        stampSessionArchived(c().repo, slug, id);
        await c().refresh(metaRel(slug, id));
        if (live) c().runner.stop(id);
        c().telemetry.record(() => ({ event: "session.archive", source: "alineryd", killedLive: live, sessionId: ids.session, taskId: ids.task }));
        return { applied: applied(), killedLive: live };
      });
    },
    killSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const slug = refSlug(req.session);
        const id = req.session?.id ?? "";
        const ids = c().telemetryIds(slug, id);
        c().runner.stop(id);
        c().telemetry.record(() => ({ event: "session.kill", source: "alineryd", sessionId: ids.session, taskId: ids.task }));
        return { applied: applied() };
      });
    },
    clearNotifications: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        const refs = req.sessions.map((r) => ({ slug: refSlug(r.session), id: r.session?.id ?? "", ...(r.suppression ? { suppression: { notice: r.suppression.notice, occurrence: r.suppression.occurrence } } : {}) }));
        clearSessionNotifications(c().repo, refs, req.exitOnly);
        for (const r of refs) await c().refresh(metaRel(r.slug, r.id));
        return { applied: applied() };
      });
    },
    readHistory: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => {
        const out = readHistory(c().repo, refSlug(req.session), req.session?.id ?? "", req.offset === undefined ? undefined : Number(req.offset), req.limit === undefined ? undefined : Number(req.limit));
        return { data: out.data, length: BigInt(out.length), nextOffset: BigInt(out.nextOffset), eof: out.eof };
      });
    },
    readVinculumWindow: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => {
        const w = readVinculumWindow(c().repo, refSlug(req.session), req.session?.id ?? "", req.end === undefined ? undefined : Number(req.end), req.want === undefined ? undefined : Number(req.want));
        return { data: w.data, start: BigInt(w.start), end: BigInt(w.end), length: BigInt(w.length) };
      });
    },
    artifactReady: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return { ready: sessionArtifactReady(c().repo, refSlug(req.session), req.session?.id ?? "") };
    },
    promptSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => {
        await c().turns.prompt(req.sessionId, req.text, promptImages(req.images));
        return {};
      });
    },
    abortSession: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return domain(async () => {
        await c().turns.abort(req.sessionId);
        return {};
      });
    },
    setSessionModel: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => controlsOf(await c().turns.setModel(req.sessionId, req.model)));
    },
    setSessionThinkingLevel: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return once(req.meta, async () => controlsOf(await c().turns.setThinkingLevel(req.sessionId, req.level)));
    },
  };
}

function transcriptHandlers(transcripts: Transcripts): Pick<ServiceImpl<typeof SessionService>, "watchTranscript"> {
  return {
    async *watchTranscript(req, ctx) {
      requireCapability(ctx, Capability.VIEW);
      if (!req.session?.id) throw new ConnectError("WatchTranscript needs a session", Code.InvalidArgument);
      const source = await transcripts(req.session.taskSlug, req.session.id);
      if (!source) throw new ConnectError(`no open session ${req.session.id}`, Code.NotFound);
      for await (const frame of watchTranscript(source, Number(req.fromItem), ctx.signal)) yield toResponse(frame);
    },
  };
}
