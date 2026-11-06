// A parent task's sub-task (plan S4.8), ported from alinery-core `subtask.rs` and the manager prompts of `shared.rs`: what the
// task page offers, the manager session, creating the child, and killing a child or discarding a setup. Finishing a child
// (`inspect_subtask_finish`, `finalize_subtask`) stays in core until S5.1, because `alinery-mcp` calls it. Every file written
// here keeps the shape Rust's serde reads. A child is reserved by `provisionTask` with the parent's links written in the same
// reservation (`ProvisionHooks`), so the parent never names a child that has no task.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "alinery-proto/alinery/v1/entities_pb";
import managerPrompt from "../../../../prompts/subtask-manager.md" with { type: "text" };
import recoveryPrompt from "../../../../prompts/subtask-manager-recovery.md" with { type: "text" };
import { writeAtomic } from "../platform/fs.ts";
import { git } from "../platform/git.ts";
import { DomainError, withTaskMutation } from "../platform/lock.ts";
import { parseSessionMeta } from "../sync/parsers/sessionMeta.ts";
import { loadRelationships } from "./artifactTree.ts";
import { executionPath } from "./executionStore.ts";
import {
  alineryDir,
  artifactsDir,
  definitionIdentity,
  RELATED_MARKDOWN,
  readTask,
  readTaskChecked,
  safeComponent,
  sessionsDir,
  type TaskRecord,
  taskDir,
  worktreesDir,
  writeTaskUnlocked,
} from "./taskFiles.ts";
import { type CreateDeps, type CreateReply, type CreateTaskParams, type ProvisionHooks, pruneExecutionObjects } from "./tasks.ts";

type Json = Record<string, unknown>;

const text = (o: Json, key: string): string => (typeof o[key] === "string" ? (o[key] as string) : "");
const relationshipError = (message: string) => new DomainError("failed_precondition", `relationship corruption: ${message}`);

/** The fields of a task a sub-task view shows (`TaskSummary`). */
export type TaskSummary = { name: string; slug: string; branch: string; worktree: string; hasWorktree: boolean; playbook: string; archived: boolean; draft: boolean; subtaskOutcome: string };

export function taskSummary(task: TaskRecord): TaskSummary {
  const ref = task.playbook_ref as { key?: unknown } | undefined;
  return {
    name: task.name,
    slug: task.slug,
    branch: text(task, "branch"),
    worktree: text(task, "worktree"),
    hasWorktree: task.has_worktree === true,
    playbook: typeof ref?.key === "string" ? ref.key : text(task, "playbook"),
    archived: task.archived === true,
    draft: task.draft === true,
    subtaskOutcome: text(task, "subtask_outcome"),
  };
}

// ---- manager sessions --------------------------------------------------------------------------------------

type SessionFile = { slug: string; path: string; meta: Json; session: Session };

/** Every `*.meta.json` of a task that serde would accept. A file it refuses is no session, here as in Rust. */
function sessionFiles(repo: string, slug: string): SessionFile[] {
  const dir = sessionsDir(repo, slug);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionFile[] = [];
  for (const name of names.filter((n) => n.endsWith(".meta.json")).sort()) {
    const path = join(dir, name);
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const entity = parseSessionMeta(body, slug, name.slice(0, -".meta.json".length));
    if (entity?.value.case !== "session") continue;
    out.push({ slug, path, meta: JSON.parse(body) as Json, session: entity.value.value });
  }
  return out;
}

const created = (f: SessionFile) => (typeof f.meta.created === "number" ? f.meta.created : 0);
const isManager = (f: SessionFile) => f.meta.subtask_manager === true && f.meta.archived !== true;

/** `manager_sessions`: the task's live-or-not manager sessions that are not archived, oldest first. */
function managerSessions(repo: string, slug: string): SessionFile[] {
  return sessionFiles(repo, slug)
    .filter(isManager)
    .sort((a, b) => created(a) - created(b) || (a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0));
}

const lastWhere = <T>(items: T[], pick: (item: T) => boolean): T | undefined => [...items].reverse().find(pick);

/** `manager_is_usable`: a manager that has not ended, or that can be resumed. */
const managerUsable = (f: SessionFile) => f.meta.archived !== true && (f.meta.ended_at == null || text(f.meta, "harness_resume_token") !== "");

