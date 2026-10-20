/**
 * The scheduler: a pure function from (playbook, state) to the executions that
 * may now be reserved. This is the transition relation → of the paper made
 * concrete: which operations have an admissible input set available.
 *
 * It decides only eligibility. Capacity, coding exclusivity and launching are
 * the engine's job. Nothing here reads the filesystem or the clock.
 *
 * Binding rule
 * ------------
 * The paper describes companion inputs by outcome: a request must bind the
 * review it was derived from, not the newest review. We get that from
 * provenance alone, using which executions read which occurrences:
 *
 *   1. A candidate for a slot is an available occurrence matching it, or for
 *      a `complete` slot a closed nonempty collection.
 *   2. The trigger is the most downstream candidate: nothing in another slot
 *      descends from it. For a step with a collection input only the
 *      collection triggers; `single` slots are companions.
 *   3. For each companion slot, candidates downstream of the trigger are
 *      excluded (they are their own triggers). If any remaining candidate is
 *      upstream of the trigger or shares its producer, only those count.
 *   4. A candidate is shadowed by another of the same role that descends from
 *      it: a newer loop pass supersedes the pass it grew from.
 *   5. Zero candidates: wait. More than one: record an ambiguity and bind
 *      nothing. Exactly one: bind, unless it is unrelated to the trigger and
 *      does not itself resolve back to this trigger alone, which would join two
 *      independent families by position.
 *   6. A binding already recorded is never reserved twice.
 *
 * Cost
 * ----
 * Two things keep a tick proportional to new work rather than to history.
 * A trigger that already has a bound execution is final (every occurrence
 * upstream of it existed before it did, so its companions cannot change) and
 * is skipped before any resolution. And "is execution P upstream of Q" is one
 * bit test against Q's ancestor bitset, built once per execution and kept in
 * a SchedulerCache across ticks. Neither changes a result; an empty cache
 * recomputes the same answers.
 */
import { collectionInput, type Input, matches, overlaps, type Playbook, type Step } from './playbook.ts';
import { type Ambiguity, available, isDone, type Occurrence, occurrences, type State } from './state.ts';

export interface Reservation {
  step: string;
  inputs: Record<string, string[]>;
  depth: number;
  origin: string | null;
}

/** A `complete` collection that exists but may not be consumed yet, and why. For people, not for the engine. */
export interface Blocked {
  step: string;
  selector: string;
  reason: string;
}

export interface Schedule {
  reservations: Reservation[];
  ambiguities: Ambiguity[];
  blocked: Blocked[];
}

/**
 * Derived facts that never change once an execution is reserved. Safe to keep
 * for the life of an engine and safe to throw away: it only saves work.
 */
export class SchedulerCache {
  /** Execution id → dense index in reservation order. Ancestors always have smaller indices. */
  readonly index = new Map<string, number>();
  /** Execution id → bitset over indices of its ancestors, itself included. Memory is E²/16 bytes in the worst case. */
  readonly ancestors = new Map<string, Uint32Array>();
}

/** A candidate binding for one slot: one occurrence, or one closed collection. */
interface Cand {
  key: string;
  ids: string[];
  producers: Set<string | null>;
}

type Pick = { kind: 'one'; cand: Cand } | { kind: 'none' } | { kind: 'many'; cands: Cand[] };

