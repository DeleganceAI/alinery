// BlobService (plan 2.1.5, S4.3): chunked uploads and reads of attachments, staged uploads and a draft's pasted
// images. A client names a blob; it never names a path. The bookkeeping and the path checks are `domain/blobs.ts`.
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { BlobRef, BlobService } from "alinery-proto/alinery/v1/blobs_pb";
import { artifactBlob, artifactNodeBlob, attachmentBlob, type BlobBytes, canvasPanelBlob, chatAttachmentBlob, type BlobStore, CHUNK_BYTES, draftImageBlob, stepObjectBlob, type UploadTarget, worktreeFileBlob } from "../domain/blobs.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

export type BlobDeps = { repo: string; blobs: BlobStore };

function targetOf(ref: BlobRef | undefined): UploadTarget {
  const t = ref?.target;
  if (t?.case === "attachment") return { kind: "attachment", taskSlug: t.value.taskSlug, name: t.value.name };
  if (t?.case === "chatAttachment") return { kind: "chat", threadId: t.value.threadId, name: t.value.name };
  if (t?.case === "staged") return { kind: "staged", name: t.value.name };
  throw fail(Code.InvalidArgument, "invalid_argument", "an upload target is an attachment, a chat attachment or a staged file");
}

function resolve(repo: string, ref: BlobRef | undefined): BlobBytes {
  const t = ref?.target;
  if (t?.case === "attachment") return attachmentBlob(repo, t.value.taskSlug, t.value.name);
  if (t?.case === "chatAttachment") return chatAttachmentBlob(repo, t.value.threadId, t.value.name);
  if (t?.case === "draftImage") return draftImageBlob(repo, t.value.draftSlug, t.value.name);
  if (t?.case === "artifact") return artifactBlob(repo, t.value.taskSlug, t.value.name);
  if (t?.case === "artifactNode") return artifactNodeBlob(repo, t.value.taskSlug, t.value.nodeId);
  if (t?.case === "stepObject") return stepObjectBlob(repo, t.value.taskSlug, t.value.executionId, t.value.sha256);
  if (t?.case === "canvasPanel") return canvasPanelBlob(repo, t.value.threadId, t.value.panel);
  if (t?.case === "worktreeFile") return worktreeFileBlob(repo, t.value.taskSlug, t.value.path);
  throw fail(Code.InvalidArgument, "invalid_argument", "this blob cannot be read");
}

export function blobService(d: BlobDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof BlobService> {
  return {
    async *readBlob(req, ctx) {
      requireCapability(ctx, Capability.VIEW);
      const blob = await domain(() => resolve(d.repo, req.ref));
      const start = Number(req.offset);
      const end = req.length === 0n ? blob.total : Math.min(blob.total, start + Number(req.length));
      if (start > blob.total) throw fail(Code.InvalidArgument, "invalid_argument", "offset is past the end of the blob");
      if (start === end) {
        yield { data: new Uint8Array(0), offset: BigInt(start), total: BigInt(blob.total), contentType: blob.contentType };
        return;
      }
      const frame = blob.frame ?? CHUNK_BYTES;
      for (let at = start; at < end; at += frame) {
        const data = blob.read(at, Math.min(frame, end - at));
        yield { data, offset: BigInt(at), total: BigInt(blob.total), contentType: blob.contentType };
      }
    },
    beginUpload: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => domain(() => {
        const begun = d.blobs.begin(targetOf(req.target), Number(req.size), req.sha256);
        return { uploadId: begun.uploadId, chunkSize: begun.chunkBytes };
      }));
    },
    uploadChunk: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return domain(() => {
        d.blobs.chunk(req.uploadId, Number(req.offset), req.data);
        return {};
      });
    },
    commitUpload: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return domain(async () => {
        const done = await d.blobs.commit(req.uploadId);
        const target =
          done.kind === "attachment"
            ? ({ case: "attachment", value: { taskSlug: done.taskSlug, name: done.name } } as const)
            : done.kind === "chat"
              ? ({ case: "chatAttachment", value: { threadId: done.threadId, name: done.name } } as const)
              : ({ case: "staged", value: { name: done.name, uploadId: done.uploadId } } as const);
        return { applied: { cursor: store.cursor() }, ref: { target } };
      });
    },
  };
}
