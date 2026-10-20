import { createConnection, createServer, type Socket } from "node:net";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync, realpathSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import type { WatchHandle } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { Harness, LiveDoc, createRegistry, defineDoc, defineExtension, defineTool, type Conversation, type Harness as OpenedHarness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { installAlineryProvider, modelSources, resolveModelId } from "./provider.ts";

// Vinculum is the Alinery daemon. Its agent runtime is pi-durable (@earendil-works/pi-durable).
const PROTOCOL = 17;
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
  console.error("neither hosted inference nor XAI_API_KEY is usable");
  process.exit(1);
}

const lane = namespace;
const identity = appConfigIdentity(appConfig);
acquireOwnership(repo, lane, identity);
const uiSocket = join(repo, ".alinery", `${namespace ? `alineryd-${namespace}` : "alineryd"}.sock`);
const helperSocket = join(repo, ".alinery", `${namespace ? `alinery-playbook-${namespace}` : "alinery-playbook"}.sock`);
try {
  unlinkSync(uiSocket);
} catch {
  /* absent */
}
mkdirSync(dirname(uiSocket), { recursive: true });

const models = createModels();
installAlineryProvider(models, appConfig);
const registry = createRegistry();
registry.install(codingExtension());
registry.install(phaseExtension());

const fileWrite = createWriteTool();
const PHASE_WRITE = "xd://alinery_phase_complete";

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

function appConfigIdentity(path: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function acquireOwnership(repoPath: string, laneName: string, configIdentity: string) {
  const library = process.env.ALINERY_OWNERSHIP_LIB;
  if (!library) throw new Error("ALINERY_OWNERSHIP_LIB is not set");
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
  const current = readMeta(taskSlug, id);
  writeFileSync(path, JSON.stringify({ ...current, ...patch, id }));
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
  const modelId = resolveModelId(appConfig, model);
  if (!modelId) throw new Error("no model is configured");
  const root = await harness.root(context, exists ? undefined : { agent: { model: { provider: "alinery", modelId } } });
  row.conversationId = root.id;
  await ensureModel(root, modelId);
  if (!String(readMeta(taskSlug, id).model ?? "").trim()) writeMeta(taskSlug, id, { model: `alinery/${modelId}` });
  // Resumed conversations were created before this hook existed. tx.doc loads an existing doc and creates a missing one.
  await root.commit(async (tx) => {
    await tx.doc(Attention, root.id);
    await tx.doc(PhaseRequest, root.id);
  }, context);
  watch(row, harness, root.id);
  if (exists) harness.resume();
  await seedPrompt(root, prompt);
  row.process = "alive";
  return row;
}

async function ensureModel(conversation: Conversation, modelId: string, force = false) {
  const agent = await conversation.agent(context);
  if (agent.model?.modelId === modelId) return;
  if (!force && agent.model?.modelId) return;
  await conversation.configure({ model: { provider: "alinery", modelId } }, context);
}

async function seedPrompt(conversation: Conversation, prompt: string) {
  if (!prompt) return;
  const page = await conversation.entries({ order: "ascending" }, 200, undefined, context);
  const hasUser = page.items.some((entry) => entry.kind === "pi.user" || (entry.model ?? []).some((message) => message.role === "user"));
  if (hasUser) return;
  // Admission only. The model run continues after this returns.
  await conversation.submit({ type: "input", content: prompt, whenBusy: "followUp" }, context);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return "";
      const text = part.text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

type ShownMessage = { role?: string; content?: unknown; errorMessage?: string };

// conversation.context() is the next model request. It drops assistant messages whose stop reason is error, aborted, or deferred, so a failed turn never reaches the pane. The transcript is the stored entries, plus the in-flight partial.
async function transcriptMessages(row: Live, conversation: Conversation): Promise<ShownMessage[]> {
  const messages: ShownMessage[] = [];
  let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) {
      const model = entry.model;
      if (!Array.isArray(model)) continue;
      for (const message of model) {
        if (message && typeof message === "object") messages.push(message as ShownMessage);
      }
    }
    cursor = page.next;
    if (!cursor) break;
  }
  const live = row.harness ? await row.harness.documentState(LiveDoc, conversation.id, context) : undefined;
  try {
    const partial = live?.value?.generation?.message;
    if (partial) messages.push(partial);
    else if (live?.value?.generation?.retry?.error) messages.push({ role: "assistant", errorMessage: live.value.generation.retry.error });
  } finally {
    live?.dispose();
  }
  return messages;
}

