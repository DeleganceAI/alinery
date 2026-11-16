// Which daemon answers for which repository. The machine MCP holds the daemons that registered with it (`machine.ts`, M8), each with
// the token it minted for this MCP; every caller reaches all of them, and the handoff is everyone's (M2). `own` is one daemon's
// endpoint, the seam a test uses to call a daemon in process.
import type { Endpoint } from "./client.ts";

const trimmed = (path: string) => path.replace(/\/+$/, "");

export class Endpoints {
  constructor(
    private readonly own?: { repo: string; endpoint: Endpoint },
    private readonly registered?: () => Record<string, Endpoint>,
  ) {}

  /** True for the machine MCP, which reaches every registered daemon and so may run `alinery_send_review_handoff`. */
  get spansRepos(): boolean {
    return this.registered !== undefined;
  }

  /** The repositories registered daemons serve, which a machine MCP may name besides the app's known list. */
  repos(): string[] {
    return Object.keys(this.registered?.() ?? {});
  }

  /** The endpoint for a repository, or undefined when this MCP has no token for its daemon. */
  forRepo(repo: string): Endpoint | undefined {
    const wanted = trimmed(repo);
    for (const [path, endpoint] of Object.entries(this.registered?.() ?? {})) if (trimmed(path) === wanted && endpoint.socket && endpoint.token) return endpoint;
    return this.own && trimmed(this.own.repo) === wanted ? this.own.endpoint : undefined;
  }
}
