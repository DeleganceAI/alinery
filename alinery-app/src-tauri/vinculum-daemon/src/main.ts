import { createServer, type Socket } from "node:net";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync, realpathSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import type { WatchHandle } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, Harness, LiveDoc, createRegistry, defineDoc, defineExtension, defineTool, section, type Conversation, type Harness as OpenedHarness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { completeSession, engineAxis, enginePlaybook, permitSession, startGraphs } from "./graph.ts";
import { CHAT_TITLE_PROMPT, SESSION_NAME_INSTRUCTION, chatTitleBucket, cleanChatTitle } from "./naming.ts";
import { completeConfiguredText, modelSources, resolveModel } from "./provider.ts";
import { openProviderRuntime } from "./runtime.ts";
import { completeSessionMeta, getTaskExecution, ownershipLibrary, suggestSessionName, taskOp, taskWorktree } from "./tasks.ts";
import { attachShell, detachPty, hasPty, isPty, killPty, resizePty, startShell, writePty } from "./terminal.ts";
import { changeSessionModel, changeThinkingLevel, ensureModel, readLaunchThinking, seedLevel, seedUnsetThinking, setModelRefusal, turnControls } from "./sessionControls.ts";
import { formatTranscript, transcriptSource, transcriptToolSlots, type TranscriptSource, type TranscriptToolSlot } from "./transcript.ts";

// Vinculum is the Alinery daemon. Its agent runtime is pi-durable (@earendil-works/pi-durable).
const PROTOCOL = 21;
const context = BACKGROUND_CONTEXT;
const Attention = defineDoc<{ wait: null | { kind: "input" | "approval"; correlationId: string; prompt?: string } }>({
  kind: "alinery.attention",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ wait: null }),
});
const PhaseRequest = defineDoc<{ phase: string; executionId: string; nonce: string }>({
  kind: "alinery.phaseRequest",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
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
  seenNonce: string;
  executionId: string;
  titledBucket: number;
  titleInFlight: boolean;
};

const live = new Map<string, Live>();
const args = process.argv.slice(2);
if (args.includes("--protocol-version")) {
  console.log(String(PROTOCOL));
  process.exit(0);
}

function flag(name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

const repo = flag("--repo");
const appConfig = flag("--app-config");
const namespace = flag("--socket-namespace");
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
acquireOwnership(repo, lane, identity);
const uiSocket = join(repo, ".alinery", `${namespace ? `alineryd-${namespace}` : "alineryd"}.sock`);
try {
  unlinkSync(uiSocket);
} catch {
  /* absent */
}
mkdirSync(dirname(uiSocket), { recursive: true });

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
          if (path === PHASE_WRITE) return requestPhase(api.conversationId);
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
        execute: async (_args, api) => requestPhase(api.conversationId),
      }),
    ],
  });
}

const sessionNameTool = defineTool({
  name: "alinery_set_session_name",
  description: "Suggest this session's short work name. An existing name, including a human correction, is preserved.",
  parameters: Type.Object({ name: Type.String() }),
  execute: async (args, api) => {
    const row = rowForConversation(api.conversationId);
    if (!row?.taskSlug) return { output: [{ type: "text", text: "Only a task session can name itself this way." }], isError: true };
    const outcome = suggestSessionName(repo, row.taskSlug, row.id, args.name);
    if ("error" in outcome) return { output: [{ type: "text", text: outcome.error }], isError: true };
    return { output: [{ type: "text", text: `Session name: ${outcome.value.name}` }] };
  },
});

