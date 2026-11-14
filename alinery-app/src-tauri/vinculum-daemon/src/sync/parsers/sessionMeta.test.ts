// Runs the TypeScript parser over the conformance cases Rust's reader also runs
// (alinery-core/tests/conformance.rs): same inputs, same expected.json.
import { toJson } from "@bufbuild/protobuf";
import { EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Feed } from "../feed.ts";
import { Store } from "../store.ts";
import { parseSessionMeta } from "./sessionMeta.ts";

const ROOT = resolve(import.meta.dir, "../../../../conformance/session_meta");

// Both sides drop null and default-valued fields and compare numbers as strings: proto3 JSON omits
// defaults and writes 64-bit integers as strings.
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const n = normalize(x);
      if (n === null || n === "" || n === 0 || n === false || n === "0") continue;
      if (typeof n === "object" && !Array.isArray(n) && !Object.keys(n as object).length) continue;
      out[k] = n;
    }
    return out;
  }
  return typeof v === "number" ? String(v) : v;
}

describe("session meta conformance", () => {
  for (const name of readdirSync(ROOT)) {
    test(name, async () => {
      const store = new Store();
      const feed = new Feed(store, join(ROOT, name, "input", ".alinery"));
      await feed.scan();
      const actual: Record<string, unknown> = {};
      for (const { key } of feed.tracked.values()) {
        const entity = store.get(key);
        if (!entity) continue; // a file the parser refused
        const json = toJson(EntitySchema, entity, { useProtoFieldName: true }) as { session: Record<string, unknown> };
        // `ref` comes from the path and `status` is S2.5's; neither is in the meta file.
        const { ref: _ref, status: _status, ...meta } = json.session;
        actual[key] = meta;
      }
      const expected = JSON.parse(readFileSync(join(ROOT, name, "expected.json"), "utf8"));
      expect(normalize(actual)).toEqual(normalize(expected));
    });
  }
});

describe("session meta parser", () => {
  const base = { id: "s", worktree: "/w", created: 1 };
  test("an empty prompt is set, not unset", () => {
    const e = parseSessionMeta(JSON.stringify({ ...base, prompt: "" }), "t", "s");
    expect(e?.value.case === "session" && e.value.value.prompt).toBe("");
    const none = parseSessionMeta(JSON.stringify(base), "t", "s");
    expect(none?.value.case === "session" && none.value.value.prompt).toBeUndefined();
  });
  test("keys come from the path", () => {
    expect(parseSessionMeta(JSON.stringify(base), "fix", "s")?.key).toBe("session/fix/s");
    expect(parseSessionMeta(JSON.stringify(base), "", "s")?.key).toBe("session/_/s");
  });
  test("what serde refuses is refused", () => {
    for (const bad of [{ ...base, phase: null }, { ...base, created: -1 }, { id: "s", worktree: "/w" }, { ...base, exit_code: 2 ** 31 }]) {
      expect(parseSessionMeta(JSON.stringify(bad), "t", "s")).toBeUndefined();
    }
    expect(parseSessionMeta("[]", "t", "s")).toBeUndefined();
  });
});
