import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { expect, test } from "bun:test";
import { attachShell, killPty, startShell, writePty } from "./terminal.ts";

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
  const chunks: Buffer[] = [];
  const socket = {
    writableLength: 0,
    write(data: Buffer | string) {
      chunks.push(Buffer.from(data));
      return true;
    },
    on() {
      return this;
    },
    destroy() {},
    end() {},
  } as unknown as Socket;
  expect(attachShell(id, socket, 7, 80, 24)).toBe(true);
  const replay = Buffer.concat(chunks).toString("utf8");
  expect(replay.startsWith('{"ok":true}\n')).toBe(true);
  expect(replay).toContain("vinculum-pty-ok");
  killPty(id);
});
