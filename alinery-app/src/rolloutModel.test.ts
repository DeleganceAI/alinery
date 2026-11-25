import { expect, it } from "vitest";
import { buildRollout, defaultFocus, formatElapsed } from "./rolloutModel";
import type { SessionDisplayMeta } from "./types";
import { executionRecord, executionReply } from "./views/executionTestFixture";

function session(id: string, started: number, ended: number | null, overrides: Partial<SessionDisplayMeta> = {}): SessionDisplayMeta {
  return {
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
    ...overrides,
  };
}

const ids = (rows: ReturnType<typeof buildRollout>) => rows.map((row) => row.map((entry) => entry.session.id));
const live = (running: string[]) => (s: SessionDisplayMeta) => running.includes(s.id);

it("puts sessions in rows by time and groups only the ones that overlap", () => {
  const reply = executionReply([]);
  const rows = buildRollout(
    [
      session("c", 300, null),
      session("a", 100, 200),
      session("aux", 320, null, { generic: true, phase: "" }),
      session("b", 200, 290),
      session("late-aux", 50, 60, { generic: true, phase: "" }),
    ],
    reply.state,
    reply.definition.step,
    live(["c", "aux"]),
  );
  expect(ids(rows)).toEqual([["late-aux"], ["a"], ["b"], ["c", "aux"]]);
  expect(rows[3][0]).toMatchObject({ stepNumber: 1, title: "Retained worker", auxiliary: false, end: null });
  expect(rows[3][1]).toMatchObject({ stepNumber: undefined, title: "Auxiliary", auxiliary: true });
  // A session that is neither ended nor live stopped when it last changed, so it does not swallow what came later.
  expect(ids(buildRollout([session("dead", 10, null, { status_changed_at: 20 }), session("next", 30, 40)], null, [], live([])))).toEqual([["dead"], ["next"]]);
});

it("keeps a retry and a consuming step sequential even when the earlier session was still closing", () => {
  const first = executionRecord({ id: "one", owner_session_id: "retry", previous_session_ids: ["try"], receipt_id: "r" });
  const second = executionRecord({ id: "two", owner_session_id: "next", parent_execution_ids: ["one"] });
  const reply = executionReply([first, second]);
  reply.state.occurrences = {
    out: { ...(reply.state.occurrences?.["input-a"] as NonNullable<typeof reply.state.occurrences>[string]), id: "out", relative_path: "1-out.md", producer_execution_id: "one" },
  };
  const rows = buildRollout(
    [session("try", 100, 160), session("retry", 150, 260, { resume_of: "try" }), session("next", 250, null)],
    reply.state,
    reply.definition.step,
    live(["next"]),
  );
  expect(ids(rows)).toEqual([["try"], ["retry"], ["next"]]);
  // The superseded attempt shows no outputs; the owner shows what it published; a running step shows what it owes.
  expect(rows.map((row) => row[0].artifacts)).toEqual([[], [{ path: "1-out.md", pending: false }], [{ path: "research/2-result-10.md", pending: true }]]);
});

it("treats an owed file that is already on disk as written", () => {
  const reply = executionReply([executionRecord({ owner_session_id: "s" })]);
  const rows = buildRollout([session("s", 1, null)], reply.state, reply.definition.step, live(["s"]), (path) => path === "research/2-result-10.md");
  expect(rows[0][0].artifacts).toEqual([{ path: "research/2-result-10.md", pending: false }]);
});

it("focuses the session waiting on the user, else the newest; and formats elapsed time", () => {
  const [row] = buildRollout([session("a", 1, null), session("b", 2, null)], null, [], live(["a", "b"]));
  expect(defaultFocus(row, () => false)).toBe("b");
  expect(defaultFocus(row, (entry) => entry.session.id === "a")).toBe("a");
  const [mixed] = buildRollout([session("step", 1, null), session("aux", 2, null, { generic: true, phase: "" })], null, [{ key: "worker" } as never], live(["step", "aux"]));
  expect(defaultFocus(mixed, () => false)).toBe("step");
  expect([formatElapsed(59), formatElapsed(150), formatElapsed(3700)]).toEqual(["59s", "2m", "1h 1m"]);
});
