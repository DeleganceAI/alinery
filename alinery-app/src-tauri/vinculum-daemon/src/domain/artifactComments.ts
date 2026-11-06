// Human review comments on a task's artifacts (plan S4.5): the comment, draft and review-pending files, and the prepared
// "address these comments" prompt. Ports alinery-core `artifact_comments.rs` byte for byte where a file is written: the
// comments markdown is what an agent reads, and its hash is what proves the prompt a person sent is the one on disk.
// Everything here is synchronous, so two calls cannot interleave; the files are written atomically.
import { existsSync, readFileSync, realpathSync, rmSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import { parseSessionMeta } from "../sync/parsers/sessionMeta.ts";
import { artifactFilePath, artifactTextHash, resolveArtifactPath } from "./artifactFiles.ts";
import { artifactsDir, readTaskChecked, safeComponent, sessionsDir } from "./taskFiles.ts";

export type Comment = {
  id: string;
  artifact: string;
  anchor_id: string;
  anchor_kind: string;
  anchor_label: string;
  anchor_excerpt: string;
  line_start: number;
  line_end: number;
  body: string;
  created_at_ms: number;
};
/** What a reviewer typed: where in the artifact it is anchored, and the text. */
export type CommentInput = Pick<Comment, "anchor_id" | "anchor_kind" | "anchor_label" | "anchor_excerpt" | "line_start" | "line_end" | "body">;
export type Draft = CommentInput & { artifact: string; artifact_hash: string; updated_at_ms: number; stale: boolean };
export type PendingStatus = { artifact: string; review: string };
export type Snapshot = { artifact: string; review: string; comments_hash: string };
export type Provenance = { type: "artifact_comments"; items: Snapshot[] } | { type: "review_approval"; review_artifact: string };
export type PreparedAction = { text: string; provenance: Provenance };

const refuse = (message: string) => new DomainError("invalid_argument", message);
const COMMENT_LIMITS = { label: 120, excerpt: 500 };
const now = () => Date.now();

/** Rust's `str::lines`: a line ends at `\n` (and drops the `\r` before it); a last line without one keeps what it has. */
function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const last = parts.pop() as string;
  const out = parts.map((p) => (p.endsWith("\r") ? p.slice(0, -1) : p));
  if (last !== "") out.push(last);
  return out;
}

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
export const clampChars = (value: string, max: number) => [...value].slice(0, max).join("");
export const escapeCommentMarkdown = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** `artifact_comment_stem`: the name without its extension (a directory part stays). */
export function artifactCommentStem(name: string): string {
  const slash = name.lastIndexOf("/");
  const file = name.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? name.slice(0, slash + 1) + file.slice(0, dot) : name;
}

const sidecarName = (artifact: string, suffix: string) => `${artifactCommentStem(artifact)}${suffix}`;
export function commentsJsonName(repo: string, slug: string, artifact: string): string {
  artifactFilePath(repo, slug, artifact);
  return sidecarName(artifact, ".comments.json");
}
export const commentsMarkdownName = (repo: string, slug: string, artifact: string) => (artifactFilePath(repo, slug, artifact), sidecarName(artifact, ".comments.md"));
export const reviewPendingName = (repo: string, slug: string, artifact: string) => (artifactFilePath(repo, slug, artifact), sidecarName(artifact, ".review-pending.json"));

export function draftsPath(repo: string, slug: string): string {
  if (!safeComponent(slug)) throw refuse("invalid task slug");
  return resolveArtifactPath(repo, `.alinery/tasks/${slug}/artifact-comment-drafts.json`);
}

const removeIfExists = (path: string) => rmSync(path, { force: true });

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, text);
}

// ---- reads -------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : fail(k));
const uint = (o: Record<string, unknown>, k: string, max = Number.MAX_SAFE_INTEGER): number => (typeof o[k] === "number" && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 && (o[k] as number) <= max ? (o[k] as number) : fail(k));
const fail = (k: string): never => {
  throw new Error(`invalid ${k}`);
};

function parseComment(v: unknown): Comment {
  if (!isObject(v)) return fail("comment");
  return {
    id: text(v, "id"),
    artifact: text(v, "artifact"),
    anchor_id: text(v, "anchor_id"),
    anchor_kind: text(v, "anchor_kind"),
    anchor_label: text(v, "anchor_label"),
    anchor_excerpt: text(v, "anchor_excerpt"),
    line_start: uint(v, "line_start", 2 ** 32 - 1),
    line_end: uint(v, "line_end", 2 ** 32 - 1),
    body: text(v, "body"),
    created_at_ms: uint(v, "created_at_ms"),
  };
}

