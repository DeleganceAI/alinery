import { useEffect, useSyncExternalStore } from "react";
import * as ipc from "./ipc";
import type { PullRequestSnapshot, TaskActivityRef } from "./types";

const FRESH_MS = 60_000;
type CacheEntry = { snapshot?: PullRequestSnapshot; updatedAt: number; inFlight?: Promise<void> };
const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();
let revision = 0;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const getRevision = () => revision;
const isVisible = () => document.visibilityState !== "hidden";

async function refresh(tasks: TaskActivityRef[]) {
  const pending = new Set<Promise<void>>();
  const missing = new Map<string, TaskActivityRef>();
  for (const task of tasks) {
    const key = `${task.repoPath}:${task.taskSlug}`;
    const entry = cache.get(key);
    if (entry?.inFlight) pending.add(entry.inFlight);
    else if (!entry?.snapshot || Date.now() - entry.updatedAt >= FRESH_MS) missing.set(key, task);
  }
  if (missing.size) {
    // Defer IPC until every entry is marked pending so overlapping consumers share it.
    const request = Promise.resolve()
      .then(() => ipc.listTaskPullRequests([...missing.values()]))
      .catch((error: unknown): Record<string, PullRequestSnapshot> => {
        const message = error instanceof Error ? error.message : String(error);
        return Object.fromEntries([...missing.keys()].map((key) => [key, { pr: null, error: message }]));
      })
      .then((snapshots) => {
        for (const key of missing.keys()) {
          const previous = cache.get(key)?.snapshot;
          const next = snapshots[key] ?? { pr: null, error: "Pull request status was not returned" };
          cache.set(key, {
            snapshot: next.error ? { pr: next.pr ?? previous?.pr ?? null, error: next.error } : next,
            updatedAt: Date.now(),
          });
        }
        revision += 1;
        for (const listener of listeners) listener();
      });
    for (const key of missing.keys()) {
      const entry = cache.get(key) ?? { updatedAt: 0 };
      entry.inFlight = request;
      cache.set(key, entry);
    }
    pending.add(request);
  }
  await Promise.all(pending);
}

export function useTaskPullRequests(tasks: readonly TaskActivityRef[]): Record<string, PullRequestSnapshot> {
  useSyncExternalStore(subscribe, getRevision, getRevision);
  const signature = JSON.stringify(tasks);

  useEffect(() => {
    const refs: TaskActivityRef[] = JSON.parse(signature);
    if (!refs.length) return;
    let alive = true;
    let running = false;
    let timer: number | undefined;
    const load = async () => {
      if (!alive || running || !isVisible()) return;
      running = true;
      try {
        await refresh(refs);
      } finally {
        running = false;
        if (alive && isVisible()) {
          const nextRefresh = Math.min(...refs.map((ref) => (cache.get(`${ref.repoPath}:${ref.taskSlug}`)?.updatedAt ?? 0) + FRESH_MS));
          timer = window.setTimeout(() => void load(), Math.max(0, nextRefresh - Date.now()));
        }
      }
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (isVisible()) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void load();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [signature]);

  // Read only this render's identities; a late response from another repo cannot leak in.
  const snapshots: Record<string, PullRequestSnapshot> = {};
  for (const task of tasks) {
    const key = `${task.repoPath}:${task.taskSlug}`;
    const snapshot = cache.get(key)?.snapshot;
    if (snapshot) snapshots[key] = snapshot;
  }
  return snapshots;
}
