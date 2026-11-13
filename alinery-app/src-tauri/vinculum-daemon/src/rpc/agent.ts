// AgentService (plan S4.10, O12 a): the host's agent directory. The directory is the one beside the app config this daemon was
// started with, so a remote repository's host has its own, and a session on that host loads that one. The scans and writes are
// `domain/agentDir.ts`. Writes are serialized with each other (two installs of one skill must not interleave their staging).
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { Code, type ServiceImpl } from "@connectrpc/connect";
import type { AgentService } from "alinery-proto/alinery/v1/agent_pb";
import { customizationPrompt, customizationsFromDir, deleteSkill, installSkill, readModelRoles, writeModelRoles } from "../domain/agentDir.ts";
import type { BlobStore } from "../domain/blobs.ts";
import { OFFICE_TOOLS, whichOn } from "../agentShell.ts";
import { vinculumAgentDir } from "../skills.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

export type AgentDeps = {
  appConfig: string;
  blobs: BlobStore;
  /** The live MCP-hub state: the built-in tools and each server connection (`McpHub.refresh`). */
  mcp?: { refresh(): Promise<{ tools: string[]; servers: { name: string; builtin: boolean; state: string; error?: string }[] }> };
  /** The agent shell's PATH and its bundled Python, if any (`agentShell.ts`). */
  shell?: { path: string; python?: string };
};

export function agentService(d: AgentDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof AgentService> {
  const agentDir = () => vinculumAgentDir(d.appConfig);
  const applied = () => ({ cursor: store.cursor() });
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(f: () => Promise<T> | T): Promise<T> => {
    const run = tail.catch(() => {}).then(f);
    tail = run;
    return run;
  };
  return {
    readModelRoles: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => ({ roles: readModelRoles(agentDir()), agentDir: agentDir() }));
    },
    writeModelRoles: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(() =>
          serialized(() => {
            writeModelRoles(agentDir(), req.roles);
            return { applied: applied(), roles: req.roles };
          }),
        ),
      );
    },
    readCustomizations: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => {
        const inv = customizationsFromDir(agentDir());
        return { items: inv.items.map((i) => ({ ...i, path: i.path ?? undefined })), errors: inv.errors, agentDir: agentDir() };
      });
    },
    readMcpStatus: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(async () => {
        if (!d.mcp) throw fail(Code.Unimplemented, "unimplemented", "this daemon runs no MCP hub");
        const status = await d.mcp.refresh();
        return { tools: status.tools, servers: status.servers.map((s) => ({ name: s.name, builtin: s.builtin, state: s.state, error: s.error })) };
      });
    },
    readOfficeTools: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      const path = d.shell?.path ?? process.env.PATH ?? "";
      const tools = OFFICE_TOOLS.map((name) => ({ name, path: whichOn(name, path) ?? "" }));
      const python = tools.find((tool) => tool.name === "python3")?.path ?? "";
      return { tools, bundledPython: !!d.shell?.python && python.startsWith(`${d.shell.python}/`) };
    },
    installSkill: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(() =>
          serialized(async () => {
            const staged = d.blobs.staged(req.uploadId);
            if (!staged) throw fail(Code.InvalidArgument, "invalid_argument", "the skill was not uploaded");
            try {
              const done = await installSkill(agentDir(), staged.path, req.fileName || staged.name, req.replace);
              return { applied: applied(), ...done };
            } finally {
              d.blobs.release(req.uploadId);
            }
          }),
        ),
      );
    },
    deleteSkill: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        domain(() =>
          serialized(() => {
            deleteSkill(agentDir(), req.name);
            return { applied: applied() };
          }),
        ),
      );
    },
    customizationPrompt: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return domain(() => ({ prompt: customizationPrompt(d.appConfig, agentDir()) }));
    },
  };
}
