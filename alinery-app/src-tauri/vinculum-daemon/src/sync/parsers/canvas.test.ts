import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { matcher } from "../store.ts";
import { route } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a canvas file becomes the thread's canvas row, in panel order, and the chat scope carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-parse-"));
  dirs.push(dir);
  const path = join(dir, "t1.canvas.json");
  writeFileSync(path, JSON.stringify({ v: 1, thread_id: "t1", enabled_at_ms: 3, order: ["p2", "p1"], focus: "p2", panels: { p1: { kind: "table", title: "T", rev: 2, updated_at_ms: 9 }, p2: { kind: "html", title: "H", rev: 1, updated_at_ms: 8 } }, user_closed: [] }));
  const r = route("sessions/t1.canvas.json");
  expect(r?.key).toBe("canvas/_/t1");
  const entity = await r?.parser.parse(path, r.m);
  expect(entity?.value).toMatchObject({ case: "canvas", value: { threadId: "t1", focus: "p2", enabledAtMs: 3n, panels: [{ id: "p2", kind: "html", rev: 1n }, { id: "p1", kind: "table", title: "T", rev: 2n }] } });
  writeFileSync(path, JSON.stringify({ v: 1, thread_id: "someone-else", panels: {} }));
  expect(await r?.parser.parse(path, r.m)).toBeNull();
  expect(route("sessions/t1.canvas/p1.html")).toBeUndefined();
  const chat = matcher(create(ScopeSchema, { kind: { case: "chat", value: {} } }));
  const repoScope = matcher(create(ScopeSchema, { kind: { case: "repo", value: {} } }));
  expect([chat("canvas/_/t1"), repoScope("canvas/_/t1")]).toEqual([true, false]);
});
