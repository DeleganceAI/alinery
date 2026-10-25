import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** Must match `OMP_ENV_ALLOWLIST` in alinery-core. A stdio MCP child gets only these, then its own env. */
const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE", "SSH_AUTH_SOCK", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "alinery_phase_complete", "alinery_set_session_name"];
const MISSING_BINARY = "bundled alinery-mcp was not found";
const COULD_NOT_START = "could not start";
const OAUTH = "OAuth is not supported";
const COULD_NOT_LIST = "could not list tools";
const BAD_DEFINITION = "an MCP server definition must be an object";

export type McpServerReport = { name: string; builtin: boolean; state: "connected" | "disabled" | "error"; error?: string };
export type CustomizationsReply = { tools: string[]; servers: McpServerReport[] };

type InstalledExtension = ReturnType<typeof defineExtension>;
type ToolRegistry = {
  install(extension: InstalledExtension): void;
  uninstall(extension: InstalledExtension): void;
};

type StdioSpec = { kind: "stdio"; command: string; args: string[]; cwd: string; env: Record<string, string> };
type HttpSpec = { kind: "http"; url: string; headers: Record<string, string> };
type Desired = { name: string; builtin: boolean; state: "disabled" | "error" | "start"; error?: string; spec?: StdioSpec | HttpSpec; key: string };

type Endpoint = {
  list(): Promise<{ name: string; description: string; inputSchema: unknown }[]>;
  call(name: string, args: unknown): Promise<{ text: string; isError: boolean }>;
  close(): void;
  alive(): boolean;
};

type Live = { key: string; extension: InstalledExtension; endpoint: Endpoint; report: McpServerReport };

export function resolveAlineryMcp(execPath: string, here = import.meta.dir): string | null {
  const dirs = [dirname(execPath), join(here, "..", "..", "target", "debug")];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const exact = names.find((name) => name === "alinery-mcp");
    const prefixed = names.find((name) => name.startsWith("alinery-mcp-"));
    const found = exact ?? prefixed;
    if (!found) continue;
    const path = join(dir, found);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export class McpHub {
  private live = new Map<string, Live>();
  private tail: Promise<CustomizationsReply> = Promise.resolve({ tools: BUILTIN_TOOLS, servers: [] });

  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: { repo: string; appConfig: string; agentDir: string; resolveBuiltin?: () => string | null },
  ) {}

  refresh(): Promise<CustomizationsReply> {
    const run = this.tail.then(() => this.refreshInner(), () => this.refreshInner());
    this.tail = run;
    return run;
  }

  close() {
    for (const row of this.live.values()) row.endpoint.close();
    this.live.clear();
  }

  private async refreshInner(): Promise<CustomizationsReply> {
    const desired = desiredServers(this.options);
    const keep = new Set<string>();
    for (const server of desired) {
      const current = this.live.get(server.name);
      if (server.state !== "start" || !server.spec) {
        this.drop(server.name);
        continue;
      }
      if (current && current.key === server.key && current.endpoint.alive()) {
        keep.add(server.name);
        continue;
      }
      this.drop(server.name);
      const started = await startServer(server.name, server.spec);
      if ("error" in started) {
        server.state = "error";
        server.error = started.error;
        continue;
      }
      const extension = mcpExtension(server.name, started.tools, started.endpoint);
      this.registry.install(extension);
      this.live.set(server.name, {
        key: server.key,
        extension,
        endpoint: started.endpoint,
        report: { name: server.name, builtin: server.builtin, state: "connected" },
      });
      keep.add(server.name);
    }
    for (const name of [...this.live.keys()]) {
      if (!keep.has(name)) this.drop(name);
    }
    const servers = desired.map((server) => this.live.get(server.name)?.report ?? { name: server.name, builtin: server.builtin, state: server.state === "start" ? "error" : server.state, error: server.error });
    return { tools: BUILTIN_TOOLS, servers };
  }

  private drop(name: string) {
    const row = this.live.get(name);
    if (!row) return;
    row.endpoint.close();
    this.registry.uninstall(row.extension);
    this.live.delete(name);
  }
}

