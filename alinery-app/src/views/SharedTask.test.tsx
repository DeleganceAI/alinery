import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { sharedTasks } from "../sharedTask";
import type { TeamShare, TeamShareDetail } from "../types";
import { SharedTaskList, SharedTaskView } from "./SharedTask";

vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));

const share: TeamShare = { id: "share-1", team_id: "team-1", name: "alinery", online: true };
const detail: TeamShareDetail = {
  tasks: [{ task_slug: "permission-related-issues", body: 'name = "Permission related issues"\nbranch = "permission-related-issues"\n' }],
  artifacts: [
    { task_slug: "permission-related-issues", filename: "00-ticket.md", body: "# Ticket\n\nThe agent stops." },
    { task_slug: "permission-related-issues", filename: "01-plan.md", body: "# Plan\n\nFix the stop." },
  ],
  comments: [],
};

describe("SharedTaskList", () => {
  it("lists tasks by their task.md name and opens one", () => {
    const onOpen = vi.fn();
    render(<SharedTaskList share={share} tasks={sharedTasks(detail)} loaded onBack={() => {}} onOpen={onOpen} onRefresh={() => Promise.resolve()} />);
    fireEvent.click(screen.getByText("Permission related issues"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ slug: "permission-related-issues" }));
  });

  it("pulls the latest from the icon button", () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { container } = render(<SharedTaskList share={share} tasks={sharedTasks(detail)} loaded onBack={() => {}} onOpen={() => {}} onRefresh={onRefresh} />);
    fireEvent.click(within(container).getByRole("button", { name: "Pull the latest tasks, artifacts and comments" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("SharedTaskView", () => {
  it("opens the newest artifact and saves a comment pinned to the clicked block", async () => {
    const onComment = vi.fn(() => Promise.resolve());
    const [task] = sharedTasks(detail);
    render(
      <SharedTaskView
        share={share}
        task={task}
        detail={detail}
        appearance={DEFAULT_APPEARANCE}
        onAppearanceChange={() => {}}
        onBack={() => {}}
        onComment={onComment}
        onRefresh={() => Promise.resolve()}
      />,
    );
    fireEvent.click(await screen.findByText("Fix the stop."));
    fireEvent.change(screen.getByPlaceholderText("Comment for alinery..."), { target: { value: "Check the approval path" } });
    fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
    expect(onComment).toHaveBeenCalledWith("01-plan.md", "Check the approval path", expect.objectContaining({ anchor_kind: "p", line_start: 3 }));
  });
});
