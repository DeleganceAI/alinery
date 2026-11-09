import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCustomProviders, validateCustom } from "./customProviders.ts";

test("a custom endpoint keeps a saved key when the field is left blank and drops it when asked", () => {
  const existing = [{ id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "keep", models: ["llama"] }];
  const kept = validateCustom({ id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", models: ["llama"] }, new Set(), existing);
  expect(kept.apiKey).toBe("keep");
  const cleared = validateCustom({ id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", models: ["llama"], clearKey: true }, new Set(), existing);
  expect(cleared.apiKey).toBeUndefined();
});

test("a custom endpoint rejects a built-in id and a key hiding in the URL", () => {
  expect(() => validateCustom({ id: "openai", name: "Other", baseUrl: "http://127.0.0.1:1/v1", models: ["m"] }, new Set(["openai"]))).toThrow("already a provider");
  expect(() => validateCustom({ id: "local", name: "Local", baseUrl: "http://user:secret@127.0.0.1:1/v1", models: ["m"] }, new Set())).toThrow("key field");
});

test("two daemons saving different endpoints keep both", () => {
  const path = join(mkdtempSync(join(tmpdir(), "alinery-custom-")), "custom-providers.json");
  const first = openCustomProviders(path);
  const second = openCustomProviders(path);
  first.save({ id: "a", name: "A", baseUrl: "http://127.0.0.1:1/v1", models: ["m"] }, new Set());
  second.save({ id: "b", name: "B", baseUrl: "http://127.0.0.1:2/v1", models: ["m"] }, new Set());
  expect(openCustomProviders(path).list().map((row) => row.id).sort()).toEqual(["a", "b"]);
});
