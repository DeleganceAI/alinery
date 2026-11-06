// Task create, duplicate, rename, archive, restore, auto-approve and related tasks (plan S4.3), ported from alinery-core
// `task_creation.rs` and `task.rs`. Rust still provisions sub-tasks (S4.8) and reads these files, so every file written
// here keeps the shape Rust's serde reads. A task is reserved under the task-mutation lock, its worktree is added outside
// it (git can be slow, and an uncertain outcome is never retried), and the result is committed under it again.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Playbook } from "playbook-engine/src/playbook.ts";
import { writeDurable } from "../platform/fs.ts";
import { branchNameValid, localBranches, registeredWorktrees, worktreeAdd } from "../platform/git.ts";
import { DomainError, withTaskMutation } from "../platform/lock.ts";
import { executionPath } from "./executionStore.ts";
import {
  alineryDir,
  artifactsDir,
  attachmentsDir,
  branchIsParent,
  branchNamesConflict,
  composeTicket,
  definitionIdentity,
  listActiveTasks,
  nowSecs,
  readTask,
  readTaskChecked,
  type RelatedRef,
  safeComponent,
  sessionsDir,
  slugify,
  syncRelatedLinks,
  type TaskRecord,
  taskDir,
  taskMdPath,
  uniqueName,
  validateRelatedRefs,
  validateRetainedFile,
  validateTaskName,
  worktreesDir,
  writeTaskUnlocked,
} from "./taskFiles.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES, uniqueAttachmentName } from "./blobs.ts";
import { ensureIgnored } from "./settings.ts";

type Json = Record<string, unknown>;

/** A file a new task keeps as an attachment: where its bytes are now. A duplicate points at its source's file; both are copied. */
export type AttachmentSource = { name: string; path: string; size: number };

export type CreateTaskParams = {
  name: string;
  draftSlug?: string;
  requestedSlug?: string;
  description?: string;
  evidence?: string;
  attachments?: AttachmentSource[];
  originalTicket?: string;
  attachmentUrls?: string[];
  attachmentErrors?: string[];
  linearId?: string;
  githubIssue?: string;
  relatedTasks?: RelatedRef[];
  /** A sub-task names its parent; only `createSubtask` sets it, and then the identity may not be suffixed (it is refused if occupied). */
  parentTask?: string;
  playbook: { reference: { scope: string; key: string }; source: string };
  branchName?: string;
  worktreeName?: string;
  baseRef?: string;
  launchDefaults?: { harness: string; model: string };
  autoAdvanceSteps?: string[];
  stepModels?: Record<string, string>;
  maxLiveSessions?: number;
  start: boolean;
};

export type CreationError = { stage: string; code: string; message: string };
/** The reply the daemon always built for a create: `task` is the record as written. */
export type CreateReply = { task: TaskRecord | null; sessions: Json[]; executions: Json[]; creation: "ready" | "partial"; start: string; errors: CreationError[] };

const nonempty = (value: string | undefined, fallback: string) => (value?.trim() ? value.trim() : fallback);

// ---- execution.json ---------------------------------------------------------------------------------------

/** execution.rs `new_execution_state`: the first file, `creation: "provisioning"`. */
function newExecutionState(p: CreateTaskParams, playbook: Playbook, lane: string, identity: string, enabled: string[]): Json {
  const maxLive = p.maxLiveSessions ?? 10;
  if (maxLive === 0) throw new DomainError("invalid_argument", "maximum live sessions must be positive");
  if (playbook.key !== p.playbook.reference.key) throw new DomainError("invalid_argument", "task playbook key does not match source identity");
  const harnesses = [playbook.defaultHarness, ...playbook.steps.map((s) => s.harness), p.launchDefaults?.harness ?? ""];
  for (const harness of harnesses) {
    if (harness.trim() !== "" && harness.trim() !== "omp") throw new DomainError("invalid_argument", `unsupported graph harness '${harness}'`);
  }
  for (const key of enabled) {
    if (!playbook.steps.some((s) => s.key === key)) throw new DomainError("invalid_argument", `unknown enabled step '${key}'`);
  }
  const models: Record<string, string> = {};
  for (const [key, value] of Object.entries(p.stepModels ?? {})) {
    if (!playbook.steps.some((s) => s.key === key)) throw new DomainError("invalid_argument", `unknown step model '${key}'`);
    if (value.trim() !== "") models[key] = value.trim();
  }
  return {
    version: 1,
    revision: 0,
    creation: "provisioning",
    creation_error: null,
    initial_start_requested: p.start,
    owning_lane: lane,
    owning_app_config_identity: identity,
    definition_identity: definitionIdentity(p.playbook.source),
    reference: p.playbook.reference,
    max_live_sessions: maxLive,
    enabled_steps: [...new Set(enabled)].sort(),
    auto_approve_all: false,
    launch_defaults: p.launchDefaults ?? { harness: "", model: "" },
    ...(Object.keys(models).length ? { step_models: models } : {}),
    contexts: { root: { id: "root", parent_id: null, cause: { kind: "root" }, bindings: {} } },
    executions: {},
    occurrences: {},
    collections: {},
  };
}

