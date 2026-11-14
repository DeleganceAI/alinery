// `sessions/<id>.canvas.json` to the `canvas/_/<id>` row (domain/canvas.ts). A missing or malformed file is no row.
import { create } from "@bufbuild/protobuf";
import { CanvasSchema, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { readFile } from "node:fs/promises";
import { canvasKey, parseCanvas } from "../../domain/canvas.ts";
import type { Parser } from "./index.ts";

export const canvas: Parser = {
  match: /^sessions\/([^/]+)\.canvas\.json$/,
  key: (m) => canvasKey(m[1]),
  async parse(absPath, m) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(absPath, "utf8"));
    } catch {
      return null;
    }
    const file = parseCanvas(raw, m[1]);
    if (!file) return null;
    const panels = file.order.flatMap((id) => {
      const p = file.panels[id];
      return p ? [{ id, kind: p.kind, title: p.title, rev: BigInt(p.rev), updatedAtMs: BigInt(p.updated_at_ms) }] : [];
    });
    return create(EntitySchema, {
      key: canvasKey(m[1]),
      value: { case: "canvas", value: create(CanvasSchema, { threadId: m[1], panels, focus: file.focus, enabledAtMs: BigInt(file.enabled_at_ms) }) },
    });
  },
};
