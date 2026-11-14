import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackupSettings, createBackup, CURATED, curatedFiles, enforceRetention, featureReady, listBackups, restoreBackup, safeEntryPath, shouldPublish, validateDestination, verifyBackup } from "./backup.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `alinery-bk-${name}-`)));
  dirs.push(d);
  return d;
};

/** A repository whose `.alinery/` holds every kind of thing a backup must treat differently. */
function fixture(name = "repo") {
  const base = scratch(name);
  const repo = join(base, "repo");
  const dest = join(base, "dest");
  const a = join(repo, ".alinery");
  mkdirSync(dest, { recursive: true });
  const put = (rel: string, text: string) => {
    mkdirSync(join(a, rel, ".."), { recursive: true });
    writeFileSync(join(a, rel), text);
  };
  put("tasks/one/task.md", 'name = "One"\n');
  put("tasks/one/sessions/s1.meta.json", "{}");
  put("tasks/one/sessions/s1.scrollback", "\x1b[31mred\x1b[0m\n");
  put("tasks/one/artifacts/01-[draft] *.md", "# odd name\n");
  put("tasks/one/artifacts/empty.md", "");
  put("tasks/two/task.md", 'name = "Two"\n');
  put("sessions/root.meta.json", "{}");
  put("config.toml", "[backup]\nenabled = true\n");
  put("playbooks/p/playbook.toml", "x = 1\n");
  // Runtime-only: none of it belongs in a backup.
  put("worktrees/one/code.ts", "export {}\n");
  put("tmp/uploads/u1", "half an upload");
  put("alineryd.sock", "not a socket");
  symlinkSync("/etc/hosts", join(a, "tasks/one/link-out"));
  const settings: BackupSettings = { destination: dest, enabled: true, retention: 3, triggerPreArchive: true, triggerPostArtifactChange: true, triggerPostPushCommit: true };
  return { base, repo, dest, a, settings };
}

/** The curated files of a repository as path to text, the thing a restore must reproduce. */
function treeOf(alinery: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of curatedFiles(alinery)) out[rel] = readFileSync(join(alinery, rel), "utf8");
  return out;
}

