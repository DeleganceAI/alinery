// The MCP server itself: the JSON-RPC handling the machine MCP serves (`machine.ts`), and the stdio bridge every client runs to reach it.
// The tools are in `handlers.ts` and every one of them is a call on a daemon.
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { callTool, type Context } from "./handlers.ts";
import { appConfigDirOf } from "../domain/playbookLibrary.ts";
import { ask, currentToken, ensureMachine, machinePaths, serveMachine, spawnMachine } from "./machine.ts";
import { TOOLS } from "./tools.ts";

type Json = Record<string, unknown>;

const REMOTE_MSG = "This repo appears to be remote (ssh). MCP currently supports read-only discovery of remote repos only. Full operations require the Alinery desktop app or future remote daemon support.";
const PROCESS_SCOPED = "(MCP resource URIs are process-scoped)";

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function resourceRead(ctx: Context, params: Json): Promise<Json> {
  const uri = typeof params.uri === "string" ? params.uri : "";
  const repo = ctx.processRepo ?? "";
  if (!existsSync(join(repo, ".git"))) return { contents: [{ uri, mimeType: "text/plain", text: REMOTE_MSG }] };
  const rel = uri.replace(/^alinery:\/\//, "").replace(/^\/+/, "");
  const tail = rel.includes("/.alinery/") ? rel.slice(rel.indexOf("/.alinery/") + "/.alinery/".length) : rel.replace(/^\.alinery\//, "");
  const parts = tail.split("/");
  let answer = "";
  if (parts[0] === "tasks" && parts.length >= 3) {
    const slug = parts[1];
    const rest = parts.slice(2).join("/");
    if (rest === "task.md") answer = (await callTool(ctx, "alinery_get_task", { repo, slug })).content[0].text;
    else if (rest.startsWith("artifacts/")) {
      const reply = await callTool(ctx, "alinery_read_artifact", { repo, slug, filename: rest.slice("artifacts/".length) });
      answer = reply.content[0].text.startsWith("error: ") ? "" : reply.content[0].text;
    } else if (/^sessions\/[^/]+\.meta\.json$/.test(rest)) {
      const listed = (await callTool(ctx, "alinery_list_sessions", { repo, slug })).content[0].text;
      const sessions = (listed.startsWith("[") ? JSON.parse(listed) : []) as { id: string }[];
      const id = rest.slice("sessions/".length, -".meta.json".length);
      const found = sessions.find((s) => s.id === id);
      answer = found ? JSON.stringify(found, null, 2) : "";
    }
  }
  return { contents: [{ uri, mimeType: "text/markdown", text: answer }] };
}

/** One JSON-RPC message. A notification (no `id`) is never answered. */
export async function handleRequest(ctx: Context, req: Json): Promise<Json | null> {
  const method = typeof req.method === "string" ? req.method : "";
  const params = (req.params && typeof req.params === "object" ? req.params : {}) as Json;
  const id = req.id;
  let outcome: { result: unknown } | { error: { code: number; message: string } };
  switch (method) {
    case "initialize":
      outcome = {
        result: {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "alinery-mcp", version: "0.1" },
        },
      };
      break;
    case "tools/list":
      outcome = { result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
      break;
    case "tools/call":
      outcome = { result: await callTool(ctx, typeof params.name === "string" ? params.name : "", params.arguments) };
      break;
    case "resources/list": {
      const repo = ctx.processRepo;
      outcome = repo
        ? {
            result: {
              resources: [
                { uri: `alinery://${repo}/.alinery/tasks/{slug}/task.md`, name: "task.md" },
                { uri: `alinery://${repo}/.alinery/tasks/{slug}/artifacts/{nn}.md`, name: "artifact" },
                { uri: `alinery://${repo}/.alinery/tasks/{slug}/sessions/{id}.meta.json`, name: "session meta" },
              ],
            },
          }
        : { error: { code: -32602, message: `resources/list requires --repo at process launch ${PROCESS_SCOPED}` } };
      break;
    }
    case "resources/read":
      outcome = ctx.processRepo ? { result: await resourceRead(ctx, params) } : { error: { code: -32602, message: `resources/read requires --repo at process launch ${PROCESS_SCOPED}` } };
      break;
    default:
      outcome = { error: { code: -32601, message: "Method not found" } };
  }
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, ...outcome };
}

/** Feeds every line of `input` to `handle` one after another and writes each answer, so tool calls on a connection never overlap. */
export function serveLines(input: NodeJS.ReadableStream, write: (line: string) => void, ctx: Context, onLine?: (req: Json) => boolean) {
  let chain: Promise<void> = Promise.resolve();
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let req: Json;
      try {
        req = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (onLine?.(req)) return;
      const answer = await handleRequest(ctx, req).catch((e) => ({ jsonrpc: "2.0", id: req.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
      if (answer) write(JSON.stringify(answer));
    });
  });
  return new Promise<void>((resolve) => lines.on("close", () => void chain.then(resolve)));
}

/**
 * The stdio bridge (plan 4.5): a client's `--mcp` becomes a pipe to the machine MCP's socket. It holds no daemon tokens, presents
 * the optional token, starts the MCP when nothing answers, and refuses an MCP of another protocol (M7).
 */
async function bridge(appConfig: string, namespace: string | undefined, protocol: number): Promise<number> {
  const paths = machinePaths(appConfigDirOf(appConfig), namespace);
  if (!(await ensureMachine(paths, () => spawnMachine(appConfig, namespace)))) {
    console.error(`alinery-mcp: the machine MCP did not start at ${paths.socket}`);
    return 1;
  }
  const token = currentToken(paths.key);
  let status: Record<string, unknown>;
  try {
    status = await ask(paths.socket, { op: "status" }, token);
  } catch (e) {
    console.error(`alinery-mcp: the machine MCP at ${paths.socket} did not answer (${(e as Error).message}); use Restart MCP in Alinery's Settings → Updates → Runtime`);
    return 1;
  }
  if (status.ok !== true) {
    console.error(`alinery-mcp: the machine MCP refused this bridge: ${String(status.error)}`);
    return 1;
  }
  if (status.protocol !== protocol) {
    console.error(`alinery-mcp: the machine MCP speaks protocol ${String(status.protocol)}, this bridge ${protocol}; use Restart MCP in Alinery's Settings → Updates → Runtime`);
    return 1;
  }
  const socket = connect(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // The auth answer is the bridge's, not the client's: swallow the first line, then pipe both ways.
  if (token) {
    socket.write(`${JSON.stringify({ op: "auth", token })}\n`);
    await new Promise<void>((resolve) => {
      let seen = "";
      const first = (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        const at = seen.indexOf("\n");
        if (at < 0) return;
        socket.off("data", first);
        const rest = seen.slice(at + 1);
        if (rest) process.stdout.write(rest);
        resolve();
      };
      socket.on("data", first);
    });
  }
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  return new Promise<number>((resolve) => {
    socket.on("close", () => resolve(0));
    process.stdin.on("end", () => socket.end());
  });
}

/** `alinery-vinculum-daemon --mcp`: the entry `main.ts` hands the command line to. Returns the exit code. */
export async function runMcp(args: string[], protocol: number, version = ""): Promise<number> {
  const appConfig = flagValue(args, "--app-config");
  const namespace = flagValue(args, "--socket-namespace");
  if (args.includes("--machine")) {
    if (!appConfig) {
      console.error("Usage: alinery-vinculum-daemon --mcp --machine --app-config /path/to/app.toml");
      return 2;
    }
    const idle = Number(flagValue(args, "--idle-ms"));
    return serveMachine({ paths: machinePaths(appConfigDirOf(appConfig), namespace), protocol, build: version, appConfig, idleMs: idle > 0 ? idle : undefined });
  }
  // Every client, a harness's included, goes through the machine MCP (docs/machine-mcp-plan.md P6). A config pasted before the bridge
  // (`--mcp --app-config … --endpoints-file …`) lands here too.
  if (appConfig) return bridge(appConfig, namespace, protocol);
  console.error("Usage: alinery-vinculum-daemon --mcp --bridge --app-config /path/to/app.toml [--socket-namespace NS]");
  return 2;
}

