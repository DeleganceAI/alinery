import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { fakeBoard } from "../test/boardHooks";
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
  getTaskExecution: vi.fn(),
  confirmDanger: vi.fn(),
  listArtifactsWithMetadata: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock("../confirm", () => ({ confirmDanger: mocks.confirmDanger }));

vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
vi.mock("../sync/execution", async (actual) => (await import("../test/executionFeed")).executionHooks(await actual()));
vi.mock("../sync/sessions", async (actual) => ({ ...(await actual<typeof import("../sync/sessions")>()), renameSession: mocks.renameSession }));
vi.mock("../ipc", () =>
  mockIpc({
    getTaskExecution: mocks.getTaskExecution,
    listArtifactsWithMetadata: mocks.listArtifactsWithMetadata,
  }),
);

beforeEach(() => {
  localStorage.removeItem("alinery.taskSessionView");
  fakeBoard.reset();
  mocks.getTaskExecution.mockReset().mockResolvedValue(executionReply([]));

  mocks.confirmDanger.mockReset().mockResolvedValue(true);
  mocks.listArtifactsWithMetadata.mockReset().mockResolvedValue([]);
  mocks.renameSession.mockReset();
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
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    mocks.getTaskExecution.mockRejectedValue(new Error("Invalid execution.json"));
    fakeBoard.set({ taskSessions: [session({ id: "s1" })] as never });
    mocks.listArtifactsWithMetadata.mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);

    renderDetail({ initialTask: fixture });

    // Seeded header survives synchronously.
    expect(screen.getByText(fixture.name)).toBeDefined();
    expect(screen.getByText(fixture.branch)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
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
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    mocks.getTaskExecution.mockResolvedValue(retained);
    fakeBoard.set({ taskSessions: [session({ id: "s1" })] as never });
    mocks.listArtifactsWithMetadata.mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);
    renderDetail({ initialTask: fixture });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

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
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    mocks.getTaskExecution.mockResolvedValue(executionReply([executionRecord({ owner_session_id: "current" })]));
    fakeBoard.set({ taskSessions: [session({ id: "current", phase: "worker" }), session({ id: "historical", playbook: "removed-playbook", phase: "old-phase" })] as never });
    renderDetail({ initialTask: fixture });
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));

    expect(await screen.findByRole("row", { name: "Open session Retained playbook · Retained worker" })).toBeDefined();
    expect(screen.getByRole("row", { name: "Open session removed-playbook · old-phase" })).toBeDefined();
  });
});

describe("a failing artifact scan on an unseeded related-task route", () => {
  it("still renders name/branch/worktree and sessions when getTask succeeds without a seed", async () => {
    const fixture = task({ slug: "related-task", name: "Related Task", branch: "related-branch", worktree: "/w/related-task" });
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    fakeBoard.set({ taskSessions: [session({ id: "s1" })] as never });
    mocks.listArtifactsWithMetadata.mockRejectedValue(new Error("artifact scan failed"));

    // No initialTask — this is App.tsx's related-task navigation case (App.tsx:797).
    renderDetail({ slug: "related-task" });

    // Nothing is seeded synchronously; everything comes from getTask resolving.
    await waitFor(() => expect(screen.getByText("Related Task")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Show list view" }));
    expect(screen.getByText("related-branch")).toBeDefined();
    expect(screen.getByText("/w/related-task")).toBeDefined();
    expect(screen.getByRole("row", { name: "Open session superdevelop · research" })).toBeDefined();

    // The failure is surfaced, not swallowed and not blanking.
    await waitFor(() => expect(screen.getByText("Couldn't load artifacts.")).toBeDefined());
  });
});

describe("a successful listSessions returning an empty array", () => {
  it("shows the empty-sessions state", async () => {
    const fixture = task();
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    fakeBoard.set({ taskSessions: [] as never });
    mocks.listArtifactsWithMetadata.mockResolvedValue([]);

    renderDetail({ initialTask: fixture });

    await waitFor(() => expect(screen.getByText("No sessions yet.")).toBeDefined());
  });
});

describe("an artifact read that fails first and recovers on the next poll", () => {
  it("clears the artifacts warning", async () => {
    vi.useFakeTimers();
    const fixture = task();
    fakeBoard.set({ anyRepoTasks: [fixture] as never });
    mocks.listArtifactsWithMetadata.mockRejectedValueOnce(new Error("artifact scan failed")).mockResolvedValue([artifactItem({ name: "00-ticket.md" })]);

    renderDetail({ initialTask: fixture });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Couldn't load artifacts.")).toBeDefined();
    expect(screen.queryByText("No sessions yet.")).toBeDefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.queryByText("Couldn't load artifacts.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Artifacts", pressed: false }));
    expect(screen.getByText("00-ticket.md")).toBeDefined();
  });
});

it("a rename shows at once and the stream's later name replaces it", async () => {
  const fixture = task();
  let current = { ...session(), name: "Original purpose", name_source: "auto" as const };
  fakeBoard.set({ anyRepoTasks: [fixture] as never, taskSessions: [current] as never });
  mocks.renameSession.mockImplementation(async () => {
    current = { ...current, name: "Committed purpose" };
    fakeBoard.set({ taskSessions: [current] as never });
    return { name: current.name, source: "user" };
  });
  renderDetail({ initialTask: fixture });
  fireEvent.click(await screen.findByRole("button", { name: "Show list view" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Committed purpose" } });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  });
  expect(screen.getByText("Committed purpose")).toBeDefined();
  expect(screen.queryByText("Original purpose")).toBeNull();
  act(() => fakeBoard.set({ taskSessions: [{ ...current, name: "External purpose" }] as never }));
  expect(screen.getByText("External purpose")).toBeDefined();
});
