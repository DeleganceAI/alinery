import { describe, expect, it, vi } from "vitest";
import { readTaskExecution, readTaskExecutions } from "./useExecutionObservation";
import { executionReply } from "./views/executionTestFixture";

const observeTaskExecutions = vi.hoisted(() => vi.fn());
vi.mock("./ipc", () => ({ observeTaskExecutions }));
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("execution observation admission", () => {
  it("coalesces same-turn reads into one batch and keeps the next set pending", async () => {
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    observeTaskExecutions.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const one = readTaskExecution("/repo-a", "one");
    const two = readTaskExecution("/repo-b", "one");
    const again = readTaskExecution("/repo-a", "one");
    await Promise.resolve();
    expect(observeTaskExecutions).toHaveBeenCalledTimes(1);
    expect(observeTaskExecutions.mock.calls[0][0]).toEqual([
      { repoPath: "/repo-a", taskSlug: "one" },
      { repoPath: "/repo-b", taskSlug: "one" },
    ]);

    const later = readTaskExecution("/repo-a", "two");
    await Promise.resolve();
    expect(observeTaskExecutions).toHaveBeenCalledTimes(1);

    first.resolve([
      { repo_path: "/repo-a", task_slug: "one", execution: { live: { status: "available" } } },
      { repo_path: "/repo-b", task_slug: "one", error: "saved state is corrupt" },
    ]);
    await expect(one).resolves.toEqual({ live: { status: "available" } });
    await expect(again).resolves.toEqual({ live: { status: "available" } });
    await expect(two).rejects.toBe("saved state is corrupt");
    await Promise.resolve();
    expect(observeTaskExecutions).toHaveBeenCalledTimes(2);
    expect(observeTaskExecutions.mock.calls[1][0]).toEqual([{ repoPath: "/repo-a", taskSlug: "two" }]);
    second.resolve([{ repo_path: "/repo-a", task_slug: "two", execution: { live: { status: "offline" } } }]);
    await expect(later).resolves.toEqual({ live: { status: "offline" } });
  });

  it("replaces live continuation authority with saved history after disconnect", async () => {
    const live = executionReply();
    live.state.executions["execution-a"].last_ready_revision = 7;
    live.state.executions["execution-a"].ready_revision = 7;
    live.continuation["execution-a"] = { process_incarnation: "owner-process", available: true, reason: null };
    const saved = structuredClone(live);
    saved.live = { status: "offline", detail: "owner disconnected" };
    saved.continuation = {};
    observeTaskExecutions
      .mockReset()
      .mockResolvedValueOnce([{ repo_path: "/repo", task_slug: "task", execution: live }])
      .mockResolvedValueOnce([{ repo_path: "/repo", task_slug: "task", execution: saved }]);

    expect((await readTaskExecution("/repo", "task")).continuation["execution-a"].available).toBe(true);
    const disconnected = await readTaskExecution("/repo", "task");
    expect(disconnected.continuation).toEqual({});
    expect(disconnected.live.status).toBe("offline");
    expect(disconnected.state.executions["execution-a"].last_ready_revision).toBe(7);
  });

  it("returns an empty batch without a native call", async () => {
    observeTaskExecutions.mockReset();
    await expect(readTaskExecutions([])).resolves.toEqual([]);
    expect(observeTaskExecutions).not.toHaveBeenCalled();
  });
});