/** Writes the state the way `write_execution_state_unlocked` does: the revision goes up by one, the file is replaced durably. The caller holds the lock. */
async function writeExecutionState(repo: string, slug: string, state: Json): Promise<void> {
  state.revision = (typeof state.revision === "number" ? state.revision : 0) + 1;
  await writeDurable(executionPath(repo, slug), JSON.stringify(state, null, 2));
}

/** Reads, changes and writes `execution.json` under the lock, carrying every key the change does not touch (the engine block included). */
function mutateExecution(repo: string, slug: string, op: string, change: (state: Json) => void): Promise<void> {
  return withTaskMutation(repo, op, async () => {
    const state = JSON.parse(readFileSync(executionPath(repo, slug), "utf8")) as Json;
    change(state);
    await writeExecutionState(repo, slug, state);
  });
}

/** `install_seed`: the ticket becomes an occurrence the first steps can read. */
function installSeed(state: Json, logicalPath: string, relativePath: string): void {
  const contexts = state.contexts as Record<string, { bindings: Record<string, string[]> }>;
  const root = contexts.root;
  if (!root) throw new DomainError("failed_precondition", "missing root context");
  if (root.bindings[logicalPath]) throw new DomainError("failed_precondition", `duplicate seed '${logicalPath}'`);
  const id = crypto.randomUUID();
  root.bindings[logicalPath] = [id];
  (state.occurrences as Json)[id] = {
    id,
    producer_execution_id: null,
    selector: logicalPath,
    logical_path: logicalPath,
    relative_path: relativePath,
    depth: 0,
    discriminator: 0,
    context_id: "root",
    collection_ids: [],
  };
}

// ---- create -----------------------------------------------------------------------------------------------

export type CreateDeps = { repo: string; lane: string; identity: string };

/** A sub-task joins its parent inside the reservation: `before` re-checks the premises under the lock, `after` writes the links. */
export type ProvisionHooks = { before?: () => void | Promise<void>; after?: (task: TaskRecord) => void | Promise<void> };

/**
 * Validates the whole package and the branch namespace before reserving anything, reserves the slug, branch and worktree
 * name under the lock, adds the worktree outside it, then installs the ticket and attachments and commits `ready`.
 * A failure after the reservation is recorded as `creation: "partial"` and the reservation is kept, as Rust did.
 */