function parseDraft(v: unknown): Draft {
  if (!isObject(v)) return fail("draft");
  return {
    artifact: text(v, "artifact"),
    anchor_id: text(v, "anchor_id"),
    anchor_kind: text(v, "anchor_kind"),
    anchor_label: text(v, "anchor_label"),
    anchor_excerpt: text(v, "anchor_excerpt"),
    line_start: uint(v, "line_start", 2 ** 32 - 1),
    line_end: uint(v, "line_end", 2 ** 32 - 1),
    body: text(v, "body"),
    artifact_hash: text(v, "artifact_hash"),
    updated_at_ms: uint(v, "updated_at_ms"),
    stale: false,
  };
}

/** The comments of one artifact; an unreadable file is an error, a missing one is none. */
export function loadComments(repo: string, slug: string, artifact: string): Comment[] {
  const path = artifactFilePath(repo, slug, commentsJsonName(repo, slug, artifact));
  if (!existsSync(path)) return [];
  try {
    const file = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(file)) return fail("file");
    uint(file, "version", 2 ** 32 - 1);
    text(file, "artifact");
    if (!Array.isArray(file.comments)) return fail("comments");
    return file.comments.map(parseComment);
  } catch (error) {
    throw new DomainError("failed_precondition", `parse artifact comments ${path}: ${(error as Error).message}`);
  }
}

export function loadDrafts(repo: string, slug: string): Draft[] {
  const path = draftsPath(repo, slug);
  if (!existsSync(path)) return [];
  try {
    const file = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(file)) return fail("file");
    uint(file, "version", 2 ** 32 - 1);
    if (!Array.isArray(file.drafts)) return fail("drafts");
    return file.drafts.map(parseDraft);
  } catch (error) {
    throw new DomainError("failed_precondition", `parse artifact comment drafts ${path}: ${(error as Error).message}`);
  }
}

/** The hash of an artifact's text now (`artifact_hash_for`); throws when the file cannot be read. */
export function artifactHashFor(repo: string, slug: string, artifact: string): string {
  const path = artifactFilePath(repo, slug, artifact);
  try {
    return artifactTextHash(readFileSync(path, "utf8"));
  } catch (error) {
    throw new DomainError("not_found", `read ${path}: ${(error as Error).message}`);
  }
}

/** The drafts of a task, each marked stale when its artifact changed since the draft was saved. */
export function listDrafts(repo: string, slug: string): Draft[] {
  const hashes = new Map<string, string | undefined>();
  return loadDrafts(repo, slug).map((draft) => {
    if (!hashes.has(draft.artifact)) {
      try {
        hashes.set(draft.artifact, artifactHashFor(repo, slug, draft.artifact));
      } catch {
        hashes.set(draft.artifact, undefined);
      }
    }
    return { ...draft, stale: hashes.get(draft.artifact) !== draft.artifact_hash };
  });
}

export function readArtifactText(repo: string, slug: string, name: string): string {
  const path = artifactFilePath(repo, slug, name);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new DomainError("not_found", `read ${path}: ${(error as Error).message}`);
  }
}

// ---- drafts ------------------------------------------------------------------------------------------------

function writeDrafts(repo: string, slug: string, drafts: Draft[]): void {
  const path = draftsPath(repo, slug);
  if (drafts.length === 0) return removeIfExists(path);
  const rows = drafts.map(({ stale: _stale, ...d }) => ({
    artifact: d.artifact,
    anchor_id: d.anchor_id,
    anchor_kind: d.anchor_kind,
    anchor_label: d.anchor_label,
    anchor_excerpt: d.anchor_excerpt,
    line_start: d.line_start,
    line_end: d.line_end,
    body: d.body,
    artifact_hash: d.artifact_hash,
    updated_at_ms: d.updated_at_ms,
  }));
  writeFile(path, JSON.stringify({ version: 1, drafts: rows }, null, 2));
}

export function deleteDraft(repo: string, slug: string, artifact: string, anchorId: string): void {
  artifactFilePath(repo, slug, artifact);
  writeDrafts(
    repo,
    slug,
    loadDrafts(repo, slug).filter((d) => d.artifact !== artifact || d.anchor_id !== anchorId),
  );
}

