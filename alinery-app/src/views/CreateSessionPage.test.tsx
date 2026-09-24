import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { BoardTask, TaskExecutionReply } from "../types";
import { CreateSessionPage } from "./CreateSessionPage";
import { executionRecord, executionReply } from "./executionTestFixture";

const task: BoardTask = {
  name: "A task",
  slug: "a-task",
  branch: "a-task",
  repo_path: "/r",
  worktree: "/w/a-task",
  has_worktree: true,
  created: 1,
  updated: 1,
  archived: false,
  draft: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  auto_advance: [],
  playbook: "deleted-from-library",
  playbook_ref: { scope: "repo", key: "deleted-from-library" },
  playbook_title: "Retained workflow",
  playbook_steps: [],
  session_count: 0,
  current_phase: "",
  current_step_title: "",
  latest_session_title: "",
  latest_session_column_key: "",
  current_column_key: "",
  current_column_title: "",
};
const mocks = vi.hoisted(() => ({ getTaskExecution: vi.fn(), listBoardTasks: vi.fn(), askConfirm: vi.fn() }));
vi.mock("../confirm", () => ({ askConfirm: mocks.askConfirm }));
vi.mock("../ipc", () => mockIpc({ getTaskExecution: mocks.getTaskExecution, listBoardTasks: mocks.listBoardTasks, listHarnessModelsForRepo: async () => [] }));

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
  mocks.listBoardTasks.mockReset().mockResolvedValue([task]);
  mocks.getTaskExecution.mockReset().mockResolvedValue(executionReply([executionRecord({ lifecycle: "queued" })]));
  mocks.askConfirm.mockReset().mockResolvedValue("cancel");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPage(onCreated = vi.fn(async () => {})) {
  render(<CreateSessionPage allRepos={false} activeRepo="/r" onCancel={() => {}} onCreated={onCreated} />);
  return onCreated;
}

function choose(value: string) {
  fireEvent.change(screen.getByLabelText("Session type"), { target: { value } });
}

describe("retained execution session selection", () => {
  it("starts the exact reserved binding after its library definition was removed", async () => {
    const created = renderPage();
    await screen.findByRole("option", { name: /Start queued · Retained worker · execution-a/ });
    expect(screen.getByText("research/1-request-2.md")).toBeDefined();
    expect(screen.getByText("research/2-result-10.md")).toBeDefined();
    expect(screen.getByText(/Current owner owner-a/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(task, { kind: "existing", session_id: "owner-a" }, "omp", "", undefined));
  });

  it("offers recovery only for an unaccepted execution with proven stopped ownership", async () => {
    mocks.getTaskExecution.mockResolvedValue(
      executionReply([
        executionRecord({ id: "stopped", lifecycle: "failed", shutdown_confirmed: true, error: "Process exited before completing" }),
        executionRecord({ id: "uncertain", lifecycle: "interrupted" }),
        executionRecord({ id: "accepted", lifecycle: "finishing", receipt_id: "receipt" }),
      ]),
    );
    const created = renderPage();
    await screen.findByRole("option", { name: /Recover · Retained worker · stopped/ });
    expect(screen.queryByRole("option", { name: /Recover.*uncertain/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Recover.*accepted/ })).toBeNull();
    choose("recover:stopped");
    expect(screen.getByText("Process exited before completing")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(task, { kind: "primary", step_key: "worker", execution_id: "stopped" }, "omp", "", undefined));
  });

  it("binds an independent execution to recorded occurrence IDs without guessing filenames", async () => {
    const created = renderPage();
    await screen.findByRole("option", { name: /Independent execution/ });
    choose("manual:execution-a");
    fireEvent.change(screen.getByLabelText("Additional instructions"), { target: { value: "Also check the boundary." } });
    expect(screen.queryByText("research/2-result-10.md")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith(task, { kind: "primary", step_key: "worker", input_occurrence_ids: ["input-a"] }, "omp", "", "Also check the boundary."),
    );
  });

  it("keeps auxiliary Terminal separate when graph state cannot be loaded", async () => {
    mocks.getTaskExecution.mockRejectedValue(new Error("pre-v2 task has no execution state"));
    const created = renderPage();
    await screen.findByText(/Could not load retained execution state/);
    expect(screen.queryByRole("option", { name: /Retained worker/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(task, { kind: "auxiliary" }, "no-harness", "", undefined));
  });

  it.each(["offline", "foreign_owner", undefined] as const)("keeps saved bindings browsable but blocks graph launches when live status is %s", async (status) => {
    const saved = executionReply([executionRecord({ lifecycle: "queued" }), executionRecord({ id: "stopped", lifecycle: "failed", shutdown_confirmed: true })]);
    mocks.getTaskExecution.mockResolvedValue({ ...saved, live: status ? { status, detail: "Owner cannot be queried" } : undefined });
    const created = renderPage();
    const queued = await screen.findByRole("option", { name: /Start queued · Retained worker · execution-a/ });
    expect((queued.closest("optgroup") as HTMLOptGroupElement).disabled).toBe(true);
    expect(screen.getByText("research/1-request-2.md")).toBeDefined();
    expect(screen.getByText("research/2-result-10.md")).toBeDefined();
    fireEvent.click(screen.getByText("Retained step instructions"));
    expect(screen.getByText("Use the exact assigned request, not the newest filename.")).toBeDefined();

    for (const selection of ["existing:execution-a", "recover:stopped", "manual:execution-a"]) {
      // Force selection as well as a keyboard launch to exercise the handler's authority guard.
      choose(selection);
      const launch = screen.getByRole("button", { name: "Launch" });
      expect((launch as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(launch);
      fireEvent.keyDown(launch, { key: "Enter", ctrlKey: true });
    }
    expect(created).not.toHaveBeenCalled();

    choose("auxiliary");
    fireEvent.click(screen.getByText("Retained playbook instructions"));
    expect(screen.getByText("Use the exact assigned request, not the newest filename.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(task, { kind: "auxiliary" }, "no-harness", "", undefined));
  });

  it("does not replace another task's binding with a late query response", async () => {
    let resolve!: (value: TaskExecutionReply) => void;
    const pending = new Promise<TaskExecutionReply>((accept) => {
      resolve = accept;
    });
    mocks.listBoardTasks.mockResolvedValue([task, { ...task, name: "B task", slug: "b-task", worktree: "/w/b-task" }]);
    mocks.getTaskExecution.mockImplementation((slug: string) =>
      slug === "a-task" ? pending : Promise.resolve(executionReply([executionRecord({ id: "b-only", lifecycle: "queued", owner_session_id: "owner-b" })])),
    );
    const created = renderPage();
    const b = (await screen.findByRole("option", { name: "B task" })) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: b.value } });
    await screen.findByRole("option", { name: /Start queued.*b-only/ });
    await act(async () => resolve(executionReply()));
    expect(screen.queryByRole("option", { name: /execution-a/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith(expect.objectContaining({ slug: "b-task" }), { kind: "existing", session_id: "owner-b" }, "omp", "", undefined));
  });

  it("preserves edited instructions when a context-change discard is cancelled", async () => {
    renderPage();
    await screen.findByRole("option", { name: /Independent execution/ });
    choose("manual:execution-a");
    fireEvent.change(screen.getByLabelText("Additional instructions"), { target: { value: "Keep this draft" } });
    choose("auxiliary");
    await waitFor(() => expect(mocks.askConfirm).toHaveBeenCalled());
    expect((screen.getByLabelText("Additional instructions") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect((screen.getByLabelText("Session type") as HTMLSelectElement).value).toBe("manual:execution-a");
  });
});