function formatTranscript(messages: ReadonlyArray<ShownMessage>): Array<{ role: "user" | "assistant" | "tool"; text: string }> {
  const out: Array<{ role: "user" | "assistant" | "tool"; text: string }> = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) out.push({ role: "user", text });
      continue;
    }
    if (message.role !== "assistant") continue;
    const prose: string[] = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const record = part as { type?: string; text?: string; name?: string };
        if (record.type === "toolCall" || record.type === "tool_call") {
          const name = record.name?.trim();
          if (name) out.push({ role: "tool", text: name });
          continue;
        }
        if (record.type === "text" && record.text?.trim()) prose.push(record.text.trim());
      }
    }
    if (prose.length > 0) out.push({ role: "assistant", text: prose.join("\n") });
    else if (message.errorMessage?.trim()) out.push({ role: "assistant", text: message.errorMessage.trim() });
  }
  return out;
}

async function conversationFor(row: Live): Promise<Conversation | null> {
  if (!row.harness || !row.conversationId) return null;
  return (await row.harness.conversation(row.conversationId, context)) ?? null;
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
    row.liveRun = Boolean(value?.run);
    if (row.agent.state === "waiting_for_input" || row.agent.state === "waiting_for_approval") return;
    row.agent = { state: row.liveRun ? "busy" : "idle" };
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
  const meta = readMeta(row.taskSlug, row.id);
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const reply = await helper({
    op: "phase_request",
    task_slug: row.taskSlug,
    session_id: row.id,
    phase: String(meta.phase ?? ""),
    execution_id: String(meta.execution_id ?? ""),
    nonce,
  });
  applyPhaseReply(row, reply);
  row.seenNonce = nonce;
  return { output: [{ type: "text" as const, text: phaseResultText(reply) }], isError: reply.outcome !== "accepted" };
}

async function forwardPhase(row: Live, value: { phase: string; executionId: string; nonce: string }) {
  const reply = await helper({ op: "phase_request", task_slug: row.taskSlug, session_id: row.id, phase: value.phase, execution_id: value.executionId, nonce: value.nonce });
  applyPhaseReply(row, reply);
}

