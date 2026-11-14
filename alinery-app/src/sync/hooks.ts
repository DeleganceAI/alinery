// Views read entities through these (plan 2.2.10, 2.5). One replica per repo and scope, shared by
// every view that asks for it; the stream closes when the last one lets go.
import { create, toJsonString } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { type Scope, ScopeSchema, SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { daemonTransport } from "../daemon/transport";
import { Replica, runReplica } from "./replica";

export const REPO_SCOPE: Scope = create(ScopeSchema, { kind: { case: "repo", value: {} } });

type Held = { replica: Replica; users: number; stop: () => void };
const held = new Map<string, Held>();

/** Take a share of the replica for (repo, scope), opening its stream if this is the first. `release` is idempotent. */
export function acquireScope(repo: string, scope: Scope): { replica: Replica; release: () => void } {
  const id = `${repo}\u0000${toJsonString(ScopeSchema, scope)}`;
  let h = held.get(id);
  if (!h) {
    const replica = new Replica();
    const client = createClient(SyncService, daemonTransport(repo));
    h = { replica, users: 0, stop: runReplica(replica, (cursor, signal) => client.subscribe({ scope, cursor }, { signal })) };
    held.set(id, h);
  }
  const mine = h;
  mine.users += 1;
  let released = false;
  return {
    replica: mine.replica,
    release: () => {
      if (released) return;
      released = true;
      mine.users -= 1;
      if (mine.users === 0) {
        mine.stop();
        held.delete(id);
      }
    },
  };
}

/** The replica for (repo, scope) while this component is mounted; null before the effect runs and for an empty repo key. */
export function useScope(repo: string, scope: Scope): Replica | null {
  const [replica, setReplica] = useState<Replica | null>(null);
  const scopeKey = toJsonString(ScopeSchema, scope);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey stands for scope
  useEffect(() => {
    if (!repo) return setReplica(null);
    const mine = acquireScope(repo, scope);
    setReplica(mine.replica);
    return () => {
      mine.release();
      setReplica(null);
    };
  }, [repo, scopeKey]);
  return replica;
}

const NONE = new Replica();

export function useEntity(replica: Replica | null, key: string): Entity | undefined {
  const r = replica ?? NONE;
  return useSyncExternalStore(r.listen, () => r.get(key));
}

/** Rows passing `filter`. Memoize `filter` (useCallback), or the list is rebuilt on every render. */
export function useEntities(replica: Replica | null, filter?: (e: Entity) => boolean): Entity[] {
  const r = replica ?? NONE;
  const all = useSyncExternalStore(r.listen, r.all);
  return useMemo(() => (filter ? all.filter(filter) : all), [all, filter]);
}

/** The run loop's link state for `useDaemonStatus`: reachable while frames flow, stale once it drops after data. */
export function useLink(replica: Replica | null): { reachable: boolean; stale: boolean } {
  const r = replica ?? NONE;
  const reachable = useSyncExternalStore(r.listen, () => r.reachable);
  const stale = useSyncExternalStore(r.listen, () => r.stale);
  return { reachable, stale };
}

/** One-shot read for a dialog: the live-session count of a repo's daemon, 0 if it does not answer within `timeoutMs`. */
export function liveSessionsNow(repo: string, timeoutMs = 3000): Promise<number> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  return new Promise<number>((resolve) => {
    let off = () => {};
    const done = (n: number) => {
      clearTimeout(timer);
      off();
      release();
      resolve(n);
    };
    const read = () => (replica.ready ? done(liveSessionsOf(replica.get(DAEMON_STATUS_KEY))) : undefined);
    const timer = setTimeout(() => done(0), timeoutMs);
    off = replica.listen(read);
    read();
  });
}

export const DAEMON_STATUS_KEY = "daemon/_/status";

export function liveSessionsOf(e: Entity | undefined): number {
  return e?.value.case === "daemonStatus" ? e.value.value.liveSessions : 0;
}

/** Live-session count per repo for a settings screen, kept current by each repo's stream. A repo whose link is down reads 0, as "nothing running to lose". */
export function useLiveSessionsByRepo(repos: string[]): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const reposKey = JSON.stringify(repos);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reposKey stands for repos
  useEffect(() => {
    const mine = repos.map((repo) => ({ repo, ...acquireScope(repo, REPO_SCOPE) }));
    const read = () =>
      setCounts((prev) => {
        const next = Object.fromEntries(mine.map((m) => [m.repo, m.replica.reachable ? liveSessionsOf(m.replica.get(DAEMON_STATUS_KEY)) : 0]));
        return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
      });
    const offs = mine.map((m) => m.replica.listen(read));
    read();
    return () => {
      for (const off of offs) off();
      for (const m of mine) m.release();
    };
  }, [reposKey]);
  return counts;
}
