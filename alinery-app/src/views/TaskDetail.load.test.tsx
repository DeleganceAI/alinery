import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { mockIpc } from "../test/mockIpc";
import type { ArtifactListItem, SessionMeta, Task } from "../types";
import { executionRecord, executionReply } from "./executionTestFixture";
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

// `vi.mock` factories are hoisted above imports, so the mocks it references must be created
// through `vi.hoisted` rather than plain module-scope `const`.
const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  getTaskExecution: vi.fn(),
  listSessions: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  sessionStatuses: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    getTask: mocks.getTask,
    getTaskExecution: mocks.getTaskExecution,
    listSessions: mocks.listSessions,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
    sessionStatuses: mocks.sessionStatuses,
  }),
);

beforeEach(() => {
  mocks.getTask.mockReset().mockResolvedValue(null);
  mocks.getTaskExecution.mockReset().mockResolvedValue(executionReply([]));
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

describe("an unreadable saved execution state", () => {
  it("keeps the header, sessions and artifacts visible instead of blanking the page", async () => {
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.getTaskExecution.mockRejectedValue(new Error("Invalid execution.json"));
    mocks.listSessions.mockResolvedValue([session({ id: "s1" })]);
    mocks.listArtifactsWithMetadata.mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);

    renderDetail({ initialTask: fixture });

    // Seeded header survives synchronously.
    expect(screen.getByText(fixture.name)).toBeDefined();
    expect(screen.getByText(fixture.branch)).toBeDefined();

    // Sessions still render with historical metadata when execution state is unavailable.
    await waitFor(() => expect(screen.getByRole("row", { name: "Open session superdevelop · research" })).toBeDefined());

    // Artifacts still render — switch to the Artifacts tab to observe them.
    fireEvent.click(screen.getByRole("button", { name: "Artifacts", pressed: false }));
    await waitFor(() => expect(screen.getByText("00-ticket.md")).toBeDefined());
    expect(screen.getByRole("alert").textContent).toContain("Invalid execution.json");

    // getTask itself succeeded, so the primary error bar must not appear.
    expect(screen.queryByText("Couldn't load the task.")).toBeNull();
  });
});

describe("saved execution state without live access", () => {
  it("keeps sessions, retained history and artifacts available for a foreign owner", async () => {
    const fixture = task();
    const retained = executionReply([executionRecord({ owner_session_id: "s1" })]);
    retained.live = { status: "foreign_owner", detail: "Owner configuration differs from this app" };
    mocks.getTask.mockResolvedValue(fixture);
    mocks.getTaskExecution.mockResolvedValue(retained);
    mocks.listSessions.mockResolvedValue([session({ id: "s1" })]);
    mocks.listArtifactsWithMetadata.mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);
    renderDetail({ initialTask: fixture });

    await screen.findByRole("row", { name: "Open session Retained playbook · Retained worker" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByText(retained.live.detail).closest("details") as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("article", { name: "Execution execution-a" })).toBeDefined();
    expect((screen.getByRole("button", { name: "Allow this session to complete · s1" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Artifacts", pressed: false }));
    expect(await screen.findByText("00-ticket.md")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a removed library definition", () => {
  it("keeps retained labels and historical sessions without foreign library lookup", async () => {
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
    mocks.getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "current" })]));
    mocks.listSessions.mockResolvedValue([session({ id: "current", phase: "worker" }), session({ id: "historical", playbook: "removed-playbook", phase: "old-phase" })]);
    renderDetail({ initialTask: fixture });

    expect(await screen.findByRole("row", { name: "Open session Retained playbook · Retained worker" })).toBeDefined();
    expect(screen.getByRole("row", { name: "Open session removed-playbook · old-phase" })).toBeDefined();
  });
});

describe("a failing artifact scan on an unseeded related-task route", () => {
  it("still renders name/branch/worktree and sessions when getTask succeeds without a seed", async () => {
    const fixture = task({ slug: "related-task", name: "Related Task", branch: "related-branch", worktree: "/w/related-task" });
    mocks.getTask.mockResolvedValue(fixture);
    mocks.listSessions.mockResolvedValue([session({ id: "s1" })]);
    mocks.listArtifactsWithMetadata.mockRejectedValue(new Error("artifact scan failed"));

    // No initialTask — this is App.tsx's related-task navigation case (App.tsx:797).
    renderDetail({ slug: "related-task" });

    // Nothing is seeded synchronously; everything comes from getTask resolving.
    await waitFor(() => expect(screen.getByText("Related Task")).toBeDefined());
    expect(screen.getByText("related-branch")).toBeDefined();
    expect(screen.getByText("/w/related-task")).toBeDefined();
    expect(screen.getByRole("row", { name: "Open session superdevelop · research" })).toBeDefined();

    // The failure is surfaced, not swallowed and not blanking.
    await waitFor(() => expect(screen.getByText("Couldn't load artifacts.")).toBeDefined());
  });
});

describe("a failing listSessions", () => {
  it("never shows the empty-sessions state", async () => {
    const fixture = task();
    mocks.getTask.mockResolvedValue(fixture);
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
    mocks.listSessions.mockResolvedValue([]);
    mocks.listArtifactsWithMetadata.mockResolvedValue([]);

    renderDetail({ initialTask: fixture });

    await waitFor(() => expect(screen.getByText("No sessions yet.")).toBeDefined());
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
