// The conformance cases of the task creator (plan S4.3): the Rust `provision_task` wrote `expected.json` for each
// `conformance/task_create/<case>/command.json`, and `provisionTask` must leave the same task behind. The task record
// is compared without its clock and its paths, `execution.json` by its shape.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { taskDir } from "./taskFiles.ts";
import { type CreateTaskParams, provisionTask } from "./tasks.ts";

const CASES = resolve(import.meta.dir, "../../../conformance/task_create");
const PLAYBOOK = readFileSync(resolve(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** Every file under `dir`, keyed by its path relative to it; text only. */
function filesUnder(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) Object.assign(out, filesUnder(join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.isFile()) out[`${prefix}${e.name}`] = readFileSync(join(dir, e.name), "utf8");
  }
  return out;
}

const paramsOf = (request: Record<string, any>, attachments: { name: string; path: string; size: number }[]): CreateTaskParams => ({
  name: request.name,
  requestedSlug: request.requested_slug,
  description: request.description,
  evidence: request.evidence,
  attachments,
  attachmentUrls: request.attachment_urls,
  attachmentErrors: request.attachment_errors,
  linearId: request.linear_id,
  githubIssue: request.github_issue,
  playbook: { reference: request.playbook.reference, source: request.playbook.source === "@one-shot" ? PLAYBOOK : request.playbook.source },
  launchDefaults: request.launch_defaults,
  maxLiveSessions: request.max_live_sessions,
  start: request.start,
});

for (const name of readdirSync(CASES)) {
  test(`${name} leaves what Rust's provision_task left`, async () => {
    const command = JSON.parse(readFileSync(join(CASES, name, "command.json"), "utf8"));
    const expected = JSON.parse(readFileSync(join(CASES, name, "expected.json"), "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "alinery-create-conf-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const staged = join(dir, "staged");
    mkdirSync(staged);
    const attachments = (command.attachments as { name: string; text: string }[]).map((a, i) => {
      const path = join(staged, String(i));
      writeFileSync(path, a.text);
      return { name: a.name, path, size: Buffer.byteLength(a.text) };
    });
    const actual: Record<string, unknown> = {};
    for (let n = 0; n < (command.twice ? 2 : 1); n++) {
      const reply = await provisionTask({ repo, lane: "", identity: "fixture" }, paramsOf(command.request, attachments));
      expect(reply.creation).toBe("ready");
      const slug = reply.task?.slug ?? "";
      const root = taskDir(repo, slug);
      const files = filesUnder(root);
      const task = parse(files["task.md"]) as Record<string, unknown>;
      for (const volatile of ["created", "telemetry_id", "worktree"]) delete task[volatile];
      const execution = JSON.parse(files["execution.json"]);
      const shape: Record<string, unknown> = {};
      for (const key of ["version", "creation", "owning_lane", "definition_identity", "enabled_steps", "max_live_sessions", "launch_defaults", "reference"]) {
        if (key in execution) shape[key] = execution[key];
      }
      const out: Record<string, unknown> = { "task.md": task, "execution.json": shape };
      for (const [path, text] of Object.entries(files)) {
        if (path === "artifacts/00-ticket.md" || path.startsWith("artifacts/attachments/")) out[path] = text;
      }
      actual[slug] = out;
    }
    expect(actual).toEqual(expected);
  });
}