function namingExtension() {
  return defineExtension({
    name: "alinery-session-name",
    tools: [sessionNameTool],
    sections: [
      section("session-name", (input) => {
        const row = rowForConversation(input.conversationId);
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

let releaseKeepAwake = () => undefined as void;

function startKeepAwake(library: string) {
  const lib = dlopen(library, {
    alinery_keep_awake_start: { args: [FFIType.cstring], returns: FFIType.void },
    alinery_keep_awake_sessions: { args: [FFIType.u32], returns: FFIType.void },
    alinery_keep_awake_release: { args: [], returns: FFIType.void },
  });
  lib.symbols.alinery_keep_awake_start(ptr(Buffer.from(`${appConfig}\0`)));
  setInterval(() => {
    const count = [...live.values()].filter((row) => row.process !== "exited").length;
    lib.symbols.alinery_keep_awake_sessions(count);
  }, 1000);
  releaseKeepAwake = () => lib.symbols.alinery_keep_awake_release();
}

// These consts are initialized above. Calling the extensions any earlier reads sessionNameTool and releaseKeepAwake in the temporal dead zone, and the bundled daemon exits before it listens.
startKeepAwake(ownershipLibrary());
registry.install(codingExtension());
registry.install(phaseExtension());
registry.install(namingExtension());

function acquireOwnership(repoPath: string, laneName: string, configIdentity: string) {
  const library = ownershipLibrary();
  const lib = dlopen(library, {
    alinery_pi_acquire: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
    alinery_pi_acquire_error: { args: [], returns: FFIType.cstring },
  });
  const code = lib.symbols.alinery_pi_acquire(ptr(Buffer.from(`${repoPath}\0`)), ptr(Buffer.from(`${laneName}\0`)), ptr(Buffer.from(`${configIdentity}\0`)));
  if (code !== 0) {
    const message = lib.symbols.alinery_pi_acquire_error();
    const text = typeof message === "string" ? message : typeof message === "number" && message !== 0 ? new CString(message).toString() : "ownership acquire failed";
    throw new Error(text || "ownership acquire failed");
  }
}

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
  writeFileSync(path, JSON.stringify(next));
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
      if (typeof meta.worktree === "string" && meta.worktree !== "" && typeof meta.created === "number") continue;
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
  }
}

function sessionState(row: Live) {
  const agent = row.agent.correlation_id ? { state: row.agent.state, correlation_id: row.agent.correlation_id } : row.agent.reason ? { state: row.agent.state, reason: row.agent.reason } : { state: row.agent.state };
  const playbook = row.playbook.reason ? { state: row.playbook.state, reason: row.playbook.reason } : { state: row.playbook.state };
  return {
    process: { state: row.process === "exited" ? "exited" : row.process },
    agent,
    playbook,
    adapter: "omp",
    message_adapter: "unsupported",
  };
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
  const meta = readMeta(taskSlug, id);
  if (!meta.started_at) writeMeta(taskSlug, id, { started_at: Math.floor(Date.now() / 1000), harness: "omp", harness_resume_token: "" });
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
      env: (target) => new NodeExecutionEnv({ cwd: sessionCwd(target.conversationId) }),
      conversationCreated: async (tx, conversation) => {
        await tx.doc(Attention, conversation.id);
        await tx.doc(PhaseRequest, conversation.id);
      },
    },
    context,
  );
  row.harness = harness;
  const resolved = resolveModel(appConfig, model);
  if (!resolved) throw new Error("no model is configured");
  const root = await harness.root(context, exists ? undefined : { agent: { model: resolved } });
  row.conversationId = root.id;
  await ensureModel(root, resolved, context);
  const agentDoc = await harness.documentState(AgentDoc, root.id, context);
  const storedThinking = agentDoc?.value?.thinkingLevel;
  agentDoc?.dispose();
  const registered = models.getModel(resolved.provider, resolved.modelId);
  await seedUnsetThinking(storedThinking, root, seedLevel(readLaunchThinking(repo, appConfig), registered), context);
  if (!String(readMeta(taskSlug, id).model ?? "").trim()) writeMeta(taskSlug, id, { model: `${resolved.provider}/${resolved.modelId}` });
  // Resumed conversations were created before this hook existed. tx.doc loads an existing doc and creates a missing one.
  await root.commit(async (tx) => {
    await tx.doc(Attention, root.id);
    await tx.doc(PhaseRequest, root.id);
  }, context);
  if (!taskSlug) {
    await root.configure({ tools: { remove: [sessionNameTool] } }, context);
    row.titledBucket = chatTitleBucket(await userMessageCount(root));
  }
  watch(row, harness, root.id);
  if (exists) harness.resume();
  await seedPrompt(root, prompt);
  row.process = "alive";
  return row;
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
  const messages: TranscriptSource[] = [];
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) {
      const model = entry.model;
      if (!Array.isArray(model)) continue;
      for (let index = 0; index < model.length; index += 1) {
        const message = model[index];
        if (!message || typeof message !== "object") continue;
        const id = model.length === 1 ? String(entry.id) : `${String(entry.id)}:${index}`;
        messages.push(transcriptSource(id, message));
      }
    }
    cursor = page.next;
    if (!cursor) break;
  }
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
    const outcome = suggestSessionName(repo, "", row.id, name);
    if ("error" in outcome) return;
    row.titledBucket = bucket;
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
  return turnControls(id, agent.thinkingLevel, catalog);
}

