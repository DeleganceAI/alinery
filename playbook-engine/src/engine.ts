/**
 * The Playbook engine. One instance per task: one playbook, one event log,
 * one artifacts directory, one harness.
 *
 * What it does, in the paper's terms: it holds the current artifact state,
 * reserves an execution for every operation whose inputs are admissible and
 * available, launches those executions through the harness within the task's
 * capacity and coding-exclusivity rules, accepts their publications, and
 * extends the state only after the producing process has confirmed exit.
 *
 * What it refuses to do: retry, pick a "latest" file, guess a companion
 * pairing, prune a branch because an intermediate is missing, or start a
 * replacement session on its own. All of those are human decisions, exposed
 * as explicit methods.
 *
 * Lifecycle of one execution:
 *
 *   reserved ──start──▶ live ──requestCompletion──▶ finishing ──exit──▶ done
 *      │                 │                                                 ▲
 *      │ launch failed   │ crash / lost / exited early       confirmEx.    │
 *      ▼                 ▼                                                 │
 *    failed ◀────────────┘  ──resume (human)──▶ live       failed ────────┘
 *
 * Call `tick()` on a timer. Each tick observes sessions, requests shutdown of
 * accepted ones, reserves newly eligible work, and launches what capacity
 * allows. Everything durable goes through the log; in-memory state is a replay.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectOutputs } from './accept.ts';
import type { CompletionReply, Harness, Launch } from './harness.ts';
import { type Playbook, type Step, validatePlaybook } from './playbook.ts';
import { type Blocked, schedule, SchedulerCache } from './schedule.ts';
import { type Ambiguity, appendLog, apply, type Event, type Execution, fold, type Occurrence, occurrences, readLog, type State } from './state.ts';

export interface EngineOptions {
  playbook: Playbook;
  harness: Harness;
  /** Append-only JSONL event log for this task. Created on first write. */
  logPath: string;
  /** Parent of every execution's output directory. */
  artifactsDir: string;
  /** Agent working directory: the task's repo checkout or worktree. */
  cwd: string;
  /** Task-level live-session cap. Starting, running, idle and finishing sessions all count. Default 10. */
  maxLiveSessions?: number;
  /** Task-level human gate per step key. true = the agent may complete on its own. Defaults to each step's autoAdvanceDefault. */
  autoAdvance?: Record<string, boolean>;
  /** Values for `{{TICKET_FILE}}` and `{{PROMPT_EXTRA}}`. `{{ARTIFACTS_DIR}}` is each execution's own output directory. */
  tokens?: { TICKET_FILE?: string; PROMPT_EXTRA?: string };
}

const WRAP_UP = 'Permission to finish granted. Complete your writes, give a brief handoff, then call the completion tool once and finish without starting more work.';

export class Engine {
  readonly #opts: EngineOptions;
  readonly #cap: number;
  #state: State;
  /** Executions whose shutdown this process has already requested. Rebuilt lazily after restart; stop() is idempotent. */
  readonly #stopping = new Set<string>();
  /** Derived ancestry, kept across ticks. Purely an optimisation; see schedule.ts. */
  readonly #cache = new SchedulerCache();

  private constructor(opts: EngineOptions, state: State) {
    this.#opts = opts;
    this.#cap = opts.maxLiveSessions ?? 10;
    this.#state = state;
  }

  /** Validate the playbook and replay the log. Throws on an invalid definition: a task never runs a playbook the engine cannot honour. */
  static open(opts: EngineOptions): Engine {
    const problems = validatePlaybook(opts.playbook);
    if (problems.length) throw new Error(`invalid playbook: ${problems.map((p) => p.message).join('; ')}`);
    return new Engine(opts, fold(readLog(opts.logPath)));
  }

  get state(): State {
    return this.#state;
  }

