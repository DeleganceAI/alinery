// Mitigation B for echo-load.ts: a child process that F_FULLFSYNCs each path argument.
import { closeSync, openSync } from "node:fs";
import { fullFsync } from "./lock.ts";

for (const p of process.argv.slice(2)) {
  const fd = openSync(p, "r");
  if (fullFsync(fd) !== 0) process.exit(1);
  closeSync(fd);
}
