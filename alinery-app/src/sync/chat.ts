// Chat threads (plan S4.4). The rail is the chat scope of each open repo: a thread is its `session/_/<id>` row beside its
// `chat/_/<id>` row, so a thread another window made, a rename and an archive all show without a poll. The writes are
// ChatService calls; a thread's attachments and images travel through BlobService.
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { BlobRefSchema } from "alinery-proto/alinery/v1/blobs_pb";
import { ChatService } from "alinery-proto/alinery/v1/chat_pb";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import type { Canvas, Entity } from "alinery-proto/alinery/v1/entities_pb";
import { type Scope, ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionControls } from "../chatTranscript";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import { type ChatImage, type CopyChatAttachmentsResult, onRemoteHostConnected } from "../ipc";
import type { ChatThread, CreateExecutionSessionReply, SessionMeta } from "../types";
import { sessionDisplayOf } from "./board";
import { acquireScope, useEntity, useScope } from "./hooks";
import { newMutationMeta } from "./mutation";
import type { Replica } from "./replica";
import { call, controlsOf, startedOf } from "./sessions";
import { MAX_FILE_BYTES, readBlob, readBlobSized, upload } from "./tasks";

export const chatApi = {
  chat: (repo: string) => createClient(ChatService, daemonTransport(repo)),
};

export const CHAT_SCOPE: Scope = create(ScopeSchema, { kind: { case: "chat", value: {} } });

const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

// ---- the rail ----------------------------------------------------------------------------------------------

/** `list_chat_threads_in`: the repo's threads, a thread another continues left out, archived ones only when asked for. Pinned first, then newest. */
export function chatThreadsOf(repo: string, rows: Entity[], includeArchived: boolean): ChatThread[] {
  const rails = new Map<string, { branchLabel: string; checkout: boolean; superseded: boolean }>();
  for (const e of rows) if (e.value.case === "chatThread") rails.set(e.value.value.id, e.value.value);
  const out: ChatThread[] = [];
  for (const e of rows) {
    if (!e.key.startsWith("session/_/")) continue;
    const session = sessionDisplayOf(e);
    if (!session?.generic || (session.harness !== "vinculum" && session.harness !== "omp")) continue;
    const rail = rails.get(session.id);
    if (rail?.superseded || (session.archived && !includeArchived)) continue;
    const { name, name_source: _source, name_error: _error, ...meta } = session;
    out.push({ repo_path: repo, session: meta as SessionMeta, name: name ?? null, branch_label: rail?.branchLabel ?? "", checkout: rail?.checkout ?? true });
  }
  return sortChatThreads(out);
}

export function sortChatThreads(threads: ChatThread[]): ChatThread[] {
  return threads.sort(
    (a, b) =>
      Number(b.session.pinned) - Number(a.session.pinned) || b.session.created - a.session.created || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0),
  );
}

