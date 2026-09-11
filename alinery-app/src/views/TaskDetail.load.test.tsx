import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { ArtifactListItem, PlaybookStepSummary, PlaybookSummary, SessionMeta, Task } from "../types";
import { TaskDetail } from "./TaskDetail";

// Coverage for PR #169 review item 2 (BLOCKING): a failing secondary read in load() or
// refreshLiveTaskState() must never discard an independent successful result. Fixtures and
// mocking pattern copied from TaskDetail.test.tsx (read-only reference, not edited here).

const task = (over: Partial<Task> = {}): Task =>
  ({
    name: "A Task",
    slug: "a-task",
    requested_slug: "a-task",
    branch: "a-task-branch",
    worktree: "/w/a-task",
    has_worktree: true,
    created: 1,
    archived: false,
    pr_url: "",
    linear_id: "",
    github_issue: "",
    playbook: "superdevelop",
    draft: false,
    auto_advance: [],
    ...over,
  }) as Task;

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: "s1",
    worktree: "/w/a-task",
    created: 1,
    archived: false,
    phase: "research",
    harness: "claude",
    model: "",
    playbook: "superdevelop",
    generic: false,
    harness_resume_token: "",
    ...over,
  }) as SessionMeta;

const playbookSummary = (over: Partial<PlaybookSummary> = {}): PlaybookSummary =>
  ({
    key: "superdevelop",
    title: "SuperDevelop",
    description: "",
    kind: "linear",
    default_harness: "claude",
    steps: [],
    auto_advance: [],
    ...over,
  }) as PlaybookSummary;

const step = (over: Partial<PlaybookStepSummary> = {}): PlaybookStepSummary =>
  ({
    key: "research",
    title: "Research",
    short: "",
    artifact: "",
    column: "",
    harness: "",
    ...over,
  }) as PlaybookStepSummary;

const artifactItem = (over: Partial<ArtifactListItem> = {}): ArtifactListItem =>
  ({
    name: "00-ticket.md",
    modified_at_ms: null,
    playbook_step: "research",
    session_id: "s1",
    handoffs: [],
    attachment: false,
    ...over,
  }) as ArtifactListItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// `vi.mock` factories are hoisted above imports, so the mocks it references must be created
// through `vi.hoisted` rather than plain module-scope `const`.
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  listPlaybooks: vi.fn(),
  listPlaybookSteps: vi.fn(),
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  sessionStatuses: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    listPlaybooks: mocks.listPlaybooks,
    listPlaybookSteps: mocks.listPlaybookSteps,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    sessionStatuses: mocks.sessionStatuses,
  }),
);

