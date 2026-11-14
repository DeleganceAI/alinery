import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { killPty, startShell, subscribeOutput, writePty, type OutputFrame } from "./terminal.ts";

test("a no-harness shell can be written, detached, and reattached from scrollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vinculum-pty-"));
  const scroll = join(dir, "s.scrollback");
  const id = "shell";
  startShell(id, dir, scroll, 80, 24, () => undefined, "/bin/sh");
  writePty(id, "echo vinculum-pty-ok\n");
  const deadline = Date.now() + 4000;
  let text = "";
  while (Date.now() < deadline) {
    try {
      text = readFileSync(scroll, "utf8");
    } catch {
      text = "";
    }
    if (text.includes("vinculum-pty-ok")) break;
    await Bun.sleep(40);
  }
  expect(text).toContain("vinculum-pty-ok");
  const frames: OutputFrame[] = [];
  const sub = subscribeOutput(id, 0, (f) => frames.push(f));
  expect(sub).toBeDefined();
  const replay = Buffer.concat(sub!.frames.map((f) => ("data" in f ? f.data : Buffer.alloc(0)))).toString("utf8");
  expect(replay).toContain("vinculum-pty-ok");
  sub!.unsubscribe();
  killPty(id);
});