export type SubtaskState = {
  task: TaskSummary;
  parentTask?: TaskSummary;
  activeSubtask?: TaskSummary;
  managerSession?: Session;
  managerOwnerTaskSlug: string;
  parentManagerSession?: Session;
  parentManagerOwnerTaskSlug: string;
  canStart: boolean;
  canRecover: boolean;
  disabledReason: string;
};

/** `subtask_manager_state`: the links, the manager sessions, and why starting one is or is not allowed. */
export function subtaskState(repo: string, slug: string): SubtaskState {
  const known = loadRelationships(repo);
  const task = known.get(slug);
  if (!task) throw new DomainError("not_found", `no such task: ${slug}`);
  const summaryOf = (key: string) => {
    const other = text(task, key);
    return other === "" ? undefined : taskSummary(known.get(other) as TaskRecord);
  };
  const parentTask = summaryOf("parent_task");
  const activeSubtask = summaryOf("active_subtask");
  const own = managerSessions(repo, slug);
  const manager = activeSubtask ? lastWhere(own, (f) => text(f.meta, "subtask_slug") === activeSubtask.slug) : lastWhere(own, (f) => text(f.meta, "subtask_slug") === "");
  const parentManager = parentTask ? lastWhere(managerSessions(repo, parentTask.slug), (f) => text(f.meta, "subtask_slug") === slug) : undefined;
  const worktree = text(task, "worktree");
  const reason =
    Number(task.engine_version ?? 0) < 2
      ? "Pre-v2 task data is read-only"
      : task.draft === true
        ? "Draft tasks cannot start sub-tasks"
        : task.archived === true
          ? "Archived tasks cannot start sub-tasks"
          : task.has_worktree !== true || worktree === "" || !isDirectory(worktree)
            ? "A dedicated task worktree is required"
            : activeSubtask
              ? "Finish the active sub-task before starting another"
              : own.some((f) => text(f.meta, "subtask_slug") === "")
                ? "A sub-task setup manager already exists"
                : "";
  return {
    task: taskSummary(task),
    parentTask,
    activeSubtask,
    managerSession: manager?.session,
    managerOwnerTaskSlug: slug,
    parentManagerSession: parentManager?.session,
    parentManagerOwnerTaskSlug: parentTask?.slug ?? "",
    canStart: reason === "",
    canRecover: activeSubtask !== undefined && !(manager && managerUsable(manager)),
    disabledReason: reason,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type ManagerContext = { ownerSlug: string; parent: TaskRecord; meta: Json; metaPath: string };

/** `resolve_subtask_manager`: the one unarchived manager session with this id, and the task that owns it. */
function resolveSubtaskManager(repo: string, managerSessionId: string, known = loadRelationships(repo)): ManagerContext {
  if (managerSessionId === "" || safeComponent(managerSessionId) !== managerSessionId) throw new DomainError("invalid_argument", "invalid sub-task manager session id");
  const matches: ManagerContext[] = [];
  for (const task of known.values()) {
    for (const f of sessionFiles(repo, task.slug)) {
      if (f.session.id === managerSessionId && isManager(f)) matches.push({ ownerSlug: task.slug, parent: task, meta: f.meta, metaPath: f.path });
    }
  }
  if (matches.length === 0) throw new DomainError("failed_precondition", "sub-task manager session is missing, archived, or unauthorized");
  if (matches.length > 1) throw new DomainError("failed_precondition", "sub-task manager session id is ambiguous");
  return matches[0] as ManagerContext;
}

// ---- the manager session -----------------------------------------------------------------------------------

/** `worktree_status_label`. */
async function worktreeStatusLabel(worktree: string): Promise<"CLEAN" | "DIRTY" | "UNKNOWN"> {
  if (worktree.trim() === "" || !isDirectory(worktree)) return "UNKNOWN";
  try {
    const r = await git(worktree, ["status", "--porcelain=v1", "-z"]);
    return r.code === 0 ? (r.stdout === "" ? "CLEAN" : "DIRTY") : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/** Each `{{NAME}}` is replaced once, in one pass, so a task named `{{PARENT_SLUG}}` is not expanded again. */
const fill = (template: string, values: Record<string, string>) => template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => values[name] ?? whole);

/** `append_launch_context`: the parent's ticket and the related-task index, for a task that has them. */
function launchContext(repo: string, task: TaskRecord, prompt: string, known = loadRelationships(repo)): string {
  let out = prompt;
  const parentSlug = text(task, "parent_task");
  if (parentSlug !== "") {
    const parent = known.get(parentSlug);
    if (!parent) throw relationshipError(`task '${task.slug}' has no valid parent context`);
    const dir = artifactsDir(repo, parent.slug);
    out += `\n\n## Immediate parent context\n\nParent task slug: ${parent.slug}\nParent ticket: ${join(dir, "00-ticket.md")}\nParent artifacts directory: ${dir}\nRead the parent ticket and relevant parent artifacts directly for context.`;
  }
  if (Array.isArray(task.related_tasks) && task.related_tasks.length > 0) {
    out += `\n\n## Related tasks\n\nRead \`${join(artifactsDir(repo, task.slug), RELATED_MARKDOWN)}\` for tagged related tasks and their inlined tickets. That file lives in this task's artifacts directory.\n`;
  }
  return out;
}

/** `manager_prompt` and `recovery_manager_prompt`, with the context a launch adds. */
async function managerPromptFor(repo: string, task: TaskRecord, worktree: string, sessionId: string, child: TaskSummary | undefined): Promise<string> {
  const parentArtifacts = artifactsDir(repo, task.slug);
  const values: Record<string, string> = {
    PARENT_NAME: task.name,
    PARENT_SLUG: task.slug,
    PARENT_BRANCH: text(task, "branch"),
    PARENT_WORKTREE: worktree,
    PARENT_WORKTREE_STATUS: await worktreeStatusLabel(worktree),
    PARENT_TICKET: join(parentArtifacts, "00-ticket.md"),
    PARENT_ARTIFACTS: parentArtifacts,
    MANAGER_SESSION_ID: sessionId,
  };
  if (child) {
    const childArtifacts = artifactsDir(repo, child.slug);
    Object.assign(values, {
      CHILD_NAME: child.name,
      CHILD_SLUG: child.slug,
      CHILD_PLAYBOOK: child.playbook,
      CHILD_BRANCH: child.branch,
      CHILD_WORKTREE: child.worktree,
      CHILD_TICKET: join(childArtifacts, "00-ticket.md"),
      CHILD_ARTIFACTS: childArtifacts,
    });
  }
  return launchContext(repo, task, fill(child ? recoveryPrompt : managerPrompt, values));
}

export type ManagerSessionParams = { slug: string; subtaskSlug?: string | null; recover: boolean; harness: string; model?: string | null; start: boolean };
export type ManagerSessionReply = { session: Json; execution: null; start: string; errors: { stage: string; code: string; message: string }[] };

/**
 * `subtask_manager_request` and the manager branch of the session create: refuses a second live manager, binds a recovery to
 * the task's active child (and a first manager to none), writes the session with the prompt that tells the agent its job,
 * and starts it when asked. The session lives in the parent's `sessions/`; `subtask_slug` stays empty until a child exists.
 */
export async function createManagerSession(
  repo: string,
  p: ManagerSessionParams,
  openSession: (id: string, taskSlug: string, model: string, prompt: string) => Promise<void>,
): Promise<ManagerSessionReply> {
  const { task, meta } = await withTaskMutation(repo, "create sub-task manager session", async () => {
    const known = loadRelationships(repo);
    const owner = known.get(p.slug);
    if (!owner) throw new DomainError("not_found", `no such task: ${p.slug}`);
    if (managerSessions(repo, p.slug).some((f) => f.meta.ended_at == null)) throw new DomainError("failed_precondition", "task already has a live or unstarted manager");
    const childSlug = p.subtaskSlug ?? "";
    if (p.recover) {
      const child = known.get(childSlug);
      if (!child) throw new DomainError("failed_precondition", "missing child task");
      if (text(child, "parent_task") !== p.slug || text(owner, "active_subtask") !== childSlug) throw new DomainError("failed_precondition", "invalid manager recovery binding");
    } else if (text(owner, "active_subtask") !== "" || childSlug !== "") {
      throw new DomainError("failed_precondition", "task already has an active child");
    }
    const id = randomUUID();
    const worktree = text(owner, "worktree") || repo;
    const model = p.model ?? "";
    const child = p.recover ? taskSummary(known.get(childSlug) as TaskRecord) : undefined;
    const fresh: Json = {
      id,
      worktree,
      created: Math.floor(Date.now() / 1000),
      harness: p.harness,
      model,
      generic: true,
      subtask_manager: true,
      ...(childSlug ? { subtask_slug: childSlug } : {}),
      prompt: await managerPromptFor(repo, owner, worktree, id, child),
    };
    mkdirSync(sessionsDir(repo, p.slug), { recursive: true });
    writeAtomic(join(sessionsDir(repo, p.slug), `${id}.meta.json`), JSON.stringify(fresh));
    return { task: owner, meta: fresh };
  });
  if (!p.start) return { session: meta, execution: null, start: "not_requested", errors: [] };
  try {
    await openSession(String(meta.id), task.slug, String(meta.model), String(meta.prompt));
  } catch (error) {
    return { session: meta, execution: null, start: "failed", errors: [{ stage: "launch", code: "spawn_failed", message: error instanceof Error ? error.message : String(error) }] };
  }
  return { session: meta, execution: null, start: "started", errors: [] };
}

// ---- create ------------------------------------------------------------------------------------------------

/** The Rust `CreateSubtaskInput`, which refuses a key it does not know. */
export type CreateSubtaskInput = {
  manager_session_id: string;
  name: string;
  slug: string;
  playbook?: { reference: { scope: string; key: string }; source: string } | null;
  instructions: string;
  start: boolean;
  max_live_sessions?: number | null;
};

const INPUT_KEYS = new Set(["manager_session_id", "name", "slug", "playbook", "instructions", "start", "max_live_sessions"]);

export function parseCreateSubtaskInput(raw: unknown): CreateSubtaskInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new DomainError("invalid_argument", "sub-task request must be an object");
  const o = raw as Json;
  for (const key of Object.keys(o)) if (!INPUT_KEYS.has(key)) throw new DomainError("invalid_argument", `unknown field \`${key}\``);
  for (const key of ["manager_session_id", "name", "slug"]) if (typeof o[key] !== "string") throw new DomainError("invalid_argument", `missing field \`${key}\``);
  if (o.instructions !== undefined && typeof o.instructions !== "string") throw new DomainError("invalid_argument", "instructions must be text");
  if (o.max_live_sessions != null && !(Number.isInteger(o.max_live_sessions) && (o.max_live_sessions as number) >= 0)) throw new DomainError("invalid_argument", "max_live_sessions must be a count");
  return {
    manager_session_id: o.manager_session_id as string,
    name: o.name as string,
    slug: o.slug as string,
    playbook: (o.playbook as CreateSubtaskInput["playbook"]) ?? null,
    instructions: (o.instructions as string | undefined) ?? "",
    start: o.start === true,
    max_live_sessions: (o.max_live_sessions as number | null | undefined) ?? null,
  };
}

/** `exact_child_slug`: lowercase ASCII letters, digits and single inner dashes, with nothing normalized. */
function exactChildSlug(slug: string): boolean {
  return slug !== "" && safeComponent(slug) === slug && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/** `worktree_clean`: a missing directory is not clean, and a failing `git status` is an error, not a guess. */
async function worktreeClean(path: string): Promise<boolean> {
  if (!isDirectory(path)) return false;
  const r = await git(path, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (r.code !== 0) throw new DomainError("failed_precondition", `git status failed: ${r.stderr.trim()}`);
  return r.stdout === "";
}

/** `ref_exists`: true also when git cannot say, because a slug that might collide must not be taken. */
async function refExists(repo: string, slug: string): Promise<boolean> {
  try {
    if ((await git(repo, ["check-ref-format", "--branch", slug])).code !== 0) return true;
    return (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${slug}`])).code === 0;
  } catch {
    return true;
  }
}

/** `task_head`: the commit a task's worktree is on, provided it is on the task's own branch. */
async function taskHead(task: TaskRecord, role: string): Promise<string> {
  const worktree = text(task, "worktree");
  const branch = text(task, "branch");
  const symbolic = await git(worktree, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolic.code !== 0) throw new DomainError("failed_precondition", `${role} worktree HEAD is detached; expected branch '${branch}'`);
  const actual = symbolic.stdout.trim();
  const expected = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
  if (actual !== expected) throw new DomainError("failed_precondition", `${role} worktree is on branch '${actual.startsWith("refs/heads/") ? actual.slice("refs/heads/".length) : actual}'; expected '${branch}'`);
  const rev = await git(worktree, ["rev-parse", "--verify", "HEAD"]);
  if (rev.code !== 0) throw new DomainError("failed_precondition", `cannot resolve ${role} HEAD: ${rev.stderr.trim()}`);
  return rev.stdout.trim();
}

/** `validate_subtask_creation`. */
async function validateCreation(repo: string, input: CreateSubtaskInput): Promise<ManagerContext> {
  const manager = resolveSubtaskManager(repo, input.manager_session_id);
  if (text(manager.meta, "subtask_slug") !== "") throw new DomainError("failed_precondition", "sub-task manager already has an active child");
  const parent = manager.parent;
  if (parent.draft === true || parent.archived === true) throw new DomainError("failed_precondition", "sub-task parent must be a non-draft active task");
  if (text(parent, "active_subtask") !== "") throw new DomainError("failed_precondition", "sub-task parent already has an active child");
  if (parent.has_worktree !== true || text(parent, "worktree") === "") throw new DomainError("failed_precondition", "sub-task parent has no dedicated worktree");
  if (!(await worktreeClean(text(parent, "worktree")))) throw new DomainError("failed_precondition", "sub-task parent worktree must exist and be clean");
  if (!exactChildSlug(input.slug)) throw new DomainError("invalid_argument", "sub-task slug must use lowercase ASCII letters, numbers, and single dashes without normalization");
  if (existsSync(taskDir(repo, input.slug))) throw new DomainError("failed_precondition", "sub-task slug collides with an existing task");
  if (existsSync(join(worktreesDir(repo), input.slug))) throw new DomainError("failed_precondition", "sub-task slug collides with an existing worktree");
  if (await refExists(repo, input.slug)) throw new DomainError("failed_precondition", "sub-task slug collides with an existing or invalid Git ref");
  return manager;
}

function readState(repo: string, slug: string): Json {
  try {
    return JSON.parse(readFileSync(executionPath(repo, slug), "utf8")) as Json;
  } catch (error) {
    throw new DomainError("failed_precondition", `read execution state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type SubtaskPlan = {
  /** What `provisionTask` takes, with the hooks that make the parent's links part of the reservation. */
  params: CreateTaskParams;
  hooks: ProvisionHooks;
  /** The result the manager agent gets, once the child has been provisioned. */
  result: (reply: CreateReply, provisioning: Json) => Json;
};

/**
 * `create_subtask`: checks the parent, the manager and the slug, then describes the child's creation. The child inherits the
 * parent's retained definition, launch defaults, enabled steps and step models unless a playbook is given. The checks run
 * again inside the reservation, because the parent can change between them; a failure there leaves the retained, partial
 * child (`creation: "partial"`, stage `relationships`) as the ordinary create does.
 */
export async function prepareSubtask(d: CreateDeps, input: CreateSubtaskInput): Promise<SubtaskPlan> {
  const { repo } = d;
  const manager = await withTaskMutation(repo, "inspect sub-task creation", () => validateCreation(repo, input));
  const owner = manager.ownerSlug;
  const state = readState(repo, owner);
  const mine = (s: Json) => s.owning_lane === d.lane && s.owning_app_config_identity === d.identity;
  if (!mine(state)) throw new DomainError("failed_precondition", "sub-task parent belongs to another daemon lane or app configuration");
  if (state.creation !== "ready") throw new DomainError("failed_precondition", "sub-task parent provisioning is not ready");
  let source: string;
  try {
    source = readFileSync(join(taskDir(repo, owner), "playbook.md"), "utf8");
  } catch (error) {
    throw new DomainError("failed_precondition", `read retained parent definition: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (definitionIdentity(source) !== state.definition_identity) throw new DomainError("failed_precondition", "retained parent definition integrity mismatch");
  const baseRef = await taskHead(manager.parent, "parent");
  const inherited = !input.playbook;
  const params: CreateTaskParams = {
    name: input.name,
    requestedSlug: input.slug,
    description: input.instructions,
    parentTask: owner,
    playbook: input.playbook ?? { reference: state.reference as { scope: string; key: string }, source },
    branchName: input.slug,
    worktreeName: input.slug,
    baseRef,
    launchDefaults: state.launch_defaults as { harness: string; model: string },
    autoAdvanceSteps: inherited ? ((state.enabled_steps as string[] | undefined) ?? []) : undefined,
    maxLiveSessions: input.max_live_sessions ?? (state.max_live_sessions as number),
    stepModels: inherited ? ((state.step_models as Record<string, string> | undefined) ?? {}) : {},
    start: input.start,
  };
  const hooks: ProvisionHooks = {
    before: async () => {
      const current = await validateCreation(repo, input);
      if (current.ownerSlug !== owner || !mine(readState(repo, current.ownerSlug)) || readState(repo, current.ownerSlug).creation !== "ready") {
        throw new DomainError("failed_precondition", "sub-task parent ownership or provisioning changed during creation");
      }
      if ((await taskHead(current.parent, "parent")) !== baseRef) throw new DomainError("failed_precondition", "sub-task parent changed during creation");
    },
    after: async (child) => {
      const parent = readTaskChecked(repo, owner);
      parent.active_subtask = child.slug;
      await writeTaskUnlocked(repo, parent);
      const meta = JSON.parse(readFileSync(manager.metaPath, "utf8")) as Json;
      meta.subtask_slug = child.slug;
      writeAtomic(manager.metaPath, JSON.stringify(meta));
    },
  };
  return {
    params,
    hooks,
    result: (reply, provisioning) => {
      let session: Json = manager.meta;
      try {
        session = JSON.parse(readFileSync(manager.metaPath, "utf8")) as Json;
      } catch {
        /* the file as it was read */
      }
      const parent = readTask(repo, owner) ?? manager.parent;
      return { parent_task: snake(taskSummary(parent)), child_task: reply.task ? snake(taskSummary(reply.task)) : null, manager_session: session, provisioning };
    },
  };
}

/** The wire form the MCP tool reads: `TaskSummary` with its Rust field names. */
const snake = (s: TaskSummary): Json => ({
  name: s.name,
  slug: s.slug,
  branch: s.branch,
  worktree: s.worktree,
  has_worktree: s.hasWorktree,
  playbook: s.playbook,
  archived: s.archived,
  draft: s.draft,
  subtask_outcome: s.subtaskOutcome,
});

// ---- discard and kill --------------------------------------------------------------------------------------

type DiscardContext = { manager: ManagerContext; descendants: TaskRecord[]; sessions: { slug: string; id: string }[] };

/** `discard_context`: the manager, the chain of children it is bound to, and every session that goes with them. */
function discardContext(repo: string, ownerSlug: string, managerSessionId: string): DiscardContext {
  const known = loadRelationships(repo);
  let manager: ManagerContext;
  if (managerSessionId === "") {
    const parent = known.get(ownerSlug);
    if (!parent) throw new DomainError("not_found", `no such task: ${ownerSlug}`);
    if (text(parent, "active_subtask") === "") throw new DomainError("failed_precondition", "task has no active sub-task to discard");
    manager = { ownerSlug, parent, meta: { subtask_manager: true, subtask_slug: text(parent, "active_subtask") }, metaPath: "" };
  } else {
    manager = resolveSubtaskManager(repo, managerSessionId, known);
    if (manager.ownerSlug !== ownerSlug) throw new DomainError("failed_precondition", "sub-task manager does not belong to this task");
  }
  const bound = text(manager.meta, "subtask_slug");
  const descendants: TaskRecord[] = [];
  if (bound !== "") {
    if (text(manager.parent, "active_subtask") !== bound) throw relationshipError("manager binding does not match its parent active child");
    let parentSlug = manager.ownerSlug;
    let childSlug = bound;
    for (;;) {
      const child = known.get(childSlug);
      if (!child) throw relationshipError("active child task is missing");
      if (text(child, "parent_task") !== parentSlug) throw relationshipError("manager binding does not match reciprocal child");
      descendants.push(child);
      if (text(child, "active_subtask") === "") break;
      parentSlug = child.slug;
      childSlug = text(child, "active_subtask");
    }
  }
  const sessions = new Map<string, { slug: string; id: string }>();
  const add = (slug: string, id: string) => sessions.set(`${slug}\0${id}`, { slug, id });
  for (const f of sessionFiles(repo, manager.ownerSlug)) if (f.meta.subtask_manager === true && text(f.meta, "subtask_slug") === bound) add(manager.ownerSlug, f.session.id);
  for (const task of descendants) for (const f of sessionFiles(repo, task.slug)) add(task.slug, f.session.id);
  return { manager, descendants, sessions: [...sessions.values()].sort((a, b) => (a.slug + "\0" + a.id < b.slug + "\0" + b.id ? -1 : 1)) };
}

/** `subtask_discard_sessions`: the sessions a discard stops first. */
export function subtaskDiscardSessions(repo: string, ownerSlug: string, managerSessionId: string): { slug: string; id: string }[] {
  return discardContext(repo, ownerSlug, managerSessionId).sessions;
}

/** The files a session keeps, and its process's own database, which a discarded setup must not leave behind. */
const sessionFileNames = (id: string) => [`${id}.meta.json`, `${id}.scrollback`, `${id}.name.json`, `${id}.pi.sqlite`, `${id}.pi.sqlite-wal`, `${id}.pi.sqlite-shm`];

export type DiscardResult = {
  /** The sessions that were stopped and, for a setup, removed. */
  sessions: { slug: string; id: string }[];
  /** The children that were archived as killed, deepest last. */
  killed: string[];
};

/**
 * `discard_subtask` with the stopping in front of it: every session of the lineage is stopped first (a refusal leaves
 * everything in place), then a manager bound to a child archives that child and its active descendants as `killed`
 * (task records, sessions, artifacts and worktrees stay as history), and an unbound manager's files are removed. The
 * parent's execution is untouched: its records and `execution.json` stay as they were.
 */
export async function discardSubtask(repo: string, ownerSlug: string, managerSessionId: string, stop: (slug: string, id: string) => void | Promise<void>): Promise<DiscardResult> {
  const planned = discardContext(repo, ownerSlug, managerSessionId).sessions;
  for (const s of planned) await stop(s.slug, s.id);
  return withTaskMutation(repo, "discard or kill sub-task", async () => {
    const { manager, descendants, sessions } = discardContext(repo, ownerSlug, managerSessionId);
    if (text(manager.meta, "subtask_slug") !== "") {
      await archiveKilledLineage(repo, manager, descendants);
      return { sessions, killed: descendants.map((t) => t.slug) };
    }
    const trash = join(alineryDir(repo), "subtask-trash", `${managerSessionId}-${process.hrtime.bigint()}`);
    mkdirSync(trash, { recursive: true });
    const moved: [string, string][] = [];
    try {
      for (const s of sessions) {
        if (s.slug !== manager.ownerSlug) continue;
        for (const name of sessionFileNames(s.id)) {
          const source = join(sessionsDir(repo, s.slug), name);
          if (!existsSync(source)) continue;
          const destination = join(trash, "sessions", name);
          mkdirSync(join(trash, "sessions"), { recursive: true });
          renameSync(source, destination);
          moved.push([source, destination]);
        }
      }
    } catch (error) {
      for (const [source, destination] of moved.reverse()) {
        try {
          renameSync(destination, source);
        } catch {
          /* the file is in the trash, which is not removed below */
        }
      }
      rmSync(trash, { recursive: true, force: true });
      throw new DomainError("internal", `discard sub-task setup: ${error instanceof Error ? error.message : String(error)}`);
    }
    rmSync(trash, { recursive: true, force: true });
    return { sessions, killed: [] };
  });
}

/** `archive_killed_lineage`: the children are archived as killed and the parent lets go of its child, all or nothing. */
async function archiveKilledLineage(repo: string, manager: ManagerContext, descendants: TaskRecord[]): Promise<void> {
  const slugs = [manager.parent.slug, ...descendants.map((t) => t.slug)];
  const originals = slugs.map((slug) => [join(taskDir(repo, slug), "task.md"), readFileSync(join(taskDir(repo, slug), "task.md"))] as const);
  try {
    for (const task of descendants) {
      const killed = { ...task };
      delete killed.active_subtask;
      killed.archived = true;
      killed.subtask_outcome = "killed";
      await writeTaskUnlocked(repo, killed);
    }
    const parent = { ...manager.parent };
    delete parent.active_subtask;
    await writeTaskUnlocked(repo, parent);
  } catch (error) {
    for (const [path, bytes] of originals) writeAtomic(path, bytes);
    throw error;
  }
  for (const task of descendants) {
    try {
      pruneExecutionObjects(repo, task.slug);
    } catch (error) {
      console.error(`vinculum: archived task ${task.slug}: execution objects not pruned: ${(error as Error).message}`);
    }
  }
}
