// The ownership conformance cases of alinery-core `repo_ownership.rs` and `execution_tests.rs` (plan S4.11), run against the
// TypeScript port. Each Rust case that read "acquire" reads `acquireRepoOwnership` here; the checks on bytes are the same.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { tryLockExclusive } from "../platform/lock.ts";
import { acquireRepoOwnership, laneLockPath, laneSocketPath, validateLane } from "./ownership.ts";
import { definitionIdentity } from "./taskFiles.ts";

const tauri = new URL("../../../", import.meta.url).pathname;
const source = readFileSync(join(tauri, "playbooks", "one-shot", "playbook.md"), "utf8");
type Json = Record<string, any>;

const repos: string[] = [];
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});
// `/tmp`, not the OS temp dir: a unix socket path has a length limit.
const newRepo = () => {
  const repo = mkdtempSync("/tmp/ao-");
  repos.push(repo);
  mkdirSync(join(repo, ".alinery", "tasks"), { recursive: true });
  return repo;
};
const dir = (repo: string, slug: string) => join(repo, ".alinery", "tasks", slug);
const statePath = (repo: string, slug: string) => join(dir(repo, slug), "execution.json");
const readState = (repo: string, slug: string): Json => JSON.parse(readFileSync(statePath(repo, slug), "utf8"));
const bytes = (repo: string, slug: string) => readFileSync(statePath(repo, slug), "utf8");
const take = async (...args: Parameters<typeof acquireRepoOwnership>) => {
  const release = await acquireRepoOwnership(...args);
  releases.push(release);
  return release;
};
const free = (path: string) => {
  const lock = tryLockExclusive(path);
  lock?.release();
  return lock !== null;
};

function record(id: string, lifecycle: string, extra: Json = {}): Json {
  return {
    id,
    binding_key: id,
    candidate: { step_key: "work", context_id: "root", inputs: {}, manual: true },
    outputs: [{ selector: "result.md", relative_path: `${id}-result-1.md`, discriminator: 1 }],
    owner_session_id: `s-${id}`,
    lifecycle,
    permission: { kind: "automatic" },
    receipt_id: lifecycle === "completed" || lifecycle === "finishing" ? `r-${id}` : null,
    shutdown_confirmed: lifecycle === "completed",
    error: null,
    ...extra,
  };
}

/** A task the way a daemon leaves it: task.md, the retained playbook and an execution.json that also carries the engine's own block. */
function task(repo: string, slug: string, options: { archived?: boolean; engineVersion?: number; lane?: string; records?: Json[]; execution?: boolean } = {}) {
  const base = dir(repo, slug);
  mkdirSync(join(base, "artifacts"), { recursive: true });
  writeFileSync(
    join(base, "task.md"),
    `name = "${slug}"\nslug = "${slug}"\nbranch = "${slug}"\nworktree = ""\ncreated = 1\narchived = ${options.archived ?? false}\nengine_version = ${options.engineVersion ?? 2}\n`,
  );
  if (options.execution === false) return;
  writeFileSync(join(base, "playbook.md"), source);
  const records = options.records ?? [record("e1", "completed"), record("e2", "running"), record("e3", "queued")];
  writeFileSync(
    statePath(repo, slug),
    JSON.stringify({
      version: 1,
      revision: 4,
      creation: "ready",
      owning_lane: options.lane ?? "lane",
      owning_app_config_identity: "",
      definition_identity: definitionIdentity(source),
      max_live_sessions: 10,
      executions: Object.fromEntries(records.map((r) => [r.id, r])),
      occurrences: { "seed/x": { id: "seed/x" } },
      contexts: { root: { id: "root" } },
      collections: {},
      engine: { seeds: [], executions: [], ambiguities: [] },
    }),
  );
}

