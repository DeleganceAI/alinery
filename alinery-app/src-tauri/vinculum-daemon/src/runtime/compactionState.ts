// LiveDoc compaction fields, with the harness task id dropped (it stays off the wire).
// No I/O: the watcher compares the signature and copies this shape onto the live row.

export type LiveCompaction = { reason: string; blocking: boolean; attempt: number; retry?: { at: number; error: string } };
export type LiveCompactionFailure = { reason: string; error: string };

type CompactionInput = LiveCompaction & { taskId?: unknown };
type FailureInput = LiveCompactionFailure & { taskId?: unknown };
type LiveValue = { compactions?: CompactionInput[]; compactionFailure?: FailureInput } | undefined | null;

/** The LiveDoc value's compaction fields, with the harness task id dropped (it stays off the wire). */
export function compactionsOf(value: LiveValue): { compactions?: LiveCompaction[]; compaction_failure?: LiveCompactionFailure } {
  const compactions = value?.compactions?.map(({ reason, blocking, attempt, retry }) => ({
    reason,
    blocking,
    attempt,
    ...(retry ? { retry: { at: retry.at, error: retry.error } } : {}),
  }));
  const failure = value?.compactionFailure;
  return {
    ...(compactions && compactions.length > 0 ? { compactions } : {}),
    ...(failure ? { compaction_failure: { reason: failure.reason, error: failure.error } } : {}),
  };
}

/**
 * A string that changes whenever the live compaction state changes; the watcher's early-return guard compares it.
 * An empty list and an absent list are the same state (nothing in flight), so they share a signature. The plan's
 * `?? null` leaves `[]` and absence distinct; collapsing an empty list is what makes the guard not republish a no-op.
 */
export function compactionSignature(value: { compactions?: unknown; compactionFailure?: unknown } | undefined | null): string {
  const list = value?.compactions;
  const compactions = Array.isArray(list) && list.length > 0 ? list : null;
  return JSON.stringify(compactions) + JSON.stringify(value?.compactionFailure ?? null);
}

export type CompactionCarry = {
  compactions?: LiveCompaction[];
  compaction_failure?: LiveCompactionFailure;
};

export type CompactionWatch = { signature: string | undefined };

/** Whether the row still holds the compaction fields `value` would publish. The stop tick stamps its signature only then. */
function compactionRowMatches(row: CompactionCarry, value: Parameters<typeof compactionsOf>[0]): boolean {
  const mapped = compactionsOf(value);
  return (
    JSON.stringify(row.compactions ?? null) === JSON.stringify(mapped.compactions ?? null) &&
    JSON.stringify(row.compaction_failure ?? null) === JSON.stringify(mapped.compaction_failure ?? null)
  );
}

/**
 * Copy a changed compaction onto the row and publish it. The row is updated before publish so a
 * successful commit is the new state. A throw reverts those fields and does not store the signature,
 * so a failed publish cannot leave the row ahead of what subscribers have.
 */
export function publishChangedCompaction(
  row: CompactionCarry,
  watch: CompactionWatch,
  value: Parameters<typeof compactionsOf>[0],
  publish: () => void,
): boolean {
  const signature = compactionSignature(value);
  if (watch.signature === signature) return false;
  const mapped = compactionsOf(value);
  const previousCompactions = row.compactions;
  const previousFailure = row.compaction_failure;
  row.compactions = mapped.compactions;
  row.compaction_failure = mapped.compaction_failure;
  try {
    publish();
  } catch (error) {
    row.compactions = previousCompactions;
    row.compaction_failure = previousFailure;
    throw error;
  }
  watch.signature = signature;
  return true;
}

/**
 * Idle LiveDoc tick: publish a compaction change before the turn-outcome read. A rejected read
 * does not undo that publish, and does not put the signature back.
 * `started` runs only after publish returns and the read has been invoked, so a thrown publish
 * never records the finish as already idle.
 */
export async function admitIdleCompaction(
  row: CompactionCarry,
  watch: CompactionWatch,
  value: Parameters<typeof compactionsOf>[0],
  publish: () => void,
  readTurn: () => Promise<void>,
  started?: () => void,
): Promise<void> {
  publishChangedCompaction(row, watch, value, publish);
  const reading = readTurn();
  started?.();
  await reading;
}

/** Per-conversation watch bookkeeping. `owedFinish` survives compaction ticks; only a title or a new run clears it. */
export type LiveDocWatch = {
  version: number;
  lastRunning: boolean | undefined;
  owedFinish: boolean;
  compaction: CompactionWatch;
  /** A stop's finish read has not settled. Compaction ticks must not look like another stop. */
  finishing?: boolean;
  /** Bumped when a new run cancels the in-flight finish, so that callback cannot record idle. */
  finishGen?: number;
};

export type LiveDocTickValue = {
  run?: { inputs: ReadonlyArray<{ toString(): string }> } | null;
  compactions?: unknown;
  compactionFailure?: unknown;
} | null | undefined;

type WatchedSession = CompactionCarry & {
  id: string;
  taskSlug: string;
  runId?: string;
  liveRun: boolean;
  failedTurn?: { id: string; reason: string };
  agent: { state: string; correlation_id?: string; reason?: string };
};

export type LiveDocTickDeps = {
  publish: () => void;
  readFailure: () => Promise<{ id: string; reason: string } | undefined>;
  title: () => void;
  abandoned: () => boolean;
};

function liveValue(value: LiveDocTickValue): Parameters<typeof compactionsOf>[0] {
  return value as Parameters<typeof compactionsOf>[0];
}

