import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskKey } from "../shared";
import type * as IpcFixtures from "../test/mockIpc";
import type { BoardTask, NormalizedPlaybook, ReviewHandoffResult, ScopedSettings, TaskExecutionReply } from "../types";
import { ReviewHandoffPage } from "./ReviewHandoffPage";

const sourceTask = {
  name: "Source",
  slug: "shared",
  requested_slug: "shared",
  parent_task: "",
  active_subtask: "",
  branch: "source",
  worktree: "/w/source",
  has_worktree: true,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "superdevelop",
  draft: false,
  auto_advance: [],
  repo_path: "/a",
  session_count: 0,
  playbook_title: "SuperDevelop",
  playbook_steps: [],
  updated: 1,
  current_phase: "research",
  current_step_title: "Research",
  current_column_key: "research-design",
  current_column_title: "Research & Design",
  latest_session_title: "",
  latest_session_column_key: "",
} as BoardTask;
const foreignTask: BoardTask = { ...sourceTask, name: "Foreign shared", repo_path: "/b", worktree: "/w/foreign" };
const otherTask: BoardTask = { ...foreignTask, name: "Other", slug: "other", worktree: "/w/other" };
const definition: NormalizedPlaybook = {
  version: 2,
  key: "retained",
  title: "Retained",
  description: "",
  default_model: "",
  default_harness: "omp",
  preamble: "",
  section_order: ["repair"],
  step: [
    {
      key: "repair",
      title: "Retained repair",
      short: "",
      inputs: [],
      outputs: [{ path: "repair.md" }],
      model: "",
      harness: "",
      is_coding_step: true,
      auto_advance_default: false,
      prompt: "Repair the findings.",
    },
  ],
};
const handoffRecord = {
  version: 1,
  direction: "outbound",
  source_task: "shared",
  source_session: "s1",
  source_artifact: "review/3-findings-1.md",
  target_task: "shared",
  target_artifact: "review-handoff-001.md",
  target_session: "target-session",
  target_phase: "repair",
  created_at_ms: 1,
};
const handoffResult: ReviewHandoffResult = {
  target_repo_path: "/b",
  target_artifact: "review-handoff-001.md",
  start: "not_requested",
  errors: [],
  target_session: {
    id: "target-session",
    worktree: "/w/foreign",
    created: 1,
    archived: false,
    phase: "repair",
    harness: "omp",
    model: "",
    playbook: "",
    generic: false,
    harness_resume_token: "",
  },
  source_record: handoffRecord,
  target_record: { ...handoffRecord, direction: "inbound" },
};
const mocks = vi.hoisted(() => ({
  listBoardTasks: vi.fn(),
  readScopedSettingsForRepo: vi.fn(),
  getTaskExecution: vi.fn(),
  sendReviewHandoff: vi.fn(),
}));
vi.mock("../ipc", async () => {
  // The hoisted IPC factory runs before shared.tsx finishes importing its dependencies.
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc(mocks);
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listBoardTasks.mockResolvedValue([sourceTask, foreignTask, otherTask]);
  mocks.readScopedSettingsForRepo.mockResolvedValue({ effective: { defaults: { harness: "omp", model: "gpt-5" } } } as ScopedSettings);
  mocks.getTaskExecution.mockResolvedValue({ definition } as TaskExecutionReply);
});
afterEach(cleanup);

function renderPage(onConfirmed = vi.fn()) {
  return render(
    <ReviewHandoffPage
      source={{ source_repo_path: "/a", source_slug: "shared", source_session: "s1", source_artifact: "review/3-findings-1.md" }}
      allRepos
      activeRepo="/a"
      onCancel={() => {}}
      onConfirmed={onConfirmed}
    />,
  );
}
async function selectTarget(task: BoardTask = foreignTask) {
  await screen.findByRole("option", { name: new RegExp(task.name) });
  fireEvent.change(screen.getByLabelText("Target task"), { target: { value: taskKey(task) } });
  await screen.findByRole("option", { name: "Retained repair" });
}

describe("ReviewHandoffPage", () => {
  it("same-slug foreign repository target remains selectable and receives the selected handoff", async () => {
    const result = handoffResult;
    mocks.getTaskExecution.mockImplementation(async (slug: string, repo: string) => {
      if (repo !== "/b" || slug !== "shared") throw new Error("Wrong target repository");
      return { definition } as TaskExecutionReply;
    });
    mocks.sendReviewHandoff.mockResolvedValue(result);
    const onConfirmed = vi.fn();
    renderPage(onConfirmed);
    await selectTarget();
    expect(screen.queryByRole("option", { name: /^Source/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Foreign shared/ })).toBeTruthy();
    expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe("/w/foreign");
    expect((screen.getByRole("button", { name: "Confirm handoff" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Target step"), { target: { value: "repair" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm handoff" }));
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(result));
  });

  it("keeps a created session inspectable when the handoff reports a partial failure", async () => {
    const result: ReviewHandoffResult = {
      ...handoffResult,
      start: "failed",
      errors: [{ stage: "launch", code: "launch_failed", message: "Runner unavailable" }],
    };
    mocks.sendReviewHandoff.mockResolvedValue(result);
    const onConfirmed = vi.fn();
    renderPage(onConfirmed);
    await selectTarget();
    fireEvent.change(screen.getByLabelText("Target step"), { target: { value: "repair" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm handoff" }));
    await screen.findByText(/Runner unavailable/);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm handoff" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Open created session" }));
    expect(onConfirmed).toHaveBeenCalledWith(result);
    expect(mocks.sendReviewHandoff).toHaveBeenCalledTimes(1);
  });

  it("clears a leftover claude-owned default model from the selected target repository", async () => {
    mocks.readScopedSettingsForRepo.mockResolvedValue({ effective: { defaults: { harness: "claude", model: "sonnet" } } } as ScopedSettings);
    renderPage();
    await selectTarget();
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
  });

  it("retains an omp-owned default model from the selected target repository", async () => {
    renderPage();
    await selectTarget();
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-5");
  });

  it("does not reuse the previous target's retained steps when the new target cannot load", async () => {
    mocks.getTaskExecution.mockImplementation(async (slug: string, repo: string) => {
      if (repo !== "/b" || slug === "other") throw new Error("Retained definition unavailable");
      return { definition } as TaskExecutionReply;
    });
    renderPage();
    await selectTarget();
    fireEvent.change(screen.getByLabelText("Target step"), { target: { value: "repair" } });
    expect((screen.getByRole("button", { name: "Confirm handoff" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Target task"), { target: { value: taskKey(otherTask) } });
    await screen.findByText("Error: Retained definition unavailable");
    expect(screen.queryByRole("option", { name: "Retained repair" })).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm handoff" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.sendReviewHandoff).not.toHaveBeenCalled();
  });
});
