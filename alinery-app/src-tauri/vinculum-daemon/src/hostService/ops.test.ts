import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneLockPath, laneSocketPath } from "../domain/ownership.ts";
import { tryLockExclusive } from "../platform/lock.ts";
import { Claims, classifyFolder, daemonArguments, initFolder, listDir, removeFile, spawnDaemon, syncCredentials, waitDaemonGone, writeFile } from "./ops.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ai-host-${name}-`)));
  dirs.push(d);
  return d;
};
const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
};

describe("classifyFolder and initFolder", () => {
  test("a folder with no git entry is absent, by its canonical path", async () => {
    const dir = scratch("absent");
    const link = join(scratch("links"), "to-dir");
    symlinkSync(dir, link);
    expect(await classifyFolder(link)).toEqual({ kind: "absent", path: dir });
  });

  test("a checkout is its top level, also when asked from a subfolder", async () => {
    const dir = scratch("checkout");
    sh(dir, "git", "init", "-q");
    mkdirSync(join(dir, "sub"));
    expect(await classifyFolder(dir)).toEqual({ kind: "checkout", path: dir });
    expect(await classifyFolder(join(dir, "sub"))).toEqual({ kind: "checkout", path: dir });
  });

  test("a bare repository and a checkout's .git directory are refused, never offered for init", async () => {
    const bare = scratch("bare");
    sh(bare, "git", "init", "-q", "--bare");
    const refused = await classifyFolder(bare);
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" && refused.message).toContain("not a working tree");
    const checkout = scratch("dotgit");
    sh(checkout, "git", "init", "-q");
    expect((await classifyFolder(join(checkout, ".git"))).kind).toBe("refused");
  });

  test("a folder with a .git entry git cannot use is refused", async () => {
    const dir = scratch("junk");
    writeFileSync(join(dir, ".git"), "not a gitdir\n");
    const refused = await classifyFolder(dir);
    expect(refused.kind === "refused" && refused.message).toContain("already has a Git entry");
  });

  test("a missing path and a file say so", async () => {
    const dir = scratch("errs");
    await expect(classifyFolder(join(dir, "nope"))).rejects.toThrow(/Couldn't initialize Git in .*\nfolder does not exist/);
    writeFileSync(join(dir, "f"), "x");
    await expect(classifyFolder(join(dir, "f"))).rejects.toThrow(/path is not a directory/);
    await expect(classifyFolder("")).rejects.toThrow(/repo path is empty/);
  });

  test("init initializes an absent folder once and leaves an existing checkout alone", async () => {
    const dir = scratch("init");
    expect(await initFolder(dir)).toEqual({ kind: "initialized", root: dir });
    const config = readFileSync(join(dir, ".git/config"), "utf8");
    expect(config).not.toContain("user.name");
    const head = readFileSync(join(dir, ".git/HEAD"), "utf8");
    expect(await initFolder(dir)).toEqual({ kind: "already_checkout", root: dir });
    expect(readFileSync(join(dir, ".git/config"), "utf8")).toBe(config);
    expect(readFileSync(join(dir, ".git/HEAD"), "utf8")).toBe(head);
  });

  test("init refuses what classify refuses", async () => {
    const bare = scratch("init-bare");
    sh(bare, "git", "init", "-q", "--bare");
    await expect(initFolder(bare)).rejects.toThrow(/not a working tree/);
    expect(existsSync(join(bare, ".git"))).toBe(false);
  });
});

describe("listDir", () => {
  test("lists sorted folders with git and symlink badges and hides dot folders", () => {
    const root = scratch("list");
    mkdirSync(join(root, "beta/.git"), { recursive: true });
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "file.txt"), "x");
    symlinkSync(join(root, "alpha"), join(root, "gamma-link"));
    symlinkSync(join(root, "nowhere"), join(root, "broken"));
    const listing = listDir(root, false);
    expect(listing.entries.map((e) => [e.name, e.git, e.symlink])).toEqual([
      ["alpha", false, false],
      ["beta", true, false],
      ["gamma-link", false, true],
    ]);
    expect(listing.truncated).toBe(false);
    expect(listDir(root, true).entries.map((e) => e.name)).toContain(".hidden");
  });

  test("stops at the cap and says so; a missing folder is an error", () => {
    const root = scratch("cap");
    for (let i = 0; i < 2003; i++) mkdirSync(join(root, `d${String(i).padStart(4, "0")}`));
    const listing = listDir(root, false);
    expect(listing.entries).toHaveLength(2000);
    expect(listing.truncated).toBe(true);
    expect(() => listDir(join(root, "missing"), false)).toThrow(/^read /);
  });
});

