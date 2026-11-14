/**
 * An in-memory harness for tests. A `Script` stands in for the agent: it
 * receives the launch, writes files, and calls `requestCompletion`.
 */
import type { CompletionReply, Harness, Launch, SessionId, SessionStatus } from '../src/harness.ts';

export type Script = (launch: Launch, session: FakeSession) => Promise<void>;

export interface FakeSession {
  id: SessionId;
  launch: Launch;
  status: SessionStatus;
  inbox: string[];
  /** Set by a script that is waiting for a message. */
  wake: (() => void) | null;
  runs: number;
}

export class FakeHarness implements Harness {
  readonly sessions = new Map<SessionId, FakeSession>();
  readonly launches: Launch[] = [];
  #script: Script;

  constructor(script: Script) {
    this.#script = script;
  }

  async start(launch: Launch): Promise<SessionId> {
    const id = `s${this.sessions.size + 1}`;
    const session: FakeSession = { id, launch, status: { kind: 'starting' }, inbox: [], wake: null, runs: 0 };
    this.sessions.set(id, session);
    this.launches.push(launch);
    setImmediate(() => this.#run(session)); // an agent never acts before the engine has its session id
    return id;
  }

  async resume(id: SessionId, launch: Launch): Promise<SessionId> {
    const session = this.#get(id);
    session.launch = launch;
    session.status = { kind: 'starting' }; // a durable harness reports the new life at once, not the old death
    setImmediate(() => this.#run(session));
    return id;
  }

  async status(id: SessionId): Promise<SessionStatus> {
    return this.sessions.get(id)?.status ?? { kind: 'unknown' };
  }

  async send(id: SessionId, text: string): Promise<void> {
    const session = this.#get(id);
    session.inbox.push(text);
    session.wake?.();
  }

  async stop(id: SessionId): Promise<void> {
    this.#get(id).status = { kind: 'exited', exitCode: 0 };
  }

  /** Test helper: the process dies. */
  crash(id: SessionId, reason = 'crashed'): void {
    this.#get(id).status = { kind: 'failed', reason };
  }

  #run(session: FakeSession): void {
    session.runs++;
    session.status = { kind: 'running' };
    this.#script(session.launch, session).then(
      () => {
        if (session.status.kind === 'running') session.status = { kind: 'idle' };
      },
      (err: unknown) => {
        session.status = { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
      },
    );
  }

  #get(id: SessionId): FakeSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no session ${id}`);
    return s;
  }
}

/** Script helper: request completion; if the gate is closed, go idle until a message arrives, then try again. */
export async function complete(launch: Launch, session: FakeSession): Promise<CompletionReply> {
  for (;;) {
    const reply = await launch.requestCompletion();
    if (reply.kind === 'accepted') return reply;
    if (reply.kind === 'rejected') throw new Error(reply.problems.join('; '));
    session.status = { kind: 'idle' };
    await new Promise<void>((resolve) => {
      session.wake = resolve;
    });
    session.wake = null;
    session.status = { kind: 'running' };
  }
}
