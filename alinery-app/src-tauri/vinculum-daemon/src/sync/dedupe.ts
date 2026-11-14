// Mutation dedupe (plan 2.2.7): the last 256 mutation ids per client, each with its answer (or
// error). In memory, so a restart clears it, which is what the epoch rule there expects.
const KEEP = 256;

export type Meta = { clientId: string; mutationId: string };

export class Dedupe {
  private readonly clients = new Map<string, Map<string, Promise<unknown>>>();

  /** Runs `fn` once per (client, mutation id); a repeat gets the first call's answer or error,
   * including a repeat that arrives while the first is still running. */
  once<T>(meta: Meta, fn: () => T | Promise<T>): Promise<T> {
    let seen = this.clients.get(meta.clientId);
    if (!seen) this.clients.set(meta.clientId, (seen = new Map()));
    const prior = seen.get(meta.mutationId);
    if (prior) return prior as Promise<T>;
    const answer = Promise.resolve().then(fn);
    seen.set(meta.mutationId, answer);
    answer.catch(() => {}); // a repeat reads the error; the stored copy must not be an unhandled rejection
    if (seen.size > KEEP) seen.delete(seen.keys().next().value as string);
    return answer;
  }
}