describe("a backup round trip with the host's zip and unzip", () => {
  test("creates, lists, verifies and restores a tree equal to the source", async () => {
    const { repo, dest, a, settings } = fixture();
    const before = treeOf(a);
    expect(Object.keys(before)).toContain("tasks/one/artifacts/01-[draft] *.md");
    expect(Object.keys(before).some((n) => n.includes("link-out") || n.startsWith("worktrees") || n.startsWith("tmp"))).toBe(false);

    const made = await createBackup(repo, settings, "manual", "9.9.9");
    expect(made.path.startsWith(`${dest}/repo-`)).toBe(true);
    expect(made.path.endsWith("-v9.9.9.zip")).toBe(true);
    expect(made.repo_path).toBe(repo);
    expect(made.trigger).toBe("manual");
    expect(made.included_dirs).toEqual(["config.toml", "playbooks", "sessions", "tasks"]);
    expect(readdirSync(dest).filter((n) => n.startsWith("."))).toEqual([]); // no temporary archive is left

    const listed = await listBackups(repo, settings);
    expect(listed.map((i) => [i.id, i.trigger, i.alinery_version])).toEqual([[made.path.split("/").pop(), "manual", "9.9.9"]]);
    expect(listed[0]?.size_bytes).toBeGreaterThan(0);
    expect((await verifyBackup(repo, made.path)).created_at).toBe(made.created_at);

    // Change everything a restore must put back, and something it must leave alone.
    writeFileSync(join(a, "tasks/one/task.md"), 'name = "Changed"\n');
    rmSync(join(a, "tasks/two"), { recursive: true });
    writeFileSync(join(a, "tasks/new.md"), "created after the backup\n");
    rmSync(join(a, "config.toml"));
    writeFileSync(join(a, "worktrees/one/code.ts"), "// edited\n");

    await restoreBackup(repo, made.path);
    expect(treeOf(a)).toEqual(before);
    expect(readFileSync(join(a, "worktrees/one/code.ts"), "utf8")).toBe("// edited\n");
    expect(readFileSync(join(a, "alineryd.sock"), "utf8")).toBe("not a socket");
    expect(readdirSync(join(a, "tmp"))).toEqual(["uploads"]); // the staging directories are gone
  });

  test("two backups in one second keep both, and retention prunes only this repository's oldest", async () => {
    const { base, repo, dest, settings } = fixture();
    const one = await createBackup(repo, { ...settings, retention: 2 }, "manual", "1");
    const two = await createBackup(repo, { ...settings, retention: 2 }, "pre_archive", "1");
    expect(two.path).not.toBe(one.path);
    // Another repository with the same name shares the destination: its archive is never counted or pruned.
    const other = join(base, "elsewhere", "repo");
    mkdirSync(join(other, ".alinery/tasks/x"), { recursive: true });
    writeFileSync(join(other, ".alinery/tasks/x/task.md"), "x");
    const foreign = await createBackup(other, { ...settings, retention: 1 }, "manual", "1");
    writeFileSync(join(dest, "repo-notes.zip"), "not a zip at all");
    const three = await createBackup(repo, { ...settings, retention: 2 }, "post_push_commit", "1");
    const left = (await listBackups(repo, settings)).map((i) => i.path);
    expect(left).toHaveLength(2);
    expect(left).toContain(three.path);
    expect(existsSync(foreign.path)).toBe(true);
    expect(existsSync(join(dest, "repo-notes.zip"))).toBe(true);
    await enforceRetention(repo, { ...settings, retention: 1 });
    expect(await listBackups(repo, settings)).toHaveLength(1);
  });

  test("an archive of another repository is refused before anything changes", async () => {
    const mine = fixture("mine");
    const theirs = fixture("theirs");
    const made = await createBackup(theirs.repo, theirs.settings, "manual", "1");
    const before = treeOf(mine.a);
    await expect(restoreBackup(mine.repo, made.path)).rejects.toThrow(/belongs to/);
    expect(treeOf(mine.a)).toEqual(before);
  });

  test("a destination inside .alinery, a file or a missing folder is refused", () => {
    const { repo, a, base } = fixture();
    mkdirSync(join(a, "backups"));
    writeFileSync(join(base, "plain-file"), "");
    expect(() => validateDestination(repo, join(a, "backups"))).toThrow(/outside/);
    expect(() => validateDestination(repo, join(base, "plain-file"))).toThrow(/not a directory/);
    expect(() => validateDestination(repo, join(base, "nope"))).toThrow();
    expect(() => validateDestination(repo, "")).toThrow(/not set/);
    symlinkSync(join(a, "backups"), join(base, "via-link"));
    expect(() => validateDestination(repo, join(base, "via-link"))).toThrow(/outside/);
  });

  test("the gate: the feature must be ready, and each automatic trigger has its own flag", () => {
    const { repo, settings } = fixture();
    expect(featureReady(settings, repo)).toBe(true);
    expect(featureReady({ ...settings, enabled: false }, repo)).toBe(false);
    expect(featureReady({ ...settings, destination: "" }, repo)).toBe(false);
    expect(shouldPublish({ ...settings, triggerPostPushCommit: false }, repo, "post_push_commit")).toBe(false);
    expect(shouldPublish({ ...settings, triggerPostPushCommit: false }, repo, "pre_archive")).toBe(true);
    // A manual or MCP backup is never gated here: it reports its own result.
    expect(shouldPublish(settings, repo, "manual")).toBe(false);
    expect(shouldPublish(settings, repo, "mcp")).toBe(false);
  });
});

