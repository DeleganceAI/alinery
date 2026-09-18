import { act } from "@testing-library/react";
import type { BoardNav } from "../types";

/**
 * Wait for a board's keyboard-navigation handle to be registered.
 *
 * Every list view hands its handle up through a `registerNav` prop from inside an effect, so it is
 * null for at least one render pass. Tests capture it into a `let` and then reach for it after
 * some unrelated readiness signal — usually a `findByText` on rendered data, which says nothing
 * about whether that effect has run.
 *
 * Reaching through `nav?.moveRow(1)` in that window is the trap: optional chaining turns "not
 * ready yet" into a silent no-op, so the test carries on and fails several lines later with
 * `Number of calls: 0`, pointing at the assertion rather than the race.
 *
 * Deliberately not `waitFor`: that polls on real timers, and several of these suites run under
 * `vi.useFakeTimers()`, where it would simply hang. Flushing microtasks inside `act` drains the
 * effect queue under both real and fake timers, so this works everywhere and stays deterministic.
 */
export async function navReady(get: () => BoardNav | null): Promise<BoardNav> {
  // A handle can already exist from the empty first paint; flush pending updates too.
  await act(async () => { await Promise.resolve(); });
  for (let i = 0; i < 50 && !get(); i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  const nav = get();
  if (!nav) throw new Error("board nav handle was never registered — registerNav did not fire with a handle");
  return nav;
}

/**
 * Read a nav handle at the moment of use, failing loudly if it is not there.
 *
 * The handle must be re-read at every call site, not captured once: `registerNav` fires again on
 * later renders with a fresh object, and a handle held from an earlier pass closes over stale
 * state. So this is the safe replacement for `nav?.moveRow(1)` — same fresh read, but a missing
 * handle throws here instead of quietly doing nothing and failing an assertion further down.
 */
export function requireNav(nav: BoardNav | null): BoardNav {
  if (!nav) throw new Error("board nav handle not registered at point of use");
  return nav;
}
