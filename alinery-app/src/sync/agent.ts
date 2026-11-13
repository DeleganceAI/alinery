// The host's agent directory (plan S4.10, O12 a): model roles, the customization inventory, skill install and delete, and the prompt
// for an outside AI. The directory is the daemon's on every host, so a repository on another machine shows and edits that machine's.
// Which daemon: the repository a call names; with none, the active repository, else the first local one the app knows. What stays on
// this machine is the Finder window and the file picker (`ipc`); a picked skill reaches the daemon as a staged upload.
import { createClient } from "@connectrpc/connect";
import { AgentService } from "alinery-proto/alinery/v1/agent_pb";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import { isRemoteRepo } from "../remoteRepo";
import type { SkillInstall, VinculumCustomizations, VinculumDaemonCustomizations } from "../types";
import { agentHost, call } from "./hostCall";
import { newMutationMeta } from "./mutation";
import { upload } from "./tasks";

export { agentHost };

const agent = (host: string) => createClient(AgentService, daemonTransport(host));

/** True when the directory is on this machine, so the Finder can show it. */
export const agentDirIsLocal = (host: string) => !isRemoteRepo(host);

export async function readModelRoles(repo?: string): Promise<Record<string, string>> {
  const host = await agentHost(repo);
  return { ...(await call(() => agent(host).readModelRoles({}))).roles };
}

/** Replaces the whole set (roles left out are removed) and returns what the daemon stored. */
export async function writeModelRoles(roles: Record<string, string>, repo?: string): Promise<Record<string, string>> {
  const host = await agentHost(repo);
  return { ...(await call(() => agent(host).writeModelRoles({ meta: newMutationMeta(), roles }))).roles };
}

export async function readCustomizations(repo?: string): Promise<VinculumCustomizations> {
  const host = await agentHost(repo);
  const reply = await call(() => agent(host).readCustomizations({}));
  return {
    items: reply.items.map((item) => ({
      name: item.name,
      kind: item.kind,
      source: item.source,
      path: item.path ?? null,
      ...(item.offered === undefined ? {} : { offered: item.offered }),
    })),
    errors: reply.errors,
  };
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Installs the `.md` or `.zip` at a local path into the host's agent directory. `exists` means nothing was written and `replace` would. */
export async function installSkill(path: string, replace: boolean, repo?: string): Promise<SkillInstall> {
  const host = await agentHost(repo);
  const fileName = baseName(path);
  const bytes = new Uint8Array(await ipc.readLocalFile(path));
  const staged = await upload(host, { kind: "staged" }, fileName, bytes);
  const reply = await call(() => agent(host).installSkill({ meta: newMutationMeta(), uploadId: staged.uploadId, fileName, replace }));
  return { name: reply.name, exists: reply.exists };
}

export async function deleteSkill(name: string, repo?: string): Promise<void> {
  const host = await agentHost(repo);
  await call(() => agent(host).deleteSkill({ meta: newMutationMeta(), name }));
}

export async function customizationPrompt(repo?: string): Promise<string> {
  const host = await agentHost(repo);
  return (await call(() => agent(host).customizationPrompt({}))).prompt;
}

/** The agent's built-in tools and the state of each MCP server connection, as the host's daemon reports them. */
export async function readMcpStatus(repo?: string): Promise<VinculumDaemonCustomizations> {
  const host = await agentHost(repo);
  const reply = await call(() => agent(host).readMcpStatus({}));
  return { tools: reply.tools, servers: reply.servers.map((s) => ({ name: s.name, builtin: s.builtin, state: s.state, ...(s.error === undefined ? {} : { error: s.error }) })) };
}

export type OfficeTools = { tools: { name: string; path: string }[]; bundledPython: boolean };

/** What the office skills can run on the repository's host, as its daemon finds it on the agent's PATH. */
export async function readOfficeTools(repo?: string): Promise<OfficeTools> {
  const host = await agentHost(repo);
  const reply = await call(() => agent(host).readOfficeTools({}));
  return { tools: reply.tools.map((t) => ({ name: t.name, path: t.path })), bundledPython: reply.bundledPython };
}