/** An empty body deletes the draft; otherwise the draft replaces the one at the same anchor, stamped with the artifact's hash. */
export function saveDraft(repo: string, slug: string, artifact: string, input: CommentInput): void {
  if (input.body === "") return deleteDraft(repo, slug, artifact, input.anchor_id);
  const artifactHash = artifactHashFor(repo, slug, artifact);
  const drafts = loadDrafts(repo, slug).filter((d) => d.artifact !== artifact || d.anchor_id !== input.anchor_id);
  drafts.push({
    ...input,
    artifact,
    anchor_label: clampChars(input.anchor_label, COMMENT_LIMITS.label),
    anchor_excerpt: clampChars(input.anchor_excerpt, COMMENT_LIMITS.excerpt),
    artifact_hash: artifactHash,
    updated_at_ms: now(),
    stale: false,
  });
  drafts.sort((a, b) => byBytes(a.artifact, b.artifact) || a.line_start - b.line_start || a.updated_at_ms - b.updated_at_ms);
  writeDrafts(repo, slug, drafts);
}

// ---- comments ----------------------------------------------------------------------------------------------

function commentsMarkdown(artifact: string, comments: Comment[]): string {
  const stem = artifactCommentStem(artifact);
  let markdown = `# Human comments for ${artifact}\n\nGenerated by Alinery from \`${stem}.comments.json\`. Read this file alongside \`${artifact}\` before acting on the design.\n`;
  for (const c of comments) {
    markdown += `\n## Comment ${c.id} — ${escapeCommentMarkdown(c.anchor_label)}\n\n- Anchor: \`${c.anchor_id}\`\n- Lines: ${c.line_start}-${c.line_end}\n\nContext:\n\n`;
    for (const line of lines(escapeCommentMarkdown(c.anchor_excerpt))) markdown += `> ${line}\n`;
    markdown += `\n<comment id="${c.id}" line_start="${c.line_start}" line_end="${c.line_end}">\n${escapeCommentMarkdown(c.body)}\n</comment>\n`;
  }
  return markdown;
}

export function writeCommentsMarkdown(repo: string, slug: string, artifact: string, comments: Comment[]): void {
  writeFile(artifactFilePath(repo, slug, commentsMarkdownName(repo, slug, artifact)), commentsMarkdown(artifact, comments));
}

/** Adds a comment (the body is trimmed; an empty one is refused), rewrites the comments file and its markdown, and returns every comment of the artifact. */
export function addComment(repo: string, slug: string, artifact: string, input: CommentInput): Comment[] {
  const body = input.body.trim();
  if (body === "") throw refuse("comment body is empty");
  const comments = loadComments(repo, slug, artifact);
  const createdAt = now();
  let id = `c${createdAt}`;
  for (let suffix = 2; comments.some((c) => c.id === id); suffix++) id = `c${createdAt}_${suffix}`;
  comments.push({
    id,
    artifact,
    anchor_id: input.anchor_id,
    anchor_kind: input.anchor_kind,
    anchor_label: clampChars(input.anchor_label, COMMENT_LIMITS.label),
    anchor_excerpt: clampChars(input.anchor_excerpt, COMMENT_LIMITS.excerpt),
    line_start: input.line_start,
    line_end: input.line_end,
    body,
    created_at_ms: createdAt,
  });
  comments.sort((a, b) => a.line_start - b.line_start || a.created_at_ms - b.created_at_ms);
  writeFile(artifactFilePath(repo, slug, commentsJsonName(repo, slug, artifact)), JSON.stringify({ version: 1, artifact, comments }, null, 2));
  writeCommentsMarkdown(repo, slug, artifact, comments);
  return comments;
}

// ---- review pending ----------------------------------------------------------------------------------------

function nextReviewName(repo: string, slug: string, artifact: string): string {
  const stem = artifactCommentStem(artifact);
  for (let i = 1; i <= 999; i++) {
    const name = `${stem}.review-${String(i).padStart(3, "0")}.md`;
    if (!existsSync(artifactFilePath(repo, slug, name))) return name;
  }
  throw refuse(`too many review files for ${artifact}`);
}

function writeReviewPending(repo: string, slug: string, artifact: string, review: string): void {
  const path = artifactFilePath(repo, slug, reviewPendingName(repo, slug, artifact));
  artifactFilePath(repo, slug, review);
  writeFile(path, JSON.stringify({ version: 1, artifact, review, artifact_hash_at_send: artifactHashFor(repo, slug, artifact), created_at_ms: now() }, null, 2));
}

type PendingFile = { version: number; artifact: string; review: string; artifact_hash_at_send: string; created_at_ms: number };
function readPendingFile(path: string): PendingFile {
  const o = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(o)) return fail("file");
  return { version: uint(o, "version", 2 ** 32 - 1), artifact: text(o, "artifact"), review: text(o, "review"), artifact_hash_at_send: text(o, "artifact_hash_at_send"), created_at_ms: uint(o, "created_at_ms") };
}

