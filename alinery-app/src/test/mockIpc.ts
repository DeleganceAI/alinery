import { vi } from "vitest";
import type * as Ipc from "../ipc";
import type { PlaybookCatalog, TaskExecutionReply } from "../types";

/**
 * A stand-in for the whole ipc module, for tests that render a component.
 *
 * Commands reject unless explicitly overridden, except read-only v2 library and
 * execution queries, which provide valid empty snapshots. This keeps rendered
 * consumers on the real DTO contract without inventing legacy runtime fallbacks.
 * Rejections name the missing command instead of failing during destructuring.
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
  const cache = new Map<string, unknown>([
    [
      "listPlaybookCatalog",
      vi.fn(
        async (): Promise<PlaybookCatalog> => ({
          candidates: [],
          picker_preferences: { order: [], entries: [] },
          diagnostics: [],
        }),
      ),
    ],
    [
      "getTaskExecution",
      vi.fn(
        async (): Promise<TaskExecutionReply> => ({
          state: {
            version: 2,
            revision: 0,
            creation: "ready",
            creation_error: null,
            owning_lane: "test",
            definition_identity: "test-snapshot",
            reference: { scope: "bundled", key: "superdevelop" },
            max_live_sessions: 1,
            enabled_steps: [],
            launch_defaults: { harness: "omp", model: "" },
            executions: {},
            occurrences: {},
            contexts: {},
            collections: {},
          },
          definition: {
            version: 2,
            key: "superdevelop",
            title: "SuperDevelop",
            description: "",
            default_model: "",
            default_harness: "omp",
            step: [],
            preamble: "",
            section_order: [],
          },
        }),
      ),
    ],
  ]);
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
