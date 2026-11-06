// Two real daemons on one scratch repository (plan S4.11 Accept): the second is refused with `repo_busy` and exits, and the
// first keeps its sockets, its lease, its process and a Terminal session it was running. The loser exits before it reads a
// task or resumes a session, so the session is untouched by construction; the test starts one and asks the first for it after.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { tryLockExclusive } from "../platform/lock.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const root = mkdtempSync("/tmp/ao2-");
const procs: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
});

const daemon = (lane: string) => {
  mkdirSync(join(root, "cfg"), { recursive: true });
  const secretFile = join(root, `secret-${lane}`);
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const p = Bun.spawn([process.execPath, MAIN, "--repo", join(root, "repo"), "--app-config", join(root, "cfg", "app.toml"), "--socket-namespace", lane, "--rpc-secret-file", secretFile], { stdout: "ignore", stderr: "pipe" });
  procs.push(p);
  return p;
};
const SECRET = "s".repeat(64);
/** The gRPC clients of the first daemon's `rpc-a.sock`, with the secret the test handed it. */
const clients = (socket: string) => {
  const transport = createGrpcTransport({
    baseUrl: "http://daemon",
    nodeOptions: { createConnection: () => connect(socket) } as never,
    interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${SECRET}`), next(req))],
  });
  return { admin: createClient(AdminService, transport), sessions: createClient(SessionService, transport) };
};
const probe = (path: string) =>
  new Promise<boolean>((resolve) => {
    const s = connect(path);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

test("the second daemon exits with repo_busy and the first is untouched", async () => {
  mkdirSync(join(root, "repo"), { recursive: true });
  const first = daemon("a");
  const rpc = join(root, "repo", ".alinery", "rpc-a.sock");
  const { admin, sessions } = clients(rpc);
  const end = Date.now() + 20_000;
  for (;;) {
    try {
      if (existsSync(rpc)) {
        await admin.hello({});
        break;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > end) throw new Error("the first daemon did not start");
    await Bun.sleep(100);
  }
  // The daemon has the one listener; the JSON-lines socket is gone for good (S5.3).
  expect(existsSync(join(root, "repo", ".alinery", "alineryd-a.sock"))).toBe(false);

  // A drawer Terminal (no task) is a real shell the first daemon owns.
  const created = await sessions.createSession({
    meta: { clientId: "t", mutationId: "m1" },
    taskSlug: "",
    target: { case: "auxiliary", value: { harness: "no-harness" } },
    start: true,
  });
  const id = String((created.started?.session as { id?: string } | undefined)?.id);
  expect(id).not.toBe("undefined");
  expect((await admin.liveSessions({})).sessions.map((s) => s.id)).toContain(id);

  const second = daemon("b");
  const [stderr, code] = await Promise.all([new Response(second.stderr as ReadableStream).text(), second.exited]);
  expect(code).toBe(1);
  expect(stderr).toContain("repo_busy");

  expect(first.exitCode).toBeNull();
  expect((await admin.liveSessions({})).sessions.map((s) => s.id)).toContain(id);
  expect(await probe(rpc)).toBe(true);
  expect(existsSync(join(root, "repo", ".alinery", "rpc-b.sock"))).toBe(false);
  expect(tryLockExclusive(join(root, "repo", ".alinery", ".repo-owner.lock"))).toBeNull();
  first.kill("SIGKILL");
  await first.exited;
  const lock = tryLockExclusive(join(root, "repo", ".alinery", ".repo-owner.lock"));
  expect(lock).not.toBeNull();
  lock?.release();
  rmSync(root, { recursive: true, force: true });
}, 60_000);