/** A zip with exactly the entries given, written by hand: the host's `zip` will not write `../x` or a symlink pointing out. */
function zipBytes(entries: { name: string; data?: string; link?: string }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.link ?? e.data ?? "");
    const crc = Bun.hash.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.concat([local, name, data]);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4); // made by Unix
    head.writeUInt16LE(10, 6);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(((e.link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([head, name]));
    parts.push(entry);
    offset += entry.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

describe("an archive is untrusted input", () => {
  const meta = (repo: string) => JSON.stringify({ repo_name: "repo", repo_path: repo, created_at: 1, schema_version: 1, alinery_version: "1", trigger: "manual", included_dirs: ["tasks"] });

  test("the entry-name check", () => {
    expect(safeEntryPath("tasks/a/task.md")).toBe("tasks/a/task.md");
    expect(safeEntryPath("./tasks//a")).toBe("tasks/a");
    for (const bad of ["../../evil.txt", "/etc/evil.txt", "\\windows", "tasks/../../x", "", "."]) expect(safeEntryPath(bad)).toBeUndefined();
  });

  test("../../evil.txt and /etc/evil.txt are refused and nothing lands outside the target", async () => {
    const { base, repo, a } = fixture();
    const before = treeOf(a);
    const zip = join(base, "evil.zip");
    writeFileSync(zip, zipBytes([{ name: "backup-meta.json", data: meta(repo) }, { name: "tasks/one/task.md", data: "from the archive" }, { name: "../../evil.txt", data: "evil" }, { name: "/etc/evil.txt", data: "evil" }]));
    await expect(restoreBackup(repo, zip)).rejects.toThrow(/unsafe archive entry rejected/);
    expect(existsSync(join(a, "..", "..", "evil.txt"))).toBe(false);
    expect(existsSync(join(repo, "..", "evil.txt"))).toBe(false);
    expect(existsSync("/etc/evil.txt")).toBe(false);
    expect(treeOf(a)).toEqual(before); // the refusal came before anything was cleared or extracted
  });

  test("a symlink entry is refused, and so is a file written through it", async () => {
    const { base, repo, a } = fixture();
    const before = treeOf(a);
    const outside = join(base, "outside");
    mkdirSync(outside);
    const zip = join(base, "link.zip");
    writeFileSync(zip, zipBytes([{ name: "backup-meta.json", data: meta(repo) }, { name: "tasks/link", link: outside }, { name: "tasks/link/evil.txt", data: "evil" }]));
    await expect(restoreBackup(repo, zip)).rejects.toThrow(/link or a special file/);
    expect(readdirSync(outside)).toEqual([]);
    expect(treeOf(a)).toEqual(before);
  });

  test("a symlink already in the target is never written through", async () => {
    const { base, repo, a, settings } = fixture();
    const made = await createBackup(repo, settings, "manual", "1");
    const outside = join(base, "outside");
    mkdirSync(outside);
    // The live tree has `tasks/one/artifacts` as a link out: the restore moves the old set aside, it never writes into it.
    rmSync(join(a, "tasks/one/artifacts"), { recursive: true });
    symlinkSync(outside, join(a, "tasks/one/artifacts"));
    await restoreBackup(repo, made.path);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(a, "tasks/one/artifacts")).isDirectory()).toBe(true);
  });

  test("an entry outside the curated set is refused", async () => {
    const { base, repo } = fixture();
    const zip = join(base, "extra.zip");
    writeFileSync(zip, zipBytes([{ name: "backup-meta.json", data: meta(repo) }, { name: "worktrees/x/code.ts", data: "x" }]));
    await expect(restoreBackup(repo, zip)).rejects.toThrow(/not part of a backup/);
  });

  test("an extraction that fails leaves the old data and no staging directory", async () => {
    const { base, repo, a } = fixture();
    const before = treeOf(a);
    // `tasks/a` is a file and then a directory: unzip fails after every name check passed, with the repository still untouched.
    const broken = join(base, "broken.zip");
    writeFileSync(broken, zipBytes([{ name: "backup-meta.json", data: meta(repo) }, { name: "tasks/a", data: "a file" }, { name: "tasks/a/b", data: "x" }]));
    await expect(restoreBackup(repo, broken)).rejects.toThrow();
    expect(treeOf(a)).toEqual(before);
    expect(readdirSync(join(a, "tmp"))).toEqual(["uploads"]);
  });
});

describe("a repository of 70,000 files", () => {
  test("is written with the host's zip as one archive that lists whole, restores equal, and leaves 70,001 entries", async () => {
    const { repo, a, settings } = fixture("big");
    const bulk = join(a, "tasks", "bulk");
    mkdirSync(bulk, { recursive: true });
    for (let d = 0; d < 70; d++) {
      mkdirSync(join(bulk, `d${d}`));
      for (let f = 0; f < 1000; f++) writeFileSync(join(bulk, `d${d}`, `f${f}.md`), `${d}-${f}`);
    }
    const before = curatedFiles(a).length;
    expect(before).toBeGreaterThan(70_000);
    const made = await createBackup(repo, { ...settings, retention: 5 }, "manual", "1");
    const names = Bun.spawnSync(["unzip", "-Z1", made.path]).stdout.toString().split("\n").filter(Boolean);
    expect(names.length).toBe(before + 1); // every file and backup-meta.json
    rmSync(join(a, "tasks"), { recursive: true });
    await restoreBackup(repo, made.path);
    expect(curatedFiles(a).length).toBe(before);
    expect(readFileSync(join(bulk, "d69", "f999.md"), "utf8")).toBe("69-999");
    if (process.env.ALINERY_KEEP_BACKUP) Bun.spawnSync(["cp", made.path, process.env.ALINERY_KEEP_BACKUP]);
  }, 240_000);
});

test("CURATED is the set the Rust side archives", () => {
  expect(CURATED).toEqual(["tasks", "sessions", "config.toml", "harnesses.toml", "playbooks.toml", "playbooks"]);
});
