// MCP's connection to one daemon (plan S5.1, O10 b, O20 c): the generated gRPC client over the daemon's unix socket with a minted
// AGENT token. It reads with a one-shot subscription (the WA: no unary read RPC exists for MCP) and never calls `Shutdown`, so a
// protocol mismatch ends the call and touches nothing (`check-no-auto-session-kill.sh` scans this folder).
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Client } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { type MutationMeta, MutationMetaSchema, ErrorDetailSchema } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, JobState, type Job } from "alinery-proto/alinery/v1/entities_pb";
import { ScopeSchema, SyncService } from "alinery-proto/alinery/v1/sync_pb";
import type { DescService } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";

export type Endpoint = { socket: string; token: string };

/** A failure whose text is the whole answer: the tool replies `error: <message>`. */
export class ToolError extends Error {}

/** What a ConnectError says without Connect's own `[code]` prefix. */
export const reason = (e: unknown): string => (e instanceof ConnectError ? e.rawMessage : e instanceof Error ? e.message : String(e));

/** The tagged library error a playbook refusal carries as JSON (`ErrorDetail.fields.error`), when it has one. */
export function taggedError(e: unknown): string | undefined {
  if (!(e instanceof ConnectError)) return undefined;
  for (const detail of e.findDetails(ErrorDetailSchema)) if (detail.fields.error) return detail.fields.error;
  return undefined;
}

const CLIENT_ID = `mcp-${process.pid}`;
export const newMeta = (): MutationMeta => create(MutationMetaSchema, { clientId: CLIENT_ID, mutationId: randomUUID() });

type Scope = MessageInitShape<typeof ScopeSchema>;
const TERMINAL = new Set([JobState.DONE, JobState.FAILED, JobState.CANCELLED]);

export class DaemonConnection {
  private readonly transport;
  private readonly clients = new Map<DescService, unknown>();
  private checked = false;

  constructor(
    private readonly endpoint: Endpoint,
    private readonly protocol: number,
  ) {
    this.transport = createGrpcTransport({
      baseUrl: "http://daemon",
      nodeOptions: { createConnection: () => connect(endpoint.socket) } as never,
      interceptors: [
        (next) => (req) => {
          req.header.set("authorization", `Bearer ${endpoint.token}`);
          return next(req);
        },
      ],
    });
  }

  /** The service's client. Every call runs after `ready()` has found a daemon of this build's protocol. */
  api<S extends DescService>(service: S): Client<S> {
    let client = this.clients.get(service);
    if (!client) this.clients.set(service, (client = createClient(service, this.transport)));
    return client as Client<S>;
  }

  /** The same texts the Rust client gave: unreachable, and a daemon of another protocol (which is left running). */
  async ready(): Promise<void> {
    if (this.checked) return;
    let hello;
    try {
      hello = await this.api(AdminService).hello({ clientId: CLIENT_ID, clientKind: "mcp", protocol: this.protocol });
    } catch (e) {
      if (e instanceof ConnectError && e.code === Code.Unauthenticated) throw new ToolError(`daemon at ${this.endpoint.socket} refused this MCP's token: ${e.rawMessage}`);
      throw new ToolError(`daemon at ${this.endpoint.socket} is unreachable: ${reason(e)}`);
    }
    if (hello.protocol !== this.protocol) throw new ToolError(`repo-protocol-mismatch: daemon speaks protocol ${hello.protocol}, client speaks ${this.protocol}`);
    this.checked = true;
  }

  /** Every entity a scope holds now: the snapshot frames up to the one marked complete, then the stream is cancelled. */
  async read(scope: Scope): Promise<Entity[]> {
    await this.ready();
    const abort = new AbortController();
    const entities: Entity[] = [];
    try {
      for await (const response of this.api(SyncService).subscribe({ scope }, { signal: abort.signal })) {
        const frame = response.frame;
        if (frame.case === "mustRefetch") throw new ToolError(`the daemon could not answer the read: ${frame.value.reason}`);
        if (frame.case !== "snapshot") continue;
        entities.push(...frame.value.entities);
        if (frame.value.complete) break;
      }
    } finally {
      abort.abort();
    }
    return entities;
  }

  /** Waits for a job the daemon runs, by watching the board scope until its row has ended. */
  async job(id: string): Promise<Job> {
    await this.ready();
    const abort = new AbortController();
    const mine = (e: Entity): Job | undefined => (e.value.case === "job" && e.value.value.id === id ? e.value.value : undefined);
    try {
      for await (const response of this.api(SyncService).subscribe({ scope: { kind: { case: "repo", value: {} } } }, { signal: abort.signal })) {
        const frame = response.frame;
        const rows = frame.case === "snapshot" ? frame.value.entities : frame.case === "delta" ? frame.value.changes.flatMap((c) => (c.op.case === "put" ? [c.op.value] : [])) : [];
        for (const row of rows) {
          const job = mine(row);
          if (job && TERMINAL.has(job.state)) return job;
        }
        if (frame.case === "mustRefetch") throw new ToolError(`the daemon could not follow the job: ${frame.value.reason}`);
      }
    } finally {
      abort.abort();
    }
    throw new ToolError("the daemon closed the stream before the job ended");
  }
}
