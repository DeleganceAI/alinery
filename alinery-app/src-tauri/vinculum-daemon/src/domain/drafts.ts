// Task drafts (S4.3), ported from alinery-core `task_drafts.rs`: the half-written task the create form autosaves.
// A draft is a task with `draft = true` plus a ticket artifact and `draft-attachments.json`. Pasted images stay
// base64 inside that file, as Rust wrote them, so a draft written by either side reads on the other.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { localBranches } from "../platform/git.ts";
import { DomainError, withTaskMutation } from "../platform/lock.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_SET_BYTES } from "./blobs.ts";
import {
  alineryDir,
  artifactsDir,
  branchNamesConflict,
  composeTicket,
  draftSlugify,
  nowSecs,
  readTask,
  readTaskChecked,
  safeComponent,
  type TaskRecord,
  taskDir,
  tasksDir,
  worktreesDir,
  writeTaskUnlocked,
} from "./taskFiles.ts";

export type DraftImage = { name: string; bytes: string; mime_type: string };
export type DraftAttachments = { entries: string[]; images: DraftImage[] };

const reusable = (t: TaskRecord) => t.draft === true && t.archived !== true;

export function validateDraftAttachments(a: DraftAttachments): void {
  let total = 0;
  for (const image of a.images) {
    if (safeComponent(image.name) !== image.name) throw new DomainError("invalid_argument", `invalid attachment name: ${image.name}`);
    const len = Buffer.from(image.bytes, "base64").length;
    if (len > MAX_ATTACHMENT_BYTES) throw new DomainError("invalid_argument", `${image.name} — larger than 25 MB`);
    if (len > MAX_ATTACHMENT_SET_BYTES - total) throw new DomainError("invalid_argument", "attachment set would exceed 100 MB");
    total += len;
  }
}

function latestDraftWithName(repo: string, name: string): string | undefined {
  let best: { created: number; slug: string } | undefined;
  let entries: string[];
  try {
    entries = readdirSync(tasksDir(repo));
  } catch {
    return undefined;
  }
  for (const slug of entries) {
    const task = readTask(repo, slug);
    if (!task || !reusable(task) || task.name !== name) continue;
    const created = Number(task.created);
    if (!best || created > best.created || (created === best.created && slug > best.slug)) best = { created, slug };
  }
  return best?.slug;
}

/** `unique_slug_except`: the task directory, the worktree directory and the branch must all be free (-2, -3, ...). */
async function uniqueDraftSlug(repo: string, base: string): Promise<string> {
  const refs = await localBranches(repo);
  let slug = base;
  for (let n = 2; existsSync(taskDir(repo, slug)) || existsSync(join(worktreesDir(repo), slug)) || refs.some((r) => branchNamesConflict(r, slug)); n++) slug = `${base}-${n}`;
  return slug;
}

async function draftSlugForName(repo: string, base: string, name: string): Promise<string> {
  const existing = readTask(repo, base);
  if (existing && reusable(existing)) return base;
  const found = latestDraftWithName(repo, name);
  if (found) return found;
  return existing || existsSync(taskDir(repo, base)) ? uniqueDraftSlug(repo, base) : base;
}

export type WriteDraft = {
  draftSlug: string;
  taskSlug: string;
  name: string;
  description: string;
  evidence: string;
  linearId: string;
  githubIssue: string;
  playbook: { scope: string; key: string };
  launch: { harness: string; model: string };
  autoAdvance?: string[];
  stepModels: Record<string, string>;
  maxLiveSessions: number;
  branchName: string;
  worktreeName: string;
  draftBaseRef?: string;
  attachments?: DraftAttachments;
};

export async function writeDraft(repo: string, d: WriteDraft): Promise<{ task: TaskRecord; created: boolean }> {
  mkdirSync(alineryDir(repo), { recursive: true });
  return withTaskMutation(repo, "write draft", async () => {
    if (d.maxLiveSessions === 0) throw new DomainError("invalid_argument", "maximum live sessions must be positive");
    const name = d.name.trim();
    if (name === "") throw new DomainError("invalid_argument", "task name is empty");
    const requested = d.draftSlug.trim();
    let slug: string;
    if (requested === "") slug = await draftSlugForName(repo, draftSlugify(name), name);
    else {
      if (!safeComponent(requested)) throw new DomainError("invalid_argument", "invalid draft slug");
      const found = readTaskChecked(repo, requested);
      if (!reusable(found)) throw new DomainError("failed_precondition", "draft is archived or has already been promoted");
      slug = requested;
    }
    if (d.attachments) validateDraftAttachments(d.attachments);
    mkdirSync(taskDir(repo, slug), { recursive: true });
    const previous = readTask(repo, slug);
    let requestedSlug: string;
    if (d.taskSlug.trim() === "") requestedSlug = (previous && String(previous.requested_slug ?? "")) || draftSlugify(name);
    else {
      requestedSlug = draftSlugify(d.taskSlug.trim());
      if (requestedSlug !== d.taskSlug.trim()) throw new DomainError("invalid_argument", "task slug must use lowercase letters, numbers, and single dashes");
    }
    const models = Object.fromEntries(Object.entries(d.stepModels).flatMap(([k, v]) => (v.trim() ? [[k, v.trim()]] : [])));
    const record: TaskRecord = {
      name,
      slug,
      ...(requestedSlug ? { requested_slug: requestedSlug } : {}),
      branch: d.branchName.trim(),
      worktree: d.worktreeName.trim(),
      has_worktree: true,
      created: previous ? Number(previous.created) : nowSecs(),
      archived: false,
      pr_url: "",
      linear_id: d.linearId.trim(),
      github_issue: d.githubIssue.trim(),
      playbook: "",
      engine_version: 0,
      playbook_ref: d.playbook,
      max_live_sessions: d.maxLiveSessions,
      launch_defaults: d.launch,
      auto_advance: d.autoAdvance ?? [],
      auto_approve_all: false,
      ...(Object.keys(models).length ? { step_models: models } : {}),
      draft: true,
      ...(d.draftBaseRef !== undefined ? { draft_base_ref: d.draftBaseRef } : {}),
      telemetry_id: (previous && String(previous.telemetry_id ?? "")) || crypto.randomUUID(),
    };
    await writeTaskUnlocked(repo, record);
    const ticket = composeTicket(name, d.description, d.evidence, [], [], []);
    if (ticket !== "") {
      mkdirSync(artifactsDir(repo, slug), { recursive: true });
      const path = join(artifactsDir(repo, slug), "00-ticket.md");
      let current: string | undefined;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        /* none yet */
      }
      if (current !== ticket) writeAtomic(path, ticket);
    }
    if (d.attachments) writeAtomic(join(taskDir(repo, slug), "draft-attachments.json"), JSON.stringify(d.attachments));
    return { task: record, created: previous === undefined };
  });
}

/** Removes a draft's whole directory (an archive would leave `task.md`). Returns the telemetry id it had. */
export async function deleteDraft(repo: string, slug: string): Promise<string> {
  return withTaskMutation(repo, "delete draft", () => {
    const task = readTaskChecked(repo, slug);
    if (task.draft !== true) throw new DomainError("failed_precondition", "not a draft");
    rmSync(taskDir(repo, slug), { recursive: true, force: true });
    return String(task.telemetry_id ?? "");
  });
}