describe("files", () => {
  test("writeFile creates parents and is owner-only; removeFile tolerates a missing file", () => {
    const root = scratch("write");
    const path = join(root, "config/id/app.toml");
    writeFile(path, "a=1\n");
    expect(readFileSync(path, "utf8")).toBe("a=1\n");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    removeFile(path);
    expect(existsSync(path)).toBe(false);
    removeFile(path);
  });
});

describe("syncCredentials", () => {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  test("writes keys, drops removed API keys, names and erases the sign-ins when asked", async () => {
    const root = scratch("creds");
    const path = join(root, "provider-credentials.json");
    writeFileSync(path, JSON.stringify({ codex: { type: "oauth", refresh: "r" }, old: { type: "api_key", key: "o" } }));
    const erased = await syncCredentials(path, { key: '{"type":"api_key","key":"k"}' }, ["old"], true);
    expect(erased).toEqual(["codex"]);
    expect(read(path)).toEqual({ key: { type: "api_key", key: "k" } });
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("a sign-in made on the host survives a sync, also one that is asked to be removed", async () => {
    const root = scratch("creds-keep");
    const path = join(root, "provider-credentials.json");
    writeFileSync(path, JSON.stringify({ codex: { type: "oauth", refresh: "r" }, openai: { type: "api_key", key: "o" } }));
    expect(await syncCredentials(path, {}, ["codex", "openai"], false)).toEqual([]);
    expect(read(path)).toEqual({ codex: { type: "oauth", refresh: "r" } });
  });

  test("a missing store is created, an unreadable one is an error and stays as it was", async () => {
    const root = scratch("creds-new");
    const path = join(root, "new/provider-credentials.json");
    await syncCredentials(path, { a: '{"type":"api_key","key":"1"}' }, [], false);
    expect(read(path)).toEqual({ a: { type: "api_key", key: "1" } });
    const bad = join(root, "bad.json");
    writeFileSync(bad, "[1,2]");
    await expect(syncCredentials(bad, {}, [], false)).rejects.toThrow("credential store is unreadable");
    expect(readFileSync(bad, "utf8")).toBe("[1,2]");
    await expect(syncCredentials(path, { x: "not json" }, [], false)).rejects.toThrow(/x is not JSON/);
  });

  test("a stale lock left by a dead process is stolen at once", async () => {
    const root = scratch("creds-stale");
    const path = join(root, "provider-credentials.json");
    writeFileSync(`${path}.lock`, "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(`${path}.lock`, old, old);
    const started = Date.now();
    await syncCredentials(path, { a: '{"type":"api_key"}' }, [], false);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(read(path)).toEqual({ a: { type: "api_key" } });
  });

  test("a fresh lock another writer holds is waited out", async () => {
    const root = scratch("creds-lock");
    const path = join(root, "provider-credentials.json");
    writeFileSync(`${path}.lock`, "");
    setTimeout(() => rmSync(`${path}.lock`, { force: true }), 150);
    await syncCredentials(path, { a: '{"type":"api_key"}' }, [], false);
    expect(read(path)).toEqual({ a: { type: "api_key" } });
  });
});

describe("Claims", () => {
  test("a second holder is refused until the first lets go; the same holder may claim again", () => {
    const repo = scratch("claim");
    const first = new Claims();
    const second = new Claims();
    expect(first.claim(repo)).toBe(true);
    expect(first.claim(repo)).toBe(true);
    expect(second.claim(repo)).toBe(false);
    first.release(repo);
    expect(second.claim(repo)).toBe(true);
    expect(first.claim(repo)).toBe(false);
    second.release(repo);
    first.release(repo);
  });

  test("a repo path that cannot hold .alinery is an error that names it", () => {
    const root = scratch("claim-bad");
    writeFileSync(join(root, "file"), "x");
    expect(() => new Claims().claim(join(root, "file"))).toThrow(/prepare repository lock for/);
  });
});

describe("waitDaemonGone", () => {
  const quick = { attempts: 3, intervalMs: 5 };

  test("returns when nothing holds the socket or the lock", async () => {
    const repo = scratch("gone");
    mkdirSync(join(repo, ".alinery"));
    await waitDaemonGone(repo, "", quick);
    // The lock marker it took is a permanent, plain file.
    expect(lstatSync(laneLockPath(repo, "")).isFile()).toBe(true);
  });

  test("a repository with no .alinery is an error", async () => {
    await expect(waitDaemonGone(join(scratch("gone-missing"), "none"), "", quick)).rejects.toThrow();
  });

  test("a held process lock keeps it waiting, then it says the daemon has not let go", async () => {
    const repo = scratch("gone-lock");
    mkdirSync(join(repo, ".alinery"));
    const lease = tryLockExclusive(laneLockPath(repo, ""));
    expect(lease).not.toBeNull();
    await expect(waitDaemonGone(repo, "", quick)).rejects.toThrow(/has not released its socket and process lock/);
    lease?.release();
    await waitDaemonGone(repo, "", quick);
  });

  test("an answering socket keeps it waiting; a daemon that exits mid-wait lets it return", async () => {
    const repo = scratch("gone-sock");
    mkdirSync(join(repo, ".alinery"));
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(laneSocketPath(repo, ""), resolve));
    setTimeout(() => server.close(), 120);
    await waitDaemonGone(repo, "", { attempts: 100, intervalMs: 10 });
    await expect((async () => {
      const again = createServer(() => {});
      await new Promise<void>((resolve) => again.listen(laneSocketPath(repo, ""), resolve));
      try {
        await waitDaemonGone(repo, "", quick);
      } finally {
        again.close();
      }
    })()).rejects.toThrow(/has not released/);
  });

  test("a socket path that is not a socket is refused rather than trusted", async () => {
    const repo = scratch("gone-notsock");
    mkdirSync(join(repo, ".alinery"));
    writeFileSync(laneSocketPath(repo, ""), "");
    await expect(waitDaemonGone(repo, "", quick)).rejects.toThrow(/cannot establish daemon exit/);
  });

  test("a lane that could escape the folder is refused", async () => {
    const repo = scratch("gone-lane");
    mkdirSync(join(repo, ".alinery"));
    await expect(waitDaemonGone(repo, "../other", quick)).rejects.toThrow(/invalid daemon ownership lane/);
  });
});

describe("spawnDaemon", () => {
  const params = (root: string, over: Partial<Parameters<typeof spawnDaemon>[0]> = {}) => ({
    repo: join(root, "repo"),
    appConfig: join(root, "app.toml"),
    binary: join(root, "fake-daemon"),
    buildId: "hash1",
    namespace: "ns",
    log: join(root, "logs/d.log"),
    launch: "direct" as const,
    unit: "",
    rpcSecretFile: join(root, "rpc.secret"),
    appVersion: "9.9.9",
    ...over,
  });

  async function logged(log: string, needle: string): Promise<string> {
    let text = "";
    for (let i = 0; i < 200 && !text.includes(needle); i++) {
      text = existsSync(log) ? readFileSync(log, "utf8") : "";
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return text;
  }

  test("launches detached with the shared recipe and logs the child's output", async () => {
    const root = scratch("spawn");
    writeFileSync(join(root, "app.toml"), '[global.experiments]\ngrok_api_key = "xai-test"\n');
    writeFileSync(join(root, "fake-daemon"), '#!/bin/sh\necho "args: $*"\necho "xai=$XAI_API_KEY host=$ALINERY_HOST_EXECUTABLE remote=$ALINERY_REMOTE_LAUNCH"\n');
    chmodSync(join(root, "fake-daemon"), 0o755);
    await spawnDaemon(params(root), { ...process.env, ALINERY_HOST_EXECUTABLE: "/leak", SHELL: "/bin/sh" });
    const text = await logged(join(root, "logs/d.log"), "xai=");
    expect(text).toContain(`--repo ${join(root, "repo")}`);
    expect(text).toContain("--build-id hash1");
    expect(text).toContain("--app-version 9.9.9");
    expect(text).toContain("--socket-namespace ns");
    expect(text).toContain(`--rpc-secret-file ${join(root, "rpc.secret")}`);
    expect(text).toContain("xai=xai-test host= remote=1\n");
  });

  test("the arguments leave out what was not given", () => {
    const args = daemonArguments(params("/r", { namespace: "", rpcSecretFile: "" }));
    expect(args).toEqual(["--repo", "/r/repo", "--app-config", "/r/app.toml", "--build-id", "hash1", "--app-version", "9.9.9"]);
  });

  test("a binary that is not there is an error; systemd_run needs a unit name", async () => {
    const root = scratch("spawn-bad");
    await expect(spawnDaemon(params(root))).rejects.toThrow(/spawn .*fake-daemon/);
    await expect(spawnDaemon(params(root, { launch: "systemd_run", unit: "" }))).rejects.toThrow("systemd_run needs a unit name");
  });
});
