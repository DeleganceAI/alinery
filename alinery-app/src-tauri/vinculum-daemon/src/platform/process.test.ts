import { expect, test } from "bun:test";
import { signalChild, spawnDetached } from "./process.ts";

test("spawnDetached starts the child in its own process group", async () => {
  const child = spawnDetached(["sh", "-c", "ps -o pgid= -p $$"], { stdout: "pipe" });
  const pgid = Number((await new Response(child.stdout).text()).trim());
  await child.exited;
  expect(pgid).toBe(child.pid);
  expect(pgid).not.toBe(process.pid);
});

test("signalChild delivers the signal, and a child that already exited is not an error", async () => {
  const child = spawnDetached(["sleep", "30"], {});
  signalChild(child, "SIGTERM", "session-kill");
  expect(await child.exited).not.toBe(0);
  expect(child.signalCode).toBe("SIGTERM");
  signalChild(child, "SIGTERM", "session-kill");
});
