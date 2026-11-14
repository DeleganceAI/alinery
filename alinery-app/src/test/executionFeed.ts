// The execution feed of src/sync/execution.ts, for view tests whose subject is the view, not the stream. The
// replies come from the `getTaskExecution` stub the test gave `mockIpc` (which hands it over), so a test states the execution the way
// it always has. `fakeExecution.refresh()` stands for a delta arriving: every mounted `useTaskExecution` reads
// the stub again. An approval calls `fakeExecution.allow` and then refreshes, as the real one resolves once the
// replica has the change. The stream itself is tested in sync/execution.test.tsx.
//
//     vi.mock("../sync/execution", async (actual) => (await import("../test/executionFeed")).executionHooks(await actual()));
import { useEffect, useState } from "react";
import { vi } from "vitest";
import type * as Execution from "../sync/execution";
import type { TaskExecutionReply } from "../types";

type Stub = (taskSlug: string, repoPath?: string) => Promise<TaskExecutionReply>;

const listeners = new Set<() => void>();

export const fakeExecution = {
  /** Set by `mockIpc`: the test's `getTaskExecution`. */
  source: undefined as Stub | undefined,
  /** The approval a view made: (repo, slug, executionId, expectedRevision). */
  allow: vi.fn(async (_repo: string, _slug: string, _executionId: string, _revision?: bigint): Promise<void> => {}),
  /** A delta arrived: every mounted feed reads again. */
  refresh() {
    for (const l of [...listeners]) l();
  },
  reset() {
    fakeExecution.allow.mockReset().mockResolvedValue(undefined);
  },
};

export function executionHooks(actual: typeof Execution): typeof Execution {
  const read = (repo: string, slug: string) => {
    if (!fakeExecution.source) return Promise.reject("mockIpc() was not called, so there is no getTaskExecution");
    // A bare vi.fn() answers undefined: no execution, as the batch did.
    return Promise.resolve(fakeExecution.source(slug, repo)).then((reply) => reply ?? Promise.reject("missing execution outcome"));
  };
  return {
    ...actual,
    readTaskExecution: (repo, slug) => read(repo, slug),
    readTaskExecutions: (refs) =>
      Promise.all(
        refs.map(async (ref) => {
          try {
            return { ref, execution: await read(ref.repoPath, ref.taskSlug), error: "" };
          } catch (error) {
            return { ref, execution: null, error: String(error) };
          }
        }),
      ),
    useTaskExecution(repo, slug) {
      const [value, setValue] = useState<{ reply?: TaskExecutionReply; error: string; ready: boolean }>({ error: "", ready: false });
      useEffect(() => {
        if (!slug) return setValue({ error: "", ready: true });
        let alive = true;
        const load = () =>
          read(repo, slug).then(
            (reply) => alive && setValue({ reply, error: "", ready: true }),
            (error) => alive && setValue({ error: String(error), ready: true }),
          );
        void load();
        listeners.add(load);
        return () => {
          alive = false;
          listeners.delete(load);
        };
      }, [repo, slug]);
      return value;
    },
    async allowExecutionCompletion(repo, slug, executionId, revision) {
      await fakeExecution.allow(repo, slug, executionId, revision);
      fakeExecution.refresh();
    },
  };
}