function watch(row: Live, harness: OpenedHarness, conversationId: string) {
  const attach = <T>(pending: Promise<WatchHandle<T> | undefined>, apply: (value: T) => void) => {
    pending
      .then((state) => {
        if (!state) {
          console.error(`watchDoc unavailable for ${row.id}`);
          return;
        }
        state.start(async (value) => {
          apply(value);
        });
        apply(state.value);
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
      return;
    }
    if (row.agent.state === "waiting_for_input" || row.agent.state === "waiting_for_approval") {
      row.agent = { state: row.liveRun ? "busy" : "idle" };
    }
  });
  attach(harness.watchDoc(LiveDoc, conversationId, context), (value) => {
    const running = Boolean(value?.run);
    const finished = row.liveRun && !running;
    row.liveRun = running;
    if (row.agent.state !== "waiting_for_input" && row.agent.state !== "waiting_for_approval") row.agent = { state: running ? "busy" : "idle" };
    if (finished && !row.taskSlug) void maybeTitleChat(row);
  });
  attach(harness.watchDoc(PhaseRequest, conversationId, context), (value) => {
    if (!value?.nonce || value.nonce === row.seenNonce) return;
    row.seenNonce = value.nonce;
    if (!row.taskSlug) return;
    void forwardPhase(row, value).catch((error) => {
      console.error(`phase forward failed for ${row.id}: ${error}`);
    });
  });
}

function rowForConversation(conversationId: string): Live | undefined {
  for (const row of live.values()) if (row.conversationId === conversationId) return row;
  return undefined;
}

function sessionCwd(conversationId: string): string {
  const row = rowForConversation(conversationId);
  if (!row) return repo;
  const worktree = readMeta(row.taskSlug, row.id).worktree;
  return typeof worktree === "string" && worktree && existsSync(worktree) ? worktree : repo;
}

function phaseResultText(reply: Record<string, unknown>): string {
  if (typeof reply.error === "string" && reply.error) return `Alinery rejected phase completion: ${reply.error}. Keep this session open and resolve the error.`;
  if (reply.outcome === "accepted") return "Alinery accepted phase completion. Do no further work; this session is finishing.";
  if (reply.outcome === "waiting_for_approval") {
    return "Completion permission is still locked. Keep this session open. Do not call the completion tool again until the user grants permission or tells you to continue the work.";
  }
  if (reply.outcome === "waiting_for_input") {
    const diagnostics = Array.isArray(reply.diagnostics) ? reply.diagnostics.filter((item) => typeof item === "string").join("\n") : "";
    const detail = diagnostics ? `\n${diagnostics}` : "";
    return `Assigned publications need correction.${detail}\nWrite the assigned artifacts, then call alinery_phase_complete again. Individual outputs may be omitted.`;
  }
  if (reply.forwarded === false) return "This session has no playbook execution to complete.";
  return "Phase completion was not accepted. Keep this session open.";
}

function applyPhaseReply(row: Live, reply: Record<string, unknown>) {
  if (reply.outcome === "waiting_for_approval") row.agent = { state: "waiting_for_approval", correlation_id: String(reply.correlation_id ?? "") };
  if (reply.outcome === "waiting_for_input") row.agent = { state: "waiting_for_input", correlation_id: String(reply.correlation_id ?? "") };
  if (reply.outcome === "accepted") row.agent = { state: "idle" };
  if (reply.playbook) row.playbook = { state: String(reply.playbook) };
}

async function requestPhase(conversationId: string) {
  const row = rowForConversation(conversationId);
  if (!row) return { output: [{ type: "text" as const, text: "No session is open for this completion." }], isError: true };
  if (!row.taskSlug) return { output: [{ type: "text" as const, text: phaseResultText({ forwarded: false }) }] };
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const local = await completeSession(row.id);
  if (!local) return { output: [{ type: "text" as const, text: phaseResultText({ forwarded: false }) }], isError: true };
  applyPhaseReply(row, local);
  row.seenNonce = nonce;
  return { output: [{ type: "text" as const, text: phaseResultText(local) }], isError: local.outcome !== "accepted" };
}

