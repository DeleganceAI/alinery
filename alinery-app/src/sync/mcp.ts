// The machine MCP's status, restart and optional token (docs/machine-mcp-plan.md 4.4), through any daemon on its machine. McpService is
// ADMIN and not an agent RPC, so only the app calls it. Force restart is not here: it signals a process, so it is the shell's (`ipc`).
import { createClient } from "@connectrpc/connect";
import { McpService, McpState, type McpStatus, McpTokenAction } from "alinery-proto/alinery/v1/mcp_pb";
import { daemonTransport } from "../daemon/transport";
import { call } from "./hostCall";

export { McpState, type McpStatus };

const mcp = (repo: string) => createClient(McpService, daemonTransport(repo));
const status = (reply: { status?: McpStatus }) => {
  if (!reply.status) throw new Error("the daemon sent no MCP status");
  return reply.status;
};

export const machineMcpStatus = async (repo: string) => status(await call(() => mcp(repo).status({})));
export const restartMachineMcp = async (repo: string) => status(await call(() => mcp(repo).restart({})));

const ACTION = { read: McpTokenAction.READ, rotate: McpTokenAction.ROTATE, clear: McpTokenAction.CLEAR } as const;
/** The current token after the action, empty when none is set. */
export const machineMcpToken = async (repo: string, action: keyof typeof ACTION) => (await call(() => mcp(repo).token({ action: ACTION[action] }))).token;
