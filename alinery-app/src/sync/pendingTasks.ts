// A task the person just created, shown before its row arrives (plan S4.3, "create shows the card at once"). The daemon
// answers a create with the stored task and the cursor the write was applied at; until the replica reaches that cursor
// the card comes from here, through the same `Overlay` every optimistic write uses, and once the stream carries the
// task's own row the card is dropped, so the task appears exactly once.
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import { useSyncExternalStore } from "react";
import type { BoardTask } from "../types";
import { Overlay } from "./overlay";

const layers = new Map<string, { task: BoardTask; overlay: Overlay<BoardTask | undefined> }>();
const listeners = new Set<() => void>();
let version = 0;
const keyOf = (repo: string, slug: string) => `${repo}\n${slug}`;

export function showPendingTask(repo: string, task: BoardTask, applied: Cursor | undefined) {
  const overlay = new Overlay<BoardTask | undefined>();
  overlay.show(task);
  overlay.applied(applied);
  layers.set(keyOf(repo, task.slug), { task, overlay });
  version++;
  for (const l of listeners) l();
}

/** Re-render when a card is added. */
export function usePendingVersion(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
}

/**
 * `rows` of one repo with its pending cards added. A card whose slug the stream already carries is dropped (the row
 * wins), and so is one the replica has passed (`cursor`), which also covers a task archived or removed since.
 */
export function withPendingTasks(repo: string, rows: BoardTask[], cursor: Cursor | undefined): BoardTask[] {
  if (layers.size === 0) return rows;
  const extra: BoardTask[] = [];
  for (const [key, layer] of layers) {
    if (!key.startsWith(`${repo}\n`)) continue;
    const slug = layer.task.slug;
    if (rows.some((t) => t.slug === slug)) {
      layers.delete(key);
      continue;
    }
    const shown = layer.overlay.read(undefined, cursor);
    if (shown) extra.push(shown);
    else layers.delete(key);
  }
  return extra.length === 0 ? rows : [...rows, ...extra].sort((a, b) => a.created - b.created);
}