describe("adoption", () => {
  test("a round trip adopts active and archived tasks, keeps evidence, and interrupts unproven work", async () => {
    const repo = newRepo();
    task(repo, "task");
    task(repo, "archived", { archived: true });
    const before = readState(repo, "task");
    const archivedMd = readFileSync(join(dir(repo, "archived"), "task.md"), "utf8");
    for (const [lane, config] of [["dev", "dev-config"], ["", "production-config"], ["dev", "second-dev-config"]] as const) {
      const release = await acquireRepoOwnership(repo, lane, config);
      for (const slug of ["task", "archived"]) {
        const state = readState(repo, slug);
        expect([state.owning_lane, state.owning_app_config_identity]).toEqual([lane, config]);
        expect(state.executions.e1).toEqual(before.executions.e1);
        expect(state.executions.e3).toEqual(before.executions.e3);
        expect(state.occurrences).toEqual(before.occurrences);
        expect(state.contexts).toEqual(before.contexts);
        expect(state.engine).toEqual(before.engine);
        expect(state.executions.e2.lifecycle).toBe("interrupted");
        expect(state.executions.e2.owner_session_id).toBe("s-e2");
        expect(state.executions.e2.shutdown_confirmed).toBe(false);
        expect(state.executions.e2.error).toContain("ownership retained");
      }
      expect(readFileSync(join(dir(repo, "archived"), "task.md"), "utf8")).toBe(archivedMd);
      release();
    }
  });

  test("a finishing execution is interrupted with its receipt kept, and a second owner is refused without touching the file", async () => {
    const repo = newRepo();
    task(repo, "task", { records: [record("e1", "completed"), record("e2", "running"), record("e3", "finishing"), record("e4", "queued")] });
    const before = readState(repo, "task");
    await take(repo, "new-lane", "new-config");
    const adopted = readState(repo, "task");
    expect(adopted.owning_lane).toBe("new-lane");
    expect(adopted.revision).toBe(before.revision + 1);
    expect(adopted.executions.e3).toEqual({ ...before.executions.e3, lifecycle: "interrupted", error: adopted.executions.e3.error });
    expect(adopted.executions.e3.receipt_id).toBe("r-e3");
    const persisted = bytes(repo, "task");
    await expect(acquireRepoOwnership(repo, "third-lane", "third-config")).rejects.toMatchObject({ code: "repo_busy" });
    expect(bytes(repo, "task")).toBe(persisted);
  });

  test("a partial durable batch is retryable, and the failed attempt holds no lease", async () => {
    const repo = newRepo();
    task(repo, "task");
    task(repo, "archived", { archived: true });
    const outcome = acquireRepoOwnership(repo, "next", "next-config", {
      write: (() => {
        let writes = 0;
        return async (path: string, text: string) => {
          if (writes++ === 1) throw new Error("injected adoption write failure");
          writeFileSync(path, text);
        };
      })(),
    });
    await expect(outcome).rejects.toThrow("injected adoption write failure");
    const adopted = ["archived", "task"].filter((slug) => readState(repo, slug).owning_lane === "next");
    expect(adopted).toHaveLength(1);
    for (const path of [join(repo, ".alinery", ".repo-owner.lock"), laneLockPath(repo, "lane"), laneLockPath(repo, "next")]) expect(free(path)).toBe(true);
    await take(repo, "next", "next-config");
    for (const slug of ["archived", "task"]) {
      const state = readState(repo, slug);
      expect([state.owning_lane, state.owning_app_config_identity]).toEqual(["next", "next-config"]);
      expect(state.executions.e2.lifecycle).toBe("interrupted");
    }
  });

  test("a legacy task with no execution can be adopted, and a v2 task without one cannot", async () => {
    const repo = newRepo();
    task(repo, "task", { engineVersion: 0, execution: false });
    (await acquireRepoOwnership(repo, "next", "config"))();
    task(repo, "task", { engineVersion: 2, execution: false });
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toMatchObject({ code: "failed_precondition" });
  });
});

