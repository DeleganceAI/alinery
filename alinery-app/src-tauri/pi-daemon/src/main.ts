import { createConnection, createServer, type Socket } from "node:net";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { Type } from "@earendil-works/pi-ai";
import { Harness, createRegistry, defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { installAlineryProvider, modelSources } from "./provider.ts";

const PROTOCOL = 16;
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
  harness: unknown;
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
const buildId = flag("--build-id") || "alinery-pi-daemon";
if (!repo || !appConfig) {
  console.error("alinery-pi-daemon: missing --repo or --app-config");
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
registry.install(phaseExtension());

function phaseExtension() {
  return defineExtension({
    name: "alinery-phase",
    tools: [
      defineTool({
        name: "alinery_phase_complete",
        description: "Commit a phase completion request. Do not mark the phase completed.",
        parameters: Type.Object({ phase: Type.String(), executionId: Type.String(), nonce: Type.String() }),
        execute: async (args, api, ctx) => {
          await api.commit(async (tx) => {
            const doc = await tx.doc(PhaseRequest, api.conversationId);
            doc.phase = args.phase;
            doc.executionId = args.executionId;
            doc.nonce = args.nonce;
          }, ctx);
          return { output: [{ type: "text", text: "phase request committed" }] };
        },
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
    throw new Error(message ? new CString(message).toString() : "ownership acquire failed");
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

async function openSession(id: string, taskSlug: string, model: string) {
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
    seenNonce: "",
  };
  live.set(id, row);
  const meta = readMeta(taskSlug, id);
  if (!meta.started_at) writeMeta(taskSlug, id, { started_at: Math.floor(Date.now() / 1000), harness: "omp", harness_resume_token: "" });
  const storage = await openNodeSqliteStorage(path);
  const harness = await Harness.open(storage, { models, registry }, context);
  row.harness = harness;
  if (exists) harness.resume();
  const root = await harness.root(context, exists ? undefined : { agent: { model: { provider: "alinery", modelId: model.replace(/^alinery\//, "") } } });
  row.process = "alive";
  watch(row, root);
  return row;
}

function watch(row: Live, root: { id: string; commit: Function }) {
  const harness = row.harness as { watchDoc: Function };
  void harness.watchDoc(Attention, root.id, context).then((state: { subscribe: Function }) => {
    state.subscribe((value: { wait: Live["agent"] extends never ? never : { kind: string; correlationId: string } | null }) => {
      if (value.wait) row.agent = { state: value.wait.kind === "approval" ? "waiting_for_approval" : "waiting_for_input", correlation_id: value.wait.correlationId };
    });
  });
  void harness.watchDoc({ kind: "pi.live" } as never, root.id, context).then((state: { subscribe: Function }) => {
    state.subscribe((value: { run?: unknown } | null) => {
      if (row.agent.state === "waiting_for_input" || row.agent.state === "waiting_for_approval") return;
      row.agent = { state: value?.run ? "busy" : "idle" };
    });
  });
  void harness.watchDoc(PhaseRequest, root.id, context).then((state: { subscribe: Function }) => {
    state.subscribe((value: { phase: string; executionId: string; nonce: string }) => {
      if (!value.nonce || value.nonce === row.seenNonce) return;
      row.seenNonce = value.nonce;
      if (!row.taskSlug) return;
      void forwardPhase(row, value);
    });
  });
}

async function forwardPhase(row: Live, value: { phase: string; executionId: string; nonce: string }) {
  const reply = await helper({ op: "phase_request", task_slug: row.taskSlug, session_id: row.id, phase: value.phase, execution_id: value.executionId, nonce: value.nonce });
  if (reply.outcome === "waiting_for_approval") row.agent = { state: "waiting_for_approval", correlation_id: String(reply.correlation_id ?? "") };
  if (reply.outcome === "waiting_for_input") row.agent = { state: "waiting_for_input", correlation_id: String(reply.correlation_id ?? "") };
  if (reply.playbook) row.playbook = { state: String(reply.playbook) };
}

function helper(request: unknown, body?: Buffer): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = createConnection(helperSocket);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const line = data.split("\n")[0];
      if (line) {
        socket.end();
        try {
          resolve(JSON.parse(line) as Record<string, unknown>);
        } catch {
          resolve({ error: "bad-helper-reply" });
        }
      }
    });
    socket.on("error", (error) => resolve({ error: String(error) }));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      if (body) socket.write(body);
    });
  });
}

function peerExecutable(socket: Socket): string | null {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  if (fd == null) return null;
  try {
    const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
      getpeerid: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const pidBuf = Buffer.alloc(4);
    if (process.platform !== "darwin") return null;
    const code = libc.symbols.getpeerid(fd, ptr(pidBuf));
    if (code !== 0) return null;
    const pid = pidBuf.readInt32LE(0);
    const path = Buffer.alloc(4096);
    const proc = dlopen("libSystem.B.dylib", { proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } });
    const length = proc.symbols.proc_pidpath(pid, ptr(path), path.length);
    if (length <= 0) return null;
    return path.subarray(0, length).toString().replace(/\0+$/, "");
  } catch {
    return null;
  }
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
    reply(socket, { ok: true });
    process.exit(0);
  }
  if (op === "spawn" || op === "attach" || op === "resume") {
    const id = String(header.id ?? "");
    if (op !== "attach" && id && !live.has(id)) {
      const taskSlug = String(header.task_slug ?? "");
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
        const harness = row.harness as { close?: () => Promise<void> | void } | null;
        try {
          void harness?.close?.();
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
    try {
      await openSession(String(header.id ?? ""), String(header.task_slug ?? ""), String(header.model ?? ""));
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
    reply(socket, { ok: true }, true);
    return;
  }
  if (["get_task_execution", "create_execution_session", "start_session", "create_task", "create_subtask", "allow_execution_completion"].includes(op)) {
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
        if (meta.started_at && !meta.ended_at) void openSession(id, taskSlug, String(meta.model ?? ""));
      }
    };
    walk(root, "");
  }
}

server.listen(uiSocket, () => {
  resumeInterrupted();
});
