// BlobService's bookkeeping (plan 2.1.5, S4.3): chunked uploads into a task's attachments or into the daemon's staging
// directory, and the reads of attachments and a draft's pasted images. A blob is named, never addressed by a path: the
// client says which task and which file, and this module resolves and checks the path, so nothing outside `.alinery/`
// is reachable. Staged chunks live in `.alinery/tmp/uploads/<upload_id>` and are cleared when the daemon starts.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { extname, join } from "node:path";
import { writeDurable } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import { chatAttachmentsDir, loadChat } from "./chat.ts";
import { alineryDir, attachmentsDir, safeComponent, taskDir } from "./taskFiles.ts";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_SET_BYTES = 100 * 1024 * 1024;
/** The size a client should cut chunks to (WA 256 KiB). */
export const CHUNK_BYTES = 256 * 1024;

export type UploadTarget = { kind: "attachment"; taskSlug: string; name: string } | { kind: "chat"; threadId: string; name: string } | { kind: "staged"; name: string };

type Upload = { id: string; target: UploadTarget; size: number; sha256: string; received: number; fd: number; path: string; done?: BlobResult };
export type BlobResult = { kind: "attachment"; taskSlug: string; name: string } | { kind: "chat"; threadId: string; name: string } | { kind: "staged"; name: string; uploadId: string };

/** attachments.rs `attachment_dir_bytes`. */
export function dirBytes(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .reduce((sum, e) => sum + statSync(join(dir, e.name)).size, 0);
  } catch {
    return 0;
  }
}

