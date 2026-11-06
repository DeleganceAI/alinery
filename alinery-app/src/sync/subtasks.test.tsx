import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { SubtaskService } from "alinery-proto/alinery/v1/subtasks_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { discardSubtask, startSubtaskManager, subtaskState } from "./subtasks";

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
      router.service(SubtaskService, {
        subtaskState: wrap("subtaskState"),
        startManager: wrap("startManager"),
        discardSubtask: wrap("discardSubtask"),
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

const summary = (slug: string) => ({
  name: slug.toUpperCase(),
  slug,
  branch: slug,
  worktree: `/w/${slug}`,
  hasWorktree: true,
  playbook: "superdevelop",
  archived: false,
  draft: false,
  subtaskOutcome: "",
});

describe("state", () => {
  it("reads the links, the manager sessions and the reason from the repository's daemon", async () => {
    handlers.subtaskState = () => ({
      task: summary("parent"),
      activeSubtask: { ...summary("child"), archived: true, subtaskOutcome: "killed" },
      managerSession: { id: "m1", worktree: "/w/parent", created: 5n, subtaskManager: true, subtaskSlug: "child", harness: "omp" },
      managerOwnerTaskSlug: "parent",
      canStart: false,
      canRecover: true,
      disabledReason: "Finish the active sub-task before starting another",
    });
    const r = await subtaskState("/repo", "parent");
    expect(seen).toMatchObject([{ method: "subtaskState", repo: "/repo", req: { slug: "parent" } }]);
    expect(r.task).toEqual({
      name: "PARENT",
      slug: "parent",
      branch: "parent",
      worktree: "/w/parent",
      has_worktree: true,
      playbook: "superdevelop",
      archived: false,
      draft: false,
      subtask_outcome: "",
    });
    expect(r.active_subtask).toMatchObject({ slug: "child", archived: true, subtask_outcome: "killed" });
    expect(r.parent_task).toBeNull();
    expect(r.manager_session).toMatchObject({ id: "m1", created: 5, subtask_manager: true, subtask_slug: "child", harness: "omp" });
    expect(r.parent_manager_session).toBeNull();
    expect(r).toMatchObject({ manager_owner_task_slug: "parent", can_start: false, can_recover: true, disabled_reason: "Finish the active sub-task before starting another" });
  });

  it("surfaces the daemon's message, not the gRPC wrapper", async () => {
    handlers.subtaskState = () => {
      throw new ConnectError("no such task: nope", Code.NotFound);
    };
    await expect(subtaskState("/repo", "nope")).rejects.toThrow(/^no such task: nope$/);
  });
});

describe("manager", () => {
  it("starts a manager with a mutation id and hands back the session the view opens", async () => {
    handlers.startManager = () => ({
      applied: {},
      started: { session: { id: "m1", worktree: "/w/parent", created: 1n, subtaskManager: true }, start: "started", errors: [] },
    });
    const reply = await startSubtaskManager("/repo", "parent");
    expect(reply).toMatchObject({ session: { id: "m1", subtaskManager: true }, start: "started" });
    expect(seen[0]).toMatchObject({ method: "startManager", repo: "/repo", req: { slug: "parent", recover: false, meta: { mutationId: expect.any(String) } } });
    await startSubtaskManager("/repo", "parent", true);
    expect(seen[1].req.recover).toBe(true);
  });
});

describe("discard", () => {
  it("kills with a mutation id; the automatic backup is the daemon's own", async () => {
    handlers.discardSubtask = () => ({ applied: {}, stoppedSessionIds: ["m1"] });
    await discardSubtask("/repo", "parent", "m1");
    expect(seen).toMatchObject([{ method: "discardSubtask", repo: "/repo", req: { slug: "parent", managerSessionId: "m1", meta: { mutationId: expect.any(String) } } }]);
  });

  it("fails with the daemon's reason and leaves nothing to retry blindly", async () => {
    handlers.discardSubtask = () => {
      throw new ConnectError("task has no active sub-task to discard", Code.FailedPrecondition);
    };
    await expect(discardSubtask("/repo", "parent", "")).rejects.toThrow(/^task has no active sub-task to discard$/);
  });
});
