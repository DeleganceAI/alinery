import { afterEach, describe, expect, test } from "bun:test";
import { create, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { HostReplySchema, HostRequestSchema, type HostReply } from "alinery-proto/alinery/v1/host_pb";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, type BackupSettings } from "../domain/backup.ts";
import { Claims } from "./ops.ts";
import { frame, FrameReader, MARKER, MAX_FRAME, serveHost } from "./serve.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ai-hs-${name}-`)));
  dirs.push(d);
  return d;
};

type Call = MessageInitShape<typeof HostRequestSchema>["call"];
const request = (id: number, call: Call) => frame(toBinary(HostRequestSchema, create(HostRequestSchema, { id: BigInt(id), call })));

/** Everything the service wrote, split into the marker and the replies by id. */
function decode(bytes: Uint8Array): { marker: string; replies: HostReply[] } {
  const text = new TextDecoder().decode(bytes.subarray(0, MARKER.length));
  const frames = new FrameReader().push(bytes.subarray(MARKER.length));
  return { marker: text, replies: frames.map((f) => fromBinary(HostReplySchema, f)) };
}

/** Feeds `chunks` to an in-process service and returns what it wrote once the input has ended. */
async function exchange(chunks: Uint8Array[], claims = new Claims()) {
  const out: Uint8Array[] = [];
  async function* input() {
    for (const chunk of chunks) {
      yield chunk;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  await serveHost(input(), (b) => out.push(b), "9.9.9", claims);
  const all = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of out) {
    all.set(b, at);
    at += b.length;
  }
  return decode(all);
}

describe("framing", () => {
  test("a frame is a big-endian length and the message; the reader reassembles any split", () => {
    const f = frame(new Uint8Array([1, 2, 3]));
    expect([...f]).toEqual([0, 0, 0, 3, 1, 2, 3]);
    const reader = new FrameReader();
    const twice = new Uint8Array([...f, ...f]);
    const got: number[][] = [];
    for (let i = 0; i < twice.length; i++) for (const m of reader.push(twice.subarray(i, i + 1))) got.push([...m]);
    expect(got).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(reader.push(new Uint8Array([0, 0]))).toEqual([]);
  });

  test("a length over the limit is refused instead of allocated", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, MAX_FRAME + 1, false);
    expect(() => new FrameReader().push(header)).toThrow(/over the .* byte limit/);
  });
});

