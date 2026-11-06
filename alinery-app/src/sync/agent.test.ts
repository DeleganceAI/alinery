import { Code, ConnectError, type ServiceImpl, type Transport } from "@connectrpc/connect";
import type { AgentService } from "alinery-proto/alinery/v1/agent_pb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { cursor, daemonHarness } from "../test/daemonHarness";
import { agentDirIsLocal, agentHost, customizationPrompt, deleteSkill, installSkill, readCustomizations, readMcpStatus, readModelRoles, writeModelRoles } from "./agent";
import { NoLibraryHost } from "./playbooks";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
const ipcMocks = vi.hoisted(() => ({ readAppConfig: vi.fn(), readLocalFile: vi.fn() }));
vi.mock("../ipc", () => ipcMocks);
const uploads = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("./tasks", () => uploads);

beforeEach(() => {
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "alinery+ssh://box/srv/r", known_repos: ["alinery+ssh://box/srv/r", "/b"] });
});
afterEach(() => vi.resetAllMocks());

function serve(agent: Partial<ServiceImpl<typeof AgentService>>) {
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ agent }).transport as Transport);
}

it("asks the repository named, else the active one, else the first local one", async () => {
  expect(await agentHost("/named")).toBe("/named");
  expect(await agentHost()).toBe("alinery+ssh://box/srv/r");
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "", known_repos: ["alinery+ssh://box/srv/r", "/b"] });
  expect(await agentHost()).toBe("/b");
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "", known_repos: ["alinery+ssh://box/srv/r"] });
  await expect(agentHost()).rejects.toBeInstanceOf(NoLibraryHost);
  expect(agentDirIsLocal("/b")).toBe(true);
  expect(agentDirIsLocal("alinery+ssh://box/srv/r")).toBe(false);
});

it("reads and replaces the model roles on the host's daemon, as the whole set", async () => {
  const sent: Record<string, string>[] = [];
  serve({
    readModelRoles: () => ({ roles: { default: "p/a" }, agentDir: "/cfg/agent" }),
    writeModelRoles: (request) => {
      sent.push({ ...request.roles });
      return { applied: { cursor: cursor(1) }, roles: request.roles } as never;
    },
  });
  expect(await readModelRoles("/a")).toEqual({ default: "p/a" });
  expect(await writeModelRoles({ smol: "p/b" }, "/a")).toEqual({ smol: "p/b" });
  expect(sent).toEqual([{ smol: "p/b" }]);
  expect(vi.mocked(daemonTransport)).toHaveBeenCalledWith("/a");
});

it("maps the inventory, leaving an unset 'offered' unset", async () => {
  serve({
    readCustomizations: () =>
      ({
        items: [
          { name: "ponytail", kind: "Skill", source: "user", path: "/cfg/agent/skills/ponytail/SKILL.md", offered: false },
          { name: "ext", kind: "Extension", source: "user" },
        ],
        errors: ["bad mcp.json"],
        agentDir: "/cfg/agent",
      }) as never,
  });
  expect(await readCustomizations("/a")).toEqual({
    items: [
      { name: "ponytail", kind: "Skill", source: "user", path: "/cfg/agent/skills/ponytail/SKILL.md", offered: false },
      { name: "ext", kind: "Extension", source: "user", path: null },
    ],
    errors: ["bad mcp.json"],
  });
});

it("installs a picked file by staging its bytes with the host's daemon and naming the upload", async () => {
  const seen: { uploadId: string; fileName: string; replace: boolean }[] = [];
  ipcMocks.readLocalFile.mockResolvedValue(new TextEncoder().encode("# skill").buffer);
  uploads.upload.mockResolvedValue({ name: "demo.md", uploadId: "up-1" });
  serve({
    installSkill: (request) => {
      seen.push({ uploadId: request.uploadId, fileName: request.fileName, replace: request.replace });
      return { applied: { cursor: cursor(1) }, name: "demo", exists: !request.replace } as never;
    },
  });
  expect(await installSkill("/Users/me/Downloads/demo.md", false, "/a")).toEqual({ name: "demo", exists: true });
  expect(await installSkill("/Users/me/Downloads/demo.md", true, "/a")).toEqual({ name: "demo", exists: false });
  expect(uploads.upload).toHaveBeenCalledWith("/a", { kind: "staged" }, "demo.md", expect.any(Uint8Array));
  expect(seen).toEqual([
    { uploadId: "up-1", fileName: "demo.md", replace: false },
    { uploadId: "up-1", fileName: "demo.md", replace: true },
  ]);
});

it("deletes a skill by name and reads the prompt from the daemon", async () => {
  const names: string[] = [];
  serve({
    deleteSkill: (request) => {
      names.push(request.name);
      return { applied: { cursor: cursor(1) } } as never;
    },
    customizationPrompt: () => ({ prompt: "Inspect this installation." }),
  });
  await deleteSkill("ponytail", "/a");
  expect(names).toEqual(["ponytail"]);
  expect(await customizationPrompt("/a")).toBe("Inspect this installation.");
});

it("a refusal reads as the daemon's own message", async () => {
  serve({
    deleteSkill: () => {
      throw new ConnectError("skill name is not valid", Code.InvalidArgument);
    },
  });
  await expect(deleteSkill("../x", "/a")).rejects.toThrow("skill name is not valid");
});

it("maps the MCP status of the host's daemon, leaving an absent error absent", async () => {
  serve({
    readMcpStatus: () => ({
      tools: ["read", "alinery_phase_complete"],
      servers: [
        { name: "alinery", builtin: true, state: "connected" },
        { name: "linear", builtin: false, state: "error", error: "spawn failed" },
      ],
    }),
  });
  expect(await readMcpStatus("/a")).toEqual({
    tools: ["read", "alinery_phase_complete"],
    servers: [
      { name: "alinery", builtin: true, state: "connected" },
      { name: "linear", builtin: false, state: "error", error: "spawn failed" },
    ],
  });
  expect(vi.mocked(daemonTransport)).toHaveBeenCalledWith("/a");
});
