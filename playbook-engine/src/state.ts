/**
 * Durable execution state: a value the engine changes by applying events and saves whole.
 *
 * The paper's abstract state is the set of available artifact filenames. The
 * engine needs more: which execution produced each artifact occurrence, which
 * occurrences each execution read, and where each execution is in its life.
 * `apply` derives all of that from events. The host stores the State itself
 * (`stateToJson`), not the events, so the stored copy is the truth and a restart
 * loads it as is.
 *
 * The event log of earlier builds (`engine.jsonl`, one JSON object per line) is
 * only read once, by `readLog` and `fold`, to convert a task that has no stored
 * State yet. A torn final line (crash mid-write) is dropped.
 */
import { readFileSync } from 'node:fs';

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

/** One file a step consumed or published, as it was when the step read or finished it. */
export interface FileRecord {
  /** The occurrence this file was. */
  occurrence: string;
  role: string;
  /** Where the live file was. Presentation; the bytes are in `objects/` under `sha256`. */
  path: string;
  /** Absent when the file could not be read at that moment. */
  sha256?: string;
  size?: number;
}

/** What one execution consumed and published (O27). The bytes live in the execution's `objects/` directory. */
export interface Manifest {
  consumed: FileRecord[];
  published: FileRecord[];
  /** A step that produced a worktree: the tree, kept alive under `ref`. */
  worktree?: { ref: string; tree: string };
}

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
   * The innermost fan-out this execution belongs to: the execution that published the
   * wildcard family whose members started the `each` workers. Null outside any
   * fan-out. A nested fan-out's root has its own origin, so the outer ones are found by
   * following it. Groups collection members for `complete` inputs.
   */
  origin: string | null;
  status: ExecutionStatus;
  sessionId: string | null;
  /**
   * Whether this execution may finish without a person, snapshotted when it was reserved.
   * Absent on a log written before the snapshot: the playbook default still applies.
   * A later edit of the task set does not change it.
   */
  automatic?: boolean;
  /** Human granted permission to finish this particular execution. Reset on resume. */
  permitted: boolean;
  /** Immutable publication set. Set once on acceptance; later files never join it. */
  receipt: Occurrence[] | null;
  failure: string | null;
  /** Failed, but the harness could not confirm the process stopped: it still holds capacity and the worktree until exit is confirmed. */
  unconfirmed?: boolean;
  /** Set when the execution first starts, extended when it is accepted. Absent before then and on a state converted from an old log. */
  manifest?: Manifest;
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
  | { t: 'reserved'; execution: Pick<Execution, 'id' | 'step' | 'depth' | 'inputs' | 'outDir' | 'origin' | 'automatic'> }
  | { t: 'started'; execId: string; sessionId: string; consumed?: FileRecord[] }
  | { t: 'resumed'; execId: string; sessionId: string; consumed?: FileRecord[] }
  | { t: 'permitted'; execId: string }
  | { t: 'accepted'; execId: string; published: Occurrence[]; files?: FileRecord[]; worktree?: { ref: string; tree: string } }
  | { t: 'exited'; execId: string }
  | { t: 'failed'; execId: string; reason: string; unconfirmed?: boolean }
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
      if (ev.consumed && !e.manifest) e.manifest = { consumed: ev.consumed, published: [] };
      e.status = 'live';
      e.failure = null;
      delete e.unconfirmed;
      if (ev.t === 'resumed') e.permitted = false; // permission belonged to the previous owner
      return;
    case 'permitted':
      if (e) e.permitted = true;
      return;
    case 'accepted':
      if (!e || e.receipt) return;
      e.receipt = ev.published;
      if (ev.files || ev.worktree) {
        const m = (e.manifest ??= { consumed: [], published: [] });
        m.published = ev.files ?? [];
        if (ev.worktree) m.worktree = ev.worktree;
      }
      e.status = 'finishing';
      return;
    case 'exited':
      if (!e || e.status === 'done') return;
      delete e.unconfirmed;
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
      if (ev.unconfirmed) e.unconfirmed = true;
      else delete e.unconfirmed;
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

/** The stored form: executions as an array, so reservation order survives. */
export interface StateJson {
  seeds: Occurrence[];
  executions: Execution[];
  ambiguities: Ambiguity[];
}

export function stateToJson(state: State): StateJson {
  return { seeds: state.seeds, executions: [...state.executions.values()], ambiguities: state.ambiguities };
}

export function stateFromJson(json: StateJson): State {
  return { seeds: json.seeds ?? [], executions: new Map((json.executions ?? []).map((e) => [e.id, e])), ambiguities: json.ambiguities ?? [] };
}