describe("serveHost", () => {
  test("opens with the marker line and an unprompted hello under id 0", async () => {
    const { marker, replies } = await exchange([]);
    expect(marker).toBe(MARKER);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.id).toBe(0n);
    expect(replies[0]?.body).toMatchObject({ case: "hello", value: { runtime: "9.9.9", pid: process.pid } });
  });

  test("answers each request under its own id, errors included, and keeps serving after one", async () => {
    const root = scratch("answers");
    const { replies } = await exchange([
      request(1, { case: "ping", value: {} }),
      request(2, { case: "listDir", value: { path: join(root, "missing"), showHidden: false } }),
      request(3, { case: "writeFile", value: { path: join(root, "c/app.toml"), contents: "a = 1\n" } }),
      request(4, { case: "classify", value: { path: root } }),
    ]);
    const byId = new Map(replies.map((r) => [Number(r.id), r.body]));
    expect(byId.get(1)).toMatchObject({ case: "done" });
    expect(byId.get(2)?.case).toBe("error");
    expect((byId.get(2) as { value: string }).value).toContain("read ");
    expect(byId.get(3)).toMatchObject({ case: "done" });
    expect(readFileSync(join(root, "c/app.toml"), "utf8")).toBe("a = 1\n");
    expect(byId.get(4)).toMatchObject({ case: "folder", value: { kind: 2, path: root } });
  });

  test("a request split across reads and a request with no call are both answered", async () => {
    const whole = request(7, { case: "ping", value: {} });
    const empty = frame(toBinary(HostRequestSchema, create(HostRequestSchema, { id: 8n })));
    const { replies } = await exchange([whole.subarray(0, 3), whole.subarray(3), empty]);
    const byId = new Map(replies.map((r) => [Number(r.id), r.body]));
    expect(byId.get(7)).toMatchObject({ case: "done" });
    expect(byId.get(8)).toMatchObject({ case: "error", value: "the host's runtime does not understand this request" });
  });

  test("a frame that is not a request is skipped and the next one is still served", async () => {
    const { replies } = await exchange([frame(new Uint8Array([0xff, 0xff, 0xff])), request(5, { case: "ping", value: {} })]);
    expect(replies.map((r) => Number(r.id))).toEqual([0, 5]);
  });

  test("claim, a second claimant, release, and the folder replies", async () => {
    const repo = scratch("claim");
    const mine = new Claims();
    const first = await exchange([request(1, { case: "claimRepo", value: { repo } }), request(2, { case: "claimRepo", value: { repo } })], mine);
    expect(first.replies.slice(1).map((r) => r.body)).toMatchObject([{ case: "claim", value: { claimed: true } }, { case: "claim", value: { claimed: true } }]);
    const other = await exchange([request(1, { case: "claimRepo", value: { repo } })], new Claims());
    expect(other.replies[1]?.body).toMatchObject({ case: "claim", value: { claimed: false } });
    await exchange([request(1, { case: "releaseRepo", value: { repo } })], mine);
    const after = await exchange([request(1, { case: "claimRepo", value: { repo } })], new Claims());
    expect(after.replies[1]?.body).toMatchObject({ case: "claim", value: { claimed: true } });
  });

  test("init and classify round trip through the wire", async () => {
    const dir = scratch("init");
    const { replies } = await exchange([
      request(1, { case: "classify", value: { path: dir } }),
      request(2, { case: "init", value: { path: dir } }),
    ]);
    // Replies are concurrent, so look each up by id; ordering is not part of the wire.
    const byId = new Map(replies.map((r) => [Number(r.id), r.body]));
    expect(byId.get(1)).toMatchObject({ case: "folder", value: { kind: 2, path: dir } });
    expect(byId.get(2)).toMatchObject({ case: "init", value: { kind: 1, root: dir } });
  });

  test("credentials, remove file and the list reply", async () => {
    const root = scratch("creds");
    const creds = join(root, "c/provider-credentials.json");
    mkdirSync(join(root, "c"));
    writeFileSync(creds, JSON.stringify({ codex: { type: "oauth" } }));
    mkdirSync(join(root, "a/.git"), { recursive: true });
    const { replies } = await exchange([
      request(1, { case: "syncCredentials", value: { path: creds, set: { k: '{"type":"api_key"}' }, remove: [], eraseOauth: true } }),
      request(2, { case: "listDir", value: { path: root, showHidden: false } }),
    ]);
    const byId = new Map(replies.map((r) => [Number(r.id), r.body]));
    expect(byId.get(1)).toMatchObject({ case: "erased", value: { providers: ["codex"] } });
    expect(byId.get(2)).toMatchObject({ case: "listing", value: { path: root, truncated: false, entries: [{ name: "a", git: true, symlink: false }, { name: "c" }] } });
  });

  test("a backup is verified before and restored over a changed repository", async () => {
    const base = scratch("backup");
    const repo = join(base, "repo");
    const dest = join(base, "dest");
    mkdirSync(join(repo, ".alinery/tasks/one"), { recursive: true });
    mkdirSync(dest);
    writeFileSync(join(repo, ".alinery/tasks/one/task.md"), 'name = "One"\n');
    const settings: BackupSettings = { destination: dest, enabled: true, retention: 3, triggerPreArchive: true, triggerPostArtifactChange: true, triggerPostPushCommit: true };
    const made = await createBackup(repo, settings, "manual", "9.9.9");
    writeFileSync(join(repo, ".alinery/tasks/one/task.md"), 'name = "Changed"\n');
    const other = join(base, "other");
    mkdirSync(join(other, ".alinery"), { recursive: true });
    const { replies } = await exchange([
      request(1, { case: "backupVerify", value: { repo, backupPath: made.path } }),
      request(2, { case: "backupVerify", value: { repo: other, backupPath: made.path } }),
    ]);
    const byId = new Map(replies.map((r) => [Number(r.id), r.body]));
    expect(byId.get(1)).toMatchObject({ case: "done" });
    expect(byId.get(2)).toMatchObject({ case: "error" });
    expect((byId.get(2) as { value: string }).value).toContain("belongs to");
    const restored = await exchange([request(1, { case: "backupRestore", value: { repo, backupPath: made.path } })]);
    expect(restored.replies[1]?.body).toMatchObject({ case: "done" });
    expect(readFileSync(join(repo, ".alinery/tasks/one/task.md"), "utf8")).toBe('name = "One"\n');
  });
});

/** The real program over real pipes, the way the shell runs it over ssh. */
describe("the --host-service process", () => {
  const main = join(import.meta.dir, "../main.ts");

  function start() {
    const child = Bun.spawn([process.execPath, main, "--host-service", "--app-version", "1.2.3"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let pending = new Uint8Array(0);
    const take = async (n: number) => {
      while (pending.length < n) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the service closed its stdout");
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        pending = joined;
      }
      const out = pending.slice(0, n);
      pending = pending.subarray(n);
      return out;
    };
    return {
      child,
      async marker() {
        return new TextDecoder().decode(await take(MARKER.length));
      },
      async reply(): Promise<HostReply> {
        const length = new DataView((await take(4)).buffer).getUint32(0, false);
        return fromBinary(HostReplySchema, await take(length));
      },
      send(id: number, call: Call) {
        child.stdin.write(request(id, call));
        child.stdin.flush();
      },
    };
  }

  test("two processes cannot hold one repo; closing the channel hands it over", async () => {
    const repo = scratch("proc");
    const a = start();
    const b = start();
    expect(await a.marker()).toBe(MARKER);
    expect((await a.reply()).body).toMatchObject({ case: "hello", value: { runtime: "1.2.3" } });
    expect(await b.marker()).toBe(MARKER);
    await b.reply();

    a.send(1, { case: "claimRepo", value: { repo } });
    expect((await a.reply()).body).toMatchObject({ case: "claim", value: { claimed: true } });
    b.send(1, { case: "claimRepo", value: { repo } });
    expect((await b.reply()).body).toMatchObject({ case: "claim", value: { claimed: false } });

    // The channel dying (stdin closing) is how the lock is given up on a real host.
    a.child.stdin.end();
    expect(await a.child.exited).toBe(0);
    b.send(2, { case: "claimRepo", value: { repo } });
    expect((await b.reply()).body).toMatchObject({ case: "claim", value: { claimed: true } });
    b.child.stdin.end();
    expect(await b.child.exited).toBe(0);
  }, 30_000);
});
