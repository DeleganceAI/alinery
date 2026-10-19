import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionLineage } from "./SessionLineage";
import type { SessionDisplayMeta } from "./types";
import { executionRecord, executionReply } from "./views/executionTestFixture";

beforeEach(() => localStorage.removeItem("alinery.sessionNavigatorExpanded"));
afterEach(() => {
  cleanup();
  localStorage.removeItem("alinery.sessionNavigatorExpanded");
});

const session = (id: string, created: number): SessionDisplayMeta => ({
  id,
  name: id,
  created,
  worktree: "/work",
  archived: false,
  phase: "worker",
  harness: "omp",
  model: "",
  playbook: "retained",
  generic: false,
  harness_resume_token: "",
});

it("shows actual fan-out separately from the newest task session and preserves artifact navigation", () => {
  const root = executionRecord({ id: "root", owner_session_id: "root", lifecycle: "completed" });
  const left = executionRecord({ id: "left", owner_session_id: "left", parent_execution_ids: ["root"], lifecycle: "queued" });
  const right = executionRecord({ id: "right", owner_session_id: "right", parent_execution_ids: ["root"] });
  const unrelated = executionRecord({ id: "unrelated", owner_session_id: "unrelated" });
  const view = executionReply([root, left, right, unrelated]);
  view.state.occurrences.result = { ...view.state.occurrences["input-a"], id: "result", producer_execution_id: "root", relative_path: "nested/result.md" };
  left.candidate = { ...left.candidate, inputs: { result: ["result"] } };
  right.candidate = { ...right.candidate, inputs: { result: ["result"] } };
  const sessions = [session("root", 1), session("left", 2), session("right", 3), session("unrelated", 4), session("auxiliary", 5)];
  const openSession = vi.fn();
  const openArtifact = vi.fn();
  render(
    <SessionLineage
      id="root"
      name="root"
      phase="worker"
      sessions={sessions}
      executionView={view}
      artifactPaths={[]}
      readableArtifactPaths={["nested/result.md"]}
      error=""
      onOpenSession={openSession}
      onOpenArtifact={openArtifact}
    />,
  );
  fireEvent.click(screen.getByText("Session Navigator"));
  const finished = screen.getByRole("status");
  expect(within(finished).getByRole("button", { name: /left\s*queued/ })).toBeDefined();
  expect(within(finished).getByRole("button", { name: /right\s*running/ })).toBeDefined();
  expect(within(finished).queryByText("unrelated")).toBeNull();
  expect(screen.queryByText("auxiliary")).toBeNull();
  fireEvent.click(within(finished).getByRole("button", { name: /left\s*queued/ }));
  expect(openSession).toHaveBeenLastCalledWith(sessions[1]);
  fireEvent.click(screen.getByRole("button", { name: "unrelated" }));
  expect(openSession).toHaveBeenLastCalledWith(sessions[3]);
  fireEvent.click(screen.getByRole("button", { name: "result.md" }));
  expect(openArtifact).toHaveBeenLastCalledWith("nested/result.md");
});

it("does not report completion before exit or attribute replacement outputs to a previous attempt", () => {
  const record = executionRecord({ owner_session_id: "current", previous_session_ids: ["old"], lifecycle: "finishing" });
  const view = executionReply([record]);
  const props = {
    name: "Work",
    phase: "worker",
    sessions: [session("old", 1), session("current", 2)],
    executionView: view,
    artifactPaths: [record.outputs[0].relative_path],
    readableArtifactPaths: [record.outputs[0].relative_path],
    error: "",
    onOpenArtifact: vi.fn(),
  };
  const { rerender } = render(<SessionLineage {...props} id="current" />);
  fireEvent.click(screen.getByText("Session Navigator"));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: /result.*Not yet published/ })).toBeDefined();
  record.lifecycle = "completed";
  rerender(<SessionLineage {...props} id="old" executionView={{ ...view }} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("button", { name: /result.*Not yet published/ })).toBeNull();
  rerender(<SessionLineage {...props} id="current" executionView={{ ...view }} error="offline" />);
  expect(screen.getByRole("status").textContent).toContain("last known state");
});

it("keeps assigned and recorded artifacts disabled until their files are readable", () => {
  const record = executionRecord({ owner_session_id: "current" });
  const view = executionReply([record]);
  const outputPath = record.outputs[0].relative_path;
  const inputPath = view.state.occurrences["input-a"].relative_path;
  const onOpenArtifact = vi.fn();
  const props = {
    id: "current",
    name: "Work",
    phase: "worker",
    sessions: [session("current", 1)],
    executionView: view,
    artifactPaths: [outputPath, inputPath],
    error: "",
    onOpenArtifact,
  };
  const { rerender } = render(<SessionLineage {...props} readableArtifactPaths={[]} />);
  fireEvent.click(screen.getByText("Session Navigator"));
  const output = screen.getByRole("button", { name: /result/ });
  const input = screen.getByRole("button", { name: /request/ });
  expect(output).toHaveProperty("disabled", true);
  expect(input).toHaveProperty("disabled", true);
  fireEvent.click(output);
  fireEvent.click(input);
  expect(onOpenArtifact).not.toHaveBeenCalled();

  rerender(<SessionLineage {...props} readableArtifactPaths={[outputPath, inputPath]} />);
  expect(output).toHaveProperty("disabled", false);
  expect(input).toHaveProperty("disabled", false);
  fireEvent.click(output);
  expect(onOpenArtifact).toHaveBeenLastCalledWith(outputPath);
  fireEvent.click(input);
  expect(onOpenArtifact).toHaveBeenLastCalledWith(inputPath);

  rerender(<SessionLineage {...props} readableArtifactPaths={[]} />);
  expect(output).toHaveProperty("disabled", true);
  expect(input).toHaveProperty("disabled", true);
});

it("remembers both expanded and collapsed choices across session remounts", () => {
  const props = {
    name: "Work",
    phase: "worker",
    sessions: [],
    executionView: null,
    artifactPaths: [],
    readableArtifactPaths: [],
    error: "",
    onOpenArtifact: vi.fn(),
  };
  const first = render(<SessionLineage {...props} id="first" />);
  expect(screen.getByText("Session Navigator").closest("details")).toHaveProperty("open", false);
  fireEvent.click(screen.getByText("Session Navigator"));
  first.unmount();

  const second = render(<SessionLineage {...props} id="next" />);
  expect(screen.getByText("Session Navigator").closest("details")).toHaveProperty("open", true);
  fireEvent.click(screen.getByText("Session Navigator"));
  second.unmount();

  render(<SessionLineage {...props} id="third" />);
  expect(screen.getByText("Session Navigator").closest("details")).toHaveProperty("open", false);
});
