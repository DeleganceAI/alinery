import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { GitService } from "alinery-proto/alinery/v1/git_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { listTaskPullRequests, pushAndCompareUrlForRepo, removeWorktreeForRepo, taskSourceBranchesForRepo } from "./git";

const ipc = vi.hoisted(() => ({ lookupTaskPullRequest: vi.fn() }));
vi.mock("../ipc", async () => (await import("../test/mockIpc")).mockIpc(ipc));
vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));

type Handlers = Record<string, (req: never) => unknown>;
let seen: { method: string; req: Record<string, unknown>; repo: string }[];
let handlers: Handlers;

function serve() {
  vi.mocked(daemonTransport).mockImplementation((repo: string) => {
    const wrap = (method: string) => (req: never) => {
      seen.push({ method, req: req as never, repo });
      return handlers[method]?.(req);
    };
    return createRouterTransport((router) => {
      router.service(GitService, {
        taskSourceBranches: wrap("taskSourceBranches"),
        removeWorktree: wrap("removeWorktree"),
        pushAndCompareUrl: wrap("pushAndCompareUrl"),
        taskPullRequestInputs: wrap("taskPullRequestInputs"),
        recordDiscoveredPullRequest: wrap("recordDiscoveredPullRequest"),
      } as never);
    }) as Transport;
  });
}

beforeEach(() => {
  seen = [];
  handlers = {};
  serve();
});
afterEach(() => vi.resetAllMocks());

describe("source branches", () => {
  it("reads the branches, HEAD and the saved choice from the repository's daemon", async () => {
    handlers.taskSourceBranches = () => ({
      branches: [{ fullRef: "refs/heads/main", name: "main" }],
      head: { head: { case: "branch", value: { fullRef: "refs/heads/main", name: "main" } } },
      selected: { baseRef: "refs/heads/old", available: false },
    });
    const r = await taskSourceBranchesForRepo("/repo", "refs/heads/old");
    expect(r).toEqual({
      branches: [{ full_ref: "refs/heads/main", name: "main" }],
      head: { kind: "branch", full_ref: "refs/heads/main", name: "main" },
      selected: { base_ref: "refs/heads/old", available: false },
    });
    expect(seen).toMatchObject([{ method: "taskSourceBranches", repo: "/repo", req: { selectedBaseRef: "refs/heads/old" } }]);
  });

  it("maps a detached and an unborn HEAD, and an absent selection", async () => {
    handlers.taskSourceBranches = () => ({ head: { head: { case: "detachedOid", value: "abc" } } });
    expect(await taskSourceBranchesForRepo("/repo", null)).toEqual({ branches: [], head: { kind: "detached", oid: "abc" }, selected: null });
    expect(seen[0].req.selectedBaseRef).toBeUndefined();
    handlers.taskSourceBranches = () => ({ head: { head: { case: "unborn", value: { fullRef: "refs/heads/main", name: "main" } } } });
    expect((await taskSourceBranchesForRepo("/repo")).head).toEqual({ kind: "unborn", full_ref: "refs/heads/main", name: "main" });
  });

  it("fails when the daemon names no HEAD", async () => {
    handlers.taskSourceBranches = () => ({});
    await expect(taskSourceBranchesForRepo("/repo")).rejects.toThrow("no HEAD");
  });

  it("surfaces the daemon's message, not the gRPC wrapper", async () => {
    handlers.taskSourceBranches = () => {
      throw new ConnectError("not a git repository", Code.FailedPrecondition);
    };
    await expect(taskSourceBranchesForRepo("/repo")).rejects.toThrow(/^not a git repository$/);
  });
});

describe("worktree and push", () => {
  it("removes a worktree with a mutation id so a retry is not a second removal", async () => {
    handlers.removeWorktree = () => ({});
    await removeWorktreeForRepo("/repo", "task");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "removeWorktree", repo: "/repo", req: { slug: "task" } });
    expect((seen[0].req.meta as { mutationId: string }).mutationId).not.toBe("");
  });

  it("returns the compare URL", async () => {
    handlers.pushAndCompareUrl = () => ({ compareUrl: "https://github.com/acme/app/compare/task?expand=1" });
    expect(await pushAndCompareUrlForRepo("/repo", "task")).toBe("https://github.com/acme/app/compare/task?expand=1");
  });

  it("fails with the daemon's message when the push was rejected", async () => {
    handlers.pushAndCompareUrl = () => {
      throw new ConnectError("git push failed: rejected", Code.FailedPrecondition);
    };
    await expect(pushAndCompareUrlForRepo("/repo", "task")).rejects.toThrow("git push failed: rejected");
  });
});

describe("pull requests", () => {
  const inputs = { prUrl: "", branch: "task", originUrl: "git@github.com:acme/app.git" };
  const pr = { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" as const };

  it("asks the daemon what the task has, GitHub from this machine, then records a link it found", async () => {
    handlers.taskPullRequestInputs = () => inputs;
    handlers.recordDiscoveredPullRequest = () => ({});
    ipc.lookupTaskPullRequest.mockResolvedValue(pr);
    const out = await listTaskPullRequests([{ repoPath: "/repo", taskSlug: "task" }]);
    expect(out).toEqual({ "/repo:task": { pr, error: null } });
    expect(ipc.lookupTaskPullRequest).toHaveBeenCalledExactlyOnceWith("", "task", "git@github.com:acme/app.git");
    expect(seen.map((s) => s.method)).toEqual(["taskPullRequestInputs", "recordDiscoveredPullRequest"]);
    expect(seen[1].req).toMatchObject({ slug: "task", branch: "task", previousUrl: "", url: pr.url });
  });

  it("records nothing when GitHub has no pull request, and passes a missing origin as null", async () => {
    handlers.taskPullRequestInputs = () => ({ prUrl: "", branch: "task" });
    ipc.lookupTaskPullRequest.mockResolvedValue(null);
    const out = await listTaskPullRequests([{ repoPath: "/repo", taskSlug: "task" }]);
    expect(out["/repo:task"]).toEqual({ pr: null, error: null });
    expect(ipc.lookupTaskPullRequest).toHaveBeenCalledWith("", "task", null);
    expect(seen.map((s) => s.method)).toEqual(["taskPullRequestInputs"]);
  });

  it("keeps one task's failure to itself and looks a duplicate reference up once", async () => {
    handlers.taskPullRequestInputs = (req: never) => {
      if ((req as { slug: string }).slug === "bad") throw new ConnectError("no such task", Code.NotFound);
      return inputs;
    };
    ipc.lookupTaskPullRequest.mockResolvedValue(null);
    const out = await listTaskPullRequests([
      { repoPath: "/repo", taskSlug: "bad" },
      { repoPath: "/repo", taskSlug: "good" },
      { repoPath: "/repo", taskSlug: "good" },
    ]);
    expect(out["/repo:bad"]).toEqual({ pr: null, error: "no such task" });
    expect(out["/repo:good"]).toEqual({ pr: null, error: null });
    expect(seen.filter((s) => s.method === "taskPullRequestInputs")).toHaveLength(2);
  });

  it("runs at most four lookups at a time", async () => {
    let active = 0;
    let peak = 0;
    handlers.taskPullRequestInputs = () => inputs;
    ipc.lookupTaskPullRequest.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return null;
    });
    await listTaskPullRequests(Array.from({ length: 10 }, (_, i) => ({ repoPath: "/repo", taskSlug: `t${i}` })));
    expect(peak).toBe(4);
  });
});
