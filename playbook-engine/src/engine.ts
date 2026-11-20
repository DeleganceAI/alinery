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
 * allows. Every change is applied to the in-memory State and then saved whole
 * through `save`; a restart is `load`, nothing else.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectOutputs } from './accept.ts';
import type { CompletionReply, Harness, Launch } from './harness.ts';
import { type Playbook, type Step, validatePlaybook } from './playbook.ts';
import { type Blocked, schedule, SchedulerCache } from './schedule.ts';
import { sha256Of, snapshotOccurrence } from './history.ts';
import { type Ambiguity, apply, emptyState, type Event, type Execution, type FileRecord, type Occurrence, occurrences, type ReadyAssessment, type State } from './state.ts';

export interface EngineOptions {
  playbook: Playbook;
  /** Called after a save has reached the store. An exception is logged and never fails the engine. */
  onSaved?: (state: State) => void;
  harness: Harness;
  /** The stored State of this task, or undefined for a task the engine has not saved yet. */
  load: () => State | undefined;
  /**
   * Store the whole State. Saves are one at a time and coalesced: a save that finds newer changes waiting
   * runs again, so the last one written is always the latest. The host must serialize `state` before its
   * first await. A rejection leaves the changes unsaved; the next `flush` tries again.
   */
  save: (state: State) => void | Promise<void>;
  /**
   * Parent of every execution's `objects/` directory. Omit it and no file states are kept.
   */
  historyDir?: string;
  /** Records the worktree an accepted coding step produced, as a tree kept alive under a ref. */
  recordWorktree?: (execution: Execution) => { ref: string; tree: string } | undefined | Promise<{ ref: string; tree: string } | undefined>;
  /** Parent of every execution's output directory. */
  artifactsDir: string;
  /** Agent working directory: the task's repo checkout or worktree. */
  cwd: string;
  /**
   * Task-level live-session cap. Starting, running, idle and finishing sessions all count.
   * A function is read again each time a session would launch. `0` launches nothing. Default 10.
   */
  maxLiveSessions?: number | (() => number);
  /**
   * Task set, read when an execution is reserved and stored on that execution.
   * A step in the list may finish on its own. A step that is absent is locked, even when the
   * playbook default is true. Omit it and the playbook default is what gets snapshotted.
   */
  enabledSteps?: () => readonly string[];
  /** Task-level human gate per step key, used only when `enabledSteps` is omitted. */
  autoAdvance?: Record<string, boolean>;
  /** Read on every completion. True lets a locked execution finish. It does not change the snapshot. */
  autoApproveAll?: () => boolean;
  /** A policy change may advance an earlier report only after subsequent agent activity and input have settled. */
  canAdvanceReviewed?: (sessionId: string) => Promise<boolean>;
  /** True when this exact follow-up has a successful final reply and the session has no outstanding work. */
  reviewFollowUpFinished?: (sessionId: string, requestId: string) => Promise<boolean>;
  /**
   * Prompt tokens that belong to one launch. Called while rendering that step.
   * When set, it replaces `PROMPT_EXTRA` and `REVIEW_HANDOFF_FILE` for that launch, including with empty strings.
   */
  stepTokens?: (step: string) => { PROMPT_EXTRA?: string; REVIEW_HANDOFF_FILE?: string } | undefined;
  /**
   * The repository's standing requirements, read each time a step launches and appended to its prompt as one block.
   * Empty adds nothing. A throw fails that launch, so a requirement is never dropped without a trace.
   */
  requirements?: () => string | Promise<string>;
  /** Clock in milliseconds for idle reminders. */
  now?: () => number;
  /** Values for prompt tokens that are not derived from the execution. `{{ARTIFACTS_DIR}}` is each execution's own output directory. */
  tokens?: {
    TICKET_FILE?: string;
    PROMPT_EXTRA?: string;
    TASK_NAME?: string;
    TASK_SLUG?: string;
    WORKTREE?: string;
    REVIEW_HANDOFF_FILE?: string;
    SESSION_HISTORY_DIR?: string;
  };
}