function desiredServers(options: { repo: string; appConfig: string; agentDir: string; resolveBuiltin?: () => string | null }): Desired[] {
  const builtinPath = (options.resolveBuiltin ?? (() => resolveAlineryMcp(process.execPath)))();
  const builtin: Desired = builtinPath
    ? {
        name: "alinery",
        builtin: true,
        state: "start",
        key: `builtin:${builtinPath}`,
        spec: { kind: "stdio", command: builtinPath, args: ["--app-config", options.appConfig, "--repo", options.repo], cwd: options.repo, env: {} },
      }
    : { name: "alinery", builtin: true, state: "error", error: MISSING_BINARY, key: "builtin:missing" };
  return [builtin, ...readUserServers(options.agentDir, options.repo)];
}

function readUserServers(agentDir: string, repo: string): Desired[] {
  const byName = new Map<string, Desired>();
  for (const fileName of ["mcp.json", ".mcp.json"]) {
    const path = join(agentDir, fileName);
    let parsed: unknown;
    try {
      if (!existsSync(path)) continue;
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const servers = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { mcpServers?: unknown }).mcpServers : undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
    for (const [name, definition] of Object.entries(servers)) {
      if (name === "alinery") continue;
      byName.set(name, userServer(name, definition, repo));
    }
  }
  return [...byName.values()];
}

function userServer(name: string, definition: unknown, repo: string): Desired {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return { name, builtin: false, state: "error", error: BAD_DEFINITION, key: `${name}:bad` };
  }
  const record = definition as Record<string, unknown>;
  if (record.enabled === false) return { name, builtin: false, state: "disabled", key: `${name}:disabled` };
  if ("oauth" in record) return { name, builtin: false, state: "error", error: OAUTH, key: `${name}:oauth` };
  if (typeof record.url === "string" && record.url) {
    const headers = stringMap(record.headers);
    const spec: HttpSpec = { kind: "http", url: record.url, headers };
    return { name, builtin: false, state: "start", spec, key: `http:${name}:${record.url}:${JSON.stringify(headers)}` };
  }
  if (typeof record.command === "string" && record.command) {
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [];
    const cwdValue = typeof record.cwd === "string" && record.cwd ? record.cwd : repo;
    const cwd = isAbsolute(cwdValue) ? cwdValue : join(repo, cwdValue);
    const env = stringMap(record.env);
    const spec: StdioSpec = { kind: "stdio", command: record.command, args, cwd, env };
    return { name, builtin: false, state: "start", spec, key: `stdio:${name}:${record.command}:${JSON.stringify(args)}:${cwd}:${JSON.stringify(env)}` };
  }
  return { name, builtin: false, state: "error", error: COULD_NOT_START, key: `${name}:empty` };
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

async function startServer(_name: string, spec: StdioSpec | HttpSpec): Promise<{ endpoint: Endpoint; tools: { name: string; description: string; inputSchema: unknown }[] } | { error: string }> {
  const endpoint = spec.kind === "stdio" ? spawnStdio(spec) : openHttp(spec);
  try {
    const tools = await endpoint.list();
    return { endpoint, tools };
  } catch (error) {
    endpoint.close();
    const message = error instanceof Error ? error.message : "";
    if (message === OAUTH || message === COULD_NOT_LIST) return { error: message };
    return { error: COULD_NOT_START };
  }
}

function mcpExtension(name: string, tools: { name: string; description: string; inputSchema: unknown }[], endpoint: Endpoint) {
  return defineExtension({
    name: `mcp:${name}`,
    tools: tools.map((tool) =>
      defineTool({
        name: `mcp__${name}__${tool.name}`,
        description: tool.description || tool.name,
        parameters: toolParameters(tool.inputSchema),
        execute: async (args) => {
          try {
            const result = await endpoint.call(tool.name, args);
            return { output: [{ type: "text" as const, text: result.text }], isError: result.isError };
          } catch {
            return { output: [{ type: "text" as const, text: "tool call failed" }], isError: true };
          }
        },
      }),
    ),
  });
}

function toolParameters(schema: unknown): TSchema {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    const unsafe = (Type as { Unsafe?: (value: unknown) => TSchema }).Unsafe;
    if (unsafe) return unsafe(schema);
  }
  return Type.Object({});
}

function allowlistedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function spawnStdio(spec: StdioSpec): Endpoint {
  const proc = Bun.spawn([spec.command, ...spec.args], {
    cwd: spec.cwd,
    env: allowlistedEnv(spec.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let buffer = "";
  let failed = false;
  const fail = (error: Error) => {
    failed = true;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const pump = async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line.trim()) continue;
          let message: { id?: unknown; result?: unknown; error?: unknown };
          try {
            message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
          } catch {
            continue;
          }
          if (typeof message.id !== "number") continue;
          const waiter = pending.get(message.id);
          if (!waiter) continue;
          pending.delete(message.id);
          if (message.error) waiter.reject(new Error(COULD_NOT_LIST));
          else waiter.resolve(message.result);
        }
      }
    } catch {
      /* closed */
    }
    fail(new Error(COULD_NOT_START));
  };
  void pump();
  const request = (method: string, params: unknown, notify = false) => {
    if (failed || proc.exitCode !== null) return Promise.reject(new Error(COULD_NOT_START));
    const id = nextId++;
    const body = notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
    proc.stdin.write(`${JSON.stringify(body)}\n`);
    if (notify) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(COULD_NOT_START));
      }, 10000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  };
  const endpoint: Endpoint = {
    alive: () => !failed && proc.exitCode === null,
    close: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    async list() {
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "alinery-vinculum", version: "1" } });
      await request("notifications/initialized", {}, true);
      const result = (await request("tools/list", {})) as { tools?: unknown };
      if (!result || !Array.isArray(result.tools)) throw new Error(COULD_NOT_LIST);
      return result.tools.flatMap((tool) => {
        if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") return [];
        const record = tool as { name: string; description?: unknown; inputSchema?: unknown };
        return [{ name: record.name, description: typeof record.description === "string" ? record.description : record.name, inputSchema: record.inputSchema ?? { type: "object" } }];
      });
    },
    async call(tool, args) {
      const result = (await request("tools/call", { name: tool, arguments: args ?? {} })) as { content?: unknown; isError?: unknown };
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .filter(Boolean)
        .join("\n");
      return { text, isError: result?.isError === true };
    },
  };
  return endpoint;
}

function openHttp(spec: HttpSpec): Endpoint {
  const session: { id?: string } = {};
  let closed = false;
  let nextId = 1;
  const post = async (method: string, params: unknown, notify = false) => {
    const id = notify ? undefined : nextId++;
    if (closed) throw new Error(COULD_NOT_START);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...spec.headers };
    if (session.id) headers["mcp-session-id"] = session.id;
    const body = JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
    const response = await fetch(spec.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10000) });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) session.id = sessionId;
    if (response.status === 401 || response.status === 403) throw new Error(OAUTH);
    if (id === undefined) return undefined;
    if (!response.ok) throw new Error(COULD_NOT_START);
    const text = await response.text();
    const message = response.headers.get("content-type")?.includes("text/event-stream") ? sseResult(text) : (JSON.parse(text) as { result?: unknown; error?: unknown });
    if (!message || message.error) throw new Error(COULD_NOT_LIST);
    return message.result;
  };
  return {
    alive: () => !closed,
    close: () => {
      closed = true;
    },
    async list() {
      await post("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "alinery-vinculum", version: "1" } });
      await post("notifications/initialized", {}, true);
      const result = (await post("tools/list", {})) as { tools?: unknown };
      if (!result || !Array.isArray(result.tools)) throw new Error(COULD_NOT_LIST);
      return result.tools.flatMap((tool) => {
        if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") return [];
        const record = tool as { name: string; description?: unknown; inputSchema?: unknown };
        return [{ name: record.name, description: typeof record.description === "string" ? record.description : record.name, inputSchema: record.inputSchema ?? { type: "object" } }];
      });
    },
    async call(tool, args) {
      const result = (await post("tools/call", { name: tool, arguments: args ?? {} })) as { content?: unknown; isError?: unknown };
      const content = Array.isArray(result?.content) ? result.content : [];
      const text = content
        .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      return { text, isError: result?.isError === true };
    },
  };
}

function sseResult(text: string): { result?: unknown; error?: unknown } | undefined {
  let last: { result?: unknown; error?: unknown } | undefined;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      last = JSON.parse(line.slice(5).trim()) as { result?: unknown; error?: unknown };
    } catch {
      /* ignore a non-json event */
    }
  }
  return last;
}
