import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { McpState, McpStatusSchema, McpTokenAction, type McpService } from "alinery-proto/alinery/v1/mcp_pb";
import { clearToken, type MachineLink, type McpStatus, rotateToken } from "../domain/machineMcp.ts";
import { currentToken } from "../mcpServer/machine.ts";
import { requireCapability } from "./auth.ts";
import { domain } from "./errors.ts";

const STATE = { absent: McpState.ABSENT, ok: McpState.OK, behind: McpState.BEHIND, stuck: McpState.STUCK } as const;

const toProto = (s: McpStatus) =>
  create(McpStatusSchema, {
    state: STATE[s.state],
    build: s.build,
    protocol: s.protocol,
    uptimeMs: BigInt(s.uptimeMs),
    clients: s.clients,
    daemons: s.daemons,
    socketPath: s.socket,
    tokenRequired: s.tokenRequired,
  });

/** ADMIN only and absent from AGENT_RPCS: the app's view of the machine MCP, never an agent's. */
export function mcpService(link: MachineLink, keyPath: string): ServiceImpl<typeof McpService> {
  return {
    status: async (_req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return { status: toProto(await link.status()) };
    },
    ensure: async (_req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return { status: toProto(await link.ensure()) };
    },
    restart: async (_req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return { status: toProto(await link.restart()) };
    },
    token: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return domain(() => {
        if (req.action === McpTokenAction.ROTATE) return { token: rotateToken(keyPath) };
        if (req.action === McpTokenAction.CLEAR) clearToken(keyPath);
        return { token: currentToken(keyPath) ?? "" };
      });
    },
  };
}
