import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { closeFailedOpen, stopOwningHarness } from "./sessionStop.ts";

const ctx = BACKGROUND_CONTEXT;
const owner = (abort: Conversation["abort"], close: Harness["close"]) => ({
  conversationId: "1",
  harness: { conversation: async () => ({ abort }) as Conversation, close },
});

test("an absent owner requires durable exit evidence", async () => {
  await expect(stopOwningHarness(undefined, false, ctx)).rejects.toThrow("unknown session owner");
  await stopOwningHarness(undefined, true, ctx);
});

test("shutdown waits for background work and successful harness close before reporting an exit", async () => {
  const drained = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const seen: string[] = [];
  const row = owner(async (_context, options) => {
    expect(options?.background).toBe(true);
    seen.push("abort");
    await drained.promise;
  }, async () => {
    seen.push("closing");
    closing.resolve();
    await closed.promise;
  });
  const stop = stopOwningHarness(row, false, ctx, async () => { seen.push("capture history controls"); }).then(() => seen.push("confirmed"));
  drained.resolve();
  await closing.promise;
  expect(seen).toEqual(["abort", "capture history controls", "closing"]);
  closed.resolve();
  await stop;
  expect(seen.at(-1)).toBe("confirmed");
});

test("a refused abort or failed close propagates without confirming shutdown", async () => {
  let closed = false;
  await expect(stopOwningHarness(owner(async () => { throw new Error("abort failed"); }, async () => { closed = true; }), false, ctx)).rejects.toThrow("abort failed");
  expect(closed).toBe(false);
  await expect(stopOwningHarness(owner(async () => {}, async () => { throw new Error("close failed"); }), false, ctx)).rejects.toThrow("close failed");
});

test("a failed open counts as exited only when it has no harness or the harness closed", async () => {
  expect(await closeFailedOpen(null, ctx)).toBe(true);
  let closed = false;
  expect(await closeFailedOpen({ close: async () => { closed = true; } }, ctx)).toBe(true);
  expect(closed).toBe(true);
  expect(await closeFailedOpen({ close: async () => { throw new Error("close failed"); } }, ctx)).toBe(false);
});
