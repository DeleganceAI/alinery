// The files of a task that the daemon reads and writes itself (plan S4.3): `task.md`, its related-task links and the
// naming rules around them, ported from alinery-core `task.rs` and `task_drafts.rs`. `task.md` is TOML that serde reads
// into `Task`; a writer here keeps every key it does not know (a Rust build one version ahead may have added some),
// and `parseTask` is the same reader the board uses, so "readable" means the same thing in both places.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { parseTask } from "../sync/parsers/task.ts";
import { DomainError } from "../platform/lock.ts";
import { writeAtomic, writeDurable } from "../platform/fs.ts";

export type TaskRecord = Record<string, unknown> & { slug: string; name: string };
export type RelatedRef = { repo_path: string; slug: string; name: string };

export const alineryDir = (repo: string) => join(repo, ".alinery");
export const tasksDir = (repo: string) => join(alineryDir(repo), "tasks");
export const taskDir = (repo: string, slug: string) => join(tasksDir(repo), slug);
export const taskMdPath = (repo: string, slug: string) => join(taskDir(repo, slug), "task.md");
export const artifactsDir = (repo: string, slug: string) => join(taskDir(repo, slug), "artifacts");
export const attachmentsDir = (repo: string, slug: string) => join(artifactsDir(repo, slug), "attachments");
export const sessionsDir = (repo: string, slug: string) => join(taskDir(repo, slug), "sessions");
export const worktreesDir = (repo: string) => join(alineryDir(repo), "worktrees");

/** paths.rs `safe_component`: pass-or-undefined; rejects empty, any `..`, any separator, and absolute paths; never rewrites. */
export function safeComponent(s: string): string | undefined {
  return s === "" || s.includes("..") || s.includes("/") || s.includes("\\") || isAbsolute(s) ? undefined : s;
}

export const nowSecs = () => Math.floor(Date.now() / 1000);

/** task.rs `slugify`, the one task creation uses: lowercase, spaces to dashes, letters, numbers and dashes kept. */
export const slugify = (name: string) => [...name.toLowerCase().replaceAll(" ", "-")].filter((c) => /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}]/u.test(c) || c === "-").join("");

/** task_drafts.rs `slugify`: kebab-case from ASCII letters and digits; "task" when nothing is left. */
export function draftSlugify(name: string): string {
  let out = "";
  let dash = false;
  for (const c of name) {
    if (/^[A-Za-z0-9]$/.test(c)) {
      out += c.toLowerCase();
      dash = false;
    } else if (out !== "" && !dash) {
      out += "-";
      dash = true;
    }
  }
  out = out.replace(/-+$/, "");
  return out === "" ? "task" : out;
}

/** Git refs conflict on equality or a slash boundary, not merely a shared prefix. */
export const branchIsParent = (parent: string, branch: string) => branch.startsWith(`${parent}/`);
export const branchNamesConflict = (existing: string, candidate: string) => existing === candidate || branchIsParent(existing, candidate) || branchIsParent(candidate, existing);

export function uniqueName(occupied: (name: string) => boolean, base: string): string {
  let name = base;
  for (let i = 1; occupied(name); i++) name = `${base}-${i}`;
  return name;
}

/** execution.rs `definition_identity`: FNV-1a over the playbook source, 16 hex digits. Integrity detection, not authentication. */
export function definitionIdentity(source: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(source, "utf8")) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

// ---- task.md ---------------------------------------------------------------------------------------------

/** `read_task_checked`: the task as a plain record, or why it is not one. */
export function readTaskChecked(repo: string, slug: string): TaskRecord {
  if (!safeComponent(slug)) throw new DomainError("invalid_argument", "invalid task slug");
  let text: string;
  try {
    text = readFileSync(taskMdPath(repo, slug), "utf8");
  } catch {
    throw new DomainError("not_found", `no such task: ${slug}`);
  }
  if (!parseTask(text, slug)) throw new DomainError("failed_precondition", `task.md of ${slug} cannot be read`);
  return parse(text) as TaskRecord;
}

/** core `read_task`: undefined when the task is missing or unreadable. */
export function readTask(repo: string, slug: string): TaskRecord | undefined {
  try {
    return readTaskChecked(repo, slug);
  } catch {
    return undefined;
  }
}

