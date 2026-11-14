// The task writes (plan S4.3): create, duplicate, rename, archive, restore, auto-approve, related tasks, drafts and the
// uploads that attachments travel in. What `create_task_for_repo`, `duplicate_task_for_repo`, `archive_task_for_repo`,
// `write_draft_for_repo` and their neighbours answered is answered here from the daemon's TaskService, DraftService and
// BlobService; the shapes are the ones the views have always read.
//
// Files travel through BlobService, never as a path: the shell reads a picked file's bytes (`read_local_file`), this
// module cuts them into chunks and uploads them to the daemon's staging area, and CreateTask names the staged uploads.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { type BlobRef, BlobRefSchema, BlobService } from "alinery-proto/alinery/v1/blobs_pb";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import type { Task as TaskProto } from "alinery-proto/alinery/v1/entities_pb";
import { CreateTaskRequestSchema, DraftService, TaskService, WriteDraftRequestSchema } from "alinery-proto/alinery/v1/tasks_pb";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import type { CreateTaskRequest, CreateTaskResult, DraftAttachments, PreparedTaskAttachments, RelatedTaskRef, Task, TaskAttachment } from "../types";
import { boardTaskFromProto } from "./board";
import { acquireScope, REPO_SCOPE } from "./hooks";
import { newMutationMeta } from "./mutation";
import { showPendingTask } from "./pendingTasks";

/** The clients, replaceable by a test (a fake transport stands in for the daemon). */
export const taskApi = {
  tasks: (repo: string) => createClient(TaskService, daemonTransport(repo)),
  drafts: (repo: string) => createClient(DraftService, daemonTransport(repo)),
  blobs: (repo: string) => createClient(BlobService, daemonTransport(repo)),
};

/** A write over a row that moved on: the view should show the newer values and say so. */
export class TaskConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskConflict";
  }
}

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const err = ConnectError.from(e);
    if (err.code === Code.Aborted) throw new TaskConflict(err.rawMessage);
    throw new Error(err.rawMessage);
  }
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SET_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

const taskOf = (t: TaskProto | undefined, repo: string): Task => {
  if (!t) throw new Error("the daemon returned no task");
  return boardTaskFromProto(t, repo);
};

// ---- uploads --------------------------------------------------------------------------------------------

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export type Target = { kind: "staged" } | { kind: "attachment"; taskSlug: string } | { kind: "chat"; threadId: string };