  /** Initial artifacts, the paper's s0. Once per task. */
  seed(files: { role: string; path: string }[]): void {
    if (this.#state.seeds.length) throw new Error('task is already seeded');
    const seen = new Map<string, number>();
    this.#append({
      t: 'seeded',
      occurrences: files.map((f) => {
        const n = (seen.get(f.role) ?? 0) + 1;
        seen.set(f.role, n);
        return { id: n === 1 ? `seed/${f.role}` : `seed/${f.role}#${n}`, role: f.role, path: resolve(f.path), producer: null };
      }),
    });
  }

  /** One scheduling round. Safe to call as often as you like. */
  async tick(): Promise<void> {
    await this.#observe();
    this.#requestShutdowns();
    this.#reserve();
    await this.#launch();
  }

  /**
   * The agent's completion call. Validates the human gate and the assigned
   * outputs, records an immutable receipt, and returns the same receipt on
   * repeat. The session is asked to stop on the next tick, after the agent
   * has seen this reply.
   */
  async requestCompletion(execId: string): Promise<CompletionReply> {
    const e = this.#state.executions.get(execId);
    if (!e) return { kind: 'rejected', problems: [`unknown execution ${execId}`] };
    if (e.receipt) return { kind: 'accepted', published: e.receipt.map((o) => o.path) };
    if (e.status !== 'live') return { kind: 'rejected', problems: [`execution is ${e.status}, not live`] };
    if (!this.#permitted(e)) return { kind: 'permission-required' };
    const result = inspectOutputs(e.outDir, this.#step(e.step).outputs);
    if (!result.ok) return { kind: 'rejected', problems: result.problems };
    const published: Occurrence[] = result.published.map((p) => ({ id: `${e.id}/${p.role}`, role: p.role, path: p.path, producer: e.id }));
    this.#append({ t: 'accepted', execId: e.id, published });
    return { kind: 'accepted', published: published.map((o) => o.path) };
  }

  /** Human gate: allow this one execution to finish, and tell the agent so. */
  async permit(execId: string): Promise<void> {
    const e = this.#must(execId);
    if (e.status !== 'live' || !e.sessionId) throw new Error(`${execId} is ${e.status}; only a live execution can be permitted`);
    this.#append({ t: 'permitted', execId });
    await this.#opts.harness.send(e.sessionId, WRAP_UP);
  }

  /** Explicit recovery: continue a failed execution. Never called by the engine itself. Capacity and coding rules still apply. */
  async resume(execId: string): Promise<void> {
    const e = this.#must(execId);
    if (e.status !== 'failed') throw new Error(`${execId} is ${e.status}; only a failed execution can be resumed`);
    if (e.receipt) throw new Error(`${execId} already published; use confirmExited once its process has stopped`);
    const step = this.#step(e.step);
    if (this.#live().length >= this.#cap) throw new Error('task is at its live-session cap');
    if (step.isCodingStep && this.#codingHeld()) throw new Error('another coding execution holds the worktree');
    const launch = this.#launchFor(e, step);
    const sessionId = e.sessionId ? await this.#opts.harness.resume(e.sessionId, launch) : await this.#opts.harness.start(launch);
    this.#append({ t: 'resumed', execId, sessionId });
  }

  /** A human asserts that a session has stopped when the harness could not confirm it. */
  confirmExited(execId: string): void {
    const e = this.#must(execId);
    if (e.status === 'done' || e.status === 'reserved') throw new Error(`${execId} is ${e.status}`);
    this.#append({ t: 'exited', execId });
  }

  /** Why eligible-looking work is not running: unresolved ambiguities and collections still waiting on contributors. */
  diagnose(): { ambiguities: Ambiguity[]; blocked: Blocked[] } {
    return { ambiguities: this.#state.ambiguities, blocked: schedule(this.#opts.playbook, this.#state, this.#cache).blocked };
  }

  // ---- tick phases ---------------------------------------------------------

  async #observe(): Promise<void> {
    for (const e of this.#live()) {
      const s = await this.#opts.harness.status(e.sessionId!);
      if (s.kind === 'exited') this.#append({ t: 'exited', execId: e.id });
      else if (s.kind === 'failed') this.#append({ t: 'failed', execId: e.id, reason: s.reason });
      else if (s.kind === 'unknown') this.#append({ t: 'failed', execId: e.id, reason: 'harness has no record of the session' });
    }
  }

  #requestShutdowns(): void {
    for (const e of this.#state.executions.values()) {
      if (e.status !== 'finishing' || !e.sessionId || this.#stopping.has(e.id)) continue;
      this.#stopping.add(e.id);
      this.#opts.harness.stop(e.sessionId).then(
        () => this.#append({ t: 'exited', execId: e.id }),
        (err: unknown) => this.#append({ t: 'failed', execId: e.id, reason: `shutdown failed: ${message(err)}` }),
      );
    }
  }

  #reserve(): void {
    const { reservations, ambiguities } = schedule(this.#opts.playbook, this.#state, this.#cache);
    for (const a of ambiguities) this.#append({ t: 'ambiguity', ambiguity: a });
    for (const r of reservations) {
      const id = `e${this.#state.executions.size + 1}`;
      const siblings = [...this.#state.executions.values()].filter((e) => e.step === r.step && e.depth === r.depth).length;
      const outDir = join(this.#opts.artifactsDir, `${r.depth}-${r.step}-${siblings + 1}`);
      this.#append({ t: 'reserved', execution: { id, ...r, outDir } });
    }
  }

  async #launch(): Promise<void> {
    for (const e of [...this.#state.executions.values()]) {
      if (e.status !== 'reserved') continue;
      if (this.#live().length >= this.#cap) break;
      const step = this.#step(e.step);
      if (step.isCodingStep && this.#codingHeld()) continue;
      mkdirSync(e.outDir, { recursive: true });
      try {
        const sessionId = await this.#opts.harness.start(this.#launchFor(e, step));
        this.#append({ t: 'started', execId: e.id, sessionId });
      } catch (err) {
        this.#append({ t: 'failed', execId: e.id, reason: `launch failed: ${message(err)}` });
      }
    }
  }

  // ---- helpers -------------------------------------------------------------

  #launchFor(e: Execution, step: Step): Launch {
    const byId = new Map(occurrences(this.#state).map((o) => [o.id, o]));
    const inputs = Object.fromEntries(Object.entries(e.inputs).map(([slot, ids]) => [slot, ids.map((id) => byId.get(id)!.path)]));
    const outputs = Object.fromEntries(step.outputs.map((o) => [o.path, join(e.outDir, o.path)]));
    return {
      executionId: e.id,
      step: step.key,
      cwd: this.#opts.cwd,
      model: step.model || this.#opts.playbook.defaultModel,
      inputs,
      outputs,
      prompt: this.#render(step, e, inputs, outputs),
      requestCompletion: () => this.requestCompletion(e.id),
    };
  }

  #render(step: Step, e: Execution, inputs: Record<string, string[]>, outputs: Record<string, string>): string {
    const tokens: Record<string, string> = {
      ARTIFACTS_DIR: e.outDir,
      TICKET_FILE: this.#opts.tokens?.TICKET_FILE ?? '',
      PROMPT_EXTRA: this.#opts.tokens?.PROMPT_EXTRA ?? '',
    };
    const lines = [step.prompt.replace(/\{\{(\w+)\}\}/g, (_, k: string) => tokens[k] ?? ''), '', '## Engine assignment', `Execution ${e.id} of step "${step.key}".`, '', 'Read exactly these inputs:'];
    const bound = Object.entries(inputs).flatMap(([slot, paths]) => paths.map((p) => `  ${slot} -> ${p}`));
    lines.push(...(bound.length ? bound : ['  (none)']));
    lines.push('', 'Write only these outputs. Publish any subset; at least one must be a nonempty file:');
    lines.push(...Object.entries(outputs).map(([role, p]) => `  ${role} -> ${p}`));
    lines.push('', 'When the files are written and verified, give a brief handoff, then call the completion tool once and finish without starting more work.');
    return lines.join('\n');
  }

  #permitted(e: Execution): boolean {
    return (this.#opts.autoAdvance?.[e.step] ?? this.#step(e.step).autoAdvanceDefault) || e.permitted;
  }

  /** Sessions occupying capacity: anything with a process that has not confirmed exit. */
  #live(): Execution[] {
    return [...this.#state.executions.values()].filter((e) => e.status === 'live' || e.status === 'finishing');
  }

  /** A coding execution keeps the worktree through acceptance until confirmed exit. */
  #codingHeld(): boolean {
    return this.#live().some((e) => this.#step(e.step).isCodingStep);
  }

  #step(key: string): Step {
    return this.#opts.playbook.steps.find((s) => s.key === key)!;
  }

  #must(execId: string): Execution {
    const e = this.#state.executions.get(execId);
    if (!e) throw new Error(`unknown execution ${execId}`);
    return e;
  }

  /** The single write path: durable first, then in memory. */
  #append(ev: Event): void {
    appendLog(this.#opts.logPath, ev);
    apply(this.#state, ev);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
