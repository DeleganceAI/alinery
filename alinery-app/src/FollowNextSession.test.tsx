import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFollowNextSessionControl, useSessionFollow } from "./FollowNextSession";
import type { ExecutionRecord, SessionDisplayMeta } from "./types";
import { executionRecord, executionReply } from "./views/executionTestFixture";

afterEach(cleanup);

function run(id: string, parent?: string): ExecutionRecord {
  return executionRecord({ id, owner_session_id: `${id}-session`, parent_execution_ids: parent ? [parent] : [], candidate: { ...executionRecord().candidate, inputs: {} } });
}
function ended(step: ExecutionRecord): ExecutionRecord {
  return { ...step, lifecycle: "completed", shutdown_confirmed: true, receipt_id: step.id };
}
function session(step: ExecutionRecord): SessionDisplayMeta {
  return {
    id: step.owner_session_id,
    execution_id: step.id,
    created: 1,
    started_at: 1,
    archived: false,
    worktree: "/worktrees/task",
    phase: "work",
    harness: "vinculum",
    model: "",
    playbook: "example",
    generic: false,
    harness_resume_token: "",
  };
}

const source = run("draft");
const next = run("review", "draft");
const unrelated = run("other");
const third = run("publish", "review");
const button = () => screen.getByRole("button", { name: "Follow next session" });

function Control({ inComposer, ...props }: Parameters<typeof useFollowNextSessionControl>[0] & { inComposer?: boolean }) {
  const eye = useFollowNextSessionControl(props);
  return inComposer ? <footer>{eye}</footer> : <nav>{eye}</nav>;
}

function View({
  records,
  selected = source,
  sessions = records.map(session),
  active = true,
  readingHistory,
  scope = "taskA",
  inComposer,
  withoutFollow,
  open,
}: {
  records: ExecutionRecord[];
  selected?: ExecutionRecord;
  sessions?: SessionDisplayMeta[];
  active?: boolean;
  readingHistory?: boolean;
  scope?: string;
  inComposer?: boolean;
  withoutFollow?: boolean;
  open: (value: SessionDisplayMeta) => void;
}) {
  const follow = useSessionFollow();
  return (
    <Control
      key={selected.id}
      follow={withoutFollow ? undefined : follow}
      inComposer={inComposer}
      scope={scope}
      sessionId={selected.owner_session_id}
      sessions={sessions}
      state={executionReply(records).state}
      onOpenSession={open}
      active={active}
      readingHistory={readingHistory}
    />
  );
}

it("keeps following a watched session when the eye moves from the composer to the navigator", () => {
  const open = vi.fn();
  const view = render(<View records={[source]} open={open} inComposer />);
  expect(button().closest("footer")).toBeTruthy();
  view.rerender(<View records={[ended(source), next]} open={open} />);
  expect(button().closest("nav")).toBeTruthy();
  expect(open).toHaveBeenCalledExactlyOnceWith(session(next));
});

it("leaves navigation alone when the session has no follow control", () => {
  const open = vi.fn();
  const view = render(<View records={[source]} open={open} withoutFollow />);
  view.rerender(<View records={[ended(source), next]} open={open} withoutFollow />);
  expect(screen.queryByRole("button", { name: "Follow next session" })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it("waits for confirmed exit, a single real successor and its started owner; follows each handoff exactly once", () => {
  const open = vi.fn();
  const view = render(<View records={[source, unrelated]} open={open} />);
  expect(button().getAttribute("aria-pressed")).toBe("true");
  view.rerender(<View records={[{ ...ended(source), shutdown_confirmed: false }, next]} open={open} />);
  view.rerender(<View records={[ended(source), { ...next, lifecycle: "queued" }, unrelated]} open={open} />);
  view.rerender(<View records={[ended(source), next, unrelated]} sessions={[{ ...session(next), started_at: null }, session(unrelated)]} open={open} />);
  view.rerender(<View records={[ended(source), next, unrelated]} sessions={[{ ...session(next), execution_id: unrelated.id }, session(unrelated)]} open={open} />);
  view.rerender(<View records={[ended(source), next, unrelated]} sessions={[{ ...session(next), worktree: "" }, session(unrelated)]} open={open} />);
  expect(open).not.toHaveBeenCalled();
  const sessions = [session(next), { ...session(unrelated), created: 999 }];
  view.rerender(<View records={[ended(source), next, unrelated]} sessions={sessions} open={open} />);
  view.rerender(<View records={[ended(source), next, unrelated]} sessions={sessions} open={open} />);
  expect(open).toHaveBeenCalledExactlyOnceWith(session(next));
  view.rerender(<View records={[ended(source), ended(next), third]} selected={next} open={open} readingHistory />);
  expect(open).toHaveBeenNthCalledWith(2, session(third));
});

it("stays on a branching handoff even when only one branch has launched", () => {
  const open = vi.fn();
  const fork = { ...run("second-review", source.id), lifecycle: "queued" as const, owner_session_id: "" };
  const view = render(<View records={[source]} open={open} />);
  view.rerender(<View records={[ended(source), unrelated]} open={open} />);
  view.rerender(<View records={[ended(source), next, fork]} sessions={[session(next)]} open={open} />);
  expect(open).not.toHaveBeenCalled();
});

it("opens a completed session for inspection and follows its successor only on explicit opt-in", () => {
  const open = vi.fn();
  render(<View records={[ended(source), next]} open={open} />);
  expect(open).not.toHaveBeenCalled();
  expect(button().getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(button());
  expect(open).toHaveBeenCalledExactlyOnceWith(session(next));
});

it.each([true, false])("keeps a read-only visit in place while exit is being confirmed (opened directly: %s)", (direct) => {
  const open = vi.fn();
  const finishing = { ...source, lifecycle: "finishing" as const, receipt_id: source.id };
  const view = render(<View records={[finishing]} open={open} readingHistory={direct} />);
  if (!direct) {
    expect(button().getAttribute("aria-pressed")).toBe("true");
    view.rerender(<View records={[finishing]} open={open} readingHistory />);
  }
  expect(button().getAttribute("aria-pressed")).toBe("false");
  view.rerender(<View records={[ended(source), next]} open={open} readingHistory />);
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(button());
  expect(open).toHaveBeenCalledExactlyOnceWith(session(next));
});

it("pauses on a manual selection, even if the selected session has another ready successor", () => {
  const open = vi.fn();
  const view = render(<View records={[source, next]} open={open} />);
  view.rerender(<View records={[source, next]} selected={next} open={open} />);
  view.rerender(<View records={[source, ended(next), third]} selected={next} open={open} />);
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(button());
  expect(open).toHaveBeenCalledExactlyOnceWith(session(third));
});

it("honors the eye, resets for a new task, and leaves a handoff alone while the session is hidden", () => {
  const open = vi.fn();
  const view = render(<View records={[source]} open={open} />);
  fireEvent.click(button());
  view.rerender(<View records={[ended(source), next]} open={open} />);
  expect(open).not.toHaveBeenCalled();
  view.rerender(<View records={[source]} scope="taskB" open={open} />);
  expect(button().getAttribute("aria-pressed")).toBe("true");
  view.rerender(<View records={[source]} scope="taskB" open={open} active={false} />);
  view.rerender(<View records={[ended(source), next]} scope="taskB" open={open} active={false} />);
  view.rerender(<View records={[ended(source), next]} scope="taskB" open={open} />);
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(open).not.toHaveBeenCalled();
});
