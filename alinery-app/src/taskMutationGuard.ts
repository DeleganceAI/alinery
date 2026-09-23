import { toast } from "./toast";

/** The two task mutations the app runs one at a time. */
export type TaskMutationKind = "create" | "duplicate";

// Every create or duplicate ends in a full `git worktree add` on the backend, which is
// unbounded in wall-clock time, so the app allows exactly one at a time — from the form,
// from ⌘N, or from any board's Duplicate.
//
// Module-level, like toast and confirm: the guard must outlive the component that started
// the mutation. A `useRef` scoped to the create form is exactly the gap this replaces —
// navigating away mid-flight used to hand the slot back while the backend was still busy.
//
// Held on globalThis so Vite HMR does not split the slot: a new module copy would
// otherwise leave App subscribed to an empty listener set while CreateTaskPage claims
// a different `current`.
type GuardState = { current: TaskMutationKind | null; listeners: Set<() => void> };
const guard: GuardState = (() => {
  const g = globalThis as typeof globalThis & { __alineryTaskMutation?: GuardState };
  if (!g.__alineryTaskMutation) {
    g.__alineryTaskMutation = { current: null, listeners: new Set() };
  }
  return g.__alineryTaskMutation;
})();

/** The task mutation running right now, or null. */
export function currentKind(): TaskMutationKind | null {
  return guard.current;
}

/** Claims the one slot, or refuses with the shared error toast. */
export function claim(kind: TaskMutationKind): boolean {
  if (guard.current) {
    refuse(guard.current);
    return false;
  }
  guard.current = kind;
  notify();
  return true;
}

/** Read-only gate for an entry point that must not start a mutation at all — opening the
    create form. Refuses in the same words as `claim`, so a second ⌘N reads like a second
    click on a board's Duplicate. */
export function refuseIfBusy(): boolean {
  if (!guard.current) return false;
  refuse(guard.current);
  return true;
}

/** Frees the slot. Callers hold it from the moment the backend call starts until that
    promise settles — not until the user navigates. */
export function release(): void {
  guard.current = null;
  notify();
}

/** Observes the slot. Signature matches `useSyncExternalStore` — read `currentKind()`
    in the snapshot, don't take the kind from this callback. */
export function subscribe(fn: () => void): () => void {
  guard.listeners.add(fn);
  return () => {
    guard.listeners.delete(fn);
  };
}

function notify() {
  for (const l of guard.listeners) l();
}

// One message, one home: every refusal names the operation actually holding the slot.
function refuse(kind: TaskMutationKind) {
  toast(`A task is already being ${kind === "duplicate" ? "duplicated" : "created"} — wait for it to finish.`, "error");
}