async function forwardPhase(row: Live, value: { phase: string; executionId: string; nonce: string }) {
  void value;
  const local = await completeSession(row.id);
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

function socketFd(socket: Socket): number | null {
  const record: unknown = socket;
  if (!record || typeof record !== "object" || !("_handle" in record)) return null;
  const handle = record._handle;
  if (!handle || typeof handle !== "object" || !("fd" in handle) || typeof handle.fd !== "number") return null;
  return handle.fd;
}

// libSystem has no getpeerid. Match alinery-core peer_process_id: getpeereid, then LOCAL_PEERPID.
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

function peerExecutable(socket: Socket): string | null {
  const fd = socketFd(socket);
  if (fd == null) return null;
  try {
    if (process.platform === "darwin") return darwinPeerExecutable(fd);
    if (process.platform === "linux") return linuxPeerExecutable(fd);
    return null;
  } catch {
    return null;
  }
}

function darwinPeerExecutable(fd: number): string | null {
  const libc = dlopen("libSystem.B.dylib", {
    getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    geteuid: { args: [], returns: FFIType.u32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const uid = Buffer.alloc(4);
  const gid = Buffer.alloc(4);
  if (libc.symbols.getpeereid(fd, ptr(uid), ptr(gid)) !== 0) return null;
  if (uid.readUInt32LE(0) !== libc.symbols.geteuid()) return null;
  const pid = Buffer.alloc(4);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4, 0);
  if (libc.symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ptr(pid), ptr(size)) !== 0) return null;
  if (size.readUInt32LE(0) !== 4) return null;
  const pidNum = pid.readInt32LE(0);
  if (pidNum <= 0) return null;
  const path = Buffer.alloc(4096);
  const length = libc.symbols.proc_pidpath(pidNum, ptr(path), path.length);
  if (length <= 0) return null;
  return path.subarray(0, length).toString().replace(/\0+$/, "");
}

function linuxPeerExecutable(fd: number): string | null {
  const libc = dlopen("libc.so.6", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    geteuid: { args: [], returns: FFIType.u32 },
  });
  const cred = Buffer.alloc(12);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(12, 0);
  if (libc.symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(size)) !== 0) return null;
  if (size.readUInt32LE(0) < 12) return null;
  const pidNum = cred.readInt32LE(0);
  const peerUid = cred.readUInt32LE(4);
  if (pidNum <= 0 || peerUid !== libc.symbols.geteuid()) return null;
  return readlinkSync(`/proc/${pidNum}/exe`);
}
function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

const kept = new WeakSet<Socket>();
const uiAuthorized = new WeakSet<Socket>();

function reply(socket: Socket, value: unknown, keep = false) {
  socket.write(`${JSON.stringify(value)}\n`);
  if (keep) kept.add(socket);
  else socket.end();
}

