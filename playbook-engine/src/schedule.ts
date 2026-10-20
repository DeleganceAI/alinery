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

/** A candidate binding for one slot: one occurrence, or one closed collection. */
interface Cand {
  key: string;
  ids: string[];
  producers: Set<string | null>;
}

type Pick = { kind: 'one'; cand: Cand } | { kind: 'none' } | { kind: 'many'; cands: Cand[] };

export function schedule(pb: Playbook, state: State): Schedule {
  const out: Schedule = { reservations: [], ambiguities: [], blocked: [] };
  const occs = available(state);
  const byId = new Map(occurrences(state).map((o) => [o.id, o]));
  const exec = (id: string | null) => (id === null ? undefined : state.executions.get(id));

  // Executions upstream of an execution, itself included.
  const ancMemo = new Map<string, Set<string>>();
  const ancestors = (execId: string): Set<string> => {
    let set = ancMemo.get(execId);
    if (set) return set;
    set = new Set([execId]);
    ancMemo.set(execId, set);
    for (const id of Object.values(state.executions.get(execId)!.inputs).flat()) {
      const producer = byId.get(id)?.producer;
      if (producer) for (const x of ancestors(producer)) set.add(x);
    }
    return set;
  };

  // Occurrences an execution read, transitively. Used for source coverage.
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

  // Executions upstream of a candidate, its producers included.
  const candAnc = new Map<string, Set<string>>();
  const anc = (c: Cand): Set<string> => {
    let set = candAnc.get(c.key);
    if (set) return set;
    set = new Set();
    candAnc.set(c.key, set);
    for (const id of c.ids) {
      const producer = byId.get(id)!.producer;
      if (producer) for (const x of ancestors(producer)) set.add(x);
    }
    return set;
  };

  const isDownstream = (c: Cand, of: Cand) => [...of.producers].some((p) => p !== null && !c.producers.has(p) && anc(c).has(p));
  /** Seeds are upstream of everything. */
  const isUpstreamOrSibling = (c: Cand, of: Cand) => c.producers.has(null) || [...c.producers].some((p) => p !== null && anc(of).has(p));
  const shadows = (newer: Cand, older: Cand) =>
    newer !== older &&
    (older.producers.has(null) ? !newer.producers.has(null) : [...older.producers].some((p) => p !== null && !newer.producers.has(p) && anc(newer).has(p)));

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

  const bound = new Set([...state.executions.values()].map((e) => bindingKey(e.step, e.inputs)));
  const reported = new Set(state.ambiguities.map(ambiguityKey));

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
      const g = exec(m.producer)?.origin ?? m.producer ?? 'seed';
      groups.set(g, [...(groups.get(g) ?? []), m]);
    }
    const result: Cand[] = [];
    for (const [origin, members] of groups) {
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
      result.push({ key: `${slot.path}@${origin}`, ids: members.map((m) => m.id), producers: new Set(members.map((m) => m.producer)) });
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