/** task_creation.rs `unique_attachment_name`: a numeric suffix goes before the extension; undefined after 99 collisions. */
export function uniqueAttachmentName(dir: string, base: string): string | undefined {
  if (!existsSync(join(dir, base))) return base;
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot + 1)] : [base, ""];
  for (let n = 2; n <= 99; n++) {
    const candidate = ext ? `${stem}-${n}.${ext}` : `${stem}-${n}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return undefined;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json" };
export const contentType = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

export class BlobStore {
  private readonly uploads = new Map<string, Upload>();
  private readonly staging: string;

  constructor(private readonly repo: string) {
    this.staging = join(alineryDir(repo), "tmp", "uploads");
    // A restart drops every unfinished upload, and a staged file nothing claimed.
    rmSync(this.staging, { recursive: true, force: true });
  }

  begin(target: UploadTarget, size: number, sha256: string): { uploadId: string; chunkBytes: number } {
    if (safeComponent(target.name) !== target.name) throw new DomainError("invalid_argument", `invalid attachment name: ${target.name}`);
    if (target.kind === "attachment") {
      if (safeComponent(target.taskSlug) !== target.taskSlug) throw new DomainError("invalid_argument", "invalid task slug");
      if (!existsSync(taskDir(this.repo, target.taskSlug))) throw new DomainError("not_found", `no such task: ${target.taskSlug}`);
    }
    if (target.kind === "chat") loadChat(this.repo, target.threadId);
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DomainError("invalid_argument", "sha256 must be 64 lowercase hex digits");
    if (!Number.isSafeInteger(size) || size < 0) throw new DomainError("invalid_argument", "invalid upload size");
    if (size > MAX_ATTACHMENT_BYTES) throw new DomainError("invalid_argument", `${target.name} - larger than 25 MB`);
    mkdirSync(this.staging, { recursive: true });
    const id = randomUUID();
    const path = join(this.staging, id);
    this.uploads.set(id, { id, target, size, sha256, received: 0, fd: openSync(path, "w", 0o600), path });
    return { uploadId: id, chunkBytes: CHUNK_BYTES };
  }

  private open(id: string): Upload {
    const u = this.uploads.get(id);
    if (!u) throw new DomainError("not_found", "unknown upload");
    return u;
  }

  chunk(id: string, offset: number, data: Uint8Array): void {
    const u = this.open(id);
    if (u.done) throw new DomainError("failed_precondition", "the upload is already committed");
    // A chunk the daemon already has (a retry after a lost reply) changes nothing.
    if (offset + data.length <= u.received && offset < u.received) return;
    if (offset !== u.received) throw new DomainError("invalid_argument", `chunk offset ${offset} does not continue at ${u.received}`);
    if (u.received + data.length > u.size) throw new DomainError("invalid_argument", "more bytes than the upload announced");
    writeSync(u.fd, data);
    u.received += data.length;
  }

  /** Verifies size and sha256, then places the file: an attachment atomically under its task, a staged one where the id names it. */
  async commit(id: string): Promise<BlobResult> {
    const u = this.open(id);
    if (u.done) return u.done;
    closeSync(u.fd);
    const bytes = readFileSync(u.path);
    const reject = (message: string): never => {
      this.uploads.delete(id);
      rmSync(u.path, { force: true });
      throw new DomainError("invalid_argument", message);
    };
    if (bytes.length !== u.size) reject(`${u.target.name} - ${bytes.length} bytes arrived, ${u.size} were announced`);
    if (createHash("sha256").update(bytes).digest("hex") !== u.sha256) reject(`${u.target.name} - the bytes do not match their sha256`);
    if (u.target.kind === "staged") {
      u.done = { kind: "staged", name: u.target.name, uploadId: id };
      return u.done;
    }
    const dir = u.target.kind === "chat" ? chatAttachmentsDir(this.repo, u.target.threadId) : attachmentsDir(this.repo, u.target.taskSlug);
    mkdirSync(dir, { recursive: true });
    if (dirBytes(dir) + bytes.length > MAX_ATTACHMENT_SET_BYTES) reject(`${u.target.name} - attachment set would exceed 100 MB`);
    const name = uniqueAttachmentName(dir, u.target.name);
    if (!name) reject(`${u.target.name} - too many name collisions`);
    renameSync(u.path, join(dir, name as string));
    u.done = u.target.kind === "chat" ? { kind: "chat", threadId: u.target.threadId, name: name as string } : { kind: "attachment", taskSlug: u.target.taskSlug, name: name as string };
    return u.done;
  }

  /** A committed staged upload's file and name; undefined for anything else. */
  staged(id: string): { path: string; name: string; size: number } | undefined {
    const u = this.uploads.get(id);
    return u?.done?.kind === "staged" ? { path: u.path, name: u.target.name, size: u.size } : undefined;
  }

  /** The create has used a staged file (or given up on it). */
  release(id: string): void {
    const u = this.uploads.get(id);
    if (!u) return;
    this.uploads.delete(id);
    rmSync(u.path, { force: true });
  }
}

// ---- reads -------------------------------------------------------------------------------------------------

export type BlobBytes = { total: number; contentType: string; read: (offset: number, length: number) => Uint8Array };

/** An attachment's file: a regular file inside the task's attachments directory, never a link. */
export function attachmentBlob(repo: string, taskSlug: string, name: string): BlobBytes {
  if (safeComponent(taskSlug) !== taskSlug) throw new DomainError("invalid_argument", "invalid task slug");
  if (safeComponent(name) !== name) throw new DomainError("invalid_argument", `invalid attachment name: ${name}`);
  return regularFileBlob(join(attachmentsDir(repo, taskSlug), name), name);
}

function regularFileBlob(path: string, name: string): BlobBytes {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new DomainError("not_found", `attachment not found: ${name}`);
  }
  if (!st.isFile()) throw new DomainError("not_found", `attachment not found: ${name}`);
  return {
    total: st.size,
    contentType: contentType(name),
    read: (offset, length) => {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset)));
        readSync(fd, buf, 0, buf.length, offset);
        return buf;
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** A file in a chat thread's attachments directory: the thread must exist, the name is one component, the file a regular file. */
export function chatAttachmentBlob(repo: string, threadId: string, name: string): BlobBytes {
  loadChat(repo, threadId);
  if (safeComponent(name) !== name) throw new DomainError("invalid_argument", `invalid attachment name: ${name}`);
  return regularFileBlob(join(chatAttachmentsDir(repo, threadId), name), name);
}

/** A pasted image a draft keeps in `draft-attachments.json` (base64 inside the file). */
export function draftImageBlob(repo: string, draftSlug: string, name: string): BlobBytes {
  if (safeComponent(draftSlug) !== draftSlug) throw new DomainError("invalid_argument", "invalid draft slug");
  let file: { images?: { name: string; bytes: string; mime_type: string }[] };
  try {
    file = JSON.parse(readFileSync(join(taskDir(repo, draftSlug), "draft-attachments.json"), "utf8"));
  } catch {
    throw new DomainError("not_found", `draft has no attachments: ${draftSlug}`);
  }
  const image = file.images?.find((i) => i.name === name);
  if (!image) throw new DomainError("not_found", `draft image not found: ${name}`);
  const bytes = Buffer.from(image.bytes, "base64");
  return { total: bytes.length, contentType: image.mime_type || contentType(name), read: (offset, length) => bytes.subarray(offset, length ? offset + length : undefined) };
}

/** Writes a file the way attachments are written: one durable replace. Used by task creation to place staged and duplicated files. */
export async function placeFile(path: string, bytes: Uint8Array): Promise<void> {
  await writeDurable(path, bytes);
}