const WRAP_UP = 'Permission to finish granted. Complete your writes, give a brief handoff, then call the completion tool. If it reports readiness for review, remain available for follow-up requests. Finish only after acceptance.';

const IDLE_REMINDER = 'Your assigned outputs are in place. If you are done, call the completion tool to submit them. If you still need an answer from the human, ask for it.';
const IDLE_REMINDER_AFTER_MS = 30_000;
const IDLE_REMINDER_LIMIT = 2;

export class StepContinuationRefusal extends Error {
  readonly reason: 'unknown-step' | 'task-override';

  constructor(reason: StepContinuationRefusal['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export class Engine {
  readonly #opts: EngineOptions;
  #state: State;
  /** Executions whose shutdown this process has already requested. Rebuilt lazily after restart; stop() is idempotent. */
  readonly #stopping = new Set<string>();
  /** A fresh engine observes a full idle period before sending any reminders. */
  readonly #idleSince = new Map<string, number>();
  readonly #remindersSent = new Map<string, number>();
  #saving: Promise<void> | null = null;
  #dirty = false;
  #saveError: unknown;
  /** Tick and resume run one at a time: a launch awaits the harness while its execution is still `reserved`, so an overlapping pass would start it twice. */
  #turn: Promise<unknown> = Promise.resolve();
  /** Prevent two concurrent Continue requests from recording the same worktree twice. */
  readonly #accepting = new Map<string, Promise<CompletionReply>>();
  /** Derived ancestry, kept across ticks. Purely an optimisation; see schedule.ts. */
  readonly #cache = new SchedulerCache();

  private constructor(opts: EngineOptions, state: State) {
    this.#opts = opts;
    this.#state = state;
  }

  /** Validate the playbook and load the stored State. Throws on an invalid definition: a task never runs a playbook the engine cannot honour. */
  static open(opts: EngineOptions): Engine {
    const problems = validatePlaybook(opts.playbook);
    if (problems.length) throw new Error(`invalid playbook: ${problems.map((p) => p.message).join('; ')}`);
    return new Engine(opts, opts.load() ?? emptyState());
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

  /** One scheduling round. Safe to call as often as you like. Ends with every change saved, or throws the save's error. */
  tick(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#observe();
      await this.#advanceReady();
      // A lost save must not release the owner or launch successors from an in-memory receipt.
      await this.flush();
      this.#requestShutdowns();
      this.#reserve();
      await this.#launch();
      await this.flush();
    });
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(run);
    this.#turn = next.catch(() => undefined);
    return next;
  }

  /** Save the State as it is, though no event changed it. Used once, to store a State converted from an old log. */
  persist(): void {
    this.#dirty = true;
    if (!this.#saving) this.#drain();
  }

  /** Wait until the state on disk is the state in memory. One retry after a failed save, then the error. */
  async flush(): Promise<void> {
    for (let retried = false; ; ) {
      if (this.#saving) {
        await this.#saving;
        continue;
      }
      if (!this.#dirty) return;
      if (retried) throw this.#saveError;
      retried = true;
      this.#drain();
    }
  }

  /** A report validates outputs. A ready manual step or endpoint stays live with its current owner. */
  async requestCompletion(execId: string, sessionId?: string, attempt?: number): Promise<CompletionReply> {
    const e = this.#state.executions.get(execId);
    if (!e) return { kind: 'rejected', problems: [`unknown execution ${execId}`] };
    if ((sessionId !== undefined && sessionId !== e.sessionId) || (attempt !== undefined && attempt !== (e.attempt ?? 0))) {
      return { kind: 'stale', reason: 'The execution owner changed.' };
    }
    if (e.receipt) return this.#receipt(e.receipt);
    if (e.status !== 'live' || !e.sessionId) return { kind: 'rejected', problems: [`execution is ${e.status}, not live`] };
    const check = this.#assess(e);
    if ('problems' in check) {
      if (e.ready || e.pendingReviewInput) this.#append({ t: 'work-changed', execId });
      await this.flush();
      return { kind: 'rejected', problems: check.problems };
    }
    let ready = e.ready;
    if (!ready || !sameAssessment(ready, check.assessment)) {
      const revision = ready ? ready.revision + 1 : Math.max(1, e.workRevision ?? 0);
      ready = { ...check.assessment, revision };
      this.#append({ t: 'ready', execId, assessment: ready });
    }
    if (!ready.endpoint && this.#permitted(e)) return this.#acceptReviewed(e, ready, false);
    await this.flush();
    if (e.receipt) return this.#receipt(e.receipt);
    if (e.ready !== ready) return { kind: 'stale', reason: 'Work changed while recording readiness.' };
    return readyReply(ready);
  }

  /** The caller names the reviewed owner and revision. A retry after acceptance reads its durable receipt. */
  async continueReviewed(execId: string, sessionId: string, revision: number): Promise<CompletionReply> {
    const e = this.#state.executions.get(execId);
    if (!e || !sessionId || e.sessionId !== sessionId || !Number.isSafeInteger(revision) || revision < 1) {
      return { kind: 'stale', reason: 'The reviewed execution or owner changed.' };
    }
    if (e.receipt && e.acceptedRevision === revision) return this.#receipt(e.receipt);
    if (e.status !== 'live' || !e.ready || e.ready.revision !== revision) return { kind: 'stale', reason: 'This revision is no longer ready.' };
    return this.#acceptReviewed(e, e.ready, true);
  }

  /** Admit work before delivering it, including when no readiness has yet been reported. */
  async invalidateReadiness(execId: string, sessionId: string, requestId?: string): Promise<void> {
    const e = this.#must(execId);
    if (!sessionId || e.sessionId !== sessionId || e.status !== 'live' || e.receipt) throw new Error('The execution no longer accepts work from this owner.');
    this.#append({ t: 'work-changed', execId, reviewInput: e.ready || e.pendingReviewInput ? requestId : undefined });
    await this.flush();
  }

  /** Reassess a previously submitted handoff after feedback. Only offer a human decision here. */
  async #reviewAfterFeedback(e: Execution): Promise<void> {
    const requestId = e.pendingReviewInput;
    const revision = e.workRevision;
    if (!requestId || !revision || !e.sessionId || e.status !== 'live' || !this.#opts.reviewFollowUpFinished) return;
    if (!(await this.#opts.reviewFollowUpFinished(e.sessionId, requestId))) return;
    // A newer message, explicit completion, or owner change can arrive while checking the reply.
    if (e.pendingReviewInput !== requestId || e.workRevision !== revision) return;
    const check = this.#assess(e);
    if ('problems' in check || (!check.assessment.endpoint && this.#permitted(e))) {
      this.#append({ t: 'work-changed', execId: e.id });
      return;
    }
    this.#append({ t: 'ready', execId: e.id, assessment: { ...check.assessment, revision } });
  }

  async setStepContinuation(stepKey: string, automatic: boolean, checkRevision?: () => void): Promise<void> {
    await this.#exclusive(async () => {
      await this.flush(); // The caller compares against the published result of any preceding write.
      checkRevision?.();
      if (!this.#step(stepKey)) throw new StepContinuationRefusal('unknown-step', `unknown step ${stepKey}`);
      if (!automatic && this.#opts.autoApproveAll?.()) {
        throw new StepContinuationRefusal('task-override', 'Turn off task-wide automatic approval before selecting manual continuation.');
      }
      this.#append({ t: 'step-mode', step: stepKey, automatic });
      await this.flush();
    });
    if (automatic) await this.#advanceReady(stepKey);
  }

  async #advanceReady(stepKey?: string): Promise<void> {
    for (const e of this.#state.executions.values()) {
      const ready = e.ready;
      if ((stepKey && e.step !== stepKey) || e.status !== 'live' || !e.sessionId || !ready || ready.endpoint || !this.#permitted(e)) continue;
      if (this.#opts.canAdvanceReviewed && !(await this.#opts.canAdvanceReviewed(e.sessionId))) continue;
      if (e.ready === ready && this.#permitted(e)) await this.#acceptReviewed(e, ready, false);
    }
  }

  #assess(e: Execution): { assessment: Omit<ReadyAssessment, 'revision'>; published: Occurrence[] } | { problems: string[] } {
    const inspected = inspectOutputs(e.outDir, this.#step(e.step).outputs);
    if (!inspected.ok) return { problems: inspected.problems };
    const published = inspected.published.map((p) => ({ ...p, id: `${e.id}/${p.role}`, producer: e.id }));
    const roles = published.map((p) => p.role);
    // Preview the same scheduler that will bind these occurrences after exit, without modifying the run.
    const projected = new Map(this.#state.executions);
    projected.set(e.id, { ...e, status: 'done', receipt: published });
    const ids = new Set(published.map((p) => p.id));
    const trace = { contributed: ids, waiting: false, ambiguous: false };
    const preview = schedule(this.#opts.playbook, { ...this.#state, executions: projected }, this.#cache, trace);
    const destinations = [...new Set(preview.reservations.filter((r) => Object.values(r.inputs).some((slot) => slot.some((id) => ids.has(id)))).map((r) => r.step))].sort();
    const endpoint = destinations.length === 0 && !trace.waiting;
    if (!this.#permitted(e) && trace.ambiguous) {
      return { problems: ['The destinations for these artifacts are ambiguous.'] };
    }
    try {
      return { published, assessment: { roles, hashes: published.map((p) => sha256Of(p.path).sha256), destinations, endpoint } };
    } catch (error) {
      return { problems: [`Unable to verify the assigned files: ${message(error)}`] };
    }
  }

  #acceptReviewed(e: Execution, ready: ReadyAssessment, human: boolean): Promise<CompletionReply> {
    const key = `${e.id}/${ready.revision}`;
    const pending = this.#accepting.get(key);
    if (pending) return pending;
    const result = this.#finishReviewed(e, ready, human).finally(() => this.#accepting.delete(key));
    this.#accepting.set(key, result);
    return result;
  }

  async #finishReviewed(e: Execution, ready: ReadyAssessment, human: boolean): Promise<CompletionReply> {
    const stale = () => e.status !== 'live' || e.ready !== ready;
    const changed = (): CompletionReply => ({ kind: 'stale', reason: 'These files or their destinations changed. Report readiness again.' });
    const rejectChanged = async (problems?: string[]): Promise<CompletionReply> => {
      if (e.ready === ready) this.#append({ t: 'work-changed', execId: e.id });
      await this.flush();
      return problems ? { kind: 'rejected', problems } : changed();
    };
    if (stale()) return changed();
    let check = this.#assess(e);
    if ('problems' in check) return rejectChanged(check.problems);
    if (!sameAssessment(ready, check.assessment)) return rejectChanged();
    let worktree;
    if (this.#step(e.step).isCodingStep && this.#opts.recordWorktree) {
      worktree = await this.#opts.recordWorktree(e);
      if (stale()) return changed();
      check = this.#assess(e);
      if ('problems' in check) return rejectChanged(check.problems);
      if (!sameAssessment(ready, check.assessment)) return rejectChanged();
    }
    if (!human && !this.#permitted(e)) return readyReply(ready);
    const files = this.#opts.historyDir ? check.published.map((o) => snapshotOccurrence(this.#opts.historyDir!, e.id, o)) : undefined;
    if (files?.some((file, i) => file.sha256 !== ready.hashes[i])) return rejectChanged();
    this.#append({ t: 'accepted', execId: e.id, revision: ready.revision, published: check.published, files, worktree });
    return this.#receipt(check.published);
  }

  async #receipt(receipt: Occurrence[]): Promise<CompletionReply> {
    await this.flush();
    return { kind: 'accepted', published: receipt.map((o) => o.path) };
  }

  /** Human gate: allow this one execution to finish, and tell the agent so. */
  async permit(execId: string): Promise<void> {
    const e = this.#must(execId);
    if (e.status !== 'live' || !e.sessionId) throw new Error(`${execId} is ${e.status}; only a live execution can be permitted`);
    this.#append({ t: 'permitted', execId });
    await this.flush();
    await this.#opts.harness.send(e.sessionId, WRAP_UP);
  }

  /** Explicit recovery: continue a failed execution. Never called by the engine itself. Capacity and coding rules still apply. */
  resume(execId: string): Promise<void> {
    return this.#exclusive(() => this.#resume(execId));
  }

  async #resume(execId: string): Promise<void> {
    const e = this.#must(execId);
    if (e.status !== 'failed') throw new Error(`${execId} is ${e.status}; only a failed execution can be resumed`);
    if (e.unconfirmed) throw new Error(`${execId} cannot resume until its previous owner is confirmed stopped`);
    if (e.receipt) throw new Error(`${execId} already published; use confirmExited once its process has stopped`);
    const step = this.#step(e.step);
    if (this.#occupying().length >= this.#liveCap()) throw new Error('task is at its live-session cap');
    if (step.isCodingStep && this.#codingHeld()) throw new Error('another coding execution holds the worktree');
    const launch = await this.#launchFor(e, step);
    const consumed = this.#consumedFor(e);
    const sessionId = e.sessionId ? await this.#opts.harness.resume(e.sessionId, launch) : await this.#opts.harness.start(launch);
    this.#append({ t: 'resumed', execId, sessionId, ...consumed });
    await this.flush();
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
    for (const e of this.#occupying()) {
      const s = await this.#opts.harness.status(e.sessionId!);
      if (s.kind === 'idle' && e.pendingReviewInput) await this.#reviewAfterFeedback(e);
      if (s.kind === 'idle' && this.#canRemind(e)) {
        await this.#remindIfIdle(e);
      } else {
        this.#idleSince.delete(e.id);
      }
      if (s.kind === 'exited') this.#append({ t: 'exited', execId: e.id });
      else if (s.kind === 'failed') {
        if (e.status !== 'failed' || e.unconfirmed) this.#append({ t: 'failed', execId: e.id, reason: s.reason });
      } else if (s.kind === 'unknown' && e.status !== 'failed') {
        // Not proof the process stopped: it keeps its capacity and worktree until a person confirms.
        this.#append({ t: 'failed', execId: e.id, reason: 'harness has no record of the session', unconfirmed: true });
      }
    }
  }

  #canRemind(e: Execution): boolean {
    return e.status === 'live' && !e.ready && !e.receipt && !e.pendingReviewInput && this.#automatic(e);
  }

  /** An automatic step can end its turn after writing the outputs and forget to request completion. */
  async #remindIfIdle(e: Execution): Promise<void> {
    const now = (this.#opts.now ?? Date.now)();
    const since = this.#idleSince.get(e.id);
    if (since === undefined) {
      this.#idleSince.set(e.id, now);
      return;
    }
    const sent = this.#remindersSent.get(e.id) ?? 0;
    if (sent >= IDLE_REMINDER_LIMIT || now - since < IDLE_REMINDER_AFTER_MS) return;
    const revision = e.workRevision;
    const sessionId = e.sessionId!;
    const outputsReady = () => inspectOutputs(e.outDir, this.#step(e.step).outputs).ok;
    if (!outputsReady()) return;
    this.#idleSince.set(e.id, now); // A failed delivery also waits a full period before retry.
    const eligible = () => e.sessionId === sessionId && e.workRevision === revision && this.#canRemind(e) && outputsReady();
    try {
      await this.#opts.harness.send(sessionId, IDLE_REMINDER, eligible);
      this.#remindersSent.set(e.id, sent + 1);
    } catch {
      // The session may have started work or lost its connection since the idle observation.
    }
  }

  #requestShutdowns(): void {
    for (const e of this.#state.executions.values()) {
      if (e.status !== 'finishing' || !e.sessionId || this.#stopping.has(e.id)) continue;
      this.#stopping.add(e.id);
      this.#opts.harness.stop(e.sessionId).then(
        () => this.#append({ t: 'exited', execId: e.id }),
        (err: unknown) => this.#append({ t: 'failed', execId: e.id, reason: `shutdown failed: ${message(err)}`, unconfirmed: true }),
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
      const step = this.#step(r.step);
      this.#append({ t: 'reserved', execution: { id, ...r, outDir, automatic: this.#gateAtReserve(step) } });
    }
  }

  async #launch(): Promise<void> {
    for (const e of [...this.#state.executions.values()]) {
      if (e.status !== 'reserved') continue;
      if (this.#occupying().length >= this.#liveCap()) break;
      const step = this.#step(e.step);
      if (step.isCodingStep && this.#codingHeld()) continue;
      mkdirSync(e.outDir, { recursive: true });
      try {
        // Captured before the agent exists, so it cannot touch an input first.
        const consumed = this.#consumedFor(e);
        const sessionId = await this.#opts.harness.start(await this.#launchFor(e, step));
        this.#append({ t: 'started', execId: e.id, sessionId, ...consumed });
      } catch (err) {
        this.#append({ t: 'failed', execId: e.id, reason: `launch failed: ${message(err)}` });
      }
    }
  }

  // ---- helpers -------------------------------------------------------------

  async #launchFor(e: Execution, step: Step): Promise<Launch> {
    const byId = new Map(occurrences(this.#state).map((o) => [o.id, o]));
    const attempt = (e.attempt ?? 0) + (e.status === 'failed' ? 1 : 0);
    const inputs = Object.fromEntries(Object.entries(e.inputs).map(([slot, ids]) => [slot, ids.map((id) => byId.get(id)!.path)]));
    const outputs = Object.fromEntries(step.outputs.map((o) => [o.path, join(e.outDir, o.path)]));
    return {
      executionId: e.id,
      step: step.key,
      cwd: this.#opts.cwd,
      model: step.model || this.#opts.playbook.defaultModel,
      inputs,
      outputs,
      prompt: this.#render(step, e, inputs, outputs, (await this.#opts.requirements?.()) ?? ''),
      requestCompletion: () => this.requestCompletion(e.id, undefined, attempt),
    };
  }

  #render(step: Step, e: Execution, inputs: Record<string, string[]>, outputs: Record<string, string>, requirements: string): string {
    const exact = step.outputs.find((output) => !output.path.includes('*'));
    const launchTokens = this.#opts.stepTokens?.(step.key);
    const extra = launchTokens ? (launchTokens.PROMPT_EXTRA ?? '') : (this.#opts.tokens?.PROMPT_EXTRA ?? '');
    const handoff = launchTokens ? (launchTokens.REVIEW_HANDOFF_FILE ?? '') : (this.#opts.tokens?.REVIEW_HANDOFF_FILE ?? '');
    const tokens: Record<string, string> = {
      ARTIFACTS_DIR: e.outDir,
      ARTIFACT_FILE: exact ? join(e.outDir, exact.path) : '',
      REVIEW_HANDOFF_FILE: handoff,
      SESSION_HISTORY_DIR: this.#opts.tokens?.SESSION_HISTORY_DIR ?? '',
      TASK_NAME: this.#opts.tokens?.TASK_NAME ?? '',
      TASK_SLUG: this.#opts.tokens?.TASK_SLUG ?? '',
      WORKTREE: this.#opts.tokens?.WORKTREE ?? this.#opts.cwd,
      PLAYBOOK_KEY: this.#opts.playbook.key,
      PHASE_KEY: step.key,
      PHASE_TITLE: step.title,
      TICKET_FILE: this.#opts.tokens?.TICKET_FILE ?? '',
      PROMPT_EXTRA: extra,
    };
    // Appended after the token pass, so braces in a requirement file are never read as tokens.
    const lines = [step.prompt.replace(/(?<!\\)\{\{(\w+)\}\}/g, (_, k: string) => tokens[k] ?? ''), ...(requirements ? ['', '## Repository requirements', '', requirements] : []), '', '## Engine assignment', `Execution ${e.id} of step "${step.key}".`, '', 'Read exactly these inputs:'];
    const bound = Object.entries(inputs).flatMap(([slot, paths]) => paths.map((p) => `  ${slot} -> ${p}`));
    lines.push(...(bound.length ? bound : ['  (none)']));
    lines.push('', 'Write only these outputs. At least one must be a nonempty file. A required output must be present:');
    lines.push(...step.outputs.map((output) => `  ${output.path} -> ${outputs[output.path]}${output.required ? ' (required)' : ''}`));
    lines.push('', 'When the files are written and verified, give a brief handoff, then call the completion tool. If it reports readiness for review, remain available for follow-up requests. Finish only after acceptance.');
    return lines.join('\n');
  }

  /** Cap for the launch about to happen. `0` is not a cap of "unlimited"; it reserves and does not start. */
  #liveCap(): number {
    const raw = this.#opts.maxLiveSessions;
    const value = typeof raw === 'function' ? raw() : (raw ?? 10);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** The gate stored on the reserved event. A provided task set wins over the playbook default. */
  #gateAtReserve(step: Step): boolean {
    if (this.#state.stepModes && Object.hasOwn(this.#state.stepModes, step.key)) return this.#state.stepModes[step.key];
    if (this.#opts.enabledSteps) return this.#opts.enabledSteps().includes(step.key);
    return this.#opts.autoAdvance?.[step.key] ?? step.autoAdvanceDefault;
  }

  #permitted(e: Execution): boolean {
    return e.permitted || this.#automatic(e);
  }

  #automatic(e: Execution): boolean {
    const gate = typeof e.automatic === 'boolean' ? e.automatic : (this.#opts.autoAdvance?.[e.step] ?? this.#step(e.step).autoAdvanceDefault);
    return gate || (this.#opts.autoApproveAll?.() ?? false);
  }

  /** Sessions occupying capacity: anything with a process that has not confirmed exit. */
  #live(): Execution[] {
    return [...this.#state.executions.values()].filter((e) => e.status === 'live' || e.status === 'finishing');
  }

  /** Live sessions plus failed ones whose process has not been confirmed gone. Both hold capacity and the worktree. */
  #occupying(): Execution[] {
    return [...this.#state.executions.values()].filter((e) => e.sessionId && (e.status === 'live' || e.status === 'finishing' || (e.status === 'failed' && e.unconfirmed)));
  }

  /** A coding execution keeps the worktree through acceptance until confirmed exit. */
  #codingHeld(): boolean {
    return this.#occupying().some((e) => this.#step(e.step).isCodingStep);
  }

  #step(key: string): Step {
    return this.#opts.playbook.steps.find((s) => s.key === key)!;
  }

  #must(execId: string): Execution {
    const e = this.#state.executions.get(execId);
    if (!e) throw new Error(`unknown execution ${execId}`);
    return e;
  }

  /** What the execution read, copied the first time it starts. Later edits of the live files cannot change it. */
  #consumedFor(e: Execution): { consumed?: FileRecord[] } {
    const dir = this.#opts.historyDir;
    if (!dir || e.manifest) return {};
    const byId = new Map(occurrences(this.#state).map((o) => [o.id, o]));
    return { consumed: Object.values(e.inputs).flatMap((ids) => ids.map((id) => snapshotOccurrence(dir, e.id, byId.get(id)!))) };
  }

  /** The single write path: apply in memory, then save the whole State. */
  #append(ev: Event): void {
    if (ev.t === 'work-changed' || ev.t === 'permitted' || ev.t === 'resumed') this.#idleSince.delete(ev.execId);
    if (ev.t === 'step-mode') {
      for (const e of this.#occupying()) if (e.step === ev.step) this.#idleSince.delete(e.id);
    }
    apply(this.#state, ev);
    this.persist();
  }

  #drain(): void {
    this.#saving = (async () => {
      while (this.#dirty) {
        this.#dirty = false;
        try {
          await this.#opts.save(this.#state);
        } catch (err) {
          this.#dirty = true;
          this.#saveError = err;
          console.error(`engine save: ${message(err)}`);
          return;
        }
        try {
          this.#opts.onSaved?.(this.#state);
        } catch (err) {
          console.error(`engine onSaved: ${message(err)}`);
        }
      }
    })().finally(() => {
      this.#saving = null;
    });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readyReply(ready: ReadyAssessment): CompletionReply {
  return { kind: 'ready', revision: ready.revision, endpoint: ready.endpoint, destinations: [...ready.destinations] };
}

function sameAssessment(left: ReadyAssessment, right: Omit<ReadyAssessment, 'revision'>): boolean {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  return left.endpoint === right.endpoint && same(left.destinations, right.destinations) && same(left.roles, right.roles) && same(left.hashes, right.hashes);
}
