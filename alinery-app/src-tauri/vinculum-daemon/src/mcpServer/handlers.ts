// The 26 tools, each a call on the daemon's RPC (plan S5.1). MCP reads nothing from `.alinery/` and writes nothing there: a read is a
// one-shot subscription, a change is the RPC that owns it. The shapes of the replies are the ones `alinery-mcp` answered with
// (`fixtures/rust-replies.json` holds what it answered for each); `docs/thick-daemon-plan.md` S5.1 names where they now differ.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { parse as tomlParse } from "smol-toml";
import { ArtifactService } from "alinery-proto/alinery/v1/artifacts_pb";
import { BlobService } from "alinery-proto/alinery/v1/blobs_pb";
import { type Entity, ExecutionSchema, HandoffRecordSchema, JobState, PickerEntrySchema, PlaybookSchema, type RepoOverrides, RepoOverridesSchema } from "alinery-proto/alinery/v1/entities_pb";
import { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import { PlaybookService, ReadPlaybookResponseSchema } from "alinery-proto/alinery/v1/playbooks_pb";
import { SessionService, SessionStartedSchema } from "alinery-proto/alinery/v1/sessions_pb";
import { SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { SubtaskService } from "alinery-proto/alinery/v1/subtasks_pb";
import { TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { validateArtifactFilename } from "../domain/artifactFiles.ts";
import { overridesToml, parseOverrides } from "../domain/settings.ts";
import { git } from "../platform/git.ts";
import { DaemonConnection, type Endpoint, newMeta, reason, taggedError, ToolError } from "./client.ts";
import type { Endpoints } from "./endpoints.ts";
import { plain } from "./plain.ts";
import { artifactRow, lifecycle, sessionMeta, sessionState, taskJson } from "./shape.ts";

export type Reply = { content: { type: "text"; text: string }[]; isError?: true };
type Args = Record<string, unknown>;

export type Context = {
  protocol: number;
  /** The `--repo` this process was started for: always a repository it may name, and the one its resources are about. */
  processRepo: string | undefined;
  appConfig: string | undefined;
  endpoints: Endpoints;
};

const REMOTE_MSG = "This repo appears to be remote (ssh). MCP currently supports read-only discovery of remote repos only. Full operations require the Alinery desktop app or future remote daemon support.";
const NOT_LOCAL_CHECKOUT_MSG =
  "This repo is registered but is not a local Git checkout at this path (no .git found). MCP currently supports read-only discovery of such repos only. Full operations require the Alinery desktop app or future remote daemon support.";
const NEEDS_APP_MCP = "alinery_send_review_handoff copies between two repositories, so it needs the Alinery app's MCP, which holds a token for every daemon the app has open; this MCP holds one for its own daemon only";

export const text = (value: string): Reply => ({ content: [{ type: "text", text: value }] });
const failure = (message: string): Reply => text(`error: ${message}`);
const json = (value: unknown): Reply => text(JSON.stringify(value));
const tagged = (value: unknown): Reply => ({ ...json(value), isError: true });

// ---- arguments -------------------------------------------------------------------------------------------------------------

/** `validate_exact_arguments`: no key outside `allowed`, and every `required` one a string. */
function exact(args: unknown, allowed: string[], required: string[]): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const object = args as Args;
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown !== undefined) return `unknown argument '${unknown}'`;
  const missing = required.find((key) => typeof object[key] !== "string");
  if (missing !== undefined) return `missing required argument '${missing}'`;
  return undefined;
}

/** `safe_component`: one path component, no `..`, no separator. */
const safe = (value: string) => value !== "" && !value.includes("..") && !value.includes("/") && !value.includes("\\");

function component(args: Args, key: string): string {
  const raw = typeof args[key] === "string" ? (args[key] as string) : "";
  if (!safe(raw)) throw new ToolError(`invalid ${key} '${raw}'`);
  return raw;
}

function optional<T>(args: Args, key: string, kind: "string" | "boolean" | "number"): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== kind) throw new ToolError(`invalid ${key}: invalid type, expected ${kind === "number" ? "an integer" : `a ${kind}`}`);
  return value as T;
}

function optionalCount(args: Args, key: string): number | undefined {
  const value = optional<number>(args, key, "number");
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 4294967295)) throw new ToolError(`invalid ${key}: invalid value, expected a u32`);
  return value;
}