function helper(request: unknown, body?: Buffer): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = createConnection(helperSocket);
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(value);
    };
    // One reply is one JSON line. split("\n")[0] is the whole buffer until that byte arrives, so a split read parsed a prefix, closed the socket, and reported bad-helper-reply after create_task had already committed.
    const takeLine = () => {
      const buffered = Buffer.concat(chunks);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) finish({ error: "bad-helper-reply" });
        else finish(parsed as Record<string, unknown>);
      } catch {
        finish({ error: "bad-helper-reply" });
      }
    };
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      takeLine();
    });
    socket.on("error", (error) => finish({ error: String(error) }));
    socket.on("end", () => {
      if (!settled) finish({ error: "bad-helper-reply" });
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      if (body) socket.write(body);
    });
  });
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
  const reply = await helper({ op: "get_task_execution", request: { task_slug: taskSlug } });
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
    const axis = await helper({ op: "playbook_axis" });
    const byId = new Map<string, { state: string; reason?: string }>();
    for (const row of (axis.sessions as Array<{ id: string; playbook: { state: string; reason?: string } }> | undefined) ?? []) byId.set(row.id, row.playbook);
    const sessions = [...live.values()]
      .filter((row) => row.id !== "__omp-setup__")
      .map((row) => ({ id: row.id, ...sessionState({ ...row, playbook: byId.get(row.id) ?? row.playbook }), transport: "rpc" }));
    reply(socket, { sessions });
    return;
  }
  if (op === "status") {
    const row = live.get(String(header.id ?? ""));
    if (!row) {
      reply(socket, { error: "unknown-session" });
      return;
    }
    const axis = await helper({ op: "playbook_axis" });
    const match = ((axis.sessions as Array<{ id: string; playbook: { state: string; reason?: string } }> | undefined) ?? []).find((item) => item.id === row.id);
    reply(socket, { ...sessionState({ ...row, playbook: match?.playbook ?? row.playbook }), transport: "rpc" });
    return;
  }
  if (op === "shutdown") {
    const now = Math.floor(Date.now() / 1000);
    for (const row of live.values()) {
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
    if (op === "kill") {
      const id = String(header.id ?? "");
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
    reply(socket, { error: "unsupported" });
    return;
  }
  if (op === "event") {
    reply(socket, { error: "event-rejected" });
    return;
  }
  if (op === "pi_open") {
    if (header.token !== process.env.ALINERY_PI_LAUNCH_TOKEN) {
      reply(socket, { error: "bad-launch-token" });
      return;
    }
    const taskSlug = String(header.task_slug ?? "");
    const owned = await taskOpenAllowed(taskSlug);
    if (!owned.ok) {
      reply(socket, ownershipRefusal(owned.reply));
      return;
    }
    try {
      await openSession(String(header.id ?? ""), taskSlug, String(header.model ?? ""), typeof header.prompt === "string" ? header.prompt : "");
      reply(socket, { ok: true });
    } catch (error) {
      reply(socket, { error: String(error) });
    }
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
        reply(socket, { messages: formatTranscript(await transcriptMessages(row, conversation)) });
        return;
      }
      if (op === "prompt") {
        const text = typeof header.text === "string" ? header.text : "";
        if (!text.trim()) {
          reply(socket, { error: "empty-prompt" });
          return;
        }
        const modelId = resolveModelId(appConfig, String(readMeta(row.taskSlug, row.id).model ?? ""));
        if (!modelId) {
          reply(socket, { error: "no model is configured" });
          return;
        }
        await ensureModel(conversation, modelId);
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
  if (op === "set_model") {
    const row = live.get(String(header.id ?? ""));
    if (!row) {
      reply(socket, { error: "unknown-session" });
      return;
    }
    const requested = typeof header.model === "string" ? header.model : "";
    const modelId = resolveModelId(appConfig, requested);
    if (!modelId) {
      reply(socket, { error: "no model is configured" });
      return;
    }
    try {
      const conversation = await conversationFor(row);
      if (!conversation) {
        reply(socket, { error: "unknown-session" });
        return;
      }
      await ensureModel(conversation, modelId, true);
      writeMeta(row.taskSlug, row.id, { model: requested.includes("/") ? requested : `alinery/${modelId}` });
      reply(socket, { ok: true });
    } catch (error) {
      reply(socket, { error: String(error) });
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
    reply(socket, await helper(header, body ?? undefined), true);
    return;
  }
  if (["get_task_execution", "create_execution_session", "start_session", "create_task", "create_subtask"].includes(op)) {
    const forwarded = await helper(header, body ?? undefined);
    reply(socket, forwarded);
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

function resumeInterrupted() {
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
          void taskOpenAllowed(taskSlug).then((owned) => {
            if (!owned.ok) {
              console.error(`resume skipped ${id}: ownership`);
              return;
            }
            return openSession(id, taskSlug, String(meta.model ?? ""));
          }).catch((error) => {
            console.error(`resume failed ${id}: ${error}`);
          });
        }
      }
    };
    walk(root, "");
  }
}

server.listen(uiSocket, () => {
  resumeInterrupted();
});
