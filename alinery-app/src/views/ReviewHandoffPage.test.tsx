import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { BoardTask, Config, PlaybookStepSummary } from "../types";
import { ReviewHandoffPage } from "./ReviewHandoffPage";

const sourceTask = {
  name: "Source",
  slug: "source",
  requested_slug: "source",
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
  repo_path: "/r",
  session_count: 0,
  playbook_title: "SuperDevelop",
  updated: 1,
  current_phase: "research",
  current_step_title: "Research",
  current_column_key: "research-design",
  current_column_title: "Research & Design",
  latest_session_title: "",
  latest_session_column_key: "",
  artifact_count: 0,
  sessions: [],
} as BoardTask;

const targetTask: BoardTask = {
  ...sourceTask,
  name: "Target",
  slug: "target",
  requested_slug: "target",
  branch: "target",
  worktree: "/w/target",
};

const readConfig = vi.hoisted(() => vi.fn());

vi.mock("../ipc", () =>
  mockIpc({
    listBoardTasks: async () => [sourceTask, targetTask],
    readConfig,
    listPlaybookSteps: async () => [{ key: "research", title: "Research" }] as PlaybookStepSummary[],
  }),
);

afterEach(() => {
  cleanup();
});

function renderPage() {
  render(
    <ReviewHandoffPage
      source={{ source_slug: "source", source_session: "s1", source_artifact: "03-review-findings.md" }}
      allRepos={false}
      activeRepo="/r"
      onCancel={() => {}}
      onConfirmed={() => {}}
    />,
  );
}

describe("ReviewHandoffPage model default", () => {
  it("clears a leftover claude-owned default model", async () => {
    readConfig.mockResolvedValue({ defaults: { harness: "claude", model: "sonnet" } } as unknown as Config);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
  });

  it("retains an omp-owned default model", async () => {
    readConfig.mockResolvedValue({ defaults: { harness: "omp", model: "gpt-5" } } as unknown as Config);
    renderPage();
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-5"));
  });
});
