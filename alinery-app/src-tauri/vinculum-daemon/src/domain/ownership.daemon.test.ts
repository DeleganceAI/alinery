// Two real daemons on one scratch repository (plan S4.11 Accept): the second is refused with `repo_busy` and exits, and the
// first keeps its sockets, its lease, its process and a Terminal session it was running. The loser exits before it reads a
// task or resumes a session, so the session is untouched by construction; the test starts one and asks the first for it after.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { tryLockExclusive } from "../platform/lock.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const root = mkdtempSync("/tmp/ao2-");
const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
});

const daemon = (lane: string) => {
  mkdirSync(join(root, "cfg"), { recursive: true });
  const p = Bun.spawn([process.execPath, MAIN, "--repo", join(root, "repo"), "--app-config", join(root, "cfg", "app.toml"), "--socket-namespace", lane], { stdout: "ignore", stderr: "pipe" });
  procs.push(p);
  return p;
};
/** One JSON-line op on the daemon's UI socket, answered with one JSON line. */
const ask = (path: string, header: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const s = connect(path);
    let buf = "";
    s.once("error", reject);
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) (s.destroy(), resolve(JSON.parse(buf.split("\n")[0])));
    });
    s.write(`${JSON.stringify(header)}\n`);
  });
const probe = (path: string) =>
  new Promise<boolean>((resolve) => {
    const s = connect(path);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

test("the second daemon exits with repo_busy and the first is untouched", async () => {
  mkdirSync(join(root, "repo"), { recursive: true });
  const first = daemon("a");
  const ui = join(root, "repo", ".alinery", "alineryd-a.sock");
  const end = Date.now() + 20_000;
  while (!(existsSync(join(root, "repo", ".alinery", "rpc-a.sock")) && (await probe(ui))) && Date.now() < end) await Bun.sleep(100);
  expect(await probe(ui)).toBe(true);

  // A drawer Terminal (no task) is a real shell the first daemon owns.
  expect(await ask(ui, { op: "spawn", id: "drawer-1", task_slug: "", cwd: join(root, "repo"), cols: 80, rows: 24 })).toEqual({ ok: true });
  const live = (await ask(ui, { op: "status", id: "drawer-1" })) as { process?: { state?: string } };
  expect(live.process?.state).toBe("alive");

  const second = daemon("b");
  const [stderr, code] = await Promise.all([new Response(second.stderr as ReadableStream).text(), second.exited]);
  expect(code).toBe(1);
  expect(stderr).toContain("repo_busy");

  expect(first.exitCode).toBeNull();
  expect(((await ask(ui, { op: "status", id: "drawer-1" })) as { process?: { state?: string } }).process?.state).toBe("alive");
  expect(await probe(ui)).toBe(true);
  expect(existsSync(join(root, "repo", ".alinery", "alineryd-b.sock"))).toBe(false);
  expect(tryLockExclusive(join(root, "repo", ".alinery", ".repo-owner.lock"))).toBeNull();
  first.kill("SIGKILL");
  await first.exited;
  const lock = tryLockExclusive(join(root, "repo", ".alinery", ".repo-owner.lock"));
  expect(lock).not.toBeNull();
  lock?.release();
  rmSync(root, { recursive: true, force: true });
}, 60_000);