async function handle(socket: Socket, header: Record<string, unknown>, body: Buffer | null) {
  const op = String(header.op ?? "");
  if (header.body_bytes != null && body == null) return;
  if (op === "version") {
    reply(socket, { protocol: PROTOCOL, build_id: buildId, app_config_identity: identity, host_guard_ready: true });
    return;
  }
  if (op === "list") {
    const byId = new Map<string, { state: string; reason?: string }>();
    for (const row of engineAxis()) byId.set(row.id, row.playbook);
    const sessions = [...live.values()]
      .filter((row) => row.id !== "__omp-setup__")
      .map((row) => ({ id: row.id, ...sessionState({ ...row, playbook: byId.get(row.id) ?? row.playbook }), transport: isPty(row.id) ? "pty" : "rpc" }));
    reply(socket, { sessions });
    return;
  }
  if (op === "status") {
    const row = live.get(String(header.id ?? ""));
    if (!row) {
      reply(socket, { error: "unknown-session" });
      return;
    }
    const fromEngine = enginePlaybook(row.id);
    reply(socket, { ...sessionState({ ...row, playbook: fromEngine ?? row.playbook }), transport: isPty(row.id) ? "pty" : "rpc" });
    return;
  }
  if (op === "shutdown") {
    releaseKeepAwake();
    const now = Math.floor(Date.now() / 1000);
    for (const row of live.values()) {
      if (isPty(row.id)) killPty(row.id);
      writeMeta(row.taskSlug, row.id, { ended_at: now, exit_code: 0 });
      row.process = "exited";
    }
    live.clear();
    try {
      unlinkSync(uiSocket);
    } catch {
      /* already gone */
    }
    socket.write(`${JSON.stringify({ ok: true })}\n`, () => {
      socket.end();
      process.exit(0);
    });
    return;
  }
  if (op === "spawn" || op === "attach" || op === "resume") {
    const id = String(header.id ?? "");
    const taskSlug = String(header.task_slug ?? "");
    if (isPty(id) || String(readMeta(taskSlug, id).harness ?? "") === "no-harness") {
      const cols = Number(header.cols ?? 0);
      const rows = Number(header.rows ?? 0);
      const attachId = Number(header.attach_id ?? 0);
      if (!hasPty(id)) {
        if (op === "attach") {
          reply(socket, { error: "unknown-session" });
          return;
        }
        const owned = await taskOpenAllowed(taskSlug);
        if (!owned.ok) {
          reply(socket, ownershipRefusal(owned.reply));
          return;
        }
        const cwd = String(header.cwd ?? repo);
        startShell(id, cwd || repo, metaPath(taskSlug, id).replace(/\.meta\.json$/, ".scrollback"), cols, rows, () => {
          const row = live.get(id);
          if (row) row.process = "exited";
          writeMeta(taskSlug, id, { ended_at: Math.floor(Date.now() / 1000) });
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
        }
      }
      const row = live.get(id);
      if (row && row.process !== "exited") row.process = "alive";
      if (!attachShell(id, socket, attachId, cols, rows)) {
        reply(socket, { error: "unknown-session" });
        return;
      }
      kept.add(socket);
      return;
    }
    if (op !== "attach" && id && !live.has(id)) {
      const taskSlug = String(header.task_slug ?? "");
      const owned = await taskOpenAllowed(taskSlug);
      if (!owned.ok) {
        reply(socket, ownershipRefusal(owned.reply));
        return;
      }
      const model = String(header.model ?? "");
      void openSession(id, taskSlug, model).catch((error) => {
        const row = live.get(id);
        if (row) row.playbook = { state: "failed", reason: String(error) };
      });
    }
    reply(socket, { ok: true }, true);
    return;
  }
  if (op === "detach" || op === "kill") {
    const id = String(header.id ?? "");
    if (op === "detach") detachPty(id, Number(header.attach_id ?? 0));
    if (op === "kill") {
      if (isPty(id)) killPty(id);
      const row = live.get(id);
      if (row) {
        const harness = row.harness;
        try {
          if (harness) void harness.close(context);
        } catch {
          /* already closed */
        }
        writeMeta(row.taskSlug, row.id, { ended_at: Math.floor(Date.now() / 1000), exit_code: 0 });
        live.delete(id);
      }
    }
    reply(socket, { ok: true });
    return;
  }
  if (op === "write" || op === "resize" || op === "send_message") {
    const id = String(header.id ?? "");
    if (op === "write" && writePty(id, String(header.data ?? ""))) {
      reply(socket, { ok: true });
      return;
    }
    if (op === "resize" && resizePty(id, Number(header.cols ?? 0), Number(header.rows ?? 0))) {
      reply(socket, { ok: true });
      return;
    }
    reply(socket, { error: "unsupported" });
    return;
  }
  if (op === "event") {
    reply(socket, { error: "event-rejected" });
    return;
  }
  if (op === "transcript" || op === "prompt" || op === "abort") {
    const row = live.get(String(header.id ?? ""));
    if (!row) {
      reply(socket, { error: "unknown-session" });
      return;
    }
    try {
      const conversation = await conversationFor(row);
      if (!conversation) {
        reply(socket, { error: "unknown-session" });
        return;
      }
      if (op === "transcript") {
        const transcript = await transcriptMessages(row, conversation);
        reply(socket, { messages: formatTranscript(transcript.messages, transcript.tools), ...(await sessionControls(conversation)) });
        return;
      }
      if (op === "prompt") {
        const text = typeof header.text === "string" ? header.text : "";
        if (!text.trim()) {
          reply(socket, { error: "empty-prompt" });
          return;
        }
        const resolved = resolveModel(appConfig, String(readMeta(row.taskSlug, row.id).model ?? ""));
        if (!resolved) {
          reply(socket, { error: "no model is configured" });
          return;
        }
        await ensureModel(conversation, resolved, context);
        await conversation.submit({ type: "input", content: text, whenBusy: "followUp" }, context);
        reply(socket, { ok: true });
        return;
      }
      try {
        await conversation.abort(context);
      } catch (error) {
        // A completion wait is local agent state, not a live run. Abort still has to release it.
        if (row.agent.state !== "waiting_for_approval" && row.agent.state !== "waiting_for_input") throw error;
      }
      if (row.agent.state === "waiting_for_approval" || row.agent.state === "waiting_for_input") {
        row.agent = { state: row.liveRun ? "busy" : "idle" };
      }
      reply(socket, { ok: true });
    } catch (error) {
      reply(socket, { error: String(error) });
    }
    return;
  }
  if (op === "set_model" || op === "set_thinking_level") {
    const row = live.get(String(header.id ?? ""));
    const requested = op === "set_model" && typeof header.model === "string" ? header.model : "";
    const refusal = op === "set_model" ? setModelRefusal(Boolean(row), requested) : row ? null : "unknown-session";
    if (refusal || !row) {
      reply(socket, { error: refusal ?? "unknown-session" });
      return;
    }
    try {
      const conversation = await conversationFor(row);
      if (!conversation) {
        reply(socket, { error: "unknown-session" });
        return;
      }
      if (op === "set_model") {
        const resolved = resolveModel(appConfig, requested);
        if (!resolved) {
          reply(socket, { error: "no model is configured" });
          return;
        }
        await changeSessionModel(conversation, resolved, context, (patch) => writeMeta(row.taskSlug, row.id, patch));
      } else {
        const level = typeof header.level === "string" ? header.level : "";
        const agent = await conversation.agent(context);
        const current = agent.model;
        const catalog = current ? models.getModel(current.provider, current.modelId) : undefined;
        await changeThinkingLevel(conversation, level, catalog, context);
      }
      reply(socket, { ok: true, ...(await sessionControls(conversation)) });
    } catch (error) {
      reply(socket, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (
    op === "provider_catalog" ||
    op === "provider_logout" ||
    op === "provider_login_start" ||
    op === "provider_login_poll" ||
    op === "provider_login_reply" ||
    op === "custom_provider_save" ||
    op === "custom_provider_delete"
  ) {
    try {
      if (op === "provider_catalog") {
        reply(socket, await providers.catalog());
        return;
      }
      if (op === "provider_logout") {
        reply(socket, await providers.logout(typeof header.provider === "string" ? header.provider : ""));
        return;
      }
      if (op === "provider_login_start") {
        const method = header.method === "oauth" ? "oauth" : header.method === "api_key" ? "api_key" : "";
        if (!method) {
          reply(socket, { error: "login method must be api_key or oauth" });
          return;
        }
        reply(socket, providers.startLogin(typeof header.provider === "string" ? header.provider : "", method));
        return;
      }
      if (op === "provider_login_poll") {
        reply(socket, providers.pollLogin(typeof header.login_id === "string" ? header.login_id : ""));
        return;
      }
      if (op === "provider_login_reply") {
        const loginId = typeof header.login_id === "string" ? header.login_id : "";
        if (header.cancel === true) providers.cancelLogin(loginId);
        else providers.replyLogin(loginId, typeof header.value === "string" ? header.value : "");
        reply(socket, { ok: true });
        return;
      }
      if (op === "custom_provider_delete") {
        reply(socket, await providers.deleteCustom(typeof header.id === "string" ? header.id : ""));
        return;
      }
      const typedKey = typeof header.api_key === "string" ? header.api_key.trim() : "";
      reply(
        socket,
        await providers.saveCustom({
          id: typeof header.id === "string" ? header.id : "",
          name: typeof header.name === "string" ? header.name : "",
          baseUrl: typeof header.base_url === "string" ? header.base_url : "",
          apiKey: typedKey || undefined,
          clearKey: !typedKey && header.keep_key !== true,
          models: Array.isArray(header.models) ? header.models.filter((model): model is string => typeof model === "string") : [],
        }),
      );
    } catch (error) {
      reply(socket, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (op === "ui_control") {
    const host = process.env.ALINERY_HOST_EXECUTABLE;
    const peer = peerExecutable(socket);
    if (!host || !peer || !samePath(peer, host)) {
      reply(socket, { error: "UI control requires the protected UI host" });
      return;
    }
    uiAuthorized.add(socket);
    reply(socket, { ok: true }, true);
    return;
  }
  if (op === "allow_execution_completion") {
    if (!uiAuthorized.has(socket)) {
      reply(socket, { error: "completion permission requires an authenticated UI control connection" });
      return;
    }
    const request = header.request;
    const sessionId = request && typeof request === "object" && !Array.isArray(request) ? String((request as { session_id?: unknown }).session_id ?? "") : "";
    if (sessionId && (await permitSession(sessionId))) {
      reply(socket, { ok: true }, true);
      return;
    }
    reply(socket, { error: "session has no engine execution to permit" });
    return;
  }
  if (["get_task_execution", "create_execution_session", "start_session", "create_task", "create_subtask"].includes(op)) {
    try {
      reply(socket, (await taskOp(repo, lane, identity, op, header, body, (id, taskSlug, model, prompt) => {
        if (String(readMeta(taskSlug, id).harness ?? "") === "no-harness") {
          startRecordedShell(id, taskSlug);
          return Promise.resolve();
        }
        return openSession(id, taskSlug, model, prompt).then(() => undefined);
      })) ?? { error: "unhandled" });
    } catch (error) {
      reply(socket, { error: String(error) });
    }
    return;
  }
  reply(socket, { error: "unknown-op" });
}

const server = createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let header: Record<string, unknown> | null = null;
  let need = 0;
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!header) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        try {
          header = JSON.parse(buffer.subarray(0, newline).toString()) as Record<string, unknown>;
        } catch {
          buffer = Buffer.alloc(0);
          if (!kept.has(socket)) reply(socket, { error: "invalid-json" });
          return;
        }
        buffer = buffer.subarray(newline + 1);
        need = Number(header.body_bytes ?? 0);
      }
      if (need > 0 && buffer.length < need) return;
      const body = need > 0 ? buffer.subarray(0, need) : null;
      if (need > 0) buffer = buffer.subarray(need);
      const current = header;
      header = null;
      need = 0;
      void handle(socket, current, body);
      if (buffer.length === 0) return;
    }
  });
});

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

