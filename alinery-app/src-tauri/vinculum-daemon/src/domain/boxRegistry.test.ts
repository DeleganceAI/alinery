import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listBoxRecords, removeBoxRecord, writeBoxRecord } from "./boxRegistry.ts";

test("a daemon's record is readable by anyone, lists while its process lives, and goes on stop", () => {
  const root = mkdtempSync("/tmp/box-t-");
  const dir = join(root, "daemons");
  try {
    const record = { repo: "/srv/app", lane: "", pid: process.pid, osUser: "dev", startedBy: "nyx on MacBook", startedAtMs: 1, version: "0.600.0", protocol: 42 };
    writeBoxRecord(record, dir);
    writeBoxRecord({ ...record, repo: "/srv/dead", pid: 2 ** 22 + 12345 }, dir); // no such process
    expect(statSync(dir).mode & 0o7777).toBe(0o1777);
    expect(listBoxRecords(dir)).toEqual([record]);
    removeBoxRecord("/srv/app", "", dir);
    expect(listBoxRecords(dir)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
