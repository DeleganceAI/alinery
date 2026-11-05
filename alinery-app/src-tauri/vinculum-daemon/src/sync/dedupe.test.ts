import { expect, test } from "bun:test";
import { Dedupe } from "./dedupe.ts";

test("a repeated mutation id gets the first answer and does not run again", async () => {
  const d = new Dedupe();
  let runs = 0;
  const run = () => d.once({ clientId: "c", mutationId: "m1" }, () => ++runs);
  expect(await run()).toBe(1);
  expect(await run()).toBe(1);
  expect(runs).toBe(1);
  expect(await d.once({ clientId: "c", mutationId: "m2" }, () => ++runs)).toBe(2);
});

test("the same mutation id from another client is a different mutation", async () => {
  const d = new Dedupe();
  expect(await d.once({ clientId: "a", mutationId: "m" }, () => "a")).toBe("a");
  expect(await d.once({ clientId: "b", mutationId: "m" }, () => "b")).toBe("b");
});

test("an error is the answer too, and a repeat while the first still runs shares it", async () => {
  const d = new Dedupe();
  let runs = 0;
  const failing = () =>
    d.once({ clientId: "c", mutationId: "bad" }, async () => {
      runs++;
      await Bun.sleep(5);
      throw new Error("nope");
    });
  const [a, b] = await Promise.allSettled([failing(), failing()]);
  expect([a.status, b.status]).toEqual(["rejected", "rejected"]);
  await expect(failing()).rejects.toThrow("nope");
  expect(runs).toBe(1);
});

test("the 257th id evicts the oldest, and only the oldest", async () => {
  const d = new Dedupe();
  const runs = new Map<string, number>();
  const run = (id: string) =>
    d.once({ clientId: "c", mutationId: id }, () => {
      runs.set(id, (runs.get(id) ?? 0) + 1);
    });
  for (let i = 0; i < 256; i++) await run(`m${i}`);
  await run("m0"); // still held: no new run
  expect(runs.get("m0")).toBe(1);
  await run("m256"); // the 257th
  await run("m1"); // m0 is the oldest and went first, so m1 is still held
  expect(runs.get("m1")).toBe(1);
  await run("m0");
  expect(runs.get("m0")).toBe(2);
});