export async function provisionTask(d: CreateDeps, p: CreateTaskParams, hooks: ProvisionHooks = {}): Promise<CreateReply> {
  const { repo } = d;
  const parsed = parsePlaybookMd(p.playbook.source);
  if (!parsed.playbook) throw new DomainError("invalid_argument", `invalid playbook: ${parsed.diagnostics.map((x) => x.message).join("; ")}`);
  const playbook = parsed.playbook;
  const name = validateTaskName(p.name);
  const enabled = p.autoAdvanceSteps ?? playbook.steps.filter((s) => s.autoAdvanceDefault).map((s) => s.key);
  const state = newExecutionState(p, playbook, d.lane, d.identity, enabled);
  for (const a of p.attachments ?? []) {
    if (safeComponent(a.name) !== a.name) throw new DomainError("invalid_argument", `invalid attachment name '${a.name}'`);
  }
  const base = slugify(name);
  const requested = nonempty(p.requestedSlug, base);
  if (requested === "" || slugify(requested) !== requested) throw new DomainError("invalid_argument", "invalid requested task slug");
  const worktreeBase = nonempty(p.worktreeName, requested);
  if (safeComponent(worktreeBase) !== worktreeBase) throw new DomainError("invalid_argument", "invalid worktree name");
  const related = p.relatedTasks ?? [];
  validateRelatedRefs(related);
  const branchBase = nonempty(p.branchName, requested);
  if (!(await branchNameValid(repo, branchBase))) throw new DomainError("invalid_argument", "invalid branch name");

  // The lock file lives in `.alinery/`; a repository the app has not readied yet has none.
  mkdirSync(alineryDir(repo), { recursive: true });
  let reservationError: string | undefined;
  const task = await withTaskMutation(repo, "reserve task provisioning", async () => {
    await hooks.before?.();
    const reserved = listActiveTasks(repo);
    const refs = await localBranches(repo);
    const branches = () => [...refs, ...reserved.map((t) => String(t.branch))];
    const branchOccupied = (candidate: string) => branches().some((existing) => branchNamesConflict(existing, candidate));
    const registered = await registeredWorktrees(repo);
    if (p.parentTask && (existsSync(taskDir(repo, requested)) || existsSync(join(worktreesDir(repo), worktreeBase)) || branchOccupied(branchBase))) {
      throw new DomainError("failed_precondition", "child task identity is already occupied");
    }
    // Suffixing the leaf cannot escape an occupied parent namespace.
    const parent = branches().find((existing) => branchIsParent(existing, branchBase));
    if (parent) throw new DomainError("invalid_argument", `branch '${branchBase}' is blocked by existing or reserved parent branch '${parent}'; choose a branch outside '${parent}/'`);
    const branch = uniqueName(branchOccupied, branchBase);
    await ensureIgnored(repo);
    let draft: TaskRecord | undefined;
    if (p.draftSlug) {
      if (safeComponent(p.draftSlug) !== p.draftSlug) throw new DomainError("invalid_argument", "invalid draft slug");
      const found = readTask(repo, p.draftSlug);
      if (!found) throw new DomainError("not_found", "draft is missing or has already been promoted");
      if (found.draft !== true) throw new DomainError("failed_precondition", "draft was already created");
      draft = found.archived === true ? undefined : found;
    }
    const slug = uniqueName((s) => existsSync(taskDir(repo, s)) && draft?.slug !== s, requested);
    if (draft && draft.slug !== slug) renameSync(taskDir(repo, draft.slug), taskDir(repo, slug));
    // The draft's form state is spent; left behind it would keep a `draft/` row for a task.
    if (draft) rmSync(join(taskDir(repo, slug), "draft-attachments.json"), { force: true });
    mkdirSync(sessionsDir(repo, slug), { recursive: true });
    mkdirSync(artifactsDir(repo, slug), { recursive: true });
    mkdirSync(worktreesDir(repo), { recursive: true });
    const leaf = uniqueName(
      (s) =>
        existsSync(join(worktreesDir(repo), s)) ||
        registered.some((path) => path.split("/").pop() === s) ||
        reserved.some((t) => String(t.worktree).split("/").pop() === s),
      worktreeBase,
    );
    const record: TaskRecord = {
      name,
      slug,
      branch,
      worktree: join(worktreesDir(repo), leaf),
      has_worktree: true,
      created: draft ? Number(draft.created) : nowSecs(),
      archived: false,
      pr_url: "",
      linear_id: (p.linearId ?? "").trim(),
      github_issue: (p.githubIssue ?? "").trim(),
      playbook: "",
      engine_version: 2,
      playbook_ref: p.playbook.reference,
      max_live_sessions: state.max_live_sessions as number,
      launch_defaults: state.launch_defaults as Json,
      auto_advance: [...(state.enabled_steps as string[])],
      auto_approve_all: false,
      ...(Object.keys((state.step_models as Json) ?? {}).length ? { step_models: state.step_models } : {}),
      draft: false,
      ...(related.length ? { related_tasks: related } : {}),
      ...(p.parentTask ? { parent_task: p.parentTask } : {}),
      telemetry_id: crypto.randomUUID(),
    };
    await writeDurable(join(taskDir(repo, slug), "playbook.md"), p.playbook.source);
    await writeTaskUnlocked(repo, record);
    await writeExecutionState(repo, slug, state);
    try {
      await hooks.after?.(record);
    } catch (e) {
      reservationError = e instanceof Error ? e.message : String(e);
      state.creation = "partial";
      state.creation_error = `relationships: ${reservationError}`;
      await writeExecutionState(repo, slug, state);
    }
    return record;
  });

  let stage = "git_worktree";
  const attachmentErrors = [...(p.attachmentErrors ?? [])];
  let failure: string | undefined;
  try {
    if (reservationError !== undefined) {
      stage = "relationships";
      throw new Error(reservationError);
    }
    await worktreeAdd(repo, String(task.worktree), String(task.branch), p.baseRef?.trim() || undefined);
    stage = "install_inputs";
    const copied: string[] = [];
    const dir = attachmentsDir(repo, task.slug);
    let accepted = 0;
    if ((p.attachments ?? []).length) mkdirSync(dir, { recursive: true });
    for (const a of p.attachments ?? []) {
      const reason = a.size > MAX_ATTACHMENT_BYTES ? "larger than 25 MiB" : a.size > MAX_ATTACHMENT_SET_BYTES - accepted ? "attachment set would exceed 100 MiB" : undefined;
      if (reason) {
        attachmentErrors.push(`${a.name} — ${reason}`);
        continue;
      }
      const stored = uniqueAttachmentName(dir, a.name);
      if (!stored) {
        attachmentErrors.push(`${a.name} — too many name collisions`);
        continue;
      }
      await writeDurable(join(dir, stored), readFileSync(a.path));
      accepted += a.size;
      copied.push(stored);
    }
    const ticket = p.originalTicket ?? composeTicket(name, p.description ?? "", p.evidence ?? "", p.attachmentUrls ?? [], copied, attachmentErrors);
    await writeDurable(join(artifactsDir(repo, task.slug), "00-ticket.md"), ticket);
    syncRelatedLinks(repo, task.slug, related);
    stage = "ready";
    await mutateExecution(repo, task.slug, "commit task ready", (s) => {
      installSeed(s, "ticket.md", "00-ticket.md");
      s.creation = "ready";
    });
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  const errors: CreationError[] = attachmentErrors.map((message) => ({ stage: "attachments", code: "import_failed", message }));
  const reply: CreateReply = { task, sessions: [], executions: [], creation: "ready", start: "not_requested", errors };
  if (failure !== undefined) {
    reply.creation = "partial";
    errors.push({ stage, code: "provisioning_failed", message: failure });
    try {
      await mutateExecution(repo, task.slug, "record partial creation", (s) => {
        s.creation = "partial";
        s.creation_error = `${stage}: ${failure}`;
      });
    } catch (commit) {
      errors.push({ stage: "persistence", code: "ambiguous_commit", message: commit instanceof Error ? commit.message : String(commit) });
    }
  }
  return reply;
}

// ---- duplicate --------------------------------------------------------------------------------------------

/** The create that makes a fresh copy of `sourceSlug`: same playbook, ticket, attachments and launch settings, one generation (`D+n`) further. */
export function duplicatePackage(repo: string, sourceSlug: string): CreateTaskParams {
  const slug = safeComponent(sourceSlug);
  if (!slug) throw new DomainError("invalid_argument", "invalid source slug");
  const source = readTaskChecked(repo, slug);
  if (source.draft === true) throw new DomainError("failed_precondition", "draft tasks cannot be duplicated");
  if (Number(source.engine_version ?? 0) < 2) throw new DomainError("failed_precondition", "pre-v2 task data cannot be duplicated into executable work");
  let state: { reference: { scope: string; key: string }; definition_identity: string };
  try {
    state = JSON.parse(readFileSync(executionPath(repo, slug), "utf8"));
  } catch (e) {
    throw new DomainError("failed_precondition", `task execution state unavailable: ${(e as Error).message}`);
  }
  const definition = readFileSync(join(taskDir(repo, slug), "playbook.md"), "utf8");
  if (definitionIdentity(definition) !== state.definition_identity) throw new DomainError("failed_precondition", "retained task definition integrity mismatch");
  const originalTicket = readFileSync(join(artifactsDir(repo, slug), "00-ticket.md"), "utf8");
  const dir = attachmentsDir(repo, slug);
  const attachments: AttachmentSource[] = [];
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (safeComponent(entry.name) !== entry.name) throw new DomainError("failed_precondition", "invalid attachment name");
      if (!entry.isFile()) throw new DomainError("failed_precondition", `attachment '${entry.name}' is not a regular file`);
      attachments.push({ name: entry.name, path: join(dir, entry.name), size: statSync(join(dir, entry.name)).size });
    }
  }
  const sourceName = String(source.name);
  const match = /^(.*) D\+(\d+)$/s.exec(sourceName.trimEnd());
  const number = match ? Number(match[2]) : 0;
  const generation = match && number > 0 ? { base: match[1], next: number + 1 } : undefined;
  const name = generation ? `${generation.base} D+${generation.next}` : `${sourceName.trimEnd()} D+1`;
  // A copy of a copy drops the numeric suffix the last duplicate added, so the identities do not grow.
  const identityBase = (value: string) => {
    if (generation) {
      const cut = value.lastIndexOf("-");
      if (cut >= 0 && /^\d+$/.test(value.slice(cut + 1))) return value.slice(0, cut);
    }
    return value;
  };
  const worktreeLeaf = String(source.worktree).split("/").pop();
  return {
    name,
    requestedSlug: identityBase(String(source.slug)),
    originalTicket,
    attachments,
    linearId: String(source.linear_id ?? ""),
    githubIssue: String(source.github_issue ?? ""),
    relatedTasks: (source.related_tasks as RelatedRef[] | undefined) ?? [],
    playbook: { reference: state.reference, source: definition },
    branchName: identityBase(String(source.branch)),
    worktreeName: worktreeLeaf ? identityBase(worktreeLeaf) : undefined,
    launchDefaults: (source.launch_defaults as { harness: string; model: string } | undefined) ?? { harness: "", model: "" },
    autoAdvanceSteps: (source.auto_advance as string[] | undefined) ?? [],
    maxLiveSessions: Number(source.max_live_sessions ?? 10),
    stepModels: (source.step_models as Record<string, string> | undefined) ?? {},
    start: true,
  };
}

