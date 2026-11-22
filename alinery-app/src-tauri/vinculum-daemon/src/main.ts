import { readFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import type { WatchHandle } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AgentDoc, Harness, InboxDoc, LiveDoc, createRegistry, defineDoc, defineExtension, defineTool, section, type Conversation, type Harness as OpenedHarness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { readCompactionSettings } from "./compaction.ts";
import { completeSession, engineAxis, enginePlaybook, sessionHarnessStatus, startGraphs, submitSessionWork } from "./graph.ts";
import { CHAT_TITLE_PROMPT, SESSION_NAME_INSTRUCTION, chatTitleBucket, cleanChatTitle } from "./naming.ts";
import { completeConfiguredText, modelSources, resolveModel } from "./provider.ts";
import { openProviderRuntime } from "./runtime.ts";
import { writeAtomic } from "./platform/fs.ts";
import { agentShellEnv, libreOfficeDir, runtimePart, writeShims } from "./agentShell.ts";
import { takeSecretFile, TokenRegistry } from "./rpc/auth.ts";
import { stopOwningHarness } from "./runtime/sessionStop.ts";
import { latestFailedTurn, retryFailedTurn, committedTurnMessages } from "./runtime/failedTurn.ts";
import { answeredReviewFollowUp, hasSettledAnswer } from "./runtime/reviewFollowUp.ts";
import { steerWrapUp } from "./runtime/nudge.ts";
import { eventsChanges } from "./runtime/transcript.ts";
import { serveRpc } from "./rpc/server.ts";
import { removeBoxRecord, writeBoxRecord } from "./domain/boxRegistry.ts";
import { commitJoinRequests, Members } from "./domain/members.ts";
import type { TaskDeps } from "./rpc/tasks.ts";
import { Feed } from "./sync/feed.ts";
import { Reconciler } from "./sync/reconcile.ts";
import { BoardProjector } from "./domain/board.ts";
import { BlobStore } from "./domain/blobs.ts";
import { ArtifactProjector } from "./domain/artifactProjector.ts";
import { appConfigDirOf } from "./domain/playbookLibrary.ts";
import { PlaybookProjector } from "./domain/playbookProjector.ts";
import { executionRecords } from "./rpc/artifacts.ts";
import { openPreflight } from "./domain/openPreflight.ts";
import { commitExecution, executionParser } from "./domain/executions.ts";
import { parsers } from "./sync/parsers/index.ts";
import { settingsParser } from "./sync/parsers/settings.ts";
import { telemetrySender } from "./platform/telemetry.ts";
import { SessionPublisher } from "./domain/sessions.ts";
import { runHostService } from "./hostService/serve.ts";
import { runJobChild, runRestoreBackup } from "./jobs/child.ts";
import { BackupHost } from "./jobs/backupHost.ts";
import { JobRunner } from "./jobs/runner.ts";
import { Store } from "./sync/store.ts";
import { Watcher } from "./sync/watcher.ts";
import { completeSessionMeta, createExecutionSession, getTaskExecution, materializeSessions, overlayStart, startSession, taskWorktree } from "./tasks.ts";
import { ChatPublisher, type ChatSessions, loadChat } from "./domain/chat.ts";
import { setSessionName } from "./domain/sessionOps.ts";
import { readTask, readTaskChecked } from "./domain/taskFiles.ts";
import { DomainError } from "./platform/lock.ts";
import { acquireRepoOwnership } from "./domain/ownership.ts";
import { KeepAwake } from "./platform/keepawake.ts";
import type { SessionControl, TurnControl } from "./rpc/sessions.ts";
import { hasPty, isPty, killPty, startShell } from "./terminal.ts";
import { changeSessionModel, changeThinkingLevel, ensureModel, readLaunchModel, readLaunchThinking, roleModel, seedLevel, seedUnsetThinking, setModelRefusal, turnControls } from "./sessionControls.ts";
import { readModelRoles } from "./domain/agentDir.ts";
import { rememberSessionEnv, sessionByToolEnv } from "./sessionLookup.ts";
import { McpHub } from "./mcp.ts";
import { MachineLink } from "./domain/machineMcp.ts";
import { machinePaths, spawnMachine } from "./mcpServer/machine.ts";
import { canvasTools } from "./canvasTools.ts";
import { renderPage } from "./domain/rendered.ts";
import { canvasEnabled } from "./domain/canvas.ts";
import { runMcp } from "./mcpServer/server.ts";
import { skillCatalog, vinculumAgentDir } from "./skills.ts";
import { readMetaChecked, retainedTranscript } from "./domain/history.ts";
import { formatTranscript, transcriptSource, transcriptToolSlots, type TranscriptSource, type TranscriptToolSlot } from "./transcript.ts";
// Bundled at compile time, so the daemon reports the app release it was built with.
import appPackage from "../../../package.json" with { type: "json" };

// Vinculum is the Alinery daemon. Its agent runtime is pi-durable (@earendil-works/pi-durable).
const PROTOCOL = 56;
const context = BACKGROUND_CONTEXT;
// 1.4.0 requires checkpointWhen. False keeps these as deltas; they are not bases.
const Attention = defineDoc<{ wait: null | { kind: "input" | "approval"; correlationId: string; prompt?: string } }>({
  kind: "alinery.attention",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ wait: null }),
});
const PhaseRequest = defineDoc<{ phase: string; executionId: string; nonce: string }>({
  kind: "alinery.phaseRequest",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ phase: "", executionId: "", nonce: "" }),
});

type Live = {
  id: string;
  taskSlug: string;
  process: "starting" | "alive" | "exited";
  agent: { state: string; correlation_id?: string; reason?: string };
  playbook: { state: string; reason?: string };
  harness: OpenedHarness | null;
  conversationId: string;
  liveRun: boolean;
  runId?: string;
  failedTurn?: { id: string; reason: string };
  seenNonce: string;
  executionId: string;
  titledBucket: number;
  titleInFlight: boolean;
  stopping?: Promise<void>;
  closedControls?: Awaited<ReturnType<typeof sessionControls>>;
  wait?: { kind: string; correlationId: string; prompt?: string };
};

const live = new Map<string, Live>();
const args = process.argv.slice(2);
if (args.includes("--protocol-version")) {
  console.log(String(PROTOCOL));
  process.exit(0);
}

// A job child is this binary run with --job <kind>; it does nothing a daemon does.
if (args.includes("--job")) process.exit(await runJobChild(args[args.indexOf("--job") + 1] ?? ""));
// The MCP server is this binary run with --mcp: a client of a daemon, never one itself.
if (args.includes("--mcp")) process.exit(await runMcp(args, PROTOCOL, appPackage.version));
// The host service is this binary run with --host-service: the work a host needs while no daemon runs.
if (args.includes("--host-service")) process.exit(await runHostService(args));
// The restore of a backup is run by the shell after it has stopped the daemon: `--restore-backup <repo> <archive>`.
if (args.includes("--restore-backup")) process.exit(await runRestoreBackup(args[args.indexOf("--restore-backup") + 1] ?? "", args[args.indexOf("--restore-backup") + 2] ?? ""));

