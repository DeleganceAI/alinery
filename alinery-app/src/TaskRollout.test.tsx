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

it("shows a preview line per running session, opens one in place, and addresses the one composer to the session brought forward", () => {
  const reply = executionReply([executionRecord({ owner_session_id: "step" })]);
  const rows = buildRollout(
    [session("step", 100, null), session("aux", 150, null, { generic: true, phase: "" }), session("done", 10, 20)],
    reply.state,
    reply.definition.step,
    (s) => s.id !== "done",
  );
  const onOpenSession = vi.fn();
  render(
    <TaskRollout
      rows={rows}
      observations={{}}
      repoPath="/repo"
      slug="task"
      now={400}
      renderSession={(s, bare) => <div>{`${bare.preview ? "preview" : "conversation"} of ${s.id}${bare.composerSlot ? " with composer" : ""}`}</div>}
      onOpenSession={onOpenSession}
      onOpenArtifact={vi.fn()}
    />,
  );
  // Each row's line is its progress: nothing written yet is a sliver, never empty; a finished row with nothing owed is full.
  expect(screen.getAllByRole("progressbar").map((el) => (el.firstElementChild as HTMLElement).style.width)).toEqual(["100%", "6%"]);

  // The running step is mounted collapsed, as its preview, and owns the composer; the finished session is a line only.
  expect(screen.getByText("preview of step with composer")).toBeTruthy();
  expect(screen.queryByText(/of done/)).toBeNull();
  expect(screen.queryByText(/of aux/)).toBeNull();

  // Bringing the auxiliary session forward (bar or the To menu) moves the composer to it.
  fireEvent.click(screen.getByRole("button", { name: "Show Auxiliary, name-aux" }));
  expect(screen.getByText("preview of aux with composer")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "step" } });
  expect(screen.getByText("preview of step with composer")).toBeTruthy();

  // The running step's owed output is listed but cannot be opened yet.
  expect((screen.getByRole("button", { name: /2-result-10\.md/ }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByText("name-step"));
  expect(screen.getByText("conversation of step with composer")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Open session" })[1]);
  expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: "step" }));
});