/** `list_tasks_for_repo`: every readable, non-archived task, oldest first. */
export function listActiveTasks(repo: string): TaskRecord[] {
  let names: string[];
  try {
    names = readdirSync(tasksDir(repo));
  } catch {
    return [];
  }
  return names
    .flatMap((n) => readTask(repo, n) ?? [])
    .filter((t) => t.archived !== true)
    .sort((a, b) => Number(a.created) - Number(b.created) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** `write_task_unlocked`: the caller holds the task-mutation lock. A record equal to the one on disk is not rewritten. */
export async function writeTaskUnlocked(repo: string, task: TaskRecord): Promise<void> {
  const text = stringify(task);
  try {
    if (readFileSync(taskMdPath(repo, task.slug), "utf8") === text) return;
  } catch {
    /* a new task */
  }
  await writeDurable(taskMdPath(repo, task.slug), text);
}

/** `validate_retained_file`: the file is a regular file with one link, reached through real directories only. */
export function validateRetainedFile(repo: string, path: string): void {
  if (!path.startsWith(`${repo}/`)) throw new DomainError("invalid_argument", "storage path escapes repository");
  const parts = path.slice(repo.length + 1).split("/");
  let current = repo;
  parts.forEach((part, i) => {
    current = join(current, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch {
      throw new DomainError("failed_precondition", "retained storage is unavailable");
    }
    if (i === parts.length - 1) {
      if (!st.isFile() || st.nlink !== 1) throw new DomainError("failed_precondition", "retained storage must be a regular, unlinked file");
    } else if (!st.isDirectory()) throw new DomainError("failed_precondition", "retained storage directory must not be a link");
  });
}

export function validateTaskName(input: string): string {
  const name = input.trim();
  if (name === "") throw new DomainError("invalid_argument", "task name is empty");
  return name;
}

/** A related task is one whose files this machine can read, so its repository must be an absolute path here. */
export function validateRelatedRefs(related: RelatedRef[]): void {
  for (const tag of related) {
    if (!isAbsolute(tag.repo_path.trim())) {
      throw new DomainError(
        "invalid_argument",
        `related task '${tag.slug}' is not on this machine (${tag.repo_path}); tasks can only be related to tasks on the same machine`,
      );
    }
  }
}

// ---- 00-ticket.md ----------------------------------------------------------------------------------------

export const TICKET_EVIDENCE_HEADING = "## Evidence & Pointers";

/** task.rs `compose_ticket`: the one format of every `00-ticket.md`; "" when there is nothing to say. */
export function composeTicket(name: string, description: string, evidence: string, urls: string[], copied: string[], failures: string[]): string {
  const desc = description.trim();
  const ev = evidence.trim();
  const hasEvidence = ev !== "" || urls.length > 0 || copied.length > 0 || failures.length > 0;
  if (desc === "" && !hasEvidence) return "";
  let out = `# ${name}\n`;
  if (desc !== "") out += `\n${desc}\n`;
  if (hasEvidence) {
    out += `\n${TICKET_EVIDENCE_HEADING}\n`;
    if (ev !== "") out += `\n${ev}\n`;
    if (urls.length > 0 || copied.length > 0 || failures.length > 0) {
      out += "\n";
      for (const url of urls) out += `- ${url}\n`;
      for (const file of copied) out += `- attachments/${file}\n`;
      for (const failure of failures) out += `- (not copied: ${failure})\n`;
    }
  }
  return out;
}

// ---- related tasks ---------------------------------------------------------------------------------------

export const relatedLinksDir = (repo: string, slug: string) => join(taskDir(repo, slug), "related");
export const RELATED_MARKDOWN = "related-tasks.md";

/** task.rs `related_link_name`: the slug and a 64-bit FNV-1a of `repo_path NUL slug`, 8 hex digits at least. */
export function relatedLinkName(repoPath: string, slug: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of [...Buffer.from(repoPath, "utf8"), 0, ...Buffer.from(slug, "utf8")]) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `${slug}-${hash.toString(16).padStart(8, "0")}`;
}

function truncateAtCharBoundary(s: string, max: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= max) return s;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function writeRelatedMarkdown(repo: string, slug: string, related: RelatedRef[]): void {
  const path = join(artifactsDir(repo, slug), RELATED_MARKDOWN);
  if (related.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  let body = "# Related tasks\n\nTagged from this task. Tickets are inlined; further artifacts live at the listed directories.\n";
  for (const tag of related) {
    const artifacts = artifactsDir(tag.repo_path, tag.slug);
    const ticketPath = join(artifacts, "00-ticket.md");
    const name = tag.name === "" ? tag.slug : tag.name;
    body += `\n## ${name} (\`${tag.slug}\`)\n\nRepository: \`${tag.repo_path}\`\nArtifacts directory: \`${artifacts}\`\nTicket path: \`${ticketPath}\`\n`;
    let ticket = "";
    try {
      ticket = readFileSync(ticketPath, "utf8");
    } catch {
      /* not readable */
    }
    if (ticket.trim() !== "") {
      const cut = truncateAtCharBoundary(ticket, 32_768);
      body += `\n### Ticket\n\n${cut}${cut.endsWith("\n") ? "" : "\n"}`;
    } else body += "\n_Ticket not readable._\n";
  }
  mkdirSync(artifactsDir(repo, slug), { recursive: true });
  writeAtomic(path, body);
}

/** `sync_related_artifact_links`: make `<task>/related/` hold exactly the symlinks `related` asks for. Only symlinks are removed. */
export function syncRelatedLinks(repo: string, slug: string, related: RelatedRef[]): void {
  const dir = relatedLinksDir(repo, slug);
  mkdirSync(dir, { recursive: true });
  const desired = related.map((tag) => {
    const name = relatedLinkName(tag.repo_path, tag.slug);
    if (safeComponent(name) !== name) throw new DomainError("invalid_argument", `unsafe related-task link name '${name}'`);
    return { name, target: artifactsDir(tag.repo_path, tag.slug) };
  });
  for (const entry of readdirSync(dir)) {
    if (desired.some((d) => d.name === entry)) continue;
    const path = join(dir, entry);
    if (lstatSync(path).isSymbolicLink()) rmSync(path);
  }
  for (const { name, target } of desired) {
    const path = join(dir, name);
    let existing: string | undefined;
    try {
      existing = readlinkSync(path);
    } catch {
      if (existsSync(path)) throw new DomainError("failed_precondition", `related-task link path is not a symlink: ${path}`);
    }
    if (existing === target) continue;
    if (existing !== undefined) rmSync(path);
    symlinkSync(target, path);
  }
  writeRelatedMarkdown(repo, slug, related);
}
