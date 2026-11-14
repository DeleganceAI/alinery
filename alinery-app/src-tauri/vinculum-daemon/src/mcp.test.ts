import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, test } from "bun:test";
import { McpHub } from "./mcp.ts";

const SERVER = `let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
    }
  }
});
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alinery-mcp-"));
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  const script = join(root, "server.js");
  writeFileSync(script, SERVER);
  const binary = join(root, "alinery-mcp");
  writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  chmodSync(binary, 0o755);
  return { root, agent, binary, script };
}

describe("mcp hub", () => {
  test("registers mcp__server__tool and ignores a user server named alinery", async () => {
    const { root, agent, binary } = fixture();
    const touched = join(root, "touched");
    writeFileSync(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          alinery: { command: "/bin/sh", args: ["-c", `echo ran > ${JSON.stringify(touched)}`] },
          demo: { command: process.execPath, args: [join(root, "server.js")] },
        },
      }),
    );
    const registry = createRegistry();
    const hub = new McpHub(registry, { repo: root, appConfig: join(root, "app.toml"), agentDir: agent, resolveBuiltin: () => binary });
    const reply = await hub.refresh();
    hub.close();
    const names = registry.snapshot().tools().map((entry) => entry.tool.name);
    expect(names).toContain("mcp__alinery__ping");
    expect(names).toContain("mcp__demo__ping");
    expect(reply.servers.find((server) => server.name === "alinery")?.builtin).toBe(true);
    expect(reply.servers.find((server) => server.name === "alinery")?.state).toBe("connected");
    expect(reply.tools).toContain("read");
    expect(reply.tools).toContain("alinery_set_session_name");
    let ran = false;
    try {
      readFileSync(touched);
      ran = true;
    } catch {
      ran = false;
    }
    expect(ran).toBe(false);
  });

  test("a server that exits immediately leaves the other installed", async () => {
    const { root, agent, binary } = fixture();
    writeFileSync(
      join(agent, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          good: { command: process.execPath, args: [join(root, "server.js")] },
          bad: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        },
      }),
    );
    const registry = createRegistry();
    const hub = new McpHub(registry, { repo: root, appConfig: join(root, "app.toml"), agentDir: agent, resolveBuiltin: () => binary });
    const reply = await hub.refresh();
    const names = registry.snapshot().tools().map((entry) => entry.tool.name);
    expect(names).toContain("mcp__good__ping");
    expect(names.some((name) => name.startsWith("mcp__bad__"))).toBe(false);
    expect(reply.servers.find((server) => server.name === "bad")?.state).toBe("error");
    hub.close();
  });
});