const SCOPES = ["bundled", "global", "repo"];
function playbookRef(value: unknown, key: string): { scope: string; key: string } {
  const row = value as Args | null;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new ToolError(`invalid ${key}: invalid type, expected a playbook reference`);
  const extra = Object.keys(row).find((k) => k !== "scope" && k !== "key");
  if (extra !== undefined) throw new ToolError(`invalid ${key}: unknown field \`${extra}\``);
  if (typeof row.scope !== "string" || !SCOPES.includes(row.scope)) throw new ToolError(`invalid ${key}: unknown variant \`${String(row.scope)}\`, expected one of \`bundled\`, \`global\`, \`repo\``);
  if (typeof row.key !== "string") throw new ToolError(`invalid ${key}: missing field \`key\``);
  return { scope: row.scope, key: row.key };
}

// ---- repositories ----------------------------------------------------------------------------------------------------------

type App = { active: string; known: string[] } | undefined;

function readApp(appConfig: string | undefined): App {
  if (!appConfig) return undefined;
  try {
    const root = tomlParse(readFileSync(appConfig, "utf8")) as Args;
    const known = Array.isArray(root.known_repos) ? root.known_repos.filter((r): r is string => typeof r === "string") : [];
    return { active: typeof root.active_repo === "string" ? root.active_repo : "", known };
  } catch {
    return undefined;
  }
}

function listRepos(ctx: Context): Reply {
  const fallback = ctx.processRepo ?? "";
  const app = readApp(ctx.appConfig) ?? { active: fallback, known: fallback ? [fallback] : [] };
  return json({ active_repo: app.active, known_repos: app.known });
}

const trimSlash = (path: string) => path.trim().replace(/\/+$/, "");

/** All repositories this MCP may name: the app's known list and active repository, and its own `--repo`. */
function knownRepos(ctx: Context): string[] {
  const app = readApp(ctx.appConfig);
  const repos = [...(app?.known ?? [])];
  if (app?.active.trim() && !repos.some((r) => r.trim() === app.active.trim())) repos.push(app.active);
  return repos;
}

const isRemote = (repo: string) => !existsSync(repo) || !existsSync(join(repo, ".git"));