// ---- rename, archive, restore, toggles ---------------------------------------------------------------------

/** `mutate_task`: read, change, write under the lock. */
/** Runs inside the task-mutation lock before a change, so a caller's `expected_revision` is checked against the file as it is now. */
export type Guard = () => void | Promise<void>;

export async function mutateTask<T>(repo: string, slug: string, op: string, change: (task: TaskRecord) => T | Promise<T>, guard?: Guard): Promise<{ task: TaskRecord; result: T }> {
  return withTaskMutation(repo, op, async () => {
    await guard?.();
    const task = readTaskChecked(repo, slug);
    const result = await change(task);
    await writeTaskUnlocked(repo, task);
    return { task, result };
  });
}

export async function renameTask(repo: string, slug: string, newName: string, guard?: Guard): Promise<TaskRecord> {
  const name = validateTaskName(newName);
  if (safeComponent(slug) !== slug) throw new DomainError("invalid_argument", "invalid task slug");
  const path = taskMdPath(repo, slug);
  if (!existsSync(path)) throw new DomainError("not_found", `no such task: ${slug}`);
  validateRetainedFile(repo, path);
  return (
    await mutateTask(repo, slug, "rename task", (task) => {
      validateRetainedFile(repo, path);
      if (task.slug !== slug) throw new DomainError("failed_precondition", "task slug does not match retained target");
      task.name = name;
    }, guard)
  ).task;
}