export function schedule(pb: Playbook, state: State, cache = new SchedulerCache()): Schedule {
  const out: Schedule = { reservations: [], ambiguities: [], blocked: [] };
  const occs = available(state);
  const byId = new Map(occurrences(state).map((o) => [o.id, o]));
  const exec = (id: string | null) => (id === null ? undefined : state.executions.get(id));
  const stepOf = new Map(pb.steps.map((s) => [s.key, s]));

  // ---- ancestry as bitsets ---------------------------------------------------
  for (const id of state.executions.keys()) if (!cache.index.has(id)) cache.index.set(id, cache.index.size);
  const ancestorBits = (execId: string): Uint32Array => {
    let bits = cache.ancestors.get(execId);
    if (bits) return bits;
    const i = cache.index.get(execId)!;
    bits = new Uint32Array((i >> 5) + 1);
    bits[i >> 5] |= 1 << (i & 31);
    for (const id of Object.values(state.executions.get(execId)!.inputs).flat()) {
      const producer = byId.get(id)?.producer;
      if (!producer) continue;
      const parent = ancestorBits(producer);
      for (let w = 0; w < parent.length; w++) bits[w] |= parent[w];
    }
    cache.ancestors.set(execId, bits);
    return bits;
  };
  /** Is execution `p` upstream of execution `q`, or `q` itself? */
  const isAncestor = (p: string, q: string): boolean => {
    const i = cache.index.get(p)!;
    const bits = ancestorBits(q);
    return i >> 5 < bits.length && ((bits[i >> 5] >>> (i & 31)) & 1) === 1;
  };
  /** Does any member of the candidate descend from execution `p`? */
  const descendsFrom = (c: Cand, p: string): boolean =>
    c.ids.some((id) => {
      const producer = byId.get(id)!.producer;
      return producer !== null && isAncestor(p, producer);
    });

  const isDownstream = (c: Cand, of: Cand) => [...of.producers].some((p) => p !== null && !c.producers.has(p) && descendsFrom(c, p));
  /** Seeds are upstream of everything. */
  const isUpstreamOrSibling = (c: Cand, of: Cand) => c.producers.has(null) || [...c.producers].some((p) => p !== null && descendsFrom(of, p));
  const shadows = (newer: Cand, older: Cand) =>
    newer !== older &&
    (older.producers.has(null) ? !newer.producers.has(null) : [...older.producers].some((p) => p !== null && !newer.producers.has(p) && descendsFrom(newer, p)));

  // Occurrences an execution read, transitively. Used only for source coverage of a closing collection.
  const readMemo = new Map<string, Set<string>>();
  const readBy = (execId: string): Set<string> => {
    let set = readMemo.get(execId);
    if (set) return set;
    set = new Set();
    readMemo.set(execId, set);
    for (const id of Object.values(state.executions.get(execId)!.inputs).flat()) {
      set.add(id);
      const producer = byId.get(id)?.producer;
      if (producer) for (const x of readBy(producer)) set.add(x);
    }
    return set;
  };

  // ---- what is already bound ---------------------------------------------------
  const groupOf = (m: Occurrence) => exec(m.producer)?.origin ?? m.producer ?? 'seed';
  const collectionKey = (slot: Input, origin: string) => `${slot.path}@${origin}`;
  const bound = new Set<string>();
  const boundTriggers = new Set<string>();
  for (const e of state.executions.values()) {
    bound.add(bindingKey(e.step, e.inputs));
    for (const slot of stepOf.get(e.step)!.inputs) {
      const ids = e.inputs[slot.path];
      if (!ids?.length) continue;
      const key = slot.mode === 'complete' ? collectionKey(slot, groupOf(byId.get(ids[0])!)) : ids[0];
      boundTriggers.add(`${e.step} ${slot.path} ${key}`);
    }
  }
  const isBoundTrigger = (step: Step, slot: Input, key: string) => boundTriggers.has(`${step.key} ${slot.path} ${key}`);
  const reported = new Set(state.ambiguities.map(ambiguityKey));

  const single = (o: Occurrence): Cand => ({ key: o.id, ids: [o.id], producers: new Set([o.producer]) });
  const candMemo = new Map<string, Cand[]>();
  const candidatesFor = (step: Step, slot: Input): Cand[] => {
    const key = `${step.key} ${slot.path}`;
    let cands = candMemo.get(key);
    if (!cands) {
      cands = slot.mode === 'complete' ? closedCollections(step, slot) : occs.filter((o) => matches(slot.path, o.role)).map(single);
      candMemo.set(key, cands);
    }
    return cands;
  };

  /** Rules 3 to 5 for one companion slot, seen from `from`. */
  const pick = (step: Step, slot: Input, from: Cand): Pick => {
    let cands = candidatesFor(step, slot).filter((c) => !isDownstream(c, from));
    const related = cands.filter((c) => isUpstreamOrSibling(c, from));
    if (related.length) cands = related;
    cands = cands.filter((c) => !cands.some((c2) => shadows(c2, c)));
    if (cands.length === 1) return { kind: 'one', cand: cands[0] };
    return cands.length === 0 ? { kind: 'none' } : { kind: 'many', cands };
  };

  for (const step of pb.steps) {
    // A step with no inputs runs exactly once, at the start.
    if (step.inputs.length === 0) {
      if (!bound.has(bindingKey(step.key, {}))) out.reservations.push({ step: step.key, inputs: {}, depth: 1, origin: null });
      continue;
    }

    const collection = collectionInput(step);
    const triggerSlots = collection ? [collection] : step.inputs;
    for (const slot of triggerSlots) {
      const others = step.inputs.filter((i) => i !== slot);
      for (const trigger of candidatesFor(step, slot)) {
        if (isBoundTrigger(step, slot, trigger.key)) continue; // final: see "Cost" above
        if (others.some((k) => candidatesFor(step, k).some((c) => isDownstream(c, trigger)))) continue; // not the most downstream element

        const inputs: Record<string, string[]> = { [slot.path]: trigger.ids };
        let complete = true;
        for (const k of others) {
          const p = pick(step, k, trigger);
          if (p.kind === 'many') {
            const a: Ambiguity = { step: step.key, slot: k.path, trigger: trigger.key, candidates: p.cands.map((c) => c.key) };
            if (!reported.has(ambiguityKey(a))) {
              reported.add(ambiguityKey(a));
              out.ambiguities.push(a);
            }
          }
          if (p.kind !== 'one') {
            complete = false;
            break;
          }
          if (!isUpstreamOrSibling(p.cand, trigger)) {
            const back = pick(step, slot, p.cand);
            if (back.kind !== 'one' || back.cand.key !== trigger.key) {
              complete = false;
              break;
            }
          }
          inputs[k.path] = p.cand.ids;
        }
        if (!complete) continue;

        const key = bindingKey(step.key, inputs);
        if (bound.has(key)) continue;
        bound.add(key);
        const depth = 1 + Math.max(0, ...Object.values(inputs).flat().map((id) => exec(byId.get(id)!.producer)?.depth ?? 0));
        out.reservations.push({ step: step.key, inputs, depth, origin: originFor(slot, trigger) });
      }
    }
  }
  return out;

  /** Which fan-out the new execution belongs to. See Execution.origin. */
  function originFor(slot: Input, trigger: Cand): string | null {
    if (slot.mode === 'complete') return null; // a merge stands outside the fan-out it consumed
    const producer = [...trigger.producers][0]; // single and each triggers have exactly one
    const parent = exec(producer);
    if (parent?.origin) return parent.origin; // already inside a fan-out: inherit it
    return slot.mode === 'each' ? (producer ?? 'seed') : null; // a family's publisher roots a new fan-out
  }

  /**
   * Nonempty collections for a `complete` slot whose every expected
   * contributor has finished. Members are grouped by fan-out origin, so two
   * loop passes never merge into one collection.
   */
  function closedCollections(step: Step, slot: Input): Cand[] {
    const groups = new Map<string, Occurrence[]>();
    for (const m of occs.filter((o) => matches(slot.path, o.role))) {
      const g = groupOf(m);
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    const result: Cand[] = [];
    for (const [origin, members] of groups) {
      const cand: Cand = { key: collectionKey(slot, origin), ids: members.map((m) => m.id), producers: new Set(members.map((m) => m.producer)) };
      // Closure is final: a collection bound once stays closed, and its membership cannot grow.
      if (isBoundTrigger(step, slot, cand.key)) {
        result.push(cand);
        continue;
      }
      // Published directly by the root (or seeds): closed as soon as it is available.
      const direct = members.every((m) => !exec(m.producer)?.origin);
      if (!direct) {
        const producingSteps = pb.steps.filter((s) => s.outputs.some((o) => overlaps(o.path, slot.path)));
        const workers = [...state.executions.values()].filter((e) => e.origin === origin && producingSteps.some((s) => s.key === e.step));
        const pending = workers.filter((w) => !isDone(w));
        if (pending.length) {
          out.blocked.push({ step: step.key, selector: slot.path, reason: `waiting for ${pending.map((w) => `${w.step} ${w.id} (${w.status})`).join(', ')}` });
          continue;
        }
        // Every source member that fed this fan-out must be represented by a
        // finished producer. An omitted intermediate does not prune the branch.
        const rootReceipt = origin === 'seed' ? state.seeds : (exec(origin)?.receipt ?? []);
        const feeders = pb.steps.filter((s) => s.inputs.some((i) => i.mode === 'each') && producingSteps.some((p) => reaches(pb, s, p)));
        const sources = rootReceipt.filter((m) => feeders.some((s) => matches(collectionInput(s)!.path, m.role)));
        const uncovered = sources.filter((src) => !workers.some((w) => readBy(w.id).has(src.id)));
        if (uncovered.length) {
          out.blocked.push({ step: step.key, selector: slot.path, reason: `no ${producingSteps.map((s) => s.key).join('/')} execution represents ${uncovered.map((s) => s.role).join(', ')}` });
          continue;
        }
      }
      result.push(cand);
    }
    return result;
  }
}

/** Static reachability in the playbook graph: can `from`'s outputs lead to `to`'s inputs? */
function reaches(pb: Playbook, from: Step, to: Step, seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from.key)) return false;
  seen.add(from.key);
  return pb.steps.some((next) => from.outputs.some((o) => next.inputs.some((i) => overlaps(o.path, i.path))) && reaches(pb, next, to, seen));
}

function bindingKey(step: string, inputs: Record<string, string[]>): string {
  const slots = Object.keys(inputs)
    .sort()
    .map((k) => [k, [...inputs[k]].sort()]);
  return `${step} ${JSON.stringify(slots)}`;
}

function ambiguityKey(a: Ambiguity): string {
  return `${a.step} ${a.slot} ${a.trigger}`;
}