async function topLevel(path: string): Promise<string> {
  let result;
  try {
    result = await git(path, ["rev-parse", "--show-toplevel"]);
  } catch (e) {
    throw new ToolError(`not a git repo: ${path}\n${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.code !== 0) throw new ToolError(`not a git repo: ${path}\n${result.stderr.trim()}`);
  return realpathSync(result.stdout.trim());
}

/** `resolve_call_repo`: the one choke point for the per-call `repo`. Returns the repository's top level, or says what it is. */
async function resolveRepo(ctx: Context, tool: string, requestedRaw: unknown): Promise<{ repo: string; discoveryOnly: boolean }> {
  const requested = typeof requestedRaw === "string" ? requestedRaw.trim() : "";
  if (!requested) throw new ToolError("repo is required");
  const known = knownRepos(ctx);
  const registered = [...(ctx.processRepo ? [ctx.processRepo] : []), ...known].some((r) => trimSlash(r) === trimSlash(requested));
  if (registered && isRemote(requested)) {
    if (tool === "alinery_list_tasks" || tool === "alinery_get_task") return { repo: requested, discoveryOnly: true };
    throw new ToolError(existsSync(requested) ? NOT_LOCAL_CHECKOUT_MSG : REMOTE_MSG, { cause: "plain" });
  }
  const target = await topLevel(requested);
  const tops: string[] = [];
  for (const candidate of [...(ctx.processRepo ? [ctx.processRepo] : []), ...known]) {
    try {
      tops.push(await topLevel(candidate));
    } catch {
      /* a listed repository that is gone cannot match */
    }
  }
  if (!tops.includes(target)) throw new ToolError(`repository is not in the known repository set: ${target}`);
  return { repo: target, discoveryOnly: false };
}

// ---- connections -----------------------------------------------------------------------------------------------------------

const connections = new Map<string, DaemonConnection>();

function connection(ctx: Context, repo: string): DaemonConnection {
  const endpoint: Endpoint | undefined = ctx.endpoints.forRepo(repo);
  if (!endpoint) throw new ToolError(`this MCP holds no token for the daemon of ${repo}; ${ctx.endpoints.spansRepos ? "open the repository in the Alinery app" : "it can reach the daemon that launched it only"}`);
  // Keyed without the token: a re-minted token reaches the same connection through `tokenSource`.
  const key = `${endpoint.socket}\0${ctx.protocol}`;
  let held = connections.get(key);
  if (!held) connections.set(key, (held = new DaemonConnection(endpoint, ctx.protocol)));
  held.tokenSource = () => ctx.endpoints.forRepo(repo)?.token ?? endpoint.token;
  return held;
}

const repoScope = { kind: { case: "repo", value: {} } } as const;
const taskScope = (slug: string) => ({ kind: { case: "task", value: { slug } } }) as const;
const sessionRef = (taskSlug: string, id: string) => ({ taskSlug, id });

type EntityValue<K> = Extract<Entity["value"], { case: K }> extends { value: infer V } ? V : never;

function row<K extends NonNullable<Entity["value"]["case"]>>(entities: Entity[], kind: K): EntityValue<K>[] {
  return entities.flatMap((e) => (e.value.case === kind ? [e.value.value] : [])) as unknown as EntityValue<K>[];
}

const newest = (a: { created: bigint; slug?: string; id?: string }, b: { created: bigint; slug?: string; id?: string }) =>
  a.created === b.created ? String(a.slug ?? a.id).localeCompare(String(b.slug ?? b.id)) : a.created < b.created ? -1 : 1;

// ---- playbooks -------------------------------------------------------------------------------------------------------------

function playbookJson(read: ReturnType<typeof create<typeof ReadPlaybookResponseSchema>>) {
  const row = plain(ReadPlaybookResponseSchema, read);
  // The Rust definition left an output's `required` out until it was true.
  for (const step of ((row.definition as { step?: { outputs?: Record<string, unknown>[] }[] } | null)?.step ?? [])) for (const output of step.outputs ?? []) if (output.required === false) delete output.required;
  return { source: { reference: row.reference, path: row.path }, definition: row.definition, source_text: row.source_text, modified_at_ms: row.modified_at_ms };
}

/** What a refused playbook call answers: the library's tagged error as it was, marked as an error. */
function playbookRefusal(e: unknown): Reply {
  const body = taggedError(e);
  if (body) return { content: [{ type: "text", text: body }], isError: true };
  return tagged({ kind: "io", message: reason(e) });
}

async function readPlaybookSource(conn: DaemonConnection, reference: { scope: string; key: string }): Promise<string> {
  try {
    return (await conn.api(PlaybookService).readPlaybook({ reference: { scope: reference.scope, key: reference.key } })).sourceText;
  } catch (e) {
    throw new ToolError(`playbook resolution failed: ${taggedError(e) ?? reason(e)}`);
  }
}

// ---- tools -----------------------------------------------------------------------------------------------------------------

const VINCULUM_HARNESSES = new Set(["vinculum", "no-harness"]);
const vinculumDefaultModel = (harness: string, model: string) => (harness.trim() === "" || VINCULUM_HARNESSES.has(harness.trim()) ? model : "");

const startedJson = (started: Parameters<typeof plain>[1]) => plain(SessionStartedSchema, started ?? create(SessionStartedSchema, {}));

/** A `config.toml` that sets nothing is the file that is not there, which `read_config` answers with no text. */
const overridesEmpty = (o: RepoOverrides) => Object.values(toJson(RepoOverridesSchema, o) as Record<string, object>).every((table) => Object.keys(table).length === 0);

/** `overridesToml` without the tables that set nothing, which is how `config.toml` was written before. */
const settingTables = (o: RepoOverrides) => Bun.TOML.stringify(Object.fromEntries(Object.entries(Bun.TOML.parse(overridesToml(o)) as Record<string, object>).filter(([, table]) => Object.keys(table).length > 0)));

async function uploadAttachments(conn: DaemonConnection, raw: unknown): Promise<{ name: string; uploadId: string }[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ToolError("invalid attachments: invalid type, expected a sequence");
  const out: { name: string; uploadId: string }[] = [];
  const blobs = conn.api(BlobService);
  for (const entry of raw) {
    const item = entry as Args;
    if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.bytes !== "string") throw new ToolError("invalid attachments: each needs a name and bytes");
    const bytes = Buffer.from(item.bytes, "base64");
    const begun = await blobs.beginUpload({ meta: newMeta(), target: { target: { case: "staged", value: { name: item.name } } }, size: BigInt(bytes.length), sha256: createHash("sha256").update(bytes).digest("hex") });
    const size = begun.chunkSize || 1 << 20;
    for (let offset = 0; offset < bytes.length; offset += size) await blobs.uploadChunk({ uploadId: begun.uploadId, offset: BigInt(offset), data: bytes.subarray(offset, offset + size) });
    const done = (await blobs.commitUpload({ uploadId: begun.uploadId })).ref?.target;
    if (done?.case !== "staged") throw new ToolError(`${item.name} - the daemon did not confirm the upload`);
    out.push({ name: done.value.name, uploadId: done.value.uploadId });
  }
  return out;
}

async function createTask(conn: DaemonConnection, args: Args): Promise<Reply> {
  const bad = exact(
    args,
    ["repo", "name", "description", "evidence", "attachments", "linear_id", "github_issue", "related_tasks", "playbook", "requested_slug", "branch_name", "worktree_name", "base_ref", "model", "max_live_sessions", "start"],
    ["repo", "name"],
  );
  if (bad) return failure(bad);
  const maxLive = optionalCount(args, "max_live_sessions");
  if (maxLive === 0) return failure("max_live_sessions must be positive");
  const name = (args.name as string).trim();
  if (!name) return failure("empty name");
  const settings = row(await conn.read(repoScope), "settings")[0];
  if (!settings || settings.error) return failure(settings?.error || "settings are unavailable");
  const defaults = settings.effective?.defaults;
  const reference = args.playbook !== undefined ? playbookRef(args.playbook, "playbook") : { scope: defaults?.playbook?.scope ?? "bundled", key: defaults?.playbook?.key ?? "" };
  const source = await readPlaybookSource(conn, reference);
  const related = args.related_tasks === undefined ? [] : Array.isArray(args.related_tasks) ? args.related_tasks : (() => { throw new ToolError("invalid related_tasks: invalid type, expected a sequence"); })();
  const reply = await conn.api(TaskService).createTask({
    meta: newMeta(),
    name,
    requestedSlug: optional<string>(args, "requested_slug", "string") ?? "",
    description: optional<string>(args, "description", "string") ?? "",
    evidence: optional<string>(args, "evidence", "string") ?? "",
    attachments: await uploadAttachments(conn, args.attachments),
    linearId: optional<string>(args, "linear_id", "string") ?? "",
    githubIssue: optional<string>(args, "github_issue", "string") ?? "",
    relatedTasks: related.map((r: Args) => ({ repoPath: String(r.repo_path ?? ""), slug: String(r.slug ?? ""), name: String(r.name ?? "") })),
    playbookRef: { scope: reference.scope, key: reference.key },
    playbookSource: source,
    branchName: optional<string>(args, "branch_name", "string"),
    worktreeName: optional<string>(args, "worktree_name", "string"),
    baseRef: optional<string>(args, "base_ref", "string"),
    launchDefaults: { harness: "vinculum", model: optional<string>(args, "model", "string") ?? vinculumDefaultModel(defaults?.harness ?? "", defaults?.model ?? "") },
    maxLiveSessions: maxLive,
    start: optional<boolean>(args, "start", "boolean") ?? false,
  });
  const created = reply.created;
  if (!created) return failure("the daemon returned no task");
  return json({
    task: created.task ? taskJson(created.task) : null,
    sessions: created.sessions,
    executions: created.executions,
    creation: created.creation,
    start: created.start,
    errors: created.errors.map((e) => ({ stage: e.stage, code: e.code, message: e.message })),
  });
}

async function createSession(conn: DaemonConnection, args: Args): Promise<Reply> {
  const bad = exact(args, ["repo", "task_slug", "generic", "step_key", "execution_id", "input_occurrence_ids", "model", "prompt_extra", "start"], ["repo", "task_slug"]);
  if (bad) return failure(bad);
  const taskSlug = args.task_slug as string;
  const generic = optional<boolean>(args, "generic", "boolean") ?? false;
  const model = optional<string>(args, "model", "string");
  const promptExtra = optional<string>(args, "prompt_extra", "string");
  let target;
  if (generic) {
    if (["step_key", "execution_id", "input_occurrence_ids", "prompt_extra"].some((key) => args[key] !== undefined)) return failure("auxiliary sessions cannot select primary work or append a graph prompt");
    target = { case: "auxiliary" as const, value: { harness: "no-harness", model } };
  } else {
    const stepKey = optional<string>(args, "step_key", "string");
    if (!stepKey) return failure("step_key is required for primary work");
    const ids = args.input_occurrence_ids;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) return failure("invalid input_occurrence_ids: invalid type, expected a sequence of strings");
    target = { case: "primary" as const, value: { stepKey, executionId: optional<string>(args, "execution_id", "string"), inputOccurrences: ids === undefined ? undefined : { ids: ids as string[] } } };
  }
  const reply = await conn.api(SessionService).createSession({
    meta: newMeta(),
    taskSlug,
    target,
    launchOverride: model === undefined ? undefined : { harness: "", model },
    promptExtra,
    start: optional<boolean>(args, "start", "boolean") ?? false,
  });
  return json(startedJson(reply.started));
}

async function reads(conn: DaemonConnection, slug: string) {
  const entities = await conn.read(taskScope(slug));
  return { entities, task: row(entities, "task").find((t) => t.slug === slug) };
}

async function readArtifact(conn: DaemonConnection, slug: string, name: string): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of conn.api(BlobService).readBlob({ ref: { target: { case: "artifact", value: { taskSlug: slug, name } } }, offset: 0n, length: 0n })) parts.push(Buffer.from(chunk.data));
  return Buffer.concat(parts).toString("utf8");
}

const HISTORY_WINDOW_MAX = 1024 * 1024;

async function jobResult(conn: DaemonConnection, start: Promise<{ jobId: string }>) {
  const job = await conn.job((await start).jobId);
  if (job.state !== JobState.DONE) throw new ToolError(job.error || (job.state === JobState.CANCELLED ? "the job was cancelled" : "the job failed"));
  return job;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function sendReviewHandoff(ctx: Context, source: { repo: string; conn: DaemonConnection }, args: Args): Promise<Reply> {
  const bad = exact(args, ["repo", "source_slug", "source_artifact", "target_repo", "target_slug", "source_session", "target_step_key", "model", "prompt_extra", "start"], ["repo", "source_slug", "source_artifact", "target_repo", "target_slug", "target_step_key"]);
  if (bad) return failure(bad);
  const targetRepo = (await resolveRepo(ctx, "alinery_send_review_handoff", args.target_repo)).repo;
  const sourceSlug = args.source_slug as string;
  const targetSlug = args.target_slug as string;
  if (source.repo === targetRepo && sourceSlug === targetSlug) return failure("review handoff target must be a different task");
  validateArtifactFilename(args.source_artifact as string);
  const target = connection(ctx, targetRepo);
  const text = await readArtifact(source.conn, sourceSlug, args.source_artifact as string);
  const installed = await target.api(ArtifactService).installReviewHandoff({
    meta: newMeta(),
    sourceRepoPath: source.repo,
    sourceSlug,
    sourceSession: optional<string>(args, "source_session", "string") ?? "",
    sourceArtifact: args.source_artifact as string,
    sourceText: text,
    targetRepoPath: targetRepo,
    targetSlug,
    targetPhase: args.target_step_key as string,
    harness: "",
    model: optional<string>(args, "model", "string") ?? "",
    promptExtra: optional<string>(args, "prompt_extra", "string") ?? "",
    start: optional<boolean>(args, "start", "boolean") ?? false,
  });
  const record = installed.record;
  if (!record || !installed.started?.session) return failure("the daemon returned no handoff");
  const errors = [...installed.started.errors, ...installed.errors].map((e) => ({ stage: e.stage, code: e.code, message: e.message }));
  try {
    await source.conn.api(ArtifactService).recordOutboundHandoff({ meta: newMeta(), sourceSlug, record: { ...record, direction: "outbound" } });
  } catch (e) {
    errors.push({ stage: "outbound_handoff_record", code: "handoff_record_failed", message: reason(e) });
  }
  const targetRecord = plain(HandoffRecordSchema, record);
  return json({
    target_repo_path: targetRepo,
    start: installed.started.start,
    errors,
    target_artifact: installed.targetArtifact,
    target_session: installed.started.session ?? null,
    source_record: { ...targetRecord, direction: "outbound" },
    target_record: targetRecord,
  });
}

/** One `tools/call`. A failure the caller must read as text is a `ToolError`; anything else the RPC refused is `error: <its reason>`. */
export async function callTool(ctx: Context, name: string, argsRaw: unknown): Promise<Reply> {
  const args = (argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw) ? argsRaw : {}) as Args;
  try {
    if (name === "alinery_list_repos") return listRepos(ctx);
    if (name === "alinery_read_playbook" || name === "alinery_save_playbook") return await playbookTool(ctx, name, args);
    if (!TOOL_NAMES.has(name)) return text(`unknown tool ${name}`);
    const { repo, discoveryOnly } = await resolveRepo(ctx, name, args.repo);
    if (discoveryOnly) {
      if (name === "alinery_list_tasks") return json([]);
      component(args, "slug");
      return text("");
    }
    if (name === "alinery_send_review_handoff" && !ctx.endpoints.offersHandoff) return failure(NEEDS_APP_MCP);
    const conn = connection(ctx, repo);
    return await dispatch(ctx, name, args, repo, conn);
  } catch (e) {
    if (e instanceof ToolError) return e.cause === "plain" ? text(e.message) : failure(e.message);
    if (e instanceof ConnectError) return failure(e.rawMessage);
    if (e instanceof Error) return failure(e.message);
    throw e;
  }
}

const TOOL_NAMES = new Set([
  "alinery_list_tasks", "alinery_get_task", "alinery_create_task", "alinery_list_sessions", "alinery_create_session", "alinery_start_session", "alinery_send_review_handoff",
  "alinery_list_playbook_steps", "alinery_get_task_execution", "alinery_session_status", "alinery_read_session_history", "alinery_list_artifacts", "alinery_read_artifact",
  "alinery_read_config", "alinery_write_config", "alinery_list_playbooks", "alinery_create_subtask", "alinery_inspect_subtask_finish", "alinery_finalize_subtask",
  "alinery_archive_task", "alinery_storage_info", "alinery_delete_archived_storage", "alinery_backup_now",
]);

async function playbookTool(ctx: Context, name: string, args: Args): Promise<Reply> {
  const save = name === "alinery_save_playbook";
  const bad = exact(args, save ? ["repo", "target", "source", "overwrite"] : ["repo", "reference"], save ? ["repo", "source"] : ["repo"]);
  let reference;
  try {
    if (bad) return tagged({ kind: "invalid_arguments", message: bad });
    reference = playbookRef(args[save ? "target" : "reference"], save ? "target" : "reference");
    if (save && args.overwrite !== undefined && typeof args.overwrite !== "boolean") throw new ToolError("invalid overwrite: invalid type, expected a boolean");
  } catch (e) {
    return tagged({ kind: "invalid_arguments", message: e instanceof Error ? e.message : String(e) });
  }
  let repo: string;
  try {
    repo = (await resolveRepo(ctx, name, args.repo)).repo;
  } catch (e) {
    return tagged({ kind: "invalid_repo", message: e instanceof ToolError ? (e.cause === "plain" ? e.message : `error: ${e.message}`) : String(e) });
  }
  try {
    const conn = connection(ctx, repo);
    await conn.ready();
    const api = conn.api(PlaybookService);
    if (!save) return json(playbookJson(await api.readPlaybook({ reference })));
    const saved = await api.savePlaybook({ meta: newMeta(), target: reference, source: args.source as string, overwrite: args.overwrite === true, expectedRevision: 0n });
    return json(playbookJson(saved.saved ?? create(ReadPlaybookResponseSchema, {})));
  } catch (e) {
    if (e instanceof ToolError) return tagged({ kind: "io", message: e.message });
    return playbookRefusal(e);
  }
}

async function dispatch(ctx: Context, name: string, args: Args, repo: string, conn: DaemonConnection): Promise<Reply> {
  switch (name) {
    case "alinery_list_tasks": {
      const tasks = row(await conn.read(repoScope), "task")
        .filter((t) => !t.archived)
        .sort(newest);
      return json(tasks.map((t) => t.slug));
    }
    case "alinery_get_task": {
      const slug = component(args, "slug");
      const task = (await reads(conn, slug)).task;
      return text(task ? Bun.TOML.stringify(taskJson(task) as never) : "");
    }
    case "alinery_create_task":
      return createTask(conn, args);
    case "alinery_list_sessions": {
      const slug = component(args, "slug");
      const sessions = row((await reads(conn, slug)).entities, "session").sort(newest);
      return json(sessions.map(sessionMeta));
    }
    case "alinery_create_session":
      return createSession(conn, args);
    case "alinery_start_session": {
      const taskSlug = component(args, "task_slug");
      const sessionId = component(args, "session_id");
      const reply = await conn.api(SessionService).startSession({ meta: newMeta(), taskSlug, sessionId });
      return json(startedJson(reply.started));
    }
    case "alinery_send_review_handoff":
      return sendReviewHandoff(ctx, { repo, conn }, args);
    case "alinery_list_playbook_steps":
    case "alinery_get_task_execution": {
      const bad = exact(args, ["repo", "task_slug"], ["repo", "task_slug"]);
      if (bad) return failure(bad);
      const slug = args.task_slug as string;
      if (!safe(slug)) return failure("invalid task_slug");
      const { entities, task } = await reads(conn, slug);
      if (!task) return failure(`missing task '${slug}'`);
      if (task.engineVersion !== 2) return failure("pre-v2 task data cannot launch or query v2 execution; historical records remain readable");
      const execution = row(entities, "execution")[0];
      if (!execution) return failure(`missing execution state for task '${slug}'`);
      const out = plain(ExecutionSchema, execution);
      return json({ state: out.state, definition: out.definition });
    }
    case "alinery_session_status": {
      const slug = component(args, "task_slug");
      const id = component(args, "session_id");
      const { entities, task } = await reads(conn, slug);
      if (!task) return failure(`missing task '${slug}'`);
      const session = row(entities, "session").find((s) => s.id === id);
      if (!session) return failure(`missing session meta '${id}' for task '${slug}'`);
      const state = sessionState(session, session.exitCode ?? null);
      return json({ ...sessionMeta(session), task_slug: slug, session_id: id, lifecycle: lifecycle(session), ...(state ? { state } : {}) });
    }
    case "alinery_read_session_history": {
      const slug = component(args, "task_slug");
      const id = component(args, "session_id");
      const number = (key: string): number | undefined => {
        const value = args[key];
        if (value === undefined) return undefined;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ToolError(`${key} must be a non-negative integer`);
        return value;
      };
      const offset = number("offset");
      const limit = number("limit");
      if ((offset === undefined) !== (limit === undefined)) return failure("offset and limit must be provided together");
      const read = await conn.api(SessionService).readHistory({ session: sessionRef(slug, id), offset: offset === undefined ? undefined : BigInt(offset), limit: limit === undefined ? undefined : BigInt(limit) });
      const data = Array.from(read.data);
      if (offset === undefined || limit === undefined) return json({ task_slug: slug, session_id: id, mode: "screen", data });
      return json({ task_slug: slug, session_id: id, mode: "raw", data, offset, limit: Math.min(limit, HISTORY_WINDOW_MAX), length: Number(read.length), next_offset: Number(read.nextOffset), eof: read.eof });
    }
    case "alinery_list_artifacts": {
      const slug = component(args, "slug");
      const { entities, task } = await reads(conn, slug);
      const artifacts = row(entities, "artifact").sort((a, b) => a.position - b.position);
      return json(task?.engineVersion === 2 ? artifacts.map(artifactRow) : artifacts.map((a) => a.name));
    }
    case "alinery_read_artifact": {
      const slug = component(args, "slug");
      const filename = typeof args.filename === "string" ? args.filename : "";
      try {
        validateArtifactFilename(filename);
      } catch (e) {
        return failure(e instanceof Error ? e.message : String(e));
      }
      return text(await readArtifact(conn, slug, filename));
    }
    case "alinery_read_config": {
      const settings = row(await conn.read(repoScope), "settings")[0];
      const overrides = settings && !settings.error ? settings.overrides : undefined;
      return text(overrides && !overridesEmpty(overrides) ? settingTables(overrides) : "");
    }
    case "alinery_write_config": {
      const content = typeof args.content === "string" ? args.content : "";
      try {
        tomlParse(content);
      } catch (e) {
        return failure(`not valid TOML (${e instanceof Error ? e.message : String(e)}); not written`);
      }
      const overrides = parseOverrides(content);
      if (!overrides) return failure("not valid repository settings (playbook defaults require a scope-qualified v2 reference); not written");
      await conn.api(SettingsService).writeOverrides({ meta: newMeta(), overrides, expectedRevision: 0n });
      return text(`wrote ${join(repo, ".alinery/config.toml")}`);
    }
    case "alinery_list_playbooks": {
      const entities = await conn.read(repoScope);
      const order = (scope: string) => SCOPES.indexOf(scope);
      const candidates = row(entities, "playbook")
        .sort((a, b) => order(a.reference?.scope ?? "") - order(b.reference?.scope ?? "") || (a.reference?.key ?? "").localeCompare(b.reference?.key ?? ""))
        .map((p) => {
          const o = plain(PlaybookSchema, p);
          return { source: { reference: o.reference, path: o.path }, title: o.title, description: o.description, modified_at_ms: o.modified_at_ms, diagnostics: o.diagnostics };
        });
      const picker = entities.find((e) => e.key === "playbook/_/picker");
      const library = row(entities, "playbookLibrary")[0];
      const prefs = picker?.value.case === "playbookPicker" ? picker.value.value : undefined;
      return json({
        candidates,
        picker_preferences: { order: (prefs?.order ?? []).map((r) => ({ scope: r.scope, key: r.key })), entries: (prefs?.entries ?? []).map((e) => plain(PickerEntrySchema, e)) },
        diagnostics: (library?.diagnostics ?? []).map((d) => ({ code: d.code, message: d.message, line: d.line ?? null, field: d.field ?? null, severity: d.severity })),
      });
    }
    case "alinery_create_subtask": {
      const bad = exact(args, ["repo", "manager_session_id", "name", "slug", "playbook", "instructions", "start"], ["repo", "manager_session_id", "name", "slug"]);
      if (bad) return failure(bad);
      const reference = args.playbook === undefined ? undefined : playbookRef(args.playbook, "playbook");
      const reply = await conn.api(SubtaskService).createSubtask({
        meta: newMeta(),
        managerSessionId: args.manager_session_id as string,
        name: args.name as string,
        slug: args.slug as string,
        playbookRef: reference,
        playbookSource: reference ? await readPlaybookSource(conn, reference) : "",
        instructions: optional<string>(args, "instructions", "string") ?? "",
        start: optional<boolean>(args, "start", "boolean") ?? false,
      });
      return json(reply.result ?? null);
    }
    case "alinery_inspect_subtask_finish": {
      const bad = exact(args, ["repo", "manager_session_id"], ["repo", "manager_session_id"]);
      if (bad) return failure(bad);
      const reply = await conn.api(SubtaskService).inspectSubtaskFinish({ managerSessionId: args.manager_session_id as string });
      return json(reply.inspection ?? null);
    }
    case "alinery_finalize_subtask": {
      const bad = exact(args, ["repo", "manager_session_id", "mode"], ["repo", "manager_session_id", "mode"]);
      if (bad) return failure(bad);
      const mode = args.mode as string;
      if (!["artifacts_only", "integrated_code", "archive_without_code"].includes(mode)) return failure(`unknown finalize mode '${mode}'`);
      const reply = await conn.api(SubtaskService).finalizeSubtask({ meta: newMeta(), managerSessionId: args.manager_session_id as string, mode });
      return json(reply.result ?? null);
    }
    case "alinery_archive_task": {
      const slug = component(args, "slug");
      if (!(await reads(conn, slug)).task) return failure("no such task");
      await conn.api(TaskService).archiveTask({ meta: newMeta(), slug });
      return text("archived");
    }
    case "alinery_storage_info": {
      const job = await jobResult(conn, conn.api(JobService).startStorageScan({ meta: newMeta() }));
      const s = job.result.case === "storage" ? job.result.value : undefined;
      if (!s) return failure("the scan returned no result");
      const archived = Number(s.archivedBytes);
      const active = Number(s.activeBytes);
      return json({ archived_task_count: s.archivedTaskCount, archived_session_count: s.archivedSessionCount, archived_bytes: archived, archived_mb: mb(archived), active_bytes: active, active_mb: mb(active), total_mb: mb(active + archived) });
    }
    case "alinery_delete_archived_storage": {
      const job = await jobResult(conn, conn.api(JobService).startPurge({ meta: newMeta() }));
      const p = job.result.case === "purge" ? job.result.value : undefined;
      if (!p) return failure("the purge returned no result");
      return json({ deleted_tasks: p.deletedTasks, deleted_sessions: p.deletedSessions, deleted_worktrees: p.deletedWorktrees, errors: p.errors.map((e) => ({ target: e.target, error: e.error })) });
    }
    case "alinery_backup_now": {
      const job = await jobResult(conn, conn.api(JobService).startBackup({ meta: newMeta() }));
      const b = job.result.case === "backup" ? job.result.value : undefined;
      if (!b) return failure("the backup returned no result");
      return json({ repo_name: b.repoName, repo_path: b.repoPath, created_at: Number(b.createdAt), schema_version: b.schemaVersion, alinery_version: b.alineryVersion, trigger: b.trigger, included_dirs: b.includedDirs });
    }
  }
  return text(`unknown tool ${name}`);
}
