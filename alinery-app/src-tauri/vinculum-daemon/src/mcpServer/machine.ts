// The machine MCP (docs/machine-mcp-plan.md): one per OS user and lane, on a unix socket in the app-config directory. Daemons
// register over that socket with an AGENT token minted for it (M8), every client reaches every registered daemon (M2), and an
// optional token in an owner-only key file guards it. The socket speaks the JSON lines the managed MCP's socket speaks: MCP
// requests, plus the control ops `auth`, `status`, `register` and the frozen `exit`.
import { readFileSync, unlinkSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tryLockExclusive } from "../platform/lock.ts";
import { selfCommand, spawnDetached } from "../platform/process.ts";
import type { Endpoint } from "./client.ts";
import { Endpoints } from "./endpoints.ts";
import { serveLines } from "./server.ts";

type Json = Record<string, unknown>;

/** M6: with no daemon registered for this long, the MCP exits; the next daemon or bridge starts it again. */
export const IDLE_MS = 10 * 60_000;
/** A `status` that takes longer than this reads as stuck (M3). */
export const STATUS_TIMEOUT_MS = 2_000;

export type MachinePaths = { socket: string; lock: string; key: string };

/** `machine-mcp[-ns].sock`, `.lock` and `.key` in the app-config directory, the namespace cut as `mcpPaths` cuts it. */
export function machinePaths(configDir: string, namespace?: string): MachinePaths {
  const clean = (namespace ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  const stem = clean ? `machine-mcp-${clean}` : "machine-mcp";
  return { socket: join(configDir, `${stem}.sock`), lock: join(configDir, `${stem}.lock`), key: join(configDir, `${stem}.key`) };
}

type KeyFile = { token?: unknown; previous?: unknown; previous_until_ms?: unknown };

function readKey(path: string): KeyFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Present but unreadable: fail closed, nothing is accepted.
    return {};
  }
}

/**
 * The tokens a caller may present now, or null when there is no key file and none is needed (M2). Read on every check, so a
 * rotation needs no restart; the previous token stays good until `previous_until_ms` (M5).
 */
export function acceptedTokens(path: string, now = Date.now()): string[] | null {
  const key = readKey(path);
  if (key === null) return null;
  const tokens = typeof key.token === "string" && key.token ? [key.token] : [];
  if (typeof key.previous === "string" && key.previous && typeof key.previous_until_ms === "number" && now < key.previous_until_ms) tokens.push(key.previous);
  return tokens;
}

/** The token a client presents: the current one, or undefined when none is set. */
export function currentToken(path: string): string | undefined {
  const key = readKey(path);
  return typeof key?.token === "string" && key.token ? key.token : undefined;
}

type Registration = { repo: string; socket: string; protocol: number; token: string; build: string };

export type MachineStatus = {
  ok: true;
  build: string;
  protocol: number;
  uptime_ms: number;
  clients: number;
  daemons: { repo: string; protocol: number; state: "ok" | "incompatible" }[];
};

const unlinkQuiet = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
};

