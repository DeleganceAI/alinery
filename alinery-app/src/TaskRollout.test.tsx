import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { buildRollout } from "./rolloutModel";
import { TaskRollout } from "./TaskRollout";
import type { SessionDisplayMeta } from "./types";
import { executionRecord, executionReply } from "./views/executionTestFixture";

vi.mock("./ipc", async () => {
  // The hoisted factory runs before static imports when shared.tsx imports the IPC boundary.
  const { mockIpc } = await import("./test/mockIpc");
  return mockIpc();
});

const session = (id: string, started: number, ended: number | null, overrides: Partial<SessionDisplayMeta> = {}): SessionDisplayMeta => ({
  id,
  worktree: "/w",
  created: started,
  started_at: started,
  ended_at: ended,
  archived: false,
  phase: "worker",
  harness: "vinculum",
  model: "",
  playbook: "retained",
  generic: false,
  harness_resume_token: "",
  name: `name-${id}`,
  ...overrides,
});

it("starts collapsed, opens a step's session and files, and swaps the wide session of a parallel row", () => {
  const reply = executionReply([executionRecord({ owner_session_id: "step" })]);
  const rows = buildRollout(
    [session("step", 100, null), session("aux", 150, null, { generic: true, phase: "" }), session("done", 10, 20)],
    reply.state,
    reply.definition.step,
    (s) => s.id !== "done",
  );
  const onOpenSession = vi.fn();
  const onOpenArtifact = vi.fn();
  render(
    <TaskRollout
      rows={rows}
      observations={{}}
      repoPath="/repo"
      slug="task"
      now={400}
      renderSession={(s) => <div>conversation of {s.id}</div>}
      onOpenSession={onOpenSession}
      onOpenArtifact={onOpenArtifact}
    />,
  );
  // The playbook step of the parallel row is wide; the auxiliary session beside it is a bar, and clicking a bar swaps them.
  expect(screen.queryByText(/conversation of/)).toBeNull();
  expect(screen.getByText("name-step")).toBeTruthy();
  expect(screen.queryByText("name-aux")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show Auxiliary, name-aux" }));
  expect(screen.getByText("name-aux")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show Retained worker, name-step" }));
  expect(screen.getByText("name-step")).toBeTruthy();

  // The running step's owed output is listed but cannot be opened yet.
  expect((screen.getByRole("button", { name: /2-result-10\.md/ }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByText("name-step"));
  expect(screen.getByText("conversation of step")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Open session" })[1]);
  expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: "step" }));
});