/**
 * The review a person sent for an artifact and has not yet seen answered. A pending mark whose artifact changed since (the
 * agent answered) is removed here, as `artifact_review_pending_status_for` always did, so the answer clears the mark.
 */
export function pendingStatus(repo: string, slug: string, artifact: string): PendingStatus | undefined {
  const path = artifactFilePath(repo, slug, reviewPendingName(repo, slug, artifact));
  if (!existsSync(path)) return undefined;
  let pending: PendingFile;
  try {
    pending = readPendingFile(path);
  } catch (error) {
    throw new DomainError("failed_precondition", `parse ${path}: ${(error as Error).message}`);
  }
  if (pending.artifact !== artifact || artifactHashFor(repo, slug, artifact) !== pending.artifact_hash_at_send) {
    removeIfExists(path);
    return undefined;
  }
  return { artifact: pending.artifact, review: pending.review };
}

export function clearPending(repo: string, slug: string, artifact: string): void {
  removeIfExists(artifactFilePath(repo, slug, reviewPendingName(repo, slug, artifact)));
}

// ---- prepare, finalize, archive ----------------------------------------------------------------------------

/** The review file already holding exactly this markdown, else the first free `<stem>.review-NNN.md`. */
function preparedReviewName(repo: string, slug: string, artifact: string, markdown: string): string {
  const stem = artifactCommentStem(artifact);
  let firstAvailable: string | undefined;
  for (let i = 1; i <= 999; i++) {
    const name = `${stem}.review-${String(i).padStart(3, "0")}.md`;
    const path = artifactFilePath(repo, slug, name);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") === markdown) return name;
    } else firstAvailable ??= name;
  }
  if (!firstAvailable) throw refuse(`too many review files for ${artifact}`);
  return firstAvailable;
}

/** Writes the comments markdown and its review copy for each artifact and returns the prompt that points an agent at them. */
export function prepareCommentsPrompt(repo: string, slug: string, artifacts: string[]): PreparedAction {
  if (artifacts.length === 0) throw refuse("no artifact comments selected");
  const items: Snapshot[] = [];
  const rows: string[] = [];
  for (const artifact of artifacts) {
    const comments = loadComments(repo, slug, artifact);
    if (comments.length === 0) throw refuse(`no comments to prepare for ${artifact}`);
    writeCommentsMarkdown(repo, slug, artifact, comments);
    const markdown = readFileSync(artifactFilePath(repo, slug, commentsMarkdownName(repo, slug, artifact)), "utf8");
    const review = preparedReviewName(repo, slug, artifact, markdown);
    const reviewPath = artifactFilePath(repo, slug, review);
    if (!existsSync(reviewPath)) writeFile(reviewPath, markdown);
    items.push({ artifact, review, comments_hash: artifactTextHash(markdown) });
    rows.push(`- \`${artifact}\` → \`${reviewPath}\``);
  }
  const first = items[0];
  const prompt =
    rows.length === 1
      ? `Human review comments were added for \`${first.artifact}\`. Read \`${artifactFilePath(repo, slug, first.review)}\`, address each comment in this session, and update \`${first.artifact}\` if the design should change; otherwise explain why no change is needed.`
      : [
          "Human review comments were added for multiple artifacts:",
          rows.join("\n"),
          "",
          "Read each review file alongside its paired artifact, address every comment in this session, and update the corresponding artifact when needed; otherwise explain why no change is needed.",
        ].join("\n");
  return { text: prompt, provenance: { type: "artifact_comments", items } };
}

export function validateFinalization(repo: string, slug: string, items: Snapshot[]): void {
  if (items.length === 0) throw refuse("artifact comment provenance is empty");
  for (const item of items) {
    artifactFilePath(repo, slug, item.artifact);
    const stem = artifactCommentStem(item.artifact);
    const suffix = item.review.startsWith(`${stem}.review-`) && item.review.endsWith(".md") ? item.review.slice(`${stem}.review-`.length, -".md".length) : undefined;
    if (!(suffix !== undefined && /^[0-9]{3}$/.test(suffix))) throw refuse(`invalid prepared review for ${item.artifact}`);
    const path = artifactFilePath(repo, slug, item.review);
    let review: string;
    try {
      review = readFileSync(path, "utf8");
    } catch (error) {
      throw new DomainError("not_found", `read ${path}: ${(error as Error).message}`);
    }
    if (artifactTextHash(review) !== item.comments_hash) throw refuse(`prepared review hash mismatch for ${item.artifact}`);
  }
}

