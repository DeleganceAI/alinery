// TaskService and DraftService (plan S4.3): the writes of a task's life. The read side is the `task/<slug>` and
// `draft/<slug>` entities. Each write is serialized with every other writer of the repository (the task-mutation lock),
// the file it changed is re-read into the store before the reply, so the reply's cursor already covers it, and a
// write that names `expected_revision` is checked against the row as the file is now (a mismatch is ABORTED).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { Task } from "alinery-proto/alinery/v1/entities_pb";
import type { DraftService, TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import type { BlobStore } from "../domain/blobs.ts";
import { deleteDraft, writeDraft } from "../domain/drafts.ts";
import { alineryDir, readTaskChecked } from "../domain/taskFiles.ts";
import { type AttachmentSource, archiveTask, type CreateReply, type CreateTaskParams, duplicatePackage, type Guard, provisionTask, renameTask, restoreTask, setAutoApproveAll, setRelatedTasks } from "../domain/tasks.ts";
import { writeAtomic } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import type { Sender } from "../platform/telemetry.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import { taskKey } from "../sync/parsers/task.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

/** What a create does after the files are in place: reserve sessions, or start the first step. The reply is JSON-shaped, as the engine's overlay builds it. */
export type AfterCreate = (reply: CreateReply, start: boolean) => Promise<{ sessions: JsonObject[]; executions: JsonObject[]; start: string; errors: CreateReply["errors"] }>;

export type TaskDeps = {
  repo: string;
  lane: string;
  identity: string;
  refresh: (rel: string) => Promise<void>;
  telemetry: Sender;
  blobs: BlobStore;
  afterCreate?: AfterCreate;
};

const passthrough: AfterCreate = async (reply) => ({ sessions: reply.sessions as JsonObject[], executions: reply.executions as JsonObject[], start: reply.start, errors: reply.errors });

/** Re-reads what a write changed, so a cursor read afterwards covers it. */
async function settleFiles(d: TaskDeps, slug: string, ...more: string[]) {
  for (const rel of [`tasks/${slug}/task.md`, ...more]) await d.refresh(rel);
}

/** The create both the TaskService and the legacy `create_task` wire op run: files, then sessions or the first step. */
async function runCreate(d: TaskDeps, params: CreateTaskParams, release: string[], draftSlug: string | undefined) {
  let reply: CreateReply;
  try {
    reply = await provisionTask(d, params);
  } finally {
    for (const id of release) d.blobs.release(id);
  }
  const slug = reply.task?.slug ?? "";
  const moved = draftSlug && draftSlug !== slug ? [`tasks/${draftSlug}/task.md`, `tasks/${draftSlug}/draft-attachments.json`] : [];
  await settleFiles(d, slug, `tasks/${slug}/execution.json`, `tasks/${slug}/draft-attachments.json`, ...moved);
  const after = d.afterCreate ?? passthrough;
  const tail = reply.creation === "ready" ? await after(reply, params.start) : { sessions: [], executions: [], start: reply.start, errors: reply.errors };
  await settleFiles(d, slug, `tasks/${slug}/execution.json`);
  return { reply, tail };
}

type WireRequest = Record<string, unknown> & {
  name: string;
  attachments?: { name: string; bytes: string }[];
  playbook: { reference: { scope: string; key: string }; source: string };
  launch_defaults?: { harness: string; model: string };
};

/**
 * The `create_task` op `alinery-mcp` still sends (plan: MCP stays on core's request shape until S5.1): the Rust
 * `CreateTaskRequest` as JSON, attachments inline as base64. The bytes are put in a scratch directory for the create
 * and removed after; the reply is the JSON `CreateTaskReply` the MCP tool returns.
 */
export async function createFromWire(d: TaskDeps, request: WireRequest): Promise<Record<string, unknown>> {
  if (typeof request.parent_task === "string" && request.parent_task !== "") return { error: "a sub-task is created by create_subtask" };
  const scratch = join(alineryDir(d.repo), "tmp", `wire-${randomUUID()}`);
  try {
    const attachments: AttachmentSource[] = [];
    for (const a of request.attachments ?? []) {
      const bytes = Buffer.from(a.bytes, "base64");
      mkdirSync(scratch, { recursive: true });
      const path = join(scratch, `${attachments.length}`);
      writeAtomic(path, bytes);
      attachments.push({ name: a.name, path, size: bytes.length });
    }
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const params: CreateTaskParams = {
      name: request.name,
      draftSlug: str(request.draft_slug),
      requestedSlug: str(request.requested_slug),
      description: str(request.description),
      evidence: str(request.evidence),
      attachments,
      originalTicket: str(request.original_ticket),
      attachmentUrls: (request.attachment_urls as string[] | undefined) ?? [],
      attachmentErrors: (request.attachment_errors as string[] | undefined) ?? [],
      linearId: str(request.linear_id),
      githubIssue: str(request.github_issue),
      relatedTasks: (request.related_tasks as CreateTaskParams["relatedTasks"]) ?? [],
      playbook: request.playbook,
      branchName: str(request.branch_name),
      worktreeName: str(request.worktree_name),
      baseRef: str(request.base_ref),
      launchDefaults: request.launch_defaults,
      autoAdvanceSteps: (request.auto_advance_steps as string[] | null | undefined) ?? undefined,
      stepModels: (request.step_models as Record<string, string> | undefined) ?? {},
      maxLiveSessions: (request.max_live_sessions as number | null | undefined) ?? undefined,
      start: request.start === true,
    };
    const { reply, tail } = await runCreate(d, params, [], params.draftSlug);
    return { task: reply.task, sessions: tail.sessions, executions: tail.executions, creation: reply.creation, start: tail.start, errors: tail.errors };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function taskService(d: TaskDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof TaskService> {
  const applied = () => ({ cursor: store.cursor() });
  const taskRow = (slug: string): Task | undefined => {
    const v = store.get(taskKey(slug))?.value;
    return v?.case === "task" ? v.value : undefined;
  };
  const settle = (slug: string, ...more: string[]) => settleFiles(d, slug, ...more);
  const guardFor = (slug: string, expected: bigint): Guard | undefined =>
    expected === 0n
      ? undefined
      : async () => {
          await d.refresh(`tasks/${slug}/task.md`);
          const row = store.get(taskKey(slug));
          if (row?.revision !== expected) throw fail(Code.Aborted, "aborted", `task ${slug} changed since revision ${expected} (now ${row?.revision ?? 0n})`);
        };
  async function create(params: CreateTaskParams, release: string[], draftSlug: string | undefined) {
    const { reply, tail } = await runCreate(d, params, release, draftSlug);
    const task = taskRow(reply.task?.slug ?? "");
    return {
      applied: applied(),
      created: {
        task,
        creation: reply.creation,
        start: tail.start,
        errors: tail.errors,
        sessions: tail.sessions,
        executions: tail.executions,
      },
    };
  }

  return {
    createTask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          const attachments: AttachmentSource[] = [];
          const release: string[] = [];
          for (const a of req.attachments) {
            const staged = d.blobs.staged(a.uploadId);
            if (!staged) throw new DomainError("invalid_argument", `attachment '${a.name}' was not uploaded and committed`);
            release.push(a.uploadId);
            attachments.push({ name: a.name, path: staged.path, size: staged.size });
          }
          if (!req.playbookRef) throw new DomainError("invalid_argument", "a task needs a playbook");
          const params: CreateTaskParams = {
            name: req.name,
            draftSlug: req.draftSlug || undefined,
            requestedSlug: req.requestedSlug || undefined,
            description: req.description,
            evidence: req.evidence,
            attachments,
            originalTicket: req.originalTicket,
            attachmentUrls: req.attachmentUrls,
            attachmentErrors: req.attachmentErrors,
            linearId: req.linearId,
            githubIssue: req.githubIssue,
            relatedTasks: req.relatedTasks.map((r) => ({ repo_path: r.repoPath, slug: r.slug, name: r.name })),
            playbook: { reference: { scope: req.playbookRef.scope, key: req.playbookRef.key }, source: req.playbookSource },
            branchName: req.branchName,
            worktreeName: req.worktreeName,
            baseRef: req.baseRef,
            launchDefaults: req.launchDefaults ? { harness: req.launchDefaults.harness, model: req.launchDefaults.model } : undefined,
            autoAdvanceSteps: req.autoAdvance?.steps,
            stepModels: req.stepModels,
            maxLiveSessions: req.maxLiveSessions,
            start: req.start,
          };
          return create(params, release, params.draftSlug);
        }),
      );
    },
    duplicateTask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => domain(async () => create(duplicatePackage(d.repo, req.sourceSlug), [], undefined)));
    },
    renameTask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await renameTask(d.repo, req.slug, req.name, guardFor(req.slug, req.expectedRevision));
          await settle(req.slug);
          return { applied: applied(), task: taskRow(req.slug) };
        }),
      );
    },
    archiveTask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          const task = await archiveTask(d.repo, req.slug, guardFor(req.slug, req.expectedRevision));
          await settle(req.slug);
          d.telemetry.record(() => ({ event: "task.archive", source: "alineryd", taskId: String(task.telemetry_id ?? "") }));
          return { applied: applied() };
        }),
      );
    },
    restoreTask: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await restoreTask(d.repo, req.slug, guardFor(req.slug, req.expectedRevision));
          await settle(req.slug);
          return { applied: applied() };
        }),
      );
    },
    setAutoApproveAll: (req, ctx) => {
      requireCapability(ctx, Capability.APPROVE);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await setAutoApproveAll(d.repo, req.slug, req.enabled, guardFor(req.slug, req.expectedRevision));
          await settle(req.slug, `tasks/${req.slug}/execution.json`);
          return { applied: applied(), task: taskRow(req.slug) };
        }),
      );
    },
    setRelatedTasks: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          const related = req.related.map((r) => ({ repo_path: r.repoPath, slug: r.slug, name: r.name }));
          await setRelatedTasks(d.repo, req.slug, related, guardFor(req.slug, req.expectedRevision));
          await settle(req.slug);
          return { applied: applied(), task: taskRow(req.slug) };
        }),
      );
    },
    worktreeExists: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(async () => {
        const worktree = readTaskChecked(d.repo, req.slug).worktree;
        return { exists: typeof worktree === "string" && worktree !== "" && existsSync(worktree) };
      });
    },
  };
}