/** `--mcp --machine`. Takes the lock first: only its holder may unlink and bind the socket. Returns the exit code. */
export async function serveMachine(options: { paths: MachinePaths; protocol: number; build: string; appConfig?: string; idleMs?: number }): Promise<number> {
  const { paths, protocol, build } = options;
  const lock = tryLockExclusive(paths.lock);
  if (!lock) {
    console.error(`machine MCP: another instance holds ${paths.lock}`);
    return 0;
  }
  const started = performance.now();
  const registrations = new Map<Socket, Registration>();
  let clients = 0;
  const registered = (): Record<string, Endpoint> => Object.fromEntries([...registrations.values()].map((r) => [r.repo, { socket: r.socket, token: r.token }]));
  // M2: every caller reaches every registered daemon, and the handoff is everyone's.
  const ctx = { protocol, processRepo: undefined, appConfig: options.appConfig, endpoints: new Endpoints(undefined, undefined, true, registered) };

  let idle: ReturnType<typeof setTimeout> | undefined;
  const leave = () => {
    unlinkQuiet(paths.socket);
    lock.release();
    process.exit(0);
  };
  // The timer runs only while no daemon is present, so a sleeping laptop with daemons does not read as idle.
  const armIdle = () => {
    clearTimeout(idle);
    idle = registrations.size === 0 ? setTimeout(leave, options.idleMs ?? IDLE_MS) : undefined;
  };

  const status = (): MachineStatus => ({
    ok: true,
    build,
    protocol,
    uptime_ms: Math.round(performance.now() - started),
    clients,
    daemons: [...registrations.values()].map((r) => ({ repo: r.repo, protocol: r.protocol, state: r.protocol === protocol ? "ok" : "incompatible" })),
  });

  const server = createServer((connection: Socket) => {
    const reply = (message: Json) => connection.writable && connection.write(`${JSON.stringify(message)}\n`);
    let authed: boolean | undefined;
    let counted = false;
    const refuse = (req: Json, message: string) => {
      if (typeof req.op === "string") reply({ ok: false, error: message });
      else if (req.id !== undefined) reply({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message } });
      connection.end();
    };
    const drop = () => {
      if (counted) clients--;
      counted = false;
      if (registrations.delete(connection)) armIdle();
    };
    connection.on("error", () => {});
    connection.on("close", drop);
    void serveLines(connection, (line) => connection.writable && connection.write(`${line}\n`), ctx, (req) => {
      if (authed === undefined) authed = acceptedTokens(paths.key) === null;
      if (req.op === "auth") {
        const accepted = acceptedTokens(paths.key);
        authed = accepted === null || accepted.includes(String(req.token ?? ""));
        if (authed) reply({ ok: true });
        else refuse(req, "wrong token for this MCP");
        return true;
      }
      if (!authed) {
        refuse(req, "this MCP needs its token (Settings → Updates → Runtime)");
        return true;
      }
      switch (req.op) {
        case "status":
          reply(status());
          return true;
        case "register": {
          const { repo, socket, token } = req;
          if (typeof repo !== "string" || typeof socket !== "string" || typeof token !== "string" || typeof req.protocol !== "number") {
            refuse(req, "register needs repo, socket, protocol and token");
            return true;
          }
          registrations.set(connection, { repo, socket, token, protocol: req.protocol, build: typeof req.build === "string" ? req.build : "" });
          armIdle();
          reply({ ok: true, protocol });
          return true;
        }
        case "exit":
          // Frozen: shipped shells send these exact bytes and wait for this ack.
          connection.write(`${JSON.stringify({ ok: true })}\n`, leave);
          return true;
        default:
          if (!counted) {
            counted = true;
            clients++;
          }
          return false;
      }
    });
  });
  // The socket is owner-only from the moment it exists: other OS users are never served (M1).
  process.umask(0o077);
  unlinkQuiet(paths.socket);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, resolve);
  });
  console.error(`machine MCP: listening on ${paths.socket}`);
  armIdle();
  // No SIGTERM handler, on purpose: Force restart (M3) relies on the default action ending even a wedged loop.
  return new Promise<number>(() => {});
}

/** One request on a fresh connection: optional auth, then `message`; resolves with the answer or rejects on timeout or close. */
export function ask(path: string, message: Json, token?: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<Json> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = "";
    const lines: Json[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);
    const finish = (error?: Error, value?: Json) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as Json);
    };
    socket.on("error", (e) => finish(e));
    socket.on("close", () => finish(new Error("closed")));
    socket.on("connect", () => {
      if (token) socket.write(`${JSON.stringify({ op: "auth", token })}\n`);
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        lines.push(JSON.parse(buffer.slice(0, at)) as Json);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
      const wanted = token ? 2 : 1;
      if (lines.length >= wanted || lines[0]?.ok === false) finish(undefined, lines[lines.length - 1]);
    });
  });
}

/** Whether something answers a connect on the socket. */
export function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

/** Starts `--mcp --machine` detached, with the daemon's own recipe (a new session, no stdio). */
export function spawnMachine(appConfig: string, namespace: string | undefined, idleMs?: number): void {
  const args = ["--mcp", "--machine", "--app-config", appConfig, ...(namespace ? ["--socket-namespace", namespace] : []), ...(idleMs ? ["--idle-ms", String(idleMs)] : [])];
  spawnDetached(selfCommand(...args), { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

let spawning: Promise<boolean> | undefined;

/**
 * Connect-or-spawn (M6): resolves true once the socket answers. Single-flight within this process; across processes the lock
 * picks the one instance that binds. Called on daemon start, a dropped registration, the bridge and an explicit Ensure, never from a poller.
 */
export function ensureMachine(paths: MachinePaths, spawn: () => void, waitMs = 5_000): Promise<boolean> {
  spawning ??= (async () => {
    try {
      if (await answers(paths.socket)) return true;
      spawn();
      const end = performance.now() + waitMs;
      while (performance.now() < end) {
        await Bun.sleep(100);
        if (await answers(paths.socket)) return true;
      }
      return false;
    } finally {
      spawning = undefined;
    }
  })();
  return spawning;
}