beforeEach(() => {
  mocks.getTask.mockReset().mockResolvedValue(null);
  mocks.listPlaybooks.mockReset().mockResolvedValue([]);
  mocks.listPlaybookSteps.mockReset().mockResolvedValue([]);
  mocks.listSessions.mockReset().mockResolvedValue([]);
  mocks.listArtifactsWithMetadata.mockReset().mockResolvedValue([]);
  mocks.sessionStatuses.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const noop = () => {};

function renderDetail(props: Partial<Parameters<typeof TaskDetail>[0]> = {}) {
  return render(
    <TaskDetail
      slug={props.slug ?? "a-task"}
      repoPath="/r"
      initialTask={props.initialTask}
      onBack={noop}
      onOpenSession={noop}
      onNewSession={noop}
      onOpenRelatedTask={noop}
      onDuplicate={noop}
      duplicating={false}
      registerNav={noop}
      appearance={DEFAULT_APPEARANCE}
      onAppearanceChange={noop}
      {...props}
    />,
  );
}

describe("an unknown task playbook", () => {
  it("keeps the header, sessions and artifacts visible instead of blanking the page", async () => {
    const fixture = task({ playbook: "removed-playbook" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([]); // the playbook is no longer registered
    mocks.listPlaybookSteps.mockRejectedValue(new Error("unknown playbook 'removed-playbook'"));
    mocks.listSessions.mockResolvedValue([session({ id: "s1" })]);
    mocks.listArtifactsWithMetadata.mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);

    renderDetail({ initialTask: fixture });

    // Seeded header survives synchronously.
    expect(screen.getByText(fixture.name)).toBeDefined();
    expect(screen.getByText(fixture.branch)).toBeDefined();

    // Sessions still render even though the task's own playbook is unknown.
    await waitFor(() => expect(screen.getByText("s1")).toBeDefined());

    // Artifacts still render — switch to the Artifacts tab to observe them.
    fireEvent.click(screen.getByRole("button", { name: "Artifacts", pressed: false }));
    await waitFor(() => expect(screen.getByText("00-ticket.md")).toBeDefined());

    // getTask itself succeeded, so the primary error bar must not appear.
    expect(screen.queryByText("Couldn't load the task.")).toBeNull();
  });
});

describe("an unknown historical-session playbook", () => {
  it("keeps other sessions and their labels rendering when a tail playbook key is unknown", async () => {
    const fixture = task({ playbook: "superdevelop" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary({ key: "superdevelop", title: "SuperDevelop" })]);
    mocks.listSessions.mockResolvedValue([
      session({ id: "current", playbook: "superdevelop", phase: "research" }),
      session({ id: "historical", playbook: "removed-playbook", phase: "old-phase" }),
    ]);
    mocks.listPlaybookSteps.mockImplementation(async (key: string) => {
      if (key === "removed-playbook") throw new Error("unknown playbook 'removed-playbook'");
      return [step({ key: "research", title: "Research" })];
    });

    renderDetail({ initialTask: fixture });

    // The current session's label resolves normally from its real playbook's steps.
    await waitFor(() => expect(screen.getByText("SuperDevelop \u00b7 Research")).toBeDefined());
    // The historical session with the unknown playbook still renders — degraded label
    // (falls back to the raw key and phase) rather than a blank/crashed row.
    expect(screen.getByText("current")).toBeDefined();
    expect(screen.getByText("historical")).toBeDefined();
    expect(screen.getByText("removed-playbook \u00b7 old-phase")).toBeDefined();
  });
});

describe("a failing artifact scan on an unseeded related-task route", () => {
  it("still renders name/branch/worktree and sessions when getTask succeeds without a seed", async () => {
    const fixture = task({ slug: "related-task", name: "Related Task", branch: "related-branch", worktree: "/w/related-task" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([playbookSummary({ key: "superdevelop", title: "SuperDevelop" })]);
    mocks.listPlaybookSteps.mockResolvedValue([step()]);
    mocks.listSessions.mockResolvedValue([session({ id: "s1" })]);
    mocks.listArtifactsWithMetadata.mockRejectedValue(new Error("artifact scan failed"));

    // No initialTask — this is App.tsx's related-task navigation case (App.tsx:797).
    renderDetail({ slug: "related-task" });

    // Nothing is seeded synchronously; everything comes from getTask resolving.
    await waitFor(() => expect(screen.getByText("Related Task")).toBeDefined());
    expect(screen.getByText("related-branch")).toBeDefined();
    expect(screen.getByText("/w/related-task")).toBeDefined();
    expect(screen.getByText("s1")).toBeDefined();

    // The failure is surfaced, not swallowed and not blanking.
    await waitFor(() => expect(screen.getByText("Couldn't load artifacts.")).toBeDefined());
  });
});

describe("a failing listSessions", () => {
  it("never shows the empty-sessions state", async () => {
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([]);
    mocks.listPlaybookSteps.mockResolvedValue([]);
    mocks.listSessions.mockRejectedValue(new Error("sessions read failed"));
    mocks.listArtifactsWithMetadata.mockResolvedValue([]);

    renderDetail({ initialTask: fixture });

    await waitFor(() => expect(screen.getByText("Couldn't load sessions.")).toBeDefined());
    expect(screen.queryByText("No sessions yet.")).toBeNull();
  });
});

describe("a successful listSessions returning an empty array", () => {
  it("shows the empty-sessions state", async () => {
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listPlaybooks.mockResolvedValue([]);
    mocks.listPlaybookSteps.mockResolvedValue([]);
    mocks.listSessions.mockResolvedValue([]);
    mocks.listArtifactsWithMetadata.mockResolvedValue([]);

    renderDetail({ initialTask: fixture });

    await waitFor(() => expect(screen.getByText("No sessions yet.")).toBeDefined());
  });
});

describe("round-trip shape", () => {
  it("still issues the happy path's wave-1 reads concurrently, not as a serial waterfall", async () => {
    const fixture = task({ playbook: "superdevelop" });
    const d = {
      getTask: deferred<Task | null>(),
      listPlaybooks: deferred<PlaybookSummary[]>(),
      listPlaybookSteps: deferred<PlaybookStepSummary[]>(),
      listSessions: deferred<SessionMeta[]>(),
      listArtifactsWithMetadata: deferred<ArtifactListItem[]>(),
    };
    mocks.getTask.mockReturnValue(d.getTask.promise);
    mocks.listPlaybooks.mockReturnValue(d.listPlaybooks.promise);
    mocks.listPlaybookSteps.mockReturnValue(d.listPlaybookSteps.promise);
    mocks.listSessions.mockReturnValue(d.listSessions.promise);
    mocks.listArtifactsWithMetadata.mockReturnValue(d.listArtifactsWithMetadata.promise);

    renderDetail({ initialTask: fixture });

    // All five wave-1 reads fire before any of them has resolved — this is one concurrent
    // wave, not a waterfall where a later call waits on an earlier one's result.
    await waitFor(() => {
      expect(mocks.getTask).toHaveBeenCalledTimes(1);
      expect(mocks.listPlaybooks).toHaveBeenCalledTimes(1);
      expect(mocks.listPlaybookSteps).toHaveBeenCalledTimes(1);
      expect(mocks.listSessions).toHaveBeenCalledTimes(1);
      expect(mocks.listArtifactsWithMetadata).toHaveBeenCalledTimes(1);
    });

    d.getTask.resolve(fixture);
    d.listPlaybooks.resolve([playbookSummary({ key: "superdevelop", title: "SuperDevelop" })]);
    d.listPlaybookSteps.resolve([step({ key: "research", title: "Research" })]);
    d.listSessions.resolve([]);
    d.listArtifactsWithMetadata.resolve([]);

    await waitFor(() => expect(screen.getByText("No sessions yet.")).toBeDefined());
    // The task's real playbook matches the seed, so no dependent-tail refetch of
    // listPlaybookSteps was needed — still exactly the one wave-1 call.
    expect(mocks.listPlaybookSteps).toHaveBeenCalledTimes(1);
  });
});

// PR #169 second review, item 2: load()'s failures were latched in one shared warning that
// only load() could clear, and refreshLiveTaskState() never set sessionsLoaded. A transient
// first read therefore left the warning up — and "No sessions yet." hidden — forever.
describe("a session read that fails first and succeeds on the next poll", () => {
  it("clears the warning and lets the empty state through", async () => {
    vi.useFakeTimers();
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockRejectedValueOnce(new Error("sessions read failed")).mockResolvedValue([]);

    renderDetail({ initialTask: fixture });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Couldn't load sessions.")).toBeDefined();
    expect(screen.queryByText("No sessions yet.")).toBeNull();

    // One 3s poll later the same read succeeds, empty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.queryByText("Couldn't load sessions.")).toBeNull();
    expect(screen.getByText("No sessions yet.")).toBeDefined();
  });
});

describe("an artifact read that recovers while sessions stay broken", () => {
  it("clears only the artifact half of the warning", async () => {
    vi.useFakeTimers();
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockRejectedValue(new Error("sessions read failed"));
    mocks.listArtifactsWithMetadata.mockRejectedValueOnce(new Error("artifact scan failed")).mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);

    renderDetail({ initialTask: fixture });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Couldn't load sessions and artifacts.")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    // Artifacts recovered independently; the still-failing sessions read keeps its own half.
    expect(screen.getByText("Couldn't load sessions.")).toBeDefined();
    expect(screen.queryByText("No sessions yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Artifacts", pressed: false }));
    expect(screen.getByText("00-ticket.md")).toBeDefined();
  });
});
