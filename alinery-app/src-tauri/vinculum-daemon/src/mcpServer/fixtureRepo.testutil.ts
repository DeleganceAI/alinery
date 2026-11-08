// A small repository the MCP tests and the recorded Rust replies share: one git repo with a task made by the daemon's own create,
// an artifact, a session scrollback, and an app config that names the repo. Every id and path is normalised by `normalise`.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionTask } from "../domain/tasks.ts";

export const PLAYBOOK = readFileSync(join(import.meta.dir, "../../../playbooks/one-shot/playbook.md"), "utf8");

/** The FNV hash `main.ts` makes of the app config path: the lane identity the tasks are stamped with. */
export function appConfigIdentity(path: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

export type Fixture = { root: string; repo: string; appConfig: string; slug: string; sessionId: string };

export async function buildFixture(prefix = "/tmp/mcp-fx-"): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(prefix));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const app = join(root, "app");
  mkdirSync(app, { recursive: true });
  const appConfig = join(app, "app.toml");
  writeFileSync(appConfig, `active_repo = ${JSON.stringify(repo)}\nknown_repos = [${JSON.stringify(repo)}]\n`);
  const created = await provisionTask(
    { repo, lane: "", identity: appConfigIdentity(appConfig) },
    { name: "First task", description: "the fixture task", playbook: { reference: { scope: "bundled", key: "one-shot" }, source: PLAYBOOK }, launchDefaults: { harness: "omp", model: "" }, maxLiveSessions: 10, start: false },
  );
  if (created.creation !== "ready" || !created.task) throw new Error(`fixture task not ready: ${JSON.stringify(created.errors)}`);
  const slug = created.task.slug;
  const task = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(task, "artifacts"), { recursive: true });
  writeFileSync(join(task, "artifacts", "01-notes.md"), "# Notes\n\nfixture artifact\n");
  const sessionId = String((created.sessions[0] as { id?: string } | undefined)?.id ?? "");
  if (sessionId) writeFileSync(join(task, "sessions", `${sessionId}.scrollback`), "hello from the fixture\r\n");
  return { root, repo, appConfig, slug, sessionId };
}