/** The threads of these repos, kept current by one chat-scope stream each while the component is mounted. */
export function useChatThreads(repos: string[] | undefined, includeArchived: boolean): ChatThread[] {
  const [held, setHeld] = useState<{ repo: string; replica: Replica }[]>([]);
  const [version, setVersion] = useState(0);
  const key = JSON.stringify(repos ?? []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for repos
  useEffect(() => {
    const mine = (JSON.parse(key) as string[]).map((repo) => ({ repo, ...acquireScope(repo, CHAT_SCOPE) }));
    setHeld(mine.map(({ repo, replica }) => ({ repo, replica })));
    const offs = mine.map((m) => m.replica.listen(() => setVersion((v) => v + 1)));
    setVersion((v) => v + 1);
    return () => {
      for (const off of offs) off();
      for (const m of mine) m.release();
      setHeld([]);
    };
  }, [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the replicas' change counter
  return useMemo(() => sortChatThreads(held.flatMap(({ repo, replica }) => chatThreadsOf(repo, replica.all(), includeArchived))), [held, version, includeArchived]);
}

/**
 * The repos Chat may use (open here, daemon attached), read when the view mounts or shows, when the window regains focus, when a
 * remote host connects and when `trigger` changes (the app's repo list). No timer: what lives inside those repos arrives by stream.
 */
export function useOpenChatRepos(active: boolean, trigger = ""): { repos: string[] | null; error: string } {
  const [state, setState] = useState<{ repos: string[] | null; error: string }>({ repos: null, error: "" });
  const read = useCallback(() => {
    ipc
      .listChatRepos()
      .then((next) => setState((prev) => (prev.error === "" && prev.repos?.join("\n") === next.join("\n") ? prev : { repos: next, error: "" })))
      .catch((cause: unknown) => setState((prev) => ({ repos: prev.repos, error: cause instanceof Error ? cause.message : String(cause) })));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger only asks for another read
  useEffect(() => {
    if (!active) return;
    read();
    window.addEventListener("focus", read);
    const off = onRemoteHostConnected(read);
    return () => {
      window.removeEventListener("focus", read);
      off();
    };
  }, [active, trigger, read]);
  return state;
}

/** Resolves once the repo's chat replica has the write at `applied` (or after `timeoutMs`; a slow stream is not a failed write). */
export function settled(repo: string, applied: Cursor | undefined, timeoutMs = 3000): Promise<void> {
  const { replica, release } = acquireScope(repo, CHAT_SCOPE);
  return new Promise<void>((resolve) => {
    let off = () => {};
    const done = () => {
      clearTimeout(timer);
      off();
      release();
      resolve();
    };
    const reached = () => replica.ready && (!applied || (replica.cursor !== undefined && (replica.cursor.epoch !== applied.epoch || replica.cursor.seq >= applied.seq)));
    const timer = setTimeout(done, timeoutMs);
    off = replica.listen(() => reached() && done());
    if (reached()) done();
  });
}

// ---- the writes --------------------------------------------------------------------------------------------

export async function createChatThread(a: { repoPath: string; model?: string | null; createWorktree: boolean }): Promise<CreateExecutionSessionReply> {
  await ipc.prepareHostedInference(a.model ?? "");
  const reply = await call(() => chatApi.chat(a.repoPath).createChatThread({ meta: newMutationMeta(), model: a.model ?? "", createWorktree: a.createWorktree }));
  await settled(a.repoPath, reply.applied?.cursor);
  return startedOf(reply.started);
}

export async function startChatThread(repo: string, threadId: string, model = ""): Promise<CreateExecutionSessionReply> {
  await ipc.prepareHostedInference(model);
  const reply = await call(() => chatApi.chat(repo).startChatThread({ meta: newMutationMeta(), threadId }));
  await settled(repo, reply.applied?.cursor);
  return startedOf(reply.started);
}

export async function setChatPinned(repo: string, threadId: string, pinned: boolean): Promise<void> {
  const reply = await call(() => chatApi.chat(repo).setChatPinned({ meta: newMutationMeta(), threadId, pinned }));
  await settled(repo, reply.applied?.cursor);
}

export async function archiveChatThread(repo: string, threadId: string, removeWorktree: boolean): Promise<void> {
  const reply = await call(() => chatApi.chat(repo).archiveChatThread({ meta: newMutationMeta(), threadId, removeWorktree }));
  await settled(repo, reply.applied?.cursor);
}

export async function removeChatWorktree(repo: string, threadId: string): Promise<void> {
  const reply = await call(() => chatApi.chat(repo).removeChatWorktree({ meta: newMutationMeta(), threadId }));
  await settled(repo, reply.applied?.cursor);
}

/** The id of the thread that continues this one (the thread itself is archived). */
export async function resumeChatThread(repo: string, threadId: string): Promise<string> {
  const reply = await call(() => chatApi.chat(repo).resumeChatThread({ meta: newMutationMeta(), threadId }));
  await settled(repo, reply.applied?.cursor);
  return reply.successorId;
}

// ---- the turn controls ---------------------------------------------------------------------------------------

export async function promptChatThread(repo: string, threadId: string, text: string): Promise<void> {
  await call(() => chatApi.chat(repo).promptChatThread({ meta: newMutationMeta(), threadId, text }));
}

export async function abortChatThread(repo: string, threadId: string): Promise<void> {
  await call(() => chatApi.chat(repo).abortChatThread({ threadId }));
}

export async function setChatModel(repo: string, threadId: string, model: string): Promise<SessionControls> {
  return controlsOf((await call(() => chatApi.chat(repo).setChatModel({ meta: newMutationMeta(), threadId, model }))).controls);
}

export async function setChatThinkingLevel(repo: string, threadId: string, level: string): Promise<SessionControls> {
  return controlsOf((await call(() => chatApi.chat(repo).setChatThinkingLevel({ meta: newMutationMeta(), threadId, level }))).controls);
}

// ---- attachments and images --------------------------------------------------------------------------------

/** A file the person dropped or pasted into a thread: the bytes go to the daemon, and the reply is the name they were stored under. */
export async function writeChatThreadAttachmentBytes(repo: string, threadId: string, fileName: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${fileName} - larger than 25 MB`);
  return (await upload(repo, { kind: "chat", threadId }, fileName, bytes)).name;
}

/** Each picked path is read here and uploaded to the thread; failures are listed and the rest still go. */
export async function copyChatThreadAttachments(repo: string, threadId: string, paths: string[]): Promise<CopyChatAttachmentsResult> {
  const copied: string[] = [];
  const failures: string[] = [];
  for (const raw of paths) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      const bytes = new Uint8Array(await ipc.readLocalFile(entry));
      copied.push(await writeChatThreadAttachmentBytes(repo, threadId, entry.split(/[\\/]/).pop() ?? entry, bytes));
    } catch (e) {
      failures.push(`${entry} - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { copied, failures };
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** `read_chat_image_file`: an image of at most 5 MB, with the type its name says. */
async function readImage(repo: string, ref: ReturnType<typeof create<typeof BlobRefSchema>>, name: string): Promise<ChatImage> {
  const mime = IMAGE_MIME[name.split(".").pop()?.toLowerCase() ?? ""];
  if (!mime) throw new Error(`${name} - not a chat image`);
  const bytes = await readBlob(repo, ref, MAX_CHAT_IMAGE_BYTES);
  if (bytes.length > MAX_CHAT_IMAGE_BYTES) throw new Error(`${name} - larger than 5 MB`);
  return { mime_type: mime, data: toBase64(bytes) };
}

export const readChatThreadImage = (repo: string, threadId: string, name: string) =>
  readImage(repo, create(BlobRefSchema, { target: { case: "chatAttachment", value: { threadId, name } } }), name);

/** An image attached to a message in a task's session. */
export const readChatImage = (repo: string, taskSlug: string, name: string) =>
  readImage(repo, create(BlobRefSchema, { target: { case: "attachment", value: { taskSlug, name } } }), name);

// ---- the thread canvas -------------------------------------------------------------------------------------

/** Turns the thread's canvas on for good (the daemon refuses an agent: APPROVE). */
export async function enableCanvas(repo: string, threadId: string): Promise<void> {
  const reply = await call(() => chatApi.chat(repo).enableCanvas({ meta: newMutationMeta(), threadId }));
  await settled(repo, reply.applied?.cursor);
}

/** The user closing a panel: recorded, so the agent reads that it was the user. */
export async function closeCanvasPanel(repo: string, threadId: string, panel: string): Promise<void> {
  const reply = await call(() => chatApi.chat(repo).closeCanvasPanel({ meta: newMutationMeta(), threadId, panel }));
  await settled(repo, reply.applied?.cursor);
}

/** The thread's canvas row, or undefined while it has none (not enabled). */
export function useCanvas(repo: string, threadId: string): Canvas | undefined {
  const entity = useEntity(useScope(repo, CHAT_SCOPE), `canvas/_/${threadId}`);
  return entity?.value.case === "canvas" ? entity.value.value : undefined;
}

const MAX_PANEL_BYTES = 1024 * 1024;

/** ponytail: the most a file panel reads into memory, for a preview or a saved copy; past it the user opens the file. */
export const MAX_CANVAS_FILE_BYTES = 100 * 1024 * 1024;

/** A file a `file` panel shows (`path` ignored) or a row of a `files` panel (`path` relative to its directory). */
export async function readCanvasFile(repo: string, threadId: string, panel: string, path: string, max = MAX_CANVAS_FILE_BYTES): Promise<{ bytes: Uint8Array; total: number }> {
  return call(() => readBlobSized(repo, create(BlobRefSchema, { target: { case: "canvasFile", value: { threadId, panel, path } } }), max));
}

/** One panel's body as text (the daemon caps a write at 1 MB). */
export async function readCanvasPanel(repo: string, threadId: string, panel: string): Promise<string> {
  const bytes = await readBlob(repo, create(BlobRefSchema, { target: { case: "canvasPanel", value: { threadId, panel } } }), MAX_PANEL_BYTES);
  return new TextDecoder().decode(bytes.subarray(0, MAX_PANEL_BYTES));
}
