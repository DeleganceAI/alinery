/**
 * Durable execution state as a fold over an append-only event log.
 *
 * The paper's abstract state is the set of available artifact filenames. The
 * engine needs more: which execution produced each artifact occurrence, which
 * occurrences each execution read, and where each execution is in its life.
 * All of that is derived here from events, so the log is both the persistence
 * format and the inspectable "path to a result" the paper promises.
 *
 * One JSON object per line in `execution.jsonl`. Replaying the file rebuilds
 * the state exactly; a torn final line (crash mid-write) is dropped.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

/**
 * One accepted publication. Two occurrences with the same role and identical
 * bytes are still distinct: scheduling works on occurrences, never filenames.
 */
export interface Occurrence {
  /** `<producer>/<role>`, or `seed/<role>` for initial task inputs. */
  id: string;
  /** Logical role, e.g. `assessment.md` or `source-request-003.md`. Selectors match this. */
  role: string;
  /** Absolute physical path. Presentation; never used for scheduling. */
  path: string;
  /** Execution id that published it, or null for a seed. */
  producer: string | null;
}

export type ExecutionStatus =
  /** Inputs bound and outputs assigned; waiting for capacity or a coding slot. The queue. */
  | 'reserved'
  /** A session exists. Ask the harness whether it is starting, running or idle. */
  | 'live'
  /** Outputs accepted; waiting for confirmed process exit before successors may use them. */
  | 'finishing'
  /** Accepted and exited. Its publications are available. Terminal. */
  | 'done'
  /** Needs a human: launch failed, process lost, exited without completing, or shutdown failed. */
  | 'failed';

export interface Execution {
  id: string;
  step: string;
  /** 1 + max depth of producing executions; seeds are depth 0. Presentation only. */
  depth: number;
  /** Input slot (role or selector) to the occurrence ids bound to it. The binding is the identity of this execution. */
  inputs: Record<string, string[]>;
  /** Directory assigned for this execution's outputs. */
  outDir: string;
  /**
   * Fan-out root this execution belongs to: the execution that published the
   * wildcard family whose members started the `each` workers. Null outside any
   * fan-out. Groups collection members for `complete` inputs.
   */
  origin: string | null;
  status: ExecutionStatus;
  sessionId: string | null;
  /** Human granted permission to finish this particular execution. Reset on resume. */
  permitted: boolean;
  /** Immutable publication set. Set once on acceptance; later files never join it. */
  receipt: Occurrence[] | null;
  failure: string | null;
}

/** A step whose companion inputs cannot be resolved without guessing. Recorded, never resolved by the engine. */
export interface Ambiguity {
  step: string;
  /** The input slot with competing candidates. */
  slot: string;
  /** The occurrence or collection that would have started the execution. */
  trigger: string;
  candidates: string[];
}

export interface State {
  seeds: Occurrence[];
  /** Insertion order is reservation order, which is also launch priority. */
  executions: Map<string, Execution>;
  ambiguities: Ambiguity[];
}

export type Event =
  | { t: 'seeded'; occurrences: Occurrence[] }
  | { t: 'reserved'; execution: Pick<Execution, 'id' | 'step' | 'depth' | 'inputs' | 'outDir' | 'origin'> }
  | { t: 'started'; execId: string; sessionId: string }
  | { t: 'resumed'; execId: string; sessionId: string }
  | { t: 'permitted'; execId: string }
  | { t: 'accepted'; execId: string; published: Occurrence[] }
  | { t: 'exited'; execId: string }
  | { t: 'failed'; execId: string; reason: string }
  | { t: 'ambiguity'; ambiguity: Ambiguity };

export function emptyState(): State {
  return { seeds: [], executions: new Map(), ambiguities: [] };
}

/** Apply one event. Mutates `state` in place; deterministic, so replay is exact. Repeated terminal events are ignored. */
export function apply(state: State, ev: Event): void {
  const e = 'execId' in ev ? state.executions.get(ev.execId) : undefined;
  switch (ev.t) {
    case 'seeded':
      state.seeds.push(...ev.occurrences);
      return;
    case 'reserved':
      state.executions.set(ev.execution.id, { ...ev.execution, status: 'reserved', sessionId: null, permitted: false, receipt: null, failure: null });
      return;
    case 'started':
    case 'resumed':
      if (!e) return;
      e.sessionId = ev.sessionId;
      e.status = 'live';
      e.failure = null;
      if (ev.t === 'resumed') e.permitted = false; // permission belonged to the previous owner
      return;
    case 'permitted':
      if (e) e.permitted = true;
      return;
    case 'accepted':
      if (!e || e.receipt) return;
      e.receipt = ev.published;
      e.status = 'finishing';
      return;
    case 'exited':
      if (!e || e.status === 'done') return;
      if (e.receipt) {
        e.status = 'done';
        e.failure = null;
      } else if (e.status !== 'failed') {
        e.status = 'failed';
        e.failure = 'exited without completing';
      }
      return;
    case 'failed':
      if (!e || e.status === 'done') return;
      e.status = 'failed';
      e.failure = ev.reason;
      return;
    case 'ambiguity': {
      const a = ev.ambiguity;
      if (!state.ambiguities.some((x) => x.step === a.step && x.slot === a.slot && x.trigger === a.trigger)) state.ambiguities.push(a);
      return;
    }
  }
}

export function fold(events: Iterable<Event>): State {
  const s = emptyState();
  for (const ev of events) apply(s, ev);
  return s;
}

export function isDone(e: Execution): boolean {
  return e.status === 'done';
}

/** Every occurrence ever recorded, seeds first, then receipts in reservation order. */
export function occurrences(state: State): Occurrence[] {
  const out = [...state.seeds];
  for (const e of state.executions.values()) if (e.receipt) out.push(...e.receipt);
  return out;
}

/** Occurrences the paper's state s contains: seeds, plus publications whose producer has exited. */
export function available(state: State): Occurrence[] {
  return occurrences(state).filter((o) => o.producer === null || isDone(state.executions.get(o.producer)!));
}

export function readLog(path: string): Event[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter((l) => l !== '');
  const out: Event[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      out.push(JSON.parse(line));
    } catch {
      if (i === lines.length - 1) break; // torn final write: the event never happened
      throw new Error(`${path}:${i + 1}: corrupt event log line`);
    }
  }
  return out;
}

export function appendLog(path: string, ev: Event): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, `${JSON.stringify(ev)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