/** Uploads `bytes` in chunks and returns the committed ref's name and (for a staged file) its upload id. */
export async function upload(repo: string, target: Target, name: string, bytes: Uint8Array): Promise<{ name: string; uploadId: string }> {
  const blobs = taskApi.blobs(repo);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const ref = create(BlobRefSchema, {
    target:
      target.kind === "staged"
        ? { case: "staged", value: { name } }
        : target.kind === "chat"
          ? { case: "chatAttachment", value: { threadId: target.threadId, name } }
          : { case: "attachment", value: { taskSlug: target.taskSlug, name } },
  });
  const begun = await call(() => blobs.beginUpload({ meta: newMutationMeta(), target: ref, size: BigInt(bytes.length), sha256 }));
  const size = begun.chunkSize || CHUNK_BYTES;
  for (let offset = 0; offset < bytes.length; offset += size) {
    const data = bytes.subarray(offset, offset + size);
    await call(() => blobs.uploadChunk({ uploadId: begun.uploadId, offset: BigInt(offset), data }));
  }
  const committed = await call(() => blobs.commitUpload({ uploadId: begun.uploadId }));
  const done = committed.ref?.target;
  if (done?.case === "staged") return { name: done.value.name, uploadId: done.value.uploadId };
  if (done?.case === "attachment" || done?.case === "chatAttachment") return { name: done.value.name, uploadId: "" };
  throw new Error(`${name} - the daemon did not confirm the upload`);
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Picked or dropped entries: a URL is recorded, a file is read here and staged on the daemon. A file that cannot be read,
 * is too large, or would push the set over its limit is reported as `<entry> - <why>` and the rest still go.
 */
export async function prepareTaskAttachments(repo: string, entries: string[]): Promise<PreparedTaskAttachments> {
  const out: PreparedTaskAttachments = { attachments: [], attachment_urls: [], attachment_errors: [] };
  let total = 0;
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("http://") || entry.startsWith("https://")) {
      out.attachment_urls.push(entry);
      continue;
    }
    try {
      const bytes = new Uint8Array(await ipc.readLocalFile(entry));
      if (bytes.length > MAX_FILE_BYTES) throw new Error("larger than 25 MB");
      if (total + bytes.length > MAX_SET_BYTES) throw new Error("attachment set would exceed 100 MB");
      const name = entry.split(/[\\/]/).pop() ?? entry;
      const staged = await upload(repo, { kind: "staged" }, name, bytes);
      total += bytes.length;
      out.attachments.push({ name: staged.name, upload_id: staged.uploadId });
    } catch (e) {
      out.attachment_errors.push(`${entry} - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Bytes the person produced in the window (a pasted image, a file from a Linear issue) go to the same staging area. */
async function stageAttachment(repo: string, a: CreateTaskRequest["attachments"] extends (infer A)[] | undefined ? A : never) {
  if ("upload_id" in a) return { name: a.name, uploadId: a.upload_id };
  const staged = await upload(repo, { kind: "staged" }, a.name, fromBase64((a as TaskAttachment).bytes));
  return { name: staged.name, uploadId: staged.uploadId };
}

/** A file added to an existing task (a chat attachment). The reply is the name it was stored under. */
export async function addTaskAttachment(repo: string, taskSlug: string, name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${name} - larger than 25 MB`);
  return (await upload(repo, { kind: "attachment", taskSlug }, name, bytes)).name;
}

/** `copy_chat_attachments`: each path is read here and uploaded to the task; failures are listed and the rest still go. */
export async function copyTaskAttachments(repo: string, taskSlug: string, paths: string[]): Promise<{ copied: string[]; failures: string[] }> {
  const copied: string[] = [];
  const failures: string[] = [];
  for (const raw of paths) {
    const entry = raw.trim();
    if (!entry || entry.startsWith("http://") || entry.startsWith("https://")) continue;
    try {
      const bytes = new Uint8Array(await ipc.readLocalFile(entry));
      copied.push(await addTaskAttachment(repo, taskSlug, entry.split(/[\\/]/).pop() ?? entry, bytes));
    } catch (e) {
      failures.push(`${entry} - ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { copied, failures };
}

/** The bytes of an attachment of a task, whole. */
export async function readAttachmentBytes(repo: string, taskSlug: string, name: string): Promise<Uint8Array> {
  return readBlob(repo, create(BlobRefSchema, { target: { case: "attachment", value: { taskSlug, name } } }));
}

/** The bytes of a blob, whole; `max` stops the read one byte past it, so a caller can refuse a file without pulling all of it. */
export async function readBlob(repo: string, ref: ReturnType<typeof create<typeof BlobRefSchema>>, max = 0): Promise<Uint8Array> {
  return (await readBlobSized(repo, ref, max)).bytes;
}

/** `readBlob` plus the blob's whole size, which the daemon sends even when `max` cut the read short. */
export async function readBlobSized(repo: string, ref: ReturnType<typeof create<typeof BlobRefSchema>>, max = 0): Promise<{ bytes: Uint8Array; total: number }> {
  const parts: Uint8Array[] = [];
  let length = 0;
  let total = 0;
  for await (const chunk of taskApi.blobs(repo).readBlob({ ref, offset: 0n, length: max > 0 ? BigInt(max + 1) : 0n })) {
    parts.push(chunk.data);
    length += chunk.data.length;
    if (chunk.total) total = Number(chunk.total);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { bytes: out, total: Math.max(total, length) };
}

/** ponytail: the most a file preview reads into memory, for the preview or a saved copy; past it the user opens the file. */
export const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;

/** A file's bytes for its preview, up to `MAX_PREVIEW_BYTES`; `total` says whether that was all of it. */
export function readPreviewBytes(repo: string, ref: BlobRef): Promise<{ bytes: Uint8Array; total: number }> {
  return call(() => readBlobSized(repo, ref, MAX_PREVIEW_BYTES));
}

/** The PDF LibreOffice draws of a presentation `source` on the repository's machine (FAILED_PRECONDITION without it). */
export function readRenderedPdf(repo: string, source: BlobRef): Promise<Uint8Array> {
  return call(() => readBlob(repo, create(BlobRefSchema, { target: { case: "renderedPdf", value: { source } } }), MAX_PREVIEW_BYTES));
}

// ---- create, duplicate --------------------------------------------------------------------------------

function resultOf(
  repo: string,
  created: import("alinery-proto/alinery/v1/tasks_pb").TaskCreated | undefined,
  applied: Cursor | undefined,
  attachmentErrors: string[],
): CreateTaskResult {
  if (!created) throw new Error("the daemon returned no result");
  const task = created.task ? taskOf(created.task, repo) : null;
  // The card shows at once; the stream's own row replaces it.
  if (task) showPendingTask(repo, boardTaskFromProto(created.task as TaskProto, repo), applied);
  return {
    task,
    sessions: created.sessions as never,
    executions: created.executions as never,
    creation: created.creation as CreateTaskResult["creation"],
    start: created.start as CreateTaskResult["start"],
    errors: created.errors.map((e) => ({ stage: e.stage, code: e.code, message: e.message })),
    attachment_errors: attachmentErrors,
  };
}

export async function createTaskForRepo(a: { repoPath: string; request: CreateTaskRequest }): Promise<CreateTaskResult> {
  const { repoPath: repo, request: r } = a;
  const staged = [];
  for (const attachment of r.attachments ?? []) staged.push(await stageAttachment(repo, attachment));
  const request = create(CreateTaskRequestSchema, {
    meta: newMutationMeta(),
    name: r.name,
    draftSlug: r.draft_slug ?? "",
    requestedSlug: r.requested_slug ?? "",
    description: r.description ?? "",
    evidence: r.evidence ?? "",
    attachments: staged.map((s) => ({ name: s.name, uploadId: s.uploadId })),
    attachmentUrls: r.attachment_urls ?? [],
    attachmentErrors: r.attachment_errors ?? [],
    linearId: r.linear_id ?? "",
    githubIssue: r.github_issue ?? "",
    relatedTasks: (r.related_tasks ?? []).map((t) => ({ repoPath: t.repo_path, slug: t.slug, name: t.name })),
    playbookRef: { scope: r.playbook.reference.scope, key: r.playbook.reference.key },
    playbookSource: r.playbook.source,
    branchName: r.branch_name ?? undefined,
    worktreeName: r.worktree_name ?? undefined,
    baseRef: r.base_ref ?? undefined,
    launchDefaults: r.launch_defaults ? { harness: r.launch_defaults.harness, model: r.launch_defaults.model } : undefined,
    autoAdvance: r.auto_advance_steps ? { steps: r.auto_advance_steps } : undefined,
    stepModels: r.step_models ?? {},
    maxLiveSessions: r.max_live_sessions ?? undefined,
    start: r.start,
  });
  const reply = await call(() => taskApi.tasks(repo).createTask(request));
  return resultOf(repo, reply.created, reply.applied?.cursor, r.attachment_errors ?? []);
}

export async function duplicateTaskForRepo(repo: string, sourceSlug: string): Promise<CreateTaskResult> {
  const reply = await call(() => taskApi.tasks(repo).duplicateTask({ meta: newMutationMeta(), sourceSlug }));
  return resultOf(repo, reply.created, reply.applied?.cursor, []);
}

// ---- the small writes -------------------------------------------------------------------------------------

export async function renameTask(repo: string, slug: string, name: string): Promise<Task> {
  const reply = await call(() => taskApi.tasks(repo).renameTask({ meta: newMutationMeta(), slug, name, expectedRevision: 0n }));
  return taskOf(reply.task, repo);
}

/** Archive a task. The daemon runs the pre-archive backup first when it is switched on: if that fails the task stays as it was and the error is the caller's. */
export async function archiveTaskForRepo(repo: string, slug: string): Promise<void> {
  await call(() => taskApi.tasks(repo).archiveTask({ meta: newMutationMeta(), slug, expectedRevision: 0n }));
}

export async function restoreTaskForRepo(repo: string, slug: string): Promise<void> {
  await call(() => taskApi.tasks(repo).restoreTask({ meta: newMutationMeta(), slug, expectedRevision: 0n }));
}

export async function setAutoApproveAllForRepo(repo: string, slug: string, enabled: boolean): Promise<Task> {
  const reply = await call(() => taskApi.tasks(repo).setAutoApproveAll({ meta: newMutationMeta(), slug, enabled, expectedRevision: 0n }));
  return taskOf(reply.task, repo);
}

export async function setRelatedTasksForRepo(repo: string, slug: string, related: RelatedTaskRef[]): Promise<Task> {
  const reply = await call(() =>
    taskApi
      .tasks(repo)
      .setRelatedTasks({ meta: newMutationMeta(), slug, related: related.map((t) => ({ repoPath: t.repo_path, slug: t.slug, name: t.name })), expectedRevision: 0n }),
  );
  return taskOf(reply.task, repo);
}

/** Whether the recorded worktree of a task is still on disk (it can go away outside the app, which no stream sees). */
export async function worktreeExists(repo: string, slug: string): Promise<boolean> {
  return (await call(() => taskApi.tasks(repo).worktreeExists({ slug }))).exists;
}

// ---- drafts ---------------------------------------------------------------------------------------------

export type WriteDraftArgs = {
  repoPath: string;
  name: string;
  taskSlug: string;
  description: string;
  evidence: string;
  linearId: string;
  githubIssue: string;
  playbook: { scope: string; key: string };
  harness: string;
  model: string;
  autoAdvance?: string[] | null;
  stepModels?: Record<string, string> | null;
  maxLiveSessions: number;
  branchName: string;
  worktreeName: string;
  draftSlug: string;
  draftBaseRef?: string | null;
  draftAttachments?: DraftAttachments;
};

export async function writeDraftForRepo(a: WriteDraftArgs): Promise<Task> {
  const request = create(WriteDraftRequestSchema, {
    meta: newMutationMeta(),
    draftSlug: a.draftSlug,
    taskSlug: a.taskSlug,
    name: a.name,
    description: a.description,
    evidence: a.evidence,
    linearId: a.linearId,
    githubIssue: a.githubIssue,
    playbook: { scope: a.playbook.scope, key: a.playbook.key },
    launch: { harness: a.harness, model: a.model },
    autoAdvance: a.autoAdvance ? { steps: a.autoAdvance } : undefined,
    stepModels: a.stepModels ?? {},
    maxLiveSessions: a.maxLiveSessions,
    branchName: a.branchName,
    worktreeName: a.worktreeName,
    draftBaseRef: a.draftBaseRef ?? undefined,
    writeAttachments: a.draftAttachments !== undefined,
    attachmentEntries: a.draftAttachments?.entries ?? [],
    images: (a.draftAttachments?.images ?? []).map((i) => ({ name: i.name, mimeType: i.mime_type, bytes: fromBase64(i.bytes) })),
  });
  const reply = await call(() => taskApi.drafts(a.repoPath).writeDraft(request));
  return taskOf(reply.task, a.repoPath);
}

export async function deleteDraftForRepo(repo: string, slug: string): Promise<void> {
  await call(() => taskApi.drafts(repo).deleteDraft({ meta: newMutationMeta(), slug }));
}

/** The attachment entries and pasted images a draft kept: the row names them, BlobService has the images' bytes. */
export async function readDraftAttachmentsForRepo(repo: string, slug: string, timeoutMs = 3000): Promise<DraftAttachments> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  try {
    const row = await new Promise<Awaited<ReturnType<typeof draftRow>>>((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => (off(), reject(new Error(`the daemon for ${repo} did not answer`))), timeoutMs);
      const read = () => {
        if (!replica.ready) return;
        clearTimeout(timer);
        off();
        resolve(draftRow(replica.get(`draft/${slug}/${slug}`)));
      };
      off = replica.listen(read);
      read();
    });
    const images = [];
    for (const i of row.images) {
      const bytes = await readBlob(repo, create(BlobRefSchema, { target: { case: "draftImage", value: { draftSlug: slug, name: i.name } } }));
      images.push({ name: i.name, bytes: toBase64(bytes), mime_type: i.mimeType });
    }
    return { entries: row.entries, images };
  } finally {
    release();
  }
}

function draftRow(e: import("alinery-proto/alinery/v1/entities_pb").Entity | undefined) {
  return e?.value.case === "draft"
    ? { entries: [...e.value.value.entries], images: e.value.value.images.map((i) => ({ name: i.name, mimeType: i.mimeType })) }
    : { entries: [] as string[], images: [] as { name: string; mimeType: string }[] };
}
