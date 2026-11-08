// The MCP server itself: JSON-RPC over stdio, or over a unix socket the app's managed child serves (plan S5.1, O10 b). It replaces the Rust
// `alinery-mcp` binary's two modes; the tools are in `handlers.ts` and every one of them is a call on the daemon.
import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writeAtomic } from "../platform/fs.ts";
import { callTool, type Context } from "./handlers.ts";
import { Endpoints } from "./endpoints.ts";
import { TOOLS } from "./tools.ts";

type Json = Record<string, unknown>;

const REMOTE_MSG = "This repo appears to be remote (ssh). MCP currently supports read-only discovery of remote repos only. Full operations require the Alinery desktop app or future remote daemon support.";
const PROCESS_SCOPED = "(MCP resource URIs are process-scoped)";

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** `mcp_socket_path` and `mcp_status_path`: `.alinery/mcp[-<namespace>].sock` and `.status.json`, the namespace cut to what a file name may hold. */
export function mcpPaths(repo: string, namespace: string | undefined) {
  const clean = (namespace ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  const stem = clean ? `mcp-${clean}` : "mcp";
  return { socket: join(repo, ".alinery", `${stem}.sock`), status: join(repo, ".alinery", `${stem}.status.json`) };
}

export function contextFrom(args: string[], protocol: number, env: Record<string, string | undefined> = process.env): Context {
  const repo = flagValue(args, "--repo");
  const socket = env.ALINERY_RPC_SOCKET;
  const token = env.ALINERY_RPC_TOKEN;
  return {
    protocol,
    processRepo: repo,
    appConfig: flagValue(args, "--app-config"),
    endpoints: new Endpoints(repo && socket && token ? { repo, endpoint: { socket, token } } : undefined, flagValue(args, "--endpoints-file"), args.includes("--managed")),
  };
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
function serveLines(input: NodeJS.ReadableStream, write: (line: string) => void, ctx: Context, onLine?: (req: Json) => boolean) {
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

/** The lane's runtime sidecar (`mcp.status.json`), as the daemon's own socket and lock are: a process marker, not repository state. */
function writeStatus(path: string, clients: number) {
  try {
    writeAtomic(path, JSON.stringify({ pid: process.pid, clients }));
  } catch {
    /* the app reads the count best-effort */
  }
}

const unlinkQuiet = (path: string) => {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
};

async function serveSocket(ctx: Context, args: string[]): Promise<number> {
  const repo = ctx.processRepo;
  if (!repo) {
    console.error("Usage: alinery-vinculum-daemon --mcp --serve --repo /path/to/repo");
    return 2;
  }
  const { socket, status } = mcpPaths(repo, flagValue(args, "--socket-namespace"));
  unlinkQuiet(socket);
  unlinkQuiet(status);
  let clients = 0;
  const server = createServer((connection: Socket) => {
    let counted = false;
    const drop = () => {
      if (counted) writeStatus(status, --clients);
      counted = false;
    };
    connection.on("error", drop);
    void serveLines(
      connection,
      (line) => connection.writable && connection.write(`${line}\n`),
      ctx,
      (req) => {
        if (!counted) {
          counted = true;
          writeStatus(status, ++clients);
        }
        // Reap: an orphaned listener is asked to leave by the process that answers its socket, never killed by a pid read from a file.
        if (req.op !== "exit") return false;
        connection.write(`${JSON.stringify({ ok: true })}\n`, () => {
          unlinkQuiet(socket);
          unlinkQuiet(status);
          process.exit(0);
        });
        return true;
      },
    ).then(drop);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  console.error(`serve: listening on ${socket}`);
  writeStatus(status, 0);
  if (args.includes("--managed")) {
    // The app that started this child holds its stdin; when the app goes, so does the listener.
    process.stdin.resume();
    process.stdin.on("end", () => {
      unlinkQuiet(socket);
      unlinkQuiet(status);
      process.exit(0);
    });
  }
  return new Promise<number>(() => {});
}

/** `alinery-vinculum-daemon --mcp`: the entry `main.ts` hands the command line to. Returns the exit code. */
export async function runMcp(args: string[], protocol: number): Promise<number> {
  const ctx = contextFrom(args, protocol);
  if (args.includes("--serve")) return serveSocket(ctx, args);
  console.error(`alinery-mcp starting (stdio); --repo=${ctx.processRepo ?? "none"} (repo is a per-call tool argument)`);
  await serveLines(process.stdin, (line) => process.stdout.write(`${line}\n`), ctx);
  return 0;
}