export function draftService(d: TaskDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof DraftService> {
  const taskRow = (slug: string): Task | undefined => {
    const v = store.get(taskKey(slug))?.value;
    return v?.case === "task" ? v.value : undefined;
  };
  return {
    writeDraft: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          if (!req.playbook) throw new DomainError("invalid_argument", "a draft needs a playbook");
          const { task, created } = await writeDraft(d.repo, {
            draftSlug: req.draftSlug,
            taskSlug: req.taskSlug,
            name: req.name,
            description: req.description,
            evidence: req.evidence,
            linearId: req.linearId,
            githubIssue: req.githubIssue,
            playbook: { scope: req.playbook.scope, key: req.playbook.key },
            launch: { harness: req.launch?.harness ?? "", model: req.launch?.model ?? "" },
            autoAdvance: req.autoAdvance?.steps,
            stepModels: req.stepModels,
            maxLiveSessions: req.maxLiveSessions,
            branchName: req.branchName,
            worktreeName: req.worktreeName,
            draftBaseRef: req.draftBaseRef,
            attachments: req.writeAttachments
              ? { entries: req.attachmentEntries, images: req.images.map((i) => ({ name: i.name, mime_type: i.mimeType, bytes: Buffer.from(i.bytes).toString("base64") })) }
              : undefined,
          });
          for (const rel of [`tasks/${task.slug}/task.md`, `tasks/${task.slug}/draft-attachments.json`]) await d.refresh(rel);
          if (created) d.telemetry.record(() => ({ event: "task.draft_create", source: "alineryd", hasWorktree: true, playbook: req.playbook?.key ?? "", taskId: String(task.telemetry_id ?? "") }));
          return { applied: { cursor: store.cursor() }, task: taskRow(task.slug) };
        }),
      );
    },
    deleteDraft: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          const taskId = await deleteDraft(d.repo, req.slug);
          for (const rel of [`tasks/${req.slug}/task.md`, `tasks/${req.slug}/draft-attachments.json`]) await d.refresh(rel);
          d.telemetry.record(() => ({ event: "task.draft_delete", source: "alineryd", taskId }));
          return { applied: { cursor: store.cursor() } };
        }),
      );
    },
  };
}
