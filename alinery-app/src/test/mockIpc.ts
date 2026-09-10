import { vi } from "vitest";
import type * as Ipc from "../ipc";

/**
 * A stand-in for the whole ipc module, for tests that render a component.
 *
 * Every command a test does not stub **rejects** rather than returning `undefined`. That
 * is the important part: an unstubbed call that resolves to `undefined` fails three
 * assertions later, in a component that destructured a field off nothing, and the stack
 * points at the component rather than at the missing stub. Rejecting names the command.
 *
 * Stubs are cached per property, so `expect(ipc.archiveTask).toHaveBeenCalledWith(...)`
 * inspects the same spy the component called.
 *
 *     vi.mock("../ipc", () => mockIpc({ listTasks: async () => [task] }));
 */
// A module namespace object is probed for `then` — `await import("../ipc")` will call it
// if it is a function, so the whole mock would be mistaken for a promise and resolve to
// nothing. Same for the interop flag.
const NOT_COMMANDS = new Set(["then", "catch", "finally", "__esModule"]);

export function mockIpc(overrides: Partial<typeof Ipc> = {}): typeof Ipc {
  const cache = new Map<string, unknown>();
  return new Proxy({} as typeof Ipc, {
    get(_target, prop: string | symbol) {
      if (typeof prop !== "string" || NOT_COMMANDS.has(prop)) return undefined;
      if (prop in overrides) return (overrides as Record<string, unknown>)[prop];
      if (!cache.has(prop)) {
        cache.set(
          prop,
          vi.fn(() => Promise.reject(new Error(`ipc.${prop}() was called but this test did not stub it — add it to mockIpc({ ... }).`))),
        );
      }
      return cache.get(prop);
    },
    // Component code and vitest both probe with `in`; without this the proxy reports
    // every command as absent and a destructuring import would fail at module load.
    has: () => true,
  });
}