/** The prompt went to the agent: mark each artifact's review pending and drop the comments the prompt carried (unless they changed since). */
export function finalizeComments(repo: string, slug: string, items: Snapshot[]): void {
  validateFinalization(repo, slug, items);
  for (const item of items) {
    const pendingPath = artifactFilePath(repo, slug, reviewPendingName(repo, slug, item.artifact));
    let finalized = false;
    try {
      const pending = readPendingFile(pendingPath);
      finalized = pending.artifact === item.artifact && pending.review === item.review;
    } catch {
      /* no pending mark yet */
    }
    if (!finalized) writeReviewPending(repo, slug, item.artifact, item.review);
    const markdownPath = artifactFilePath(repo, slug, commentsMarkdownName(repo, slug, item.artifact));
    let matches = false;
    try {
      matches = artifactTextHash(readFileSync(markdownPath, "utf8")) === item.comments_hash;
    } catch {
      /* gone */
    }
    if (matches) {
      removeIfExists(artifactFilePath(repo, slug, commentsJsonName(repo, slug, item.artifact)));
      removeIfExists(markdownPath);
    }
  }
}

/** Sends the comments as a review file without a session: copies the markdown to the next review name, marks it pending and clears the comments. Returns the review's name. */
export function archiveComments(repo: string, slug: string, artifact: string): string {
  const comments = loadComments(repo, slug, artifact);
  if (comments.length === 0) throw refuse(`no comments to archive for ${artifact}`);
  const markdownName = commentsMarkdownName(repo, slug, artifact);
  const markdownPath = artifactFilePath(repo, slug, markdownName);
  if (!existsSync(markdownPath)) writeCommentsMarkdown(repo, slug, artifact, comments);
  const review = nextReviewName(repo, slug, artifact);
  writeFile(artifactFilePath(repo, slug, review), readFileSync(markdownPath, "utf8"));
  writeReviewPending(repo, slug, artifact, review);
  removeIfExists(artifactFilePath(repo, slug, commentsJsonName(repo, slug, artifact)));
  removeIfExists(markdownPath);
  return review;
}

/** The prompt that asks a review session to approve through its own GitHub capability. */
export function prepareReviewApproval(repo: string, slug: string, reviewArtifact: string): PreparedAction {
  const task = readTaskChecked(repo, slug);
  const path = artifactFilePath(repo, slug, reviewArtifact);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (error) {
    throw new DomainError("not_found", `read ${path}: ${(error as Error).message}`);
  }
  if (!st.isFile()) throw refuse(`review findings artifact is not a file: ${path}`);
  const resolved = realpathSync(path);
  const prUrl = typeof task.pr_url === "string" ? task.pr_url : "";
  const pr = prUrl === "" ? "PR URL: not set in Alinery task metadata; infer it from the checked-out branch/remote if possible." : `PR URL: ${prUrl}`;
  return {
    text: [
      "Review playbook action: approve this PR through the harness, not through Alinery.",
      pr,
      `Review findings artifact: ${reviewArtifact}`,
      `Review findings path: ${resolved}`,
      "Read the findings artifact. If it contains no blocking work, submit an approving GitHub PR review or comment using your own GitHub capability.",
      "Do not ask Alinery/the local app to call a GitHub approval API; the approval/comment is harness-owned.",
      "After submitting or deciding not to submit, write or update the review-response artifact with the decision and evidence.",
    ].join("\n"),
    provenance: { type: "review_approval", review_artifact: reviewArtifact },
  };
}

/** The session's message went out: finalize what its prompts carried. Everything is checked before anything is changed. */
export function finalizeSessionMessageActions(repo: string, id: string, slug: string, actions: Provenance[]): void {
  const metaPath = join(sessionsDir(repo, slug), `${id}.meta.json`);
  let entity: ReturnType<typeof parseSessionMeta>;
  try {
    entity = parseSessionMeta(readFileSync(metaPath, "utf8"), slug, id);
  } catch (error) {
    throw new DomainError("not_found", `read ${metaPath}: ${(error as Error).message}`);
  }
  if (entity?.value.case !== "session") throw new DomainError("failed_precondition", `parse ${metaPath}`);
  if (entity.value.value.id !== id) throw refuse("session id mismatch");
  for (const action of actions) {
    if (action.type === "artifact_comments") validateFinalization(repo, slug, action.items);
    else artifactFilePath(repo, slug, action.review_artifact);
  }
  for (const action of actions) if (action.type === "artifact_comments") finalizeComments(repo, slug, action.items);
}

export { artifactsDir };
