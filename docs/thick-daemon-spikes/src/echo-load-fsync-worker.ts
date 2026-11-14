// Mitigation A for echo-load.ts: F_FULLFSYNC on a Worker thread, so the main loop never blocks on it.
import { closeSync, openSync } from "node:fs";
import { fullFsync } from "./lock.ts";

declare const self: Worker;
self.onmessage = (e: MessageEvent<{ id: number; paths: string[] }>) => {
  for (const p of e.data.paths) { const fd = openSync(p, "r"); if (fullFsync(fd) !== 0) throw new Error(`fsync ${p}`); closeSync(fd); }
  postMessage(e.data.id);
};