describe("evidence that blocks adoption", () => {
  test("a failed preflight retries without retaining leases and without writing", async () => {
    const repo = newRepo();
    task(repo, "task");
    const before = bytes(repo, "task");
    writeFileSync(join(dir(repo, "task"), "playbook.md"), "invalid retained playbook");
    await expect(acquireRepoOwnership(repo, "dev", "new-config")).rejects.toThrow(/retained task definition/);
    expect(bytes(repo, "task")).toBe(before);
    expect(free(join(repo, ".alinery", ".repo-owner.lock"))).toBe(true);
    writeFileSync(join(dir(repo, "task"), "playbook.md"), source);
    await take(repo, "dev", "new-config");
    expect(readState(repo, "task").owning_lane).toBe("dev");
  });

  test("a held lane lock, a lock that is a directory or a symlink, and an invalid recorded lane all refuse", async () => {
    const repo = newRepo();
    task(repo, "task");
    const before = bytes(repo, "task");
    const lock = laneLockPath(repo, "lane");
    const held = tryLockExclusive(lock);
    expect(held).not.toBeNull();
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toMatchObject({ code: "repo_busy" });
    held?.release();
    rmSync(lock);
    mkdirSync(lock);
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toThrow(/invalid project owner lock/);
    rmSync(lock, { recursive: true });
    symlinkSync(join(repo, "elsewhere"), lock);
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toThrow(/invalid project owner lock/);
    rmSync(lock);
    expect(bytes(repo, "task")).toBe(before);
    for (const lane of ["../escape", "bad lane", "a".repeat(49), "reconciler"]) {
      const file = readState(repo, "task");
      file.owning_lane = lane;
      writeFileSync(statePath(repo, "task"), JSON.stringify(file));
      await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toThrow(/invalid daemon ownership lane/);
    }
    expect(() => validateLane("dev-1_a")).not.toThrow();
    await expect(acquireRepoOwnership(repo, "bad lane", "config")).rejects.toThrow(/invalid daemon ownership lane/);
  });

  test("every owner is checked before any write, and an owner that stops frees the project", async () => {
    const repo = newRepo();
    task(repo, "task");
    task(repo, "archived", { archived: true, lane: "another" });
    const before = bytes(repo, "task");
    const other = tryLockExclusive(laneLockPath(repo, "another"));
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toMatchObject({ code: "repo_busy" });
    expect(bytes(repo, "task")).toBe(before);
    other?.release();
    const release = await acquireRepoOwnership(repo, "next", "config");
    expect(readState(repo, "archived").owning_lane).toBe("next");
    // The historical lane's lease is retained too: a lock marker is permanent.
    expect(tryLockExclusive(laneLockPath(repo, "another"))).toBeNull();
    release();
    writeFileSync(statePath(repo, "archived"), "malformed");
    await expect(acquireRepoOwnership(repo, "third", "config")).rejects.toThrow(/invalid task execution state/);
  });

  test("an unknown socket and a non-socket owner file block; so does a malformed task.md", async () => {
    const repo = newRepo();
    task(repo, "task");
    const before = bytes(repo, "task");
    const socket = laneSocketPath(repo, "unknown");
    const server = createServer().listen(socket);
    await new Promise((resolve) => server.once("listening", resolve));
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toMatchObject({ code: "repo_busy" });
    expect(bytes(repo, "task")).toBe(before);
    await new Promise((resolve) => server.close(resolve));
    rmSync(socket, { force: true });
    writeFileSync(socket, "not a socket");
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toThrow(/invalid owner socket/);
    rmSync(socket);
    writeFileSync(join(dir(repo, "task"), "task.md"), "malformed");
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toThrow();
    expect(bytes(repo, "task")).toBe(before);
  });

  test("a socket file with nothing behind it (a dead owner's) is not a live owner", async () => {
    const repo = newRepo();
    const socket = laneSocketPath(repo, "gone");
    // A real owner that was killed -9 leaves its socket inode behind.
    const owner = Bun.spawn([process.execPath, "-e", `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up")); setTimeout(() => {}, 60000)`], { stdout: "pipe" });
    await owner.stdout.getReader().read();
    owner.kill("SIGKILL");
    await owner.exited;
    expect(lstatSync(socket).isSocket()).toBe(true);
    await take(repo, "next", "config");
  });

  test("a task directory that is not a plain slug blocks", async () => {
    const repo = newRepo();
    writeFileSync(join(repo, ".alinery", "tasks", "stray-file"), "x");
    await expect(acquireRepoOwnership(repo, "next", "config")).rejects.toThrow(/invalid task ownership evidence/);
  });
});

describe("two owners", () => {
  test("concurrent starts in one process have exactly one owner", async () => {
    const repo = newRepo();
    const results = await Promise.allSettled(["prod", "dev"].map((lane) => acquireRepoOwnership(repo, lane, "config")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.code).toBe("repo_busy");
    for (const r of results) if (r.status === "fulfilled") releases.push(r.value);
  });

  test("a repository with no .alinery yet is created and owned", async () => {
    const repo = mkdtempSync("/tmp/ao-");
    repos.push(repo);
    await take(repo, "", "config");
    expect(free(join(repo, ".alinery", ".repo-owner.lock"))).toBe(false);
  });

  const second = async (repo: string, lane: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "ownership.fixture.ts"), repo, lane, "config"], { stdout: "pipe", stderr: "inherit" });
    const line = new TextDecoder().decode((await child.stdout.getReader().read()).value).trim();
    return { child, line };
  };

  test("a second daemon process is refused with repo_busy while the first holds, and takes over once the first is killed -9", async () => {
    const repo = newRepo();
    task(repo, "task");
    const first = await second(repo, "first");
    expect(first.line).toBe("held");
    const refused = await second(repo, "other");
    expect(refused.line).toBe("refused repo_busy");
    expect(await refused.child.exited).toBe(1);
    // The loser wrote nothing: the winner's adoption is what is on disk.
    expect(readState(repo, "task").owning_lane).toBe("first");
    first.child.kill("SIGKILL");
    await first.child.exited;
    const next = await second(repo, "other");
    expect(next.line).toBe("held");
    expect(readState(repo, "task").owning_lane).toBe("other");
    next.child.kill("SIGKILL");
    await next.child.exited;
  });
});