/**
 * One LiveDoc tick. A compaction change while idle must not bump `version`: that bump is what
 * cancels the in-flight run-end read, so the chat title never runs. The owed finish stays set
 * until that read titles, or a new run starts.
 *
 * On the tick that sees the run stop, idle and the compaction signature are recorded only after
 * the finish read has settled and the title decision has run. A thrown publish or a rejected read
 * retries once inside that tick. The watcher does not re-deliver an unchanged value, so a second
 * call is not the recovery, and the early return must not be able to swallow the retry.
 */
export function handleLiveDocTick(state: LiveDocWatch, row: WatchedSession, value: LiveDocTickValue, deps: LiveDocTickDeps): void {
  const running = Boolean(value?.run);
  const runId = value?.run?.inputs[0]?.toString();
  // lastRunning stays true until the finish read settles, so this tick would otherwise look like another stop.
  if (state.finishing && !running) {
    try {
      publishChangedCompaction(row, state.compaction, liveValue(value), deps.publish);
    } catch (error) {
      console.error(`turn outcome unavailable for ${row.id}: ${error}`);
    }
    return;
  }
  if (state.lastRunning === running && row.runId === runId && state.compaction.signature === compactionSignature(value)) return;
  const finished = state.lastRunning === true && !running;
  const compactionOnly = !running && state.lastRunning === false && row.runId === runId;
  if (!finished) state.lastRunning = running;
  row.runId = runId;
  row.liveRun = running;
  if (finished) state.owedFinish = true;
  if (running) {
    state.finishing = false;
    state.finishGen = (state.finishGen ?? 0) + 1;
    state.version += 1;
    state.owedFinish = false;
    row.failedTurn = undefined;
    if (row.agent.state !== "waiting_for_input" && row.agent.state !== "waiting_for_approval") row.agent = { state: "busy" };
    // The running path's immediate commit is the compaction publish. The signature is consumed only after it is issued.
    if (!publishChangedCompaction(row, state.compaction, liveValue(value), deps.publish)) deps.publish();
    return;
  }
  if (!compactionOnly) state.version += 1;
  const version = state.version;
  if (finished) {
    state.finishing = true;
    void settleStoppedRun(state, row, value, deps, version, state.finishGen ?? 0, 0, true);
    return;
  }
  // Read the terminal receipt on initial attachment too, so a daemon restart restores the same failed turn.
  // A compaction change is published before that read: a thrown turn outcome must not hide the row.
  // This is not a run stop, so a throw is only logged: the owed finish belongs to the stop tick.
  void admitIdleCompaction(row, state.compaction, liveValue(value), deps.publish, async () => {
    const failure = await deps.readFailure();
    if (state.version !== version || deps.abandoned()) return;
    row.failedTurn = failure;
    if (row.agent.state !== "waiting_for_input" && row.agent.state !== "waiting_for_approval") {
      row.agent = failure ? { state: "errored", correlation_id: failure.id, reason: failure.reason } : { state: "idle" };
    }
    deps.publish();
  }).catch((error) => console.error(`turn outcome unavailable for ${row.id}: ${error}`));
}

/**
 * Publish (when asked) and read the finish. One retry, from this catch: a thrown publish retries
 * the publish and the read; a rejected read restores lastRunning and retries the read. A second
 * throw stops. Idle and the signature are stored only after the title decision.
 *
 * The stop path clears its own signature before the read. A signature set when the read rejects
 * belongs to a compaction tick that landed during the read. Do not clear that, and do not stamp
 * the stop tick's signature over it: a later delivery of the stop value must not look unchanged.
 * Stamp the stop signature only when it is unset and the row still matches the stop value.
 */
async function settleStoppedRun(
  state: LiveDocWatch,
  row: WatchedSession,
  value: LiveDocTickValue,
  deps: LiveDocTickDeps,
  version: number,
  generation: number,
  attempt: number,
  republish: boolean,
): Promise<void> {
  const stillOurs = () => (state.finishGen ?? 0) === generation && state.version === version;
  let publishThrew = false;
  try {
    if (republish) {
      try {
        publishChangedCompaction(row, state.compaction, liveValue(value), deps.publish);
      } catch (error) {
        publishThrew = true;
        throw error;
      }
      // Do not keep it across the read. A same-value tick would then match the early return and swallow the retry.
      state.compaction.signature = undefined;
    }
    const failure = await deps.readFailure();
    if (!stillOurs()) return;
    if (!deps.abandoned()) {
      row.failedTurn = failure;
      if (row.agent.state !== "waiting_for_input" && row.agent.state !== "waiting_for_approval") {
        row.agent = failure ? { state: "errored", correlation_id: failure.id, reason: failure.reason } : { state: "idle" };
      }
      deps.publish();
      if (state.owedFinish && !row.taskSlug && !failure) {
        state.owedFinish = false;
        deps.title();
      }
    }
    if (!stillOurs()) return;
    state.lastRunning = false;
    // A signature already set belongs to a compaction tick whose publish succeeded. Do not stamp the
    // stop value over it. An unset signature is the stop tick's only when the row still matches it:
    // a publish that threw has reverted the row, and stamping stop over a mid row would swallow the retry note.
    if (state.compaction.signature === undefined && compactionRowMatches(row, liveValue(value))) {
      state.compaction.signature = compactionSignature(value);
    }
    state.finishing = false;
  } catch (error) {
    if (!stillOurs()) return;
    // Leave a signature that is already set. The stop path cleared its own before the read, so a
    // set signature belongs to a later compaction tick. Clearing it lets the success path stamp the
    // stop tick's signature over that newer one, and a re-delivery of the stop value then matches
    // the early return while the row still shows the in-between state.
    state.lastRunning = true;
    if (attempt === 0) {
      await settleStoppedRun(state, row, value, deps, version, generation, 1, publishThrew);
      return;
    }
    state.finishing = false;
    console.error(`turn outcome unavailable for ${row.id}: ${error}`);
  }
}