repairSessionMetas();
server.listen(uiSocket, () => {
  void resumeInterrupted().then(() => startGraphs(repo, {
    open: (id, taskSlug, model, prompt) => openSession(id, taskSlug, model, prompt).then(() => undefined),
    async status(id) {
      const row = live.get(id);
      if (!row) return { kind: "unknown" };
      if (row.process === "exited") return { kind: "exited", exitCode: null };
      if (row.process === "starting") return { kind: "starting" };
      if (row.agent.state === "busy" || row.liveRun) return { kind: "running" };
      return { kind: "idle" };
    },
    async send(id, text) {
      const row = live.get(id);
      const conversation = row ? await conversationFor(row) : null;
      if (!row || !conversation) throw new Error(`unknown session ${id}`);
      const resolved = resolveModel(appConfig, String(readMeta(row.taskSlug, row.id).model ?? ""));
      if (!resolved) throw new Error("no model is configured");
      await ensureModel(conversation, resolved, context);
      await conversation.submit({ type: "input", content: text, whenBusy: "followUp" }, context);
    },
    async stop(id) {
      const row = live.get(id);
      if (!row || row.process === "exited") return;
      const conversation = await conversationFor(row);
      if (conversation) {
        try {
          await conversation.abort(context);
        } catch {
          /* already idle */
        }
      }
      row.process = "exited";
      writeMeta(row.taskSlug, row.id, { ended_at: Math.floor(Date.now() / 1000) });
    },
    bind(id, executionId) {
      const row = live.get(id);
      if (row) row.executionId = executionId;
    },
  }));
});
