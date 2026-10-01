import * as ipc from "./ipc";
import type { TaskExecutionReply } from "./types";

export type ExecutionRead = { repoPath: string; taskSlug: string };

type Waiter = {
  ref: ExecutionRead;
  resolve: (value: TaskExecutionReply) => void;
  reject: (error: string) => void;
};

// One native batch in flight, plus one coalesced pending set. Missed ticks join
// the pending set instead of forming a queue. ponytail: process-wide flight;
// split per window only if a second frontend runtime appears.
let inFlight = false;
let scheduled = false;
let pending = new Map<string, Waiter[]>();

function observationKey(ref: ExecutionRead): string {
  return `${ref.repoPath}\0${ref.taskSlug}`;
}

export function readTaskExecution(repoPath: string, taskSlug: string): Promise<TaskExecutionReply> {
  let resolve: (value: TaskExecutionReply) => void = () => {};
  let reject: (error: string) => void = () => {};
  const promise = new Promise<TaskExecutionReply>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  const ref = { repoPath, taskSlug };
  const id = observationKey(ref);
  const waiters = pending.get(id) ?? [];
  waiters.push({ ref, resolve, reject });
  pending.set(id, waiters);
  scheduleObservation();
  return promise;
}

export async function readTaskExecutions(refs: readonly ExecutionRead[]): Promise<Array<{ ref: ExecutionRead; execution: TaskExecutionReply | null; error: string }>> {
  return Promise.all(
    refs.map(async (ref) => {
      try {
        return { ref, execution: await readTaskExecution(ref.repoPath, ref.taskSlug), error: "" };
      } catch (error) {
        return { ref, execution: null, error: String(error) };
      }
    }),
  );
}

function scheduleObservation() {
  if (scheduled || inFlight || pending.size === 0) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (inFlight || pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    inFlight = true;
    const refs = [...batch.values()].map((waiters) => waiters[0].ref);
    ipc
      .observeTaskExecutions(refs)
      .then((outcomes) => {
        const byKey = new Map(outcomes.map((outcome) => [`${outcome.repo_path}\0${outcome.task_slug}`, outcome]));
        for (const [id, waiters] of batch) {
          const outcome = byKey.get(id);
          for (const waiter of waiters) {
            if (!outcome) waiter.reject("missing execution outcome");
            else if (outcome.error) waiter.reject(outcome.error);
            else if (!outcome.execution) waiter.reject("missing execution outcome");
            else waiter.resolve(outcome.execution);
          }
        }
      })
      .catch((error: unknown) => {
        const message = String(error);
        for (const waiters of batch.values()) {
          for (const waiter of waiters) waiter.reject(message);
        }
      })
      .finally(() => {
        inFlight = false;
        scheduleObservation();
      });
  });
}