function flag(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

const repo = flag("--repo");
const appConfig = flag("--app-config");
// The RPC bearer token: a file the app wrote, read and deleted before the daemon listens or
// resumes anything, then held only in memory.
const rpcSecretFile = flag("--rpc-secret-file");
const rpcSecret = rpcSecretFile ? takeSecretFile(rpcSecretFile) : Buffer.alloc(0);

const namespace = flag("--socket-namespace");
// How the starting app describes its person and machine; shown to whoever else sees this daemon (a coworker on a shared box).
const startedBy = flag("--started-by");
const startedAtMs = Date.now();
const buildId = flag("--build-id") || "alinery-vinculum-daemon";
if (!repo || !appConfig) {
  console.error("alinery-vinculum-daemon: missing --repo or --app-config");
  process.exit(2);
}

const sources = modelSources(appConfig);
console.error(`hosted catalog ready=${sources.hosted}`);
console.error(`XAI_API_KEY set=${sources.grok}`);
if (!sources.hosted && !sources.grok) {
  console.error("neither hosted inference nor XAI_API_KEY is usable; terminals and task records still run");
}

const lane = namespace;
const identity = appConfigIdentity(appConfig);
const store = new Store();
const board = new BoardProjector(store, join(repo, ".alinery"));
const feed = new Feed(store, join(repo, ".alinery"), (entity) => board.decorate(publisher.decorate(entity)), board.dependents, { "app.toml": appConfig });
parsers.push(executionParser(repo, lane, identity), settingsParser(join(repo, ".alinery"), appConfig));
// The version in a telemetry event: the app passes its own, since a daemon binary has none.
const telemetry = telemetrySender(appConfig, flag("--app-version") || "unknown");
const publisher = new SessionPublisher(store, feed, () => [...live.values()].map(liveView), {
  protocol: PROTOCOL,
  buildId,
  watchExhausted: () => watcher.status.enospc,
  // Peers of the shell role are screened against the app's executable; a local daemon started without one cannot, and the shell says so (a remote one is started without by design).
  hostGuardWarning: process.env.ALINERY_HOST_EXECUTABLE || process.env.ALINERY_REMOTE_LAUNCH ? undefined : "no canonical executable for dynamic host screening",
});
// One owner per repository: a second daemon, of any lane, is refused here and exits, and this one's sessions are not touched.
try {
  await acquireRepoOwnership(repo, lane ?? "", identity);
} catch (error) {
  console.error(`${error instanceof DomainError ? error.code : "ownership_failed"}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const rpcSocket = join(repo, ".alinery", `${namespace ? `rpc-${namespace}` : "rpc"}.sock`);
mkdirSync(dirname(rpcSocket), { recursive: true });

const providers = openProviderRuntime(appConfig);
const models = providers.models;
const fileWrite = createWriteTool();
const PHASE_WRITE = "xd://alinery_phase_complete";
const registry = createRegistry();

function codingExtension() {
  return defineExtension({
    name: "coding-tools",
    tools: [
      createReadTool(),
      defineTool({
        name: fileWrite.name,
        description: fileWrite.description,
        parameters: fileWrite.parameters,
        // The playbook prompt adds `i` beside path and content. The write schema does not, and a failed validation never reaches the xd:// completion path.
        prepareArguments(args) {
          if (!args || typeof args !== "object" || Array.isArray(args)) return { path: "", content: "" };
          const record = args as { path?: unknown; content?: unknown };
          return {
            path: typeof record.path === "string" ? record.path : "",
            content: typeof record.content === "string" ? record.content : "",
          };
        },
        execute: async (args, api, ctx) => {
          const path = args.path.trim();
          if (path === PHASE_WRITE) return requestPhase(api);
          if (path.startsWith("xd://")) return { output: [{ type: "text", text: `Unsupported internal path ${path}.` }], isError: true };
          return fileWrite.execute(args, api, ctx);
        },
      }),
      createEditTool(),
      createBashTool(),
    ],
  });
}

function phaseExtension() {
  return defineExtension({
    name: "alinery-phase",
    tools: [
      defineTool({
        name: "alinery_phase_complete",
        description:
          "Request completion of the current engine-assigned Alinery Playbook execution. " +
          "When its work, checks, and at least one valid assigned artifact are ready, send the user-facing handoff, then call this tool in the same assistant turn. " +
          "Takes no arguments: the session already knows the execution. Do not invent a phase, execution id, or nonce. " +
          "A write to xd://alinery_phase_complete is the same request.",
        parameters: Type.Object({}),
        prepareArguments() {
          return {};
        },
        execute: async (_args, api) => requestPhase(api),
      }),
    ],
  });
}

const sessionNameTool = defineTool({
  name: "alinery_set_session_name",
  description: "Suggest this session's short work name. An existing name, including a human correction, is preserved.",
  parameters: Type.Object({ name: Type.String() }),
  execute: async (args, api) => {
    const row = sessionForCall(api.env, api.conversationId);
    if (!row?.taskSlug) return { output: [{ type: "text", text: "Only a task session can name itself this way." }], isError: true };
    try {
      const outcome = await setSessionName(repo, row.taskSlug, row.id, args.name, "auto");
      await feed.refresh(`tasks/${row.taskSlug}/sessions/${row.id}.name.json`);
      return { output: [{ type: "text", text: `Session name: ${outcome.value.name}` }] };
    } catch (error) {
      return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  },
});

// Lets the agent look at what it made: one page of a PDF or a deck (LibreOffice first) as an image. Chat and task sessions.
function renderExtension() {
  return defineExtension({
    name: "alinery-render",
    tools: [
      defineTool({
        name: "alinery_render_page",
        description:
          "Look at one page of a PDF, or one slide of a presentation (pptx, ppt, odp, key), as an image: check a document or deck you made, then fix what you see. " +
          "A presentation is drawn through LibreOffice first. Read an image file with the read tool instead.",
        parameters: Type.Object({
          path: Type.String({ description: "The file, relative to your working directory or absolute." }),
          page: Type.Optional(Type.Integer({ minimum: 1, description: "The page or slide, from 1. Default 1." })),
        }),
        execute: async (args, api) => {
          const cwd = (api.env as { cwd?: string } | undefined)?.cwd ?? repo;
          const page = args.page ?? 1;
          try {
            const out = await renderPage(repo, resolve(cwd, args.path), page, python && join(python, "bin", "python3"));
            return {
              output: [
                { type: "text", text: `Page ${page} of ${out.pages} of ${args.path}.` },
                { type: "image", data: Buffer.from(out.png).toString("base64"), mimeType: "image/png" },
              ],
            };
          } catch (error) {
            return { output: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
          }
        },
      }),
    ],
  });
}

function namingExtension() {
  return defineExtension({
    name: "alinery-session-name",
    tools: [sessionNameTool],
    sections: [
      section("session-name", (input) => {
        const row = sessionForCall(input.env, input.conversationId);
        if (!row?.taskSlug || sessionNameSource(row.taskSlug, row.id)) return undefined;
        return SESSION_NAME_INSTRUCTION;
      }),
    ],
  });
}

function appConfigIdentity(path: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

const keepAwake = new KeepAwake({ appConfig, liveSessions: () => [...live.values()].filter((row) => row.process !== "exited").length });
const releaseKeepAwake = () => keepAwake.release();

// These consts are initialized above. Calling the extensions any earlier reads sessionNameTool and releaseKeepAwake in the temporal dead zone, and the bundled daemon exits before it listens.
keepAwake.start();
registry.install(codingExtension());
registry.install(phaseExtension());
registry.install(namingExtension());
registry.install(renderExtension());
// Chat threads only: the thread is the calling conversation's own row, so the agent never names it.
const canvas = canvasTools({ repo, threadOf: (env, conversationId) => { const row = sessionForCall(env, conversationId); return row && !row.taskSlug ? row.id : undefined; }, refresh: (rel) => feed.refresh(rel) });
registry.install(canvas.extension);
const agentDir = vinculumAgentDir(appConfig);
/** A `role:` model is resolved when a session opens or is switched to it; the session's meta then names the model it runs on. */
const launchModel = (requested: string) => roleModel(requested, readModelRoles(agentDir), readLaunchModel(repo, appConfig));
const includedSkillsDir = runtimePart("skills", process.execPath, process.env);
registry.install(
  defineExtension({
    name: "alinery-skills",
    sections: [section("skills", () => skillCatalog(agentDir, includedSkillsDir))],
  }),
);
const python = runtimePart("python", process.execPath, process.env);
const agentEnv = agentShellEnv({
  python,
  // agentDir is <vinculum>/config/agent.
  shims: (() => {
    try {
      return writeShims(dirname(dirname(agentDir)), process.execPath);
    } catch {
      return undefined;
    }
  })(),
  repo,
  path: process.env.PATH,
  libreOffice: libreOfficeDir(),
});
// The AGENT tokens this daemon mints: the one it registers with the machine MCP, and the ones the shell asks for.
const agentTokens = new TokenRegistry();
// The harnesses' built-in MCP is the stdio bridge to the machine MCP, like any other client (docs/machine-mcp-plan.md P6).
// Only with --machine-mcp, like the registration: the bridge starts a machine MCP, and a test daemon must not leave one behind.
const mcpHub = new McpHub(registry, { repo, appConfig, agentDir, namespace, builtin: args.includes("--machine-mcp") });
// The machine MCP (docs/machine-mcp-plan.md): McpService reads and restarts it from any daemon; only a daemon started with
// --machine-mcp registers on its own, so test daemons never start one.
const machine = machinePaths(appConfigDirOf(appConfig), namespace);
const machineLink = new MachineLink({
  paths: machine,
  repo,
  rpcSocket,
  protocol: PROTOCOL,
  build: appPackage.version,
  mint: () => agentTokens.mint("machine-mcp"),
  spawn: () => spawnMachine(appConfig, namespace, flag("--machine-launch") === "systemd_run" ? "systemd_run" : "direct", machine),
  log: (line) => console.error(line),
});
void mcpHub.refresh();

function sqlitePath(taskSlug: string, id: string): string {
  return taskSlug ? join(repo, ".alinery", "tasks", taskSlug, "sessions", `${id}.pi.sqlite`) : join(repo, ".alinery", "sessions", `${id}.pi.sqlite`);
}

function metaPath(taskSlug: string, id: string): string {
  return taskSlug ? join(repo, ".alinery", "tasks", taskSlug, "sessions", `${id}.meta.json`) : join(repo, ".alinery", "sessions", `${id}.meta.json`);
}

function sessionNameSource(taskSlug: string, id: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(metaPath(taskSlug, id).replace(/\.meta\.json$/, ".name.json"), "utf8")) as { source?: unknown };
    return typeof parsed.source === "string" ? parsed.source : undefined;
  } catch {
    return undefined;
  }
}

function readMeta(taskSlug: string, id: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(metaPath(taskSlug, id), "utf8")) as Record<string, unknown>;
  } catch {
    return { id };
  }
}

function writeMeta(taskSlug: string, id: string, patch: Record<string, unknown>) {
  const path = metaPath(taskSlug, id);
  mkdirSync(dirname(path), { recursive: true });
  const worktree = taskSlug ? taskWorktree(repo, taskSlug) : repo;
  const next = completeSessionMeta(readMeta(taskSlug, id), patch, id, worktree, Math.floor(Date.now() / 1000));
  writeAtomic(path, JSON.stringify(next));
}

// Files already on disk from a writer that omitted SessionMeta's required fields.
// Invalid JSON is left alone. This runs before the socket listens, so a list cannot
// observe the incomplete file this process is about to repair.
function repairSessionMetas() {
  const repairDir = (dir: string, taskSlug: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".meta.json")) continue;
      let meta: Record<string, unknown>;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        meta = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const fieldsReady = typeof meta.worktree === "string" && meta.worktree !== "" && typeof meta.created === "number";
      if (fieldsReady) continue;
      writeMeta(taskSlug, name.slice(0, -".meta.json".length), {});
    }
  };
  const tasksRoot = join(repo, ".alinery", "tasks");
  if (existsSync(tasksRoot)) {
    for (const slug of readdirSync(tasksRoot)) repairDir(join(tasksRoot, slug, "sessions"), slug);
  }
  repairDir(join(repo, ".alinery", "sessions"), "");
}

function startRecordedShell(id: string, taskSlug: string) {
  if (hasPty(id)) return;
  const cwd = String(readMeta(taskSlug, id).worktree || repo);
  startShell(id, cwd, metaPath(taskSlug, id).replace(/\.meta\.json$/, ".scrollback"), 80, 24, () => {
    const row = live.get(id);
    if (row) row.process = "exited";
    writeMeta(taskSlug, id, { ended_at: Math.floor(Date.now() / 1000) });
    commitSession(taskSlug, id);
  });
  if (!live.has(id)) {
    live.set(id, {
      id,
      taskSlug,
      process: "alive",
      agent: { state: "idle" },
      playbook: { state: "in_progress" },
      harness: null,
      conversationId: "",
      liveRun: false,
      seenNonce: "",
      executionId: "",
      titledBucket: 0,
      titleInFlight: false,
    });
    commitSession(taskSlug, id);
  }
}

function sessionState(row: Live) {
  const playbook = row.playbook.reason ? { state: row.playbook.state, reason: row.playbook.reason } : { state: row.playbook.state };
  return {
    process: { state: row.process === "exited" ? "exited" : row.process },
    agent: row.agent.state === "busy" && row.runId ? { ...row.agent, correlation_id: row.runId } : row.agent,
    playbook,
    adapter: "vinculum",
    message_adapter: "unsupported",
  };
}

// The store's view of a live row is exactly what `list` answers (engine playbook axis included), plus the Attention wait.
function liveView(row: Live) {
  return { id: row.id, taskSlug: row.taskSlug, ...sessionState({ ...row, playbook: enginePlaybook(row.id) ?? row.playbook }), transport: isPty(row.id) ? "pty" : "rpc", wait: row.wait };
}

// Every change to a session row goes through here, so a subscriber needs no poll.
function commitSession(taskSlug: string, id: string) {
  publisher.changed(taskSlug, id);
}

async function openSession(id: string, taskSlug: string, model: string, prompt = "") {
  const path = sqlitePath(taskSlug, id);
  mkdirSync(dirname(path), { recursive: true });
  const exists = existsSync(path) && statSync(path).size > 0;
  const row: Live = {
    id,
    taskSlug,
    process: "starting",
    agent: { state: "idle" },
    playbook: { state: "in_progress" },
    harness: null,
    conversationId: "",
    liveRun: false,
    seenNonce: "",
    executionId: "",
    titledBucket: 0,
    titleInFlight: false,
  };
  live.set(id, row);
  commitSession(taskSlug, id);
  const meta = readMeta(taskSlug, id);
  if (!meta.started_at) writeMeta(taskSlug, id, { started_at: Math.floor(Date.now() / 1000), harness: "vinculum", harness_resume_token: "" });
  if (typeof meta.ended_at === "number") writeMeta(taskSlug, id, { ended_at: null, exit_code: null });
  // Bun can finish the later awaits as microtasks. Yield once so list can observe starting.
  const turn = Promise.withResolvers();
  setImmediate(turn.resolve);
  await turn.promise;
  const storage = await openNodeSqliteStorage(path);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: () => readCompactionSettings(appConfig, models),
      env: () => {
        const env = new NodeExecutionEnv({ cwd: sessionCwd(taskSlug, id), shellEnv: agentEnv });
        rememberSessionEnv(env, row);
        return env;
      },
      conversationCreated: async (tx, conversation) => {
        await tx.doc(Attention, conversation.id);
        await tx.doc(PhaseRequest, conversation.id);
      },
    },
    context,
  );
  row.harness = harness;
  const resolved = resolveModel(appConfig, launchModel(model));
  if (!resolved) throw new Error("no model is configured");
  const root = await harness.root(context, exists ? undefined : { agent: { model: resolved } });
  row.conversationId = root.id;
  await ensureModel(root, resolved, context);
  const agentDoc = await harness.documentState(AgentDoc, root.id, context);
  const storedThinking = agentDoc?.value?.thinkingLevel;
  agentDoc?.dispose();
  const registered = models.getModel(resolved.provider, resolved.modelId);
  await seedUnsetThinking(storedThinking, root, seedLevel(readLaunchThinking(repo, appConfig), registered), context);
  const recorded = String(readMeta(taskSlug, id).model ?? "").trim();
  if (!recorded || recorded.startsWith("role:")) writeMeta(taskSlug, id, { model: `${resolved.provider}/${resolved.modelId}` });
  // Resumed conversations were created before this hook existed. tx.doc loads an existing doc and creates a missing one.
  await root.commit(async (tx) => {
    await tx.doc(Attention, root.id);
    await tx.doc(PhaseRequest, root.id);
  }, context);
  await root.configure({ tools: { remove: removedTools(taskSlug, id) } }, context);
  if (!taskSlug) row.titledBucket = chatTitleBucket(await userMessageCount(root));
  watch(row, harness, root.id);
  if (exists) harness.resume();
  await seedPrompt(root, prompt);
  row.process = "alive";
  commitSession(taskSlug, id);
  return row;
}

/** The registry's tools a session does not get: a chat thread names itself another way, and only a thread whose canvas the user enabled has the canvas tools. */
function removedTools(taskSlug: string, id: string) {
  if (taskSlug) return canvas.tools;
  return canvasEnabled(repo, id) ? [sessionNameTool] : [sessionNameTool, ...canvas.tools];
}

async function seedPrompt(conversation: Conversation, prompt: string) {
  if (!prompt) return;
  const page = await conversation.entries({ order: "ascending" }, 200, undefined, context);
  const hasUser = page.items.some((entry) => entry.kind === "pi.user" || (entry.model ?? []).some((message) => message.role === "user"));
  if (hasUser) return;
  // Admission only. The model run continues after this returns.
  await conversation.submit({ type: "input", content: prompt, whenBusy: "followUp" }, context);
}

// conversation.context() is the next model request. It drops assistant messages whose stop reason is error, aborted, or deferred, so a failed turn never reaches the pane. The transcript is the stored entries, plus the in-flight partial. Nested tool slots stay out.

async function transcriptMessages(row: Live, conversation: Conversation): Promise<{ messages: TranscriptSource[]; tools: TranscriptToolSlot[] }> {
  const messages = await committedTurnMessages(conversation);
  const live = row.harness ? await row.harness.documentState(LiveDoc, conversation.id, context) : undefined;
  try {
    const partial = live?.value?.generation?.message;
    if (partial && typeof partial === "object") messages.push(transcriptSource("live", partial, true));
    else if (live?.value?.generation?.retry?.error) messages.push(transcriptSource("live", { role: "assistant", errorMessage: live.value.generation.retry.error }));
    return { messages, tools: transcriptToolSlots(live?.value?.tools) };
  } finally {
    live?.dispose();
  }
}

async function modelMessages(conversation: Conversation) {
  const messages: Awaited<ReturnType<Conversation["context"]>>["messages"] = [];
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) messages.push(...(entry.model ?? []));
    cursor = page.next;
    if (!cursor) break;
  }
  return messages;
}

async function userMessageCount(conversation: Conversation): Promise<number> {
  return (await modelMessages(conversation)).filter((message) => message.role === "user").length;
}

async function maybeTitleChat(row: Live) {
  if (row.taskSlug || row.titleInFlight || !row.harness || !row.conversationId) return;
  const conversation = await conversationFor(row);
  if (!conversation) return;
  const bucket = chatTitleBucket(await userMessageCount(conversation));
  if (bucket === 0 || bucket === row.titledBucket) return;
  if (sessionNameSource(row.taskSlug, row.id) === "user") {
    row.titledBucket = bucket;
    return;
  }
  row.titleInFlight = true;
  try {
    const reply = await completeConfiguredText(models, appConfig, String(readMeta(row.taskSlug, row.id).model ?? ""), [
      ...(await modelMessages(conversation)),
      { role: "user", content: CHAT_TITLE_PROMPT, timestamp: Date.now() },
    ]);
    const name = cleanChatTitle(reply);
    if (!name) return;
    await setSessionName(repo, "", row.id, name, "auto");
    row.titledBucket = bucket;
    commitSession(row.taskSlug, row.id);
  } catch (error) {
    console.error(`chat title failed for ${row.id}: ${error}`);
  } finally {
    row.titleInFlight = false;
  }
}

async function conversationFor(row: Live): Promise<Conversation | null> {
  if (!row.harness || !row.conversationId) return null;
  return (await row.harness.conversation(row.conversationId, context)) ?? null;
}

async function sessionControls(conversation: Conversation) {
  const agent = await conversation.agent(context);
  const current = agent.model;
  const id = current ? `${current.provider}/${current.modelId}` : "";
  const catalog = current ? models.getModel(current.provider, current.modelId) : undefined;
  // Pi's own estimate: the newest assistant's reported usage plus estimates of what came after it.
  const view = await conversation.context(context);
  return {
    ...turnControls(id, agent.thinkingLevel, catalog),
    context_tokens: Math.round(estimateContextTokens(view.messages).tokens),
    context_window: catalog?.contextWindow ?? 0,
  };
}

function watch(row: Live, harness: OpenedHarness, conversationId: string) {
  let watchVersion = 0;
  let lastRunning: boolean | undefined;
  const settledAgent = () => row.failedTurn ? { state: "errored", correlation_id: row.failedTurn.id, reason: row.failedTurn.reason } : { state: "idle" };
  const attach = <T>(pending: Promise<WatchHandle<T> | undefined>, apply: (value: T, initial?: boolean) => void) => {
    pending
      .then((state) => {
        if (!state) {
          console.error(`watchDoc unavailable for ${row.id}`);
          return;
        }
        state.start(async (value) => {
          apply(value);
        });
        apply(state.value, true);
      })
      .catch((error) => {
        console.error(`watch failed for ${row.id}: ${error}`);
      });
  };
  attach(harness.watchDoc(Attention, conversationId, context), (value) => {
    if (value?.wait) {
      row.agent = {
        state: value.wait.kind === "approval" ? "waiting_for_approval" : "waiting_for_input",
        correlation_id: value.wait.correlationId,
      };
      row.wait = value.wait;
    } else {
      row.wait = undefined;
      if (row.agent.state === "waiting_for_input" || row.agent.state === "waiting_for_approval") {
        row.agent = row.liveRun ? { state: "busy" } : settledAgent();
      }
    }
    commitSession(row.taskSlug, row.id);
  });
  attach(harness.watchDoc(LiveDoc, conversationId, context), (value) => {
    const running = Boolean(value?.run);
    const runId = value?.run?.inputs[0]?.toString();
    if (lastRunning === running && row.runId === runId) return;
    const finished = lastRunning === true && !running;
    lastRunning = running;
    row.runId = runId;
    const version = ++watchVersion;
    row.liveRun = running;
    if (running) {
      row.failedTurn = undefined;
      if (row.agent.state !== "waiting_for_input" && row.agent.state !== "waiting_for_approval") row.agent = { state: "busy" };
      commitSession(row.taskSlug, row.id);
      return;
    }
    // Read the terminal receipt on initial attachment too, so a daemon restart restores the same failed turn.
    void conversationFor(row).then(async (conversation) => {
      const failure = conversation ? await latestFailedTurn(conversation) : undefined;
      if (watchVersion !== version || live.get(row.id) !== row || row.process === "exited" || row.stopping) return;
      row.failedTurn = failure;
      if (row.agent.state !== "waiting_for_input" && row.agent.state !== "waiting_for_approval") row.agent = settledAgent();
      commitSession(row.taskSlug, row.id);
      if (finished && !row.taskSlug && !failure) void maybeTitleChat(row);
    }).catch((error) => console.error(`turn outcome unavailable for ${row.id}: ${error}`));
  });
  attach(harness.watchDoc(PhaseRequest, conversationId, context), (value, initial) => {
    if (!value?.nonce || value.nonce === row.seenNonce) return;
    row.seenNonce = value.nonce;
    // A retained nonce has no work revision. Only a fresh request naming this execution
    // can describe the resumed owner's work; both current completion tools call directly.
    if (initial || !row.taskSlug || !value.executionId) return;
    void forwardPhase(row, value).catch((error) => {
      console.error(`phase forward failed for ${row.id}: ${error}`);
    });
  });
}

function sessionForCall(env: unknown, conversationId: string): Live | undefined {
  return sessionByToolEnv(env, conversationId, (sessionId) => live.get(sessionId), live.values());
}

function sessionCwd(taskSlug: string, id: string): string {
  const worktree = readMeta(taskSlug, id).worktree;
  return typeof worktree === "string" && worktree && existsSync(worktree) ? worktree : repo;
}

function phaseResultText(reply: Record<string, unknown>): string {
  if (typeof reply.error === "string" && reply.error) return `Alinery rejected phase completion: ${reply.error}. Keep this session open and resolve the error.`;
  if (reply.outcome === "accepted") return "Alinery accepted phase completion. Do no further work; this session is finishing.";
  if (reply.outcome === "ready_for_review") return "Your handoff is ready for human review. End this turn so the reviewer can inspect your work. If they send feedback here, address it and report readiness again.";
  if (reply.outcome === "pending_work") return `${reply.reason} Yield now, address the pending work, then report readiness again.`;
  if (reply.outcome === "invalid_outputs") {
    const diagnostics = Array.isArray(reply.diagnostics) ? reply.diagnostics.filter((item) => typeof item === "string").join("\n") : "";
    const detail = diagnostics ? `\n${diagnostics}` : "";
    return `Assigned publications need correction.${detail}\nWrite the assigned artifacts, then call alinery_phase_complete again. Individual outputs may be omitted.`;
  }
  if (reply.forwarded === false) return "This session has no playbook execution to complete.";
  return "Phase completion was not accepted. Keep this session open.";
}

function applyPhaseReply(row: Live, reply: Record<string, unknown>) {
  // Validation is a tool result. Pi's run and Attention watches own the agent's activity and waits.
  if (reply.playbook) row.playbook = { state: String(reply.playbook) };
  commitSession(row.taskSlug, row.id);
}

async function requestPhase(api: { conversationId: string; env?: unknown }) {
  const row = sessionForCall(api.env, api.conversationId);
  if (!row) return { output: [{ type: "text" as const, text: "No session is open for this completion." }], isError: true };
  if (!row.taskSlug) return { output: [{ type: "text" as const, text: phaseResultText({ forwarded: false }) }] };
  const local = await completeSession(row.id, () => live.get(row.id) === row);
  if (!local) return { output: [{ type: "text" as const, text: phaseResultText({ forwarded: false }) }], isError: true };
  applyPhaseReply(row, local);
  return { output: [{ type: "text" as const, text: phaseResultText(local) }], isError: local.outcome !== "accepted" && local.outcome !== "ready_for_review" };
}

async function forwardPhase(row: Live, value: { phase: string; executionId: string; nonce: string }) {
  const local = await completeSession(row.id, () => live.get(row.id) === row, value.executionId);
  if (local) applyPhaseReply(row, local);
}

function executionOwnership(reply: Record<string, unknown>): { owning_lane: string; owning_app_config_identity: string } | null {
  if (reply.error != null || reply.definition == null) return null;
  const state = reply.state;
  if (!state || typeof state !== "object" || !("owning_lane" in state) || !("owning_app_config_identity" in state)) return null;
  const owningLane = state.owning_lane;
  const owningIdentity = state.owning_app_config_identity;
  if (typeof owningLane !== "string" || typeof owningIdentity !== "string") return null;
  return { owning_lane: owningLane, owning_app_config_identity: owningIdentity };
}

async function taskOpenAllowed(taskSlug: string): Promise<{ ok: true } | { ok: false; reply: Record<string, unknown> }> {
  if (!taskSlug) return { ok: true };
  const reply = getTaskExecution(repo, taskSlug, lane, identity);
  const ownership = executionOwnership(reply);
  if (!ownership || ownership.owning_lane !== lane || ownership.owning_app_config_identity !== identity) {
    return { ok: false, reply };
  }
  return { ok: true };
}

function ownershipRefusal(reply: Record<string, unknown>): Record<string, unknown> {
  if (reply.error != null) return reply;
  return { error: "task execution ownership mismatch" };
}

/** A resolved stop is proof of exit for the engine. Keep the last controls so a closed
 * harness can still serve its transcript directly from its SQLite database. */
async function stopHarnessSession(id: string, taskSlug: string) {
  const row = live.get(id);
  if (row && row.taskSlug !== taskSlug) throw new Error("session owner changed before shutdown");
  if (row?.stopping) return row.stopping;
  const ended = typeof readMeta(taskSlug, id).ended_at === "number";
  if (!row) return stopOwningHarness(undefined, ended, context);
  if (row.process === "exited" && ended) return;
  const stopping = async () => {
    if (row.harness || !row.closedControls) {
      let controls: Live["closedControls"];
      await stopOwningHarness(row, false, context, async (conversation) => {
        controls = await sessionControls(conversation).catch(() => ({
          ...turnControls(String(readMeta(taskSlug, id).model ?? ""), undefined, undefined), context_tokens: 0, context_window: 0,
        }));
      });
      row.harness = null;
      row.closedControls = controls;
    }
    if (live.get(id) !== row) throw new Error("session owner changed during shutdown");
    writeMeta(taskSlug, id, { ended_at: Math.floor(Date.now() / 1000), exit_code: 0 });
    row.process = "exited";
    row.liveRun = false;
    commitSession(taskSlug, id);
  };
  row.stopping = stopping();
  try {
    await row.stopping;
  } finally {
    row.stopping = undefined;
  }
}

async function killSession(id: string) {
  const row = live.get(id);
  if (isPty(id)) {
    killPty(id);
    if (!row) return;
    writeMeta(row.taskSlug, row.id, { ended_at: Math.floor(Date.now() / 1000), exit_code: 0 });
  } else {
    if (!row) return;
    await stopHarnessSession(id, row.taskSlug);
  }
  if (live.get(id) === row) live.delete(id);
  commitSession(row.taskSlug, id);
}

/**
 * `spawn`, `attach` and `resume`: starts or rejoins a session's process. Answers `{ ok: true }` or the refusal; the
 * socket op and `SessionService.ResumeSession` / the chat runner both go through it.
 */
async function openOp(op: string, header: Record<string, unknown>): Promise<{ answer: Record<string, unknown>; keep: boolean }> {
  const id = String(header.id ?? "");
  const taskSlug = String(header.task_slug ?? "");
  let metaHarness: string | undefined;
  try {
    metaHarness = String((JSON.parse(readFileSync(metaPath(taskSlug, id), "utf8")) as Record<string, unknown>).harness ?? "");
  } catch {
    /* no readable meta: the root-session rule allows it, and a task session is checked below */
  }
  const refusal = openPreflight(repo, taskSlug, metaHarness);
  if (refusal) {
    return { answer: { error: refusal }, keep: false };
  }
  if (isPty(id) || String(readMeta(taskSlug, id).harness ?? "") === "no-harness") {
    const cols = Number(header.cols ?? 0);
    const rows = Number(header.rows ?? 0);
    if (!hasPty(id)) {
      if (op === "attach") {
        return { answer: { error: "unknown-session" }, keep: false };
      }
      const owned = await taskOpenAllowed(taskSlug);
      if (!owned.ok) {
        return { answer: ownershipRefusal(owned.reply), keep: false };
      }
      const cwd = String(header.cwd ?? repo);
      startShell(id, cwd || repo, metaPath(taskSlug, id).replace(/\.meta\.json$/, ".scrollback"), cols, rows, () => {
        const row = live.get(id);
        if (row) row.process = "exited";
        writeMeta(taskSlug, id, { ended_at: Math.floor(Date.now() / 1000) });
        commitSession(taskSlug, id);
      });
      if (!live.has(id)) {
        live.set(id, {
          id,
          taskSlug,
          process: "alive",
          agent: { state: "idle" },
          playbook: { state: "in_progress" },
          harness: null,
          conversationId: "",
          liveRun: false,
          seenNonce: "",
          executionId: "",
        });
        commitSession(taskSlug, id);
      }
    }
    const row = live.get(id);
    if (row && row.process !== "exited") row.process = "alive";
    // The bytes come from TerminalService.Attach (rpc/terminal.ts); this op only starts the shell.
    return { answer: { ok: true }, keep: false };
  }
  if (op !== "attach" && id && !live.has(id)) {
    const owned = await taskOpenAllowed(taskSlug);
    if (!owned.ok) {
      return { answer: ownershipRefusal(owned.reply), keep: false };
    }
    const model = String(header.model ?? "");
    void openSession(id, taskSlug, model).catch((error) => {
      const row = live.get(id);
      if (row) {
        row.playbook = { state: "failed", reason: String(error) };
        commitSession(row.taskSlug, id);
      }
    });
  }
  return { answer: { ok: true }, keep: true };
}

/** The process of a session just created or started: a recorded terminal gets its shell, anything else its harness. */
function openCreated(id: string, taskSlug: string, model: string, prompt: string): Promise<void> {
  if (String(readMeta(taskSlug, id).harness ?? "") === "no-harness") {
    startRecordedShell(id, taskSlug);
    return Promise.resolve();
  }
  return openSession(id, taskSlug, model, prompt).then(() => undefined);
}

/** The live harness session `id` and its conversation, or the refusal a caller reads. */
async function harnessSession(id: string): Promise<{ row: Live; conversation: Conversation }> {
  const row = live.get(id);
  const conversation = row ? await conversationFor(row) : null;
  if (!row || !conversation) throw new DomainError("not_found", "unknown-session");
  if (row.stopping || row.process === "exited") throw new DomainError("failed_precondition", "the session is stopping or exited");
  return { row, conversation };
}

/** The turn controls of a live harness session: SessionService and ChatService call these (they were the `prompt`, `abort`, `set_model`
 * and `set_thinking_level` ops of the JSON-lines wire). */
const rawTurns: TurnControl = {
  async retry(id, failedEntryId) {
    const { row, conversation } = await harnessSession(id);
    const ensureActive = () => {
      const meta = readMetaChecked(repo, row.taskSlug, id);
      const waiting = row.agent.state === "waiting_for_input" || row.agent.state === "waiting_for_approval";
      if (live.get(id) !== row || row.stopping || row.process !== "alive" || waiting || meta.archived || meta.ended_at != null || (row.taskSlug && readTaskChecked(repo, row.taskSlug).archived)) {
        throw new DomainError("failed_precondition", "The session is no longer available to retry.");
      }
      return meta;
    };
    await retryFailedTurn(conversation, failedEntryId, (check, send, requestId) => submitSessionWork(
      row.taskSlug,
      id,
      async () => {
        ensureActive();
        await send();
      },
      async (boundExecution) => {
        const meta = ensureActive();
        if (meta.execution_id && boundExecution !== meta.execution_id) throw new DomainError("failed_precondition", "The owning execution is unavailable.");
        return check();
      },
      requestId,
    ));
  },
  async prompt(id, text, images = []) {
    const { row, conversation } = await harnessSession(id);
    if (!text.trim()) throw new DomainError("invalid_argument", "empty-prompt");
    const resolved = resolveModel(appConfig, String(readMeta(row.taskSlug, row.id).model ?? ""));
    if (!resolved) throw new DomainError("failed_precondition", "no model is configured");
    await ensureModel(conversation, resolved, context);
    // Images ride in the same user message; a model that reads none gets Pi's placeholder in their place.
    const content = images.length > 0 ? [{ type: "text" as const, text }, ...images] : text;
    const requestId = randomUUID();
    await submitSessionWork(row.taskSlug, id, async () => {
      if (live.get(id) !== row || row.stopping || row.process === "exited") throw new DomainError("failed_precondition", "the session owner changed");
      await conversation.submit({ type: "input", content, whenBusy: "followUp", requestId }, context);
    }, undefined, requestId);
  },
  async abort(id) {
    const { conversation } = await harnessSession(id);
    await conversation.abort(context);
  },
  async setModel(id, requested) {
    const refusal = setModelRefusal(live.has(id), requested);
    if (refusal) throw new DomainError(refusal === "unknown-session" ? "not_found" : "invalid_argument", refusal);
    const { row, conversation } = await harnessSession(id);
    const resolved = resolveModel(appConfig, launchModel(requested));
    if (!resolved) throw new DomainError("failed_precondition", "no model is configured");
    await changeSessionModel(conversation, resolved, context, (patch) => writeMeta(row.taskSlug, row.id, patch));
    return sessionControls(conversation);
  },
  async setThinkingLevel(id, level) {
    const { conversation } = await harnessSession(id);
    const agent = await conversation.agent(context);
    const current = agent.model;
    const catalog = current ? models.getModel(current.provider, current.modelId) : undefined;
    await changeThinkingLevel(conversation, level, catalog, context);
    return sessionControls(conversation);
  },
};
/** What the harness refuses (a model it does not have, a thinking level it does not offer) reaches the caller as a failed precondition with its text. */
const refused = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw error instanceof DomainError ? error : new DomainError("failed_precondition", error instanceof Error ? error.message : String(error));
  }
};
const turns: TurnControl = {
  retry: (id, failedEntryId) => refused(() => rawTurns.retry(id, failedEntryId)),
  prompt: (id, text, images) => refused(() => rawTurns.prompt(id, text, images)),
  abort: (id) => refused(() => rawTurns.abort(id)),
  setModel: (id, model) => refused(() => rawTurns.setModel(id, model)),
  setThinkingLevel: (id, level) => refused(() => rawTurns.setThinkingLevel(id, level)),
};

async function resumeInterrupted() {
  const pending: Promise<unknown>[] = [];
  const roots = [join(repo, ".alinery", "sessions"), join(repo, ".alinery", "tasks")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const walk = (dir: string, taskSlug: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path, taskSlug || (dir.endsWith("/tasks") ? name : taskSlug));
          continue;
        }
        if (!name.endsWith(".pi.sqlite")) continue;
        const id = name.slice(0, -".pi.sqlite".length);
        const meta = readMeta(taskSlug, id);
        if (meta.started_at && !meta.ended_at) {
          pending.push(
            taskOpenAllowed(taskSlug)
              .then((owned) => {
                if (!owned.ok) {
                  console.error(`resume skipped ${id}: ownership`);
                  return;
                }
                return openSession(id, taskSlug, String(meta.model ?? ""));
              })
              .catch((error) => {
                console.error(`resume failed ${id}: ${error}`);
              }),
          );
        }
      }
    };
    walk(root, "");
  }
  await Promise.all(pending);
}

/** The teardown `AdminService.Shutdown` runs: ends every
 * session and removes the sockets. Returns how many sessions were still running. */
function stopEverything(): number {
  jobs.stopAll();
  mcpHub.close();
  machineLink.stop();
  releaseKeepAwake();
  const now = Math.floor(Date.now() / 1000);
  let stopped = 0;
  for (const row of live.values()) {
    if (row.process !== "exited") stopped += 1;
    if (isPty(row.id)) killPty(row.id);
    writeMeta(row.taskSlug, row.id, { ended_at: now, exit_code: 0 });
    row.process = "exited";
  }
  const stoppedRows = [...live.values()];
  live.clear();
  for (const row of stoppedRows) commitSession(row.taskSlug, row.id);
  for (const path of [rpcSocket]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
  try {
    removeBoxRecord(repo, lane);
  } catch {
    /* the reader's pid check hides it */
  }
  return stopped;
}

// Job children are in their own process groups, so the exit waits for them: the shell treats the process
// lock's release as "the daemon is gone" and then restores or replaces files under it. The shell's wait
// (`wait_for_daemon_gone`) allows more than this.
const JOB_GRACE_MS = 1000;
async function exitWhenJobsEnded(): Promise<never> {
  await jobs.drain(JOB_GRACE_MS);
  process.exit(0);
}

repairSessionMetas();
// Files reach the store: scan with the parsers, then watch, then the 30 s reconcile, and only
// then does the RPC server listen, so a first Subscribe never sees a half-built store.
await feed.scan();
const watcher = new Watcher(join(repo, ".alinery"), (rel) => void feed.refresh(rel).catch((e) => console.error(`feed ${rel}: ${(e as Error).message}`)), { log: (line) => console.error(line), appConfig, globalPlaybooks: join(appConfigDirOf(appConfig), "playbooks") });
watcher.start();
publisher.commitStatus();
new Reconciler(feed, { log: (line) => console.error(line) }).start();
// Backups and purges: jobs the daemon starts itself, and the automatic triggers that publish into them.
let backupHost: BackupHost;
const jobs = new JobRunner(store, { onEnd: (job, params) => backupHost.ended(job, params) });
backupHost = new BackupHost(jobs, {
  repo,
  appConfig,
  version: flag("--app-version") || "unknown",
  telemetry,
  sessions: { isRunning: (id) => runner.isRunning(id), stop: (id) => runner.stop(id) },
  afterPurge: async () => {
    await feed.reconcile();
    await artifactProjector.pass();
  },
});
// Task writes: TaskService and DraftService serve them.
const taskDeps: TaskDeps = {
  backups: backupHost,
  repo,
  lane,
  identity,
  refresh: (rel) => feed.refresh(rel),
  telemetry,
  // Constructing the store clears `.alinery/tmp/uploads`: a restart drops uploads nothing claimed.
  blobs: new BlobStore(repo),
  afterCreate: async (created, start) => {
    const out = start ? await overlayStart(repo, { ...created }, true) : await materializeSessions(repo, { ...created });
    const errors = (out.errors ?? []) as typeof created.errors;
    return {
      sessions: (out.sessions ?? []) as never,
      executions: (out.executions ?? []) as never,
      start: String(out.start ?? created.start),
      // A started task's launch errors join the files the create could not import; a reserved one keeps its own.
      errors: start ? [...created.errors, ...errors] : errors,
    };
  },
};
// Session writes and chat threads: the processes stay with this file, the files and the store with the domain code.
const chat = new ChatPublisher(store, repo);
const runner: ChatSessions = {
  create: (request) => createExecutionSession(repo, request, openCreated),
  start: (request) => startSession(repo, request, openCreated),
  async open(header) {
    const { answer } = await openOp(String(header.op ?? "resume"), header);
    if (typeof answer.error === "string") throw new DomainError("failed_precondition", answer.error);
  },
  isRunning: (id) => {
    const row = live.get(id);
    return row !== undefined && row.process !== "exited";
  },
  stop: killSession,
  async canvasEnabled(id) {
    const row = live.get(id);
    const conversation = row ? await conversationFor(row) : null;
    if (row && conversation) await conversation.configure({ tools: { remove: removedTools(row.taskSlug, id) } }, context);
  },
};
const sessionControl: SessionControl = {
  repo,
  backups: backupHost,
  refresh: (rel) => feed.refresh(rel),
  telemetry,
  chat,
  runner,
  turns,
  telemetryIds: (slug, id) => {
    let session = "";
    try {
      session = String((JSON.parse(readFileSync(metaPath(slug, id), "utf8")) as Record<string, unknown>).telemetry_id ?? "");
    } catch {
      /* a session without a readable meta has no id to report */
    }
    return { session, task: slug ? String(readTask(repo, slug)?.telemetry_id ?? "") : "" };
  },
};
await chat.refreshAll();
setInterval(() => void chat.refreshAll(), 30_000).unref();
// Artifact rows: every task once, then on each change the feed reports and on the 30 s pass for a missed event.
const taskExecution = (slug: string) => getTaskExecution(repo, slug, lane, identity);
const artifactProjector = new ArtifactProjector(store, repo, executionRecords(taskExecution));
// Playbook library rows: the compiled-in set, the machine's and the repository's, once, then on each change the watcher reports and on the 30 s pass.
const playbookProjector = new PlaybookProjector(store, { globalConfigDir: appConfigDirOf(appConfig), repoDir: repo });
feed.onChanged = (rel) => {
  artifactProjector.changed(rel);
  playbookProjector.changed(rel);
};
await artifactProjector.pass();
playbookProjector.refresh();
setInterval(() => void artifactProjector.pass().catch((e) => console.error(`artifact pass: ${(e as Error).message}`)), 30_000).unref();
setInterval(() => playbookProjector.refresh(), 30_000).unref();
// Who may use this daemon besides its starter; pending requests reach the members' apps as an entity.
const members = new Members((pending) => commitJoinRequests(store, pending));
setInterval(() => members.prune(), 60_000).unref();
// Before sessions resume: a client that finds the daemon through `rpc.sock` can already call Hello.
await serveRpc({
  socketPath: rpcSocket,
  secret: rpcSecret,
  tokens: agentTokens,
  hostExecutable: process.env.ALINERY_HOST_EXECUTABLE,
  info: { protocol: PROTOCOL, buildId, repoRoot: repo, appConfigIdentity: identity, version: appPackage.version, startedBy, osUser: userInfo().username, startedAtMs },
  members,
  lifecycle: { stop: stopEverything, exit: () => void exitWhenJobsEnded(), live: () => [...live.values()].filter((row) => row.process !== "exited" && row.id !== "__vinculum-setup__").map((row) => row.id) },
  store,
  jobs,
  backups: backupHost,
  backupReads: { repo, appConfig },
  storageScan: { repo, appConfig, namespace: lane },
  settings: { repo, appConfig, refresh: (rel) => feed.refresh(rel), telemetry },
  tasks: taskDeps,
  sessions: sessionControl,
  playbooks: { repo, appConfig, projector: playbookProjector, blobs: taskDeps.blobs },
  agent: { appConfig, repo, blobs: taskDeps.blobs, mcp: mcpHub, shell: { path: agentEnv.PATH ?? "", python }, includedSkills: includedSkillsDir },
  providers: { providers, repo, appConfig },
  mcp: { link: machineLink, paths: machine },
  artifacts: { repo, backups: backupHost, projector: artifactProjector, refresh: (rel) => feed.refresh(rel), telemetry, taskExecution, createSession: (request) => createExecutionSession(repo, request, openCreated) },
  transcripts: async (taskSlug, id) => {
    const row = live.get(id);
    if (row && row.taskSlug !== taskSlug) return undefined;
    if (!row?.harness || !row.conversationId || row.closedControls) {
      const history = retainedTranscript(repo, taskSlug, id, row?.closedControls);
      return history ? { read: async () => history } : undefined;
    }
    const conversation = await conversationFor(row);
    if (!conversation) return undefined;
    return {
      read: async () => {
        if (row.stopping) await row.stopping.catch(() => {});
        if (row.closedControls) {
          const history = retainedTranscript(repo, taskSlug, id, row.closedControls);
          if (!history) throw new DomainError("not_found", "the session history is unavailable");
          return history;
        }
        const { messages, tools } = await transcriptMessages(row, conversation);
        return { items: formatTranscript(messages, tools), controls: await sessionControls(conversation) };
      },
      subscribe: eventsChanges(row.harness, conversation.id, context),
    };
  },
});
if (args.includes("--machine-mcp")) machineLink.start();
writeBoxRecord({ repo, lane, pid: process.pid, osUser: userInfo().username, startedBy, startedAtMs, version: appPackage.version, protocol: PROTOCOL });
// The installer and the updater hold no token for the wire, so a user's yes to "stop everything and install" reaches the daemon as
// SIGTERM (scripts/lib/preflight.sh). It runs the teardown `Shutdown` runs, so sessions are recorded ended rather than interrupted.
process.once("SIGTERM", () => {
  console.error("SIGTERM: ending sessions and exiting");
  stopEverything();
  void exitWhenJobsEnded();
});
void resumeInterrupted().then(() => startGraphs(repo, {
  executionChanged: (taskSlug) => {
    commitExecution(store, repo, taskSlug, lane, identity);
    // The engine owns the playbook axis of a task's sessions, so they move with the execution.
    for (const row of live.values()) if (row.taskSlug === taskSlug) commitSession(taskSlug, row.id);
  },
  open: (id, taskSlug, model, prompt) => openSession(id, taskSlug, model, prompt).then(() => undefined),
  status(id) {
    return Promise.resolve(sessionHarnessStatus(live.get(id)));
  },
  async reviewFollowUpFinished(id, requestId) {
    const row = live.get(id);
    if (!row || !row.taskSlug || row.stopping || row.process !== "alive") return false;
    try {
      const conversation = await conversationFor(row);
      if (!conversation) return false;
      return await conversation.commit(async (tx) => {
        if ((await tx.doc(Attention, conversation.id)).wait || !(await answeredReviewFollowUp(tx, conversation.id, requestId))) return false;
        if (live.get(id) !== row || row.process !== "alive" || row.stopping) return false;
        const meta = readMetaChecked(repo, row.taskSlug, id);
        const task = readTaskChecked(repo, row.taskSlug);
        return !meta.archived && meta.ended_at == null && meta.execution_id === row.executionId && !task.archived && !task.draft && task.engine_version === 2;
      }, context);
    } catch (error) {
      console.error(`vinculum: ${id} review follow-up check failed: ${error}`);
      return false;
    }
  },
  async reviewBlocker(id, human) {
    const row = live.get(id);
    const conversation = row ? await conversationFor(row) : null;
    if (!conversation || !row || row.process === "exited") return "The owning session is unavailable.";
    return conversation.commit(async (tx) => {
      if ((await tx.doc(InboxDoc, conversation.id)).items.some((item) => item.mode !== "write")) return "The session has queued user input.";
      if ((await tx.doc(Attention, conversation.id)).wait) return "The session is waiting for a response.";
      const { run } = await tx.doc(LiveDoc, conversation.id);
      if (run?.steer) return "The agent has a wrap-up request to address.";
      if (human && run) return "The current turn is still finishing.";
      return undefined;
    }, context);
  },
  async nudge(id, runId, deliveryId, checkOwner) {
    const { row, conversation } = await harnessSession(id);
    await steerWrapUp(conversation, runId, deliveryId, async (tx) => {
      const waiting = (await tx.doc(Attention, conversation.id)).wait || row.agent.state === "waiting_for_input" || row.agent.state === "waiting_for_approval";
      const meta = readMetaChecked(repo, row.taskSlug, id);
      if (live.get(id) !== row || row.stopping || row.process !== "alive" || waiting || meta.archived || meta.ended_at != null || meta.execution_id !== row.executionId) {
        throw new DomainError("failed_precondition", "The owning session is unavailable to nudge.");
      }
      checkOwner(row.executionId);
    });
  },
  async send(id, text, onlyIfIdle) {
    const row = live.get(id);
    const conversation = row ? await conversationFor(row) : null;
    if (!row || !conversation) throw new Error(`unknown session ${id}`);
    const resolved = resolveModel(appConfig, String(readMeta(row.taskSlug, row.id).model ?? ""));
    if (!resolved) throw new Error("no model is configured");
    await ensureModel(conversation, resolved, context);
    if (onlyIfIdle) {
      const settled = await conversation.commit(async (tx) => {
        if ((await tx.doc(Attention, conversation.id)).wait) return false;
        return hasSettledAnswer(tx, conversation.id);
      }, context);
      const meta = readMetaChecked(repo, row.taskSlug, id);
      if (!settled || live.get(id) !== row || row.stopping || sessionHarnessStatus(row).kind !== "idle" ||
        meta.archived || meta.ended_at != null || meta.execution_id !== row.executionId || !onlyIfIdle()) {
        throw new Error("Session is no longer eligible for an idle reminder.");
      }
    }
    await conversation.submit({ type: "input", content: text, whenBusy: onlyIfIdle ? "reject" : "followUp" }, context);
  },
  stop: stopHarnessSession,
  bind(id, executionId, step) {
    const row = live.get(id);
    if (!row) return;
    row.executionId = executionId;
    // The session's own file says which execution and step it is (disagreement 6), so the board follows the run.
    writeMeta(row.taskSlug, id, { execution_id: executionId, phase: step });
    commitSession(row.taskSlug, id);
  },
}, appConfig, { lane, identity }));