/** `ensure_task_can_archive`: a task with an active child, or a child its parent still runs, is finished from the parent. */
export function ensureTaskCanArchive(repo: string, slug: string): void {
  const task = readTask(repo, slug);
  if (!task) throw new DomainError("not_found", `no such task: ${slug}`);
  if (String(task.active_subtask ?? "") !== "") throw new DomainError("failed_precondition", "task has an active child; finalize the sub-task first");
  const parentSlug = String(task.parent_task ?? "");
  if (parentSlug !== "" && task.archived !== true) {
    const parent = readTask(repo, parentSlug);
    if (!parent) throw new DomainError("failed_precondition", "active child parent is missing");
    if (parent.active_subtask === task.slug) {
      throw new DomainError(
        "failed_precondition",
        `This task is still active under “${parent.name}”. Open the parent task and use its sub-task manager to finish or kill this task.`,
      );
    }
  }
}

/** execution.rs `prune_execution_objects` (O27): the byte copies an execution kept go; manifests and artifacts stay. */
export function pruneExecutionObjects(repo: string, slug: string): void {
  const root = join(taskDir(repo, slug), "executions");
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) rmSync(join(root, entry, "objects"), { recursive: true, force: true });
}

export async function archiveTask(repo: string, slug: string, guard?: Guard): Promise<TaskRecord> {
  return (
    await mutateTask(repo, slug, "archive task", (task) => {
      ensureTaskCanArchive(repo, slug);
      task.archived = true;
      pruneExecutionObjects(repo, slug);
    }, guard)
  ).task;
}

