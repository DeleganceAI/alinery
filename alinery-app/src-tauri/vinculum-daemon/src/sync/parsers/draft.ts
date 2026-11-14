// A draft's saved attachments (S4.3): `tasks/<slug>/draft-attachments.json`, which `task_drafts.rs` wrote as
// `{entries: string[], images: [{name, bytes (base64), mime_type}]}`. The row carries the entries and the images'
// names and sizes only; a draft's pasted images can be megabytes, so their bytes are read through BlobService.
import { create } from "@bufbuild/protobuf";
import { DraftSchema, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { readFile } from "node:fs/promises";
import type { Parser } from "./index.ts";
import { obj, req, str, strings } from "./serde.ts";

export const draftKey = (slug: string) => `draft/${slug}/${slug}`;

/** The decoded byte length of a standard base64 string, without decoding it. */
const base64Size = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export const draftAttachments: Parser = {
  match: /^tasks\/([^/]+)\/draft-attachments\.json$/,
  key: (m) => draftKey(m[1]),
  parse: async (abs, m) => {
    try {
      const o = obj(JSON.parse(await readFile(abs, "utf8")));
      const images = Array.isArray(o.images) ? o.images : [];
      return create(EntitySchema, {
        key: draftKey(m[1]),
        value: {
          case: "draft",
          value: create(DraftSchema, {
            slug: m[1],
            entries: strings(o.entries ?? []),
            images: images.map((i) => {
              const image = obj(i);
              return { name: req(image, "name"), mimeType: str(image, "mime_type"), size: BigInt(base64Size(req(image, "bytes"))) };
            }),
          }),
        },
      });
    } catch {
      return null; // unreadable: no row, as for a malformed task.md
    }
  },
};
