// This daemon's side of the machine MCP (docs/machine-mcp-plan.md M6, M8): it starts the MCP when nothing answers, registers
// over its socket with an AGENT token minted for it, keeps that connection open (a closed connection means this daemon is gone)
// and registers again after a drop. `McpService` reads and restarts the MCP through here; nothing here ever signals it.
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { writeOwnerOnly } from "../platform/fs.ts";
import { answers, ask, currentToken, ensureMachine, type MachinePaths, STATUS_TIMEOUT_MS } from "../mcpServer/machine.ts";

/** Backoff between registration attempts after a drop or a failed start. */
export const RETRY_MS = [1_000, 5_000, 30_000];

/** How long a rotated-out token keeps working, so a client mid-call or holding the old one does not fail at once (M5). */
export const ROTATION_OVERLAP_MS = 10 * 60_000;

/** M2, M5: rotate creates the token when none is set, and keeps the previous one good for the overlap; clear removes the file. */
export function rotateToken(keyPath: string, now = Date.now()): string {
  const token = randomBytes(32).toString("hex");
  const previous = currentToken(keyPath);
  writeOwnerOnly(keyPath, JSON.stringify(previous ? { token, previous, previous_until_ms: now + ROTATION_OVERLAP_MS } : { token }));
  return token;
}

export function clearToken(keyPath: string): void {
  try {
    unlinkSync(keyPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export type McpState = "absent" | "ok" | "behind" | "stuck";
export type McpStatus = {
  state: McpState;
  build: string;
  protocol: number;
  uptimeMs: number;
  clients: number;
  daemons: { repo: string; protocol: number; compatible: boolean }[];
  socket: string;
  tokenRequired: boolean;
};

export type MachineLinkOptions = {
  paths: MachinePaths;
  repo: string;
  /** This daemon's RPC socket and protocol, and its build (the app version) for the `behind` state. */
  rpcSocket: string;
  protocol: number;
  build: string;
  /** Mints a fresh AGENT token for each registration (`TokenRegistry.mint("machine-mcp")` keeps the previous one valid). */
  mint: () => string;
  spawn: () => void;
  log?: (line: string) => void;
};

export class MachineLink {
  private socket: Socket | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private connecting: Promise<void> | undefined;

  constructor(private readonly options: MachineLinkOptions) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }

  /** Connect-or-spawn, then register; a drop or failure schedules the next try. Single-flight. */
  connect(): Promise<void> {
    this.connecting ??= this.register().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private retry() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private async register(): Promise<void> {
    const { paths, log } = this.options;
    if (this.stopped || this.socket) return;
    if (!(await ensureMachine(paths, this.options.spawn))) {
      log?.(`machine MCP: nothing answers at ${paths.socket}`);
      return this.retry();
    }
    const socket = connect(paths.socket);
    this.socket = socket;
    let registered = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      if (registered) log?.("machine MCP: registration dropped");
      this.retry();
    });
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const answer = JSON.parse(buffer.slice(0, at)) as { ok?: boolean; error?: string; protocol?: number };
        buffer = buffer.slice(at + 1);
        if (answer.ok === false) log?.(`machine MCP refused this daemon: ${answer.error}`);
        else if (answer.protocol !== undefined) {
          registered = true;
          this.attempt = 0;
        }
      }
    });
    socket.on("connect", () => {
      const token = currentToken(paths.key);
      if (token) socket.write(`${JSON.stringify({ op: "auth", token })}\n`);
      const { repo, rpcSocket, protocol, build } = this.options;
      socket.write(`${JSON.stringify({ op: "register", repo, socket: rpcSocket, protocol, build, token: this.options.mint() })}\n`);
    });
  }

  /** M3: absent when nothing answers, stuck when it does not answer `status` in time, behind when its build is not this daemon's. */
  async status(): Promise<McpStatus> {
    const { paths, build, protocol } = this.options;
    const base = { build: "", protocol: 0, uptimeMs: 0, clients: 0, daemons: [], socket: paths.socket, tokenRequired: currentToken(paths.key) !== undefined };
    if (!(await answers(paths.socket))) return { ...base, state: "absent" };
    let reply: Record<string, unknown>;
    try {
      reply = await ask(paths.socket, { op: "status" }, currentToken(paths.key), STATUS_TIMEOUT_MS);
    } catch {
      return { ...base, state: "stuck" };
    }
    if (reply.ok !== true) return { ...base, state: "stuck" };
    const theirs = { build: String(reply.build ?? ""), protocol: Number(reply.protocol ?? 0) };
    const daemons = ((reply.daemons as { repo: string; protocol: number; state: string }[]) ?? []).map((d) => ({ repo: d.repo, protocol: d.protocol, compatible: d.state === "ok" }));
    return {
      ...base,
      ...theirs,
      state: theirs.build === build && theirs.protocol === protocol ? "ok" : "behind",
      uptimeMs: Number(reply.uptime_ms ?? 0),
      clients: Number(reply.clients ?? 0),
      daemons,
    };
  }

  /** Start it when nothing answers (and register this daemon). */
  async ensure(): Promise<McpStatus> {
    await this.connect();
    return this.status();
  }

  /** M3: the frozen `exit`, wait for the socket to go quiet, then connect-or-spawn. A timeout answers `stuck`, never a signal. */
  async restart(waitMs = 5_000): Promise<McpStatus> {
    const { paths } = this.options;
    try {
      await ask(paths.socket, { op: "exit" }, currentToken(paths.key), STATUS_TIMEOUT_MS);
    } catch {
      /* absent, or stuck: the wait below tells which */
    }
    const end = performance.now() + waitMs;
    while (await answers(paths.socket)) {
      if (performance.now() > end) return { ...(await this.status()), state: "stuck" };
      await Bun.sleep(100);
    }
    return this.ensure();
  }
}