export async function restoreTask(repo: string, slug: string, guard?: Guard): Promise<void> {
  await mutateTask(repo, slug, "restore task", (task) => {
    if (String(task.parent_task ?? "") !== "") throw new DomainError("failed_precondition", `cannot restore child task: ${slug}`);
    task.archived = false;
  }, guard);
}

export async function setAutoApproveAll(repo: string, slug: string, enabled: boolean, guard?: Guard): Promise<TaskRecord> {
  return withTaskMutation(repo, "set auto approve all", async () => {
    await guard?.();
    const task = readTaskChecked(repo, slug);
    if (task.archived === true) throw new DomainError("failed_precondition", "task is archived — read-only");
    if (task.draft === true) throw new DomainError("failed_precondition", "draft tasks have no execution to override");
    if (Number(task.engine_version ?? 0) < 2) throw new DomainError("failed_precondition", "pre-v2 tasks have no automatic completion to override");
    let state: Json;
    try {
      state = JSON.parse(readFileSync(executionPath(repo, slug), "utf8")) as Json;
    } catch (e) {
      throw new DomainError("failed_precondition", `task execution state unavailable (pre-v2 tasks cannot launch): ${(e as Error).message}`);
    }
    // Completion reads execution.json, not task.md. The task is written first so a failed execution write leaves the engine off
    // rather than approving while the file says off.
    task.auto_approve_all = enabled;
    await writeTaskUnlocked(repo, task);
    if (state.auto_approve_all !== enabled) {
      state.auto_approve_all = enabled;
      await writeExecutionState(repo, slug, state);
    }
    return task;
  });
}

/** `set_related_tasks_in`: tags other tasks on this machine; the links and the markdown follow. */
export async function setRelatedTasks(repo: string, slug: string, related: RelatedRef[], guard?: Guard): Promise<TaskRecord> {
  const task = readTaskChecked(repo, slug);
  if (task.archived === true) throw new DomainError("failed_precondition", "task is archived — read-only");
  const cleaned: RelatedRef[] = [];
  for (const raw of related) {
    const tag = { repo_path: raw.repo_path.trim(), slug: raw.slug.trim(), name: raw.name.trim() };
    if (tag.repo_path === "" || tag.slug === "") throw new DomainError("invalid_argument", "related task is missing repo or slug");
    validateRelatedRefs([tag]);
    if (safeComponent(tag.slug) !== tag.slug) throw new DomainError("invalid_argument", `invalid related-task slug '${tag.slug}'`);
    if (tag.repo_path === repo && tag.slug === slug) throw new DomainError("invalid_argument", "cannot tag a task as related to itself");
    if (cleaned.some((c) => c.repo_path === tag.repo_path && c.slug === tag.slug)) continue;
    // A new tag must name a task this machine can read. A tag the task already has survives its repository going away, so a
    // stale one can still be removed.
    const alreadyTagged = ((task.related_tasks as RelatedRef[] | undefined) ?? []).some((old) => old.repo_path === tag.repo_path && old.slug === tag.slug);
    try {
      const other = readTaskChecked(tag.repo_path, tag.slug);
      if (tag.name === "") tag.name = String(other.name);
    } catch (e) {
      if (!alreadyTagged) {
        throw new DomainError(
          "invalid_argument",
          `related task '${tag.slug}' was not found in ${tag.repo_path} on this machine (${(e as Error).message}); tasks can only be related to tasks on the same machine`,
        );
      }
    }
    cleaned.push(tag);
  }
  return withTaskMutation(repo, "set related tasks", async () => {
    await guard?.();
    const current = readTaskChecked(repo, slug);
    if (current.archived === true) throw new DomainError("failed_precondition", "task is archived — read-only");
    if (cleaned.length) current.related_tasks = cleaned;
    else delete current.related_tasks;
    await writeTaskUnlocked(repo, current);
    syncRelatedLinks(repo, slug, cleaned);
    return current;
  });
}

