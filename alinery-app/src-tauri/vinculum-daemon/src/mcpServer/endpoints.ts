// Which daemon answers for which repository (plan S5.1, O20 c). An MCP a daemon launched for a harness holds one endpoint, its own
// (`ALINERY_RPC_SOCKET` and `ALINERY_RPC_TOKEN` in its environment, put there by `mcp.ts`). The shell's managed MCP is for every
// repository the app has open: the shell mints one AGENT token per daemon and keeps them in an owner-only file this reads again on
// each call, so a repository opened or a daemon restarted after the MCP started is found without restarting it.
import { readFileSync } from "node:fs";
import type { Endpoint } from "./client.ts";

export type EndpointFile = { version: 1; repos: Record<string, Endpoint> };

const trimmed = (path: string) => path.replace(/\/+$/, "");

export class Endpoints {
  constructor(
    private readonly own: { repo: string; endpoint: Endpoint } | undefined,
    private readonly file: string | undefined,
    private readonly handoff: boolean = file !== undefined,
  ) {}

  /** O22 (a): `alinery_send_review_handoff` reaches two daemons, so only the shell's managed MCP offers it; a host's stdio MCP reading the same file does not. */
  get offersHandoff(): boolean {
    return this.handoff;
  }

  /** True for the shell's managed MCP, the only one that holds a token for more than its own daemon (O22 a). */
  get spansRepos(): boolean {
    return this.file !== undefined;
  }

  private fromFile(): Record<string, Endpoint> {
    if (!this.file) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<EndpointFile>;
      return parsed.version === 1 && parsed.repos && typeof parsed.repos === "object" ? parsed.repos : {};
    } catch {
      return {};
    }
  }

  /** The endpoint for a repository, or undefined when this MCP has no token for its daemon. The file wins: it is the newer. */
  forRepo(repo: string): Endpoint | undefined {
    const wanted = trimmed(repo);
    for (const [path, endpoint] of Object.entries(this.fromFile())) if (trimmed(path) === wanted && endpoint.socket && endpoint.token) return endpoint;
    return this.own && trimmed(this.own.repo) === wanted ? this.own.endpoint : undefined;
  }
}
