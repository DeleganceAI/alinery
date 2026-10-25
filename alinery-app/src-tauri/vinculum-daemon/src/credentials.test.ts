import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { openCredentialStore } from "./credentials.ts";

test("a credential is owner-only and one per provider", async () => {
  const dir = join(tmpdir(), `alinery-credentials-${crypto.randomUUID()}`);
  mkdirSync(dir);
  const store = openCredentialStore(join(dir, "provider-credentials.json"));
  await store.modify("groq", async () => ({ type: "api_key", key: "secret" }));
  expect(await store.read("groq")).toEqual({ type: "api_key", key: "secret" });
  expect(await store.list()).toEqual([{ providerId: "groq", type: "api_key" }]);
  expect(statSync(join(dir, "provider-credentials.json")).mode & 0o777).toBe(0o600);
  await store.delete("groq");
  expect(await store.read("groq")).toBeUndefined();
});
