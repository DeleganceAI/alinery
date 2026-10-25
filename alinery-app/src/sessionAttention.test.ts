import { describe, expect, it } from "vitest";
import {
  applyNotificationClearProjection,
  classifySessionNotice,
  filterSuppressedNoticeRows,
  isSessionNoticeSuppressed,
  liveNoticeSuppression,
  type ObservationDisplayKind,
  observationDisplayKind,
  orderSessionListItems,
  orderTaskPanelRows,
  PRIORITY_SESSION_SORT,
  selectSessionSort,
  sessionAttentionTier,
  sessionNoticeRows,
  sessionSortArrow,
  sessionStartedAt,
  sessionUpdatedAt,
} from "./sessionAttention";
import type { SessionListItem, SessionMeta, SessionObservation, TaskPanelRow, TaskSummary } from "./types";

const session = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: "s-a",
  worktree: "/w",
  created: 10,
  archived: false,
  phase: "design",
  harness: "omp",
  model: "",
  playbook: "superdevelop",
  generic: false,
  harness_resume_token: "",
  semantic: {},
  ...over,
});

const item = (over: Partial<SessionListItem> = {}): SessionListItem => ({
  ...session(over),
  task_slug: "task",
  task_name: "Task",
  task_worktree: "/w",
  repo_path: "/r/a",
  playbook_title: "SuperDevelop",
  step_title: "Design",
  is_playbook_step: true,
  ...over,
});

const observation = (over: Partial<SessionObservation> = {}): SessionObservation => ({
  lifecycle: { state: "live" },
  state: {
    process: { state: "alive" },
    agent: { state: "idle" },
    playbook: { state: "in_progress" },
    adapter: "omp",
    message_adapter: "unsupported",
  },
  checkpoint: {},
  ...over,
});

const live = (agent: "busy" | "waiting_for_input" | "waiting_for_approval"): SessionObservation =>
  observation({
    state: {
      process: { state: "alive" },
      agent: agent === "busy" ? { state: agent } : { state: agent, correlation_id: "c" },
      playbook: { state: "in_progress" },
      adapter: "omp",
      message_adapter: "unsupported",
    },
  });

const statusKey = (row: SessionListItem) => `${row.repo_path}:${row.task_slug}:${row.id}`;

describe("session attention classification", () => {
  it("uses waiting, busy, outcome, inactive, and archived tiers", () => {
    expect(sessionAttentionTier(session(), live("waiting_for_input"))).toBe(0);
    expect(sessionAttentionTier(session(), live("waiting_for_approval"))).toBe(0);
    expect(sessionAttentionTier(session(), live("busy"))).toBe(1);
    expect(
      sessionAttentionTier(
        session(),
        observation({
          state: {
            process: { state: "starting" },
            agent: { state: "unknown" },
            playbook: { state: "in_progress" },
            adapter: "unsupported",
            message_adapter: "unsupported",
          },
        }),
      ),
    ).toBe(1);
    const loading = observation({
      state: {
        process: { state: "alive" },
        agent: { state: "unknown" },
        playbook: { state: "in_progress" },
        adapter: "omp",
        message_adapter: "unsupported",
      },
    });
    const unsupported = observation({
      state: {
        process: { state: "alive" },
        agent: { state: "busy" },
        playbook: { state: "in_progress" },
        adapter: "unsupported",
        message_adapter: "unsupported",
      },
    });
    expect(sessionAttentionTier(session(), loading)).toBe(3);
    expect(sessionAttentionTier(session(), unsupported)).toBe(3);
    expect(sessionAttentionTier(session({ exit_code: 2 }), undefined)).toBe(2);
    expect(sessionAttentionTier(session(), undefined)).toBe(3);
    expect(sessionAttentionTier(session({ archived: true }), live("waiting_for_input"))).toBe(4);
  });

  it("requires a strict unread completion boundary and never treats artifacts as completion", () => {
    const completed = session({ semantic: { phase_completed_at: 100 } });
    expect(sessionAttentionTier(completed, undefined)).toBe(2);
    expect(sessionAttentionTier({ ...completed, notification_read_at: 99 }, undefined)).toBe(2);
    expect(sessionAttentionTier({ ...completed, notification_read_at: 100 }, undefined)).toBe(3);
    expect(sessionAttentionTier({ ...completed, notification_read_at: 101 }, undefined)).toBe(3);
    expect(sessionAttentionTier(session({ artifact: "03-design.md" }), undefined)).toBe(3);
  });

  it("keeps a later same-second exit unread after completion acknowledgment", () => {
    const exited = session({
      ended_at: 100,
      exit_code: 143,
      semantic: { phase_completed_at: 100 },
      notification_read_at: 100,
    });
    expect(sessionAttentionTier(exited, undefined)).toBe(2);
    expect(classifySessionNotice(exited, undefined)).toBe("failure");

    const acknowledged = { ...exited, exit_notification_read_at: 100 };
    expect(sessionAttentionTier(acknowledged, undefined)).toBe(3);
    expect(classifySessionNotice(acknowledged, undefined)).toBeNull();
  });

  it("does not fabricate live attention without an observation", () => {
    const staleStarted = session({ started_at: 10 });
    expect(sessionAttentionTier(staleStarted, undefined)).toBe(3);
    expect(classifySessionNotice(staleStarted, undefined)).toBeNull();
  });

  it("excludes StaleSource from failure and gives a live wait notice precedence", () => {
    const staleFailure = observation({
      state: {
        process: { state: "alive" },
        agent: { state: "idle" },
        playbook: { state: "failed", reason: "StaleSource" },
        adapter: "omp",
        message_adapter: "unsupported",
      },
    });
    expect(sessionAttentionTier(session(), staleFailure)).toBe(3);
    expect(classifySessionNotice(session(), staleFailure)).toBeNull();
    expect(classifySessionNotice(session({ semantic: { phase_completed_at: 100 } }), live("waiting_for_input"))).toBe("waiting_for_input");
  });

  it("returns the exact actionable notice and no notice for busy or acknowledged completion", () => {
    expect(classifySessionNotice(session(), live("waiting_for_approval"))).toBe("waiting_for_approval");
    expect(
      classifySessionNotice(
        session(),
        observation({
          state: {
            process: { state: "alive" },
            agent: { state: "idle" },
            playbook: { state: "failed", reason: "boom" },
            adapter: "omp",
            message_adapter: "unsupported",
          },
        }),
      ),
    ).toBe("failure");
    expect(classifySessionNotice(session({ semantic: { phase_completed_at: 100 } }), undefined)).toBe("unread_completion");
    expect(classifySessionNotice(session({ semantic: { phase_completed_at: 100 }, notification_read_at: 100 }), undefined)).toBeNull();
    expect(classifySessionNotice(session(), live("busy"))).toBeNull();
  });

  it("preserves the existing display interpretation in the extracted classifier", () => {
    expect(observationDisplayKind(live("busy"))).toBe("busy");
    expect(observationDisplayKind(observation({ state: null, checkpoint: { phase_completed_at: 100 }, lifecycle: { state: "exited", code: 0 } }))).toBe("completed");
    expect(
      observationDisplayKind(
        observation({
          state: {
            process: { state: "alive" },
            agent: { state: "idle" },
            playbook: { state: "failed", reason: "StaleSource" },
            adapter: "omp",
            message_adapter: "unsupported",
          },
        }),
      ),
    ).toBe("stale");
  });

  it("matches the durable normalized status scenarios", () => {
    const state = (
      process: "starting" | "alive" | "exited",
      agent: NonNullable<SessionObservation["state"]>["agent"],
      playbook: NonNullable<SessionObservation["state"]>["playbook"],
      adapter: "omp" | "unsupported" = "omp",
    ) =>
      observation({
        state: {
          process: process === "exited" ? { state: process, code: 0 } : { state: process },
          agent,
          playbook,
          adapter,
          message_adapter: "unsupported",
        },
      });
    const inputA = state("alive", { state: "waiting_for_input", correlation_id: "a" }, { state: "in_progress" });
    const inputB = state("alive", { state: "waiting_for_input", correlation_id: "b" }, { state: "in_progress" });
    const failedA = state("alive", { state: "idle" }, { state: "failed", reason: "boom" });
    const failedB = state("alive", { state: "idle" }, { state: "failed", reason: "different boom" });
    const scenarios: Array<[SessionObservation, ObservationDisplayKind]> = [
      [state("starting", { state: "unknown" }, { state: "in_progress" }), "starting"],
      [state("alive", { state: "unknown" }, { state: "in_progress" }), "loading"],
      [state("alive", { state: "busy" }, { state: "in_progress" }), "busy"],
      [inputA, "waiting_for_input"],
      [state("alive", { state: "waiting_for_approval", correlation_id: "a" }, { state: "in_progress" }), "waiting_for_approval"],
      [state("alive", { state: "idle" }, { state: "in_progress" }), "idle"],
      [state("alive", { state: "idle" }, { state: "ready_to_advance" }), "ready_to_advance"],
      [state("exited", { state: "idle" }, { state: "completed" }), "completed"],
      [failedA, "failed"],
      [state("exited", { state: "idle" }, { state: "failed", reason: "StaleSource" }), "stale"],
      [state("alive", { state: "unknown" }, { state: "in_progress" }, "unsupported"), "unsupported"],
      [state("exited", { state: "idle" }, { state: "in_progress" }), "exited"],
      [observation({ state: null }), "unknown"],
    ];
    for (const [value, expected] of scenarios) expect(observationDisplayKind(value)).toBe(expected);
    expect(observationDisplayKind(inputA)).toBe(observationDisplayKind(inputB));
    expect(observationDisplayKind(failedA)).toBe(observationDisplayKind(failedB));
  });
});

describe("session attention ordering", () => {
  it("promotes an older busy session over a newer settled session without mutating input", () => {
    const rows = Object.freeze([session({ id: "new", created: 20, semantic: { phase_completed_at: 20 }, notification_read_at: 20 }), session({ id: "old", created: 10 })]);
    const ordered = orderTaskPanelRows(
      rows.map<TaskPanelRow>((session) => ({ kind: "session", session })),
      { old: live("busy") },
      () => false,
      PRIORITY_SESSION_SORT,
    ).flatMap((row) => (row.kind === "subtask_history" ? [] : [row.session]));
    expect(ordered.map((row) => row.id)).toEqual(["old", "new"]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });

  it("orders waiting before busy and outcomes before inactive", () => {
    const rows = [
      session({ id: "inactive", created: 40 }),
      session({ id: "failed", created: 30, exit_code: 1 }),
      session({ id: "busy", created: 20 }),
      session({ id: "wait", created: 10 }),
    ];
    const ordered = orderTaskPanelRows(
      rows.map<TaskPanelRow>((session) => ({ kind: "session", session })),
      { busy: live("busy"), wait: live("waiting_for_input") },
      () => false,
      PRIORITY_SESSION_SORT,
    ).flatMap((row) => (row.kind === "subtask_history" ? [] : [row.session]));
    expect(ordered.map((row) => row.id)).toEqual(["wait", "busy", "failed", "inactive"]);
  });

  it("keeps Task Detail artifact-first fallback and deterministic descending IDs", () => {
    const rows = [session({ id: "s-a", created: 10, artifact: "done" }), session({ id: "s-b", created: 10 }), session({ id: "s-c", created: 9 })];
    const ordered = orderTaskPanelRows(
      rows.map<TaskPanelRow>((session) => ({ kind: "session", session })),
      {},
      (row) => row.artifact === "done",
      PRIORITY_SESSION_SORT,
    ).flatMap((row) => (row.kind === "subtask_history" ? [] : [row.session]));
    expect(ordered.map((row) => row.id)).toEqual(["s-b", "s-c", "s-a"]);
  });

  it("keeps global inactive newest-first and uses repository/task identity before descending ID", () => {
    const rows = [
      item({ id: "s-a", repo_path: "/r/b", task_slug: "a", created: 10 }),
      item({ id: "s-a", repo_path: "/r/a", task_slug: "b", created: 10 }),
      item({ id: "s-a", repo_path: "/r/a", task_slug: "a", created: 10 }),
      item({ id: "s-b", repo_path: "/r/a", task_slug: "a", created: 10 }),
      item({ id: "newest", created: 20, repo_path: "/r/z" }),
    ];
    const ordered = orderSessionListItems(rows, {});
    expect(ordered.map((row) => `${row.repo_path}:${row.task_slug}:${row.id}`)).toEqual(["/r/z:task:newest", "/r/a:a:s-b", "/r/a:a:s-a", "/r/a:b:s-a", "/r/b:a:s-a"]);
  });

  it("keeps archived rows last even when an observation says busy", () => {
    const archived = item({ id: "archived", archived: true, created: 30 });
    const active = item({ id: "active", created: 10 });
    const observations = { [statusKey(archived)]: live("busy"), [statusKey(active)]: live("busy") };
    expect(orderSessionListItems([archived, active], observations).map((row) => row.id)).toEqual(["active", "archived"]);
  });
});

describe("session time sorting", () => {
  it("starts each time field newest-first, reverses it, and restores Priority explicitly", () => {
    const startedDescending = selectSessionSort(PRIORITY_SESSION_SORT, "started");
    expect(startedDescending).toEqual({ field: "started", direction: "desc" });
    expect(selectSessionSort(startedDescending, "started")).toEqual({ field: "started", direction: "asc" });
    expect(selectSessionSort(startedDescending, "updated")).toEqual({ field: "updated", direction: "desc" });
    expect(selectSessionSort(startedDescending, "priority")).toEqual(PRIORITY_SESSION_SORT);
    expect(sessionSortArrow(PRIORITY_SESSION_SORT, "started")).toBe("");
    expect(sessionSortArrow(startedDescending, "started")).toBe("↓");
    expect(sessionSortArrow({ field: "started", direction: "asc" }, "started")).toBe("↑");
    expect(sessionSortArrow(startedDescending, "updated")).toBe("");
  });

  it("keeps Started literal and applies the read-only Updated fallback chain", () => {
    expect(sessionStartedAt(session({ created: 1 }))).toBeNull();
    expect(sessionStartedAt(session({ created: 1, started_at: 2 }))).toBe(2);
    expect(sessionUpdatedAt(session({ created: 1 }))).toBe(1);
    expect(sessionUpdatedAt(session({ created: 1, started_at: 2 }))).toBe(2);
    expect(sessionUpdatedAt(session({ created: 1, started_at: 2, ended_at: 3 }))).toBe(3);
    expect(sessionUpdatedAt(session({ created: 1, started_at: 2, ended_at: 3, semantic: { phase_completed_at: 4 } }))).toBe(4);
    expect(
      sessionUpdatedAt(
        session({
          created: 1,
          started_at: 2,
          ended_at: 3,
          semantic: { phase_completed_at: 4 },
          status_changed_at: 5,
        }),
      ),
    ).toBe(5);
  });

  it("sorts present Started values in both directions and leaves missing values last without mutating input", () => {
    const rows = Object.freeze([
      item({ id: "missing", created: 30, started_at: null }),
      item({ id: "older", created: 20, started_at: 100 }),
      item({ id: "newer-archived", archived: true, created: 10, started_at: 200 }),
    ]);

    expect(orderSessionListItems(rows, {}, { field: "started", direction: "desc" }).map((row) => row.id)).toEqual(["newer-archived", "older", "missing"]);
    expect(orderSessionListItems(rows, {}, { field: "started", direction: "asc" }).map((row) => row.id)).toEqual(["older", "newer-archived", "missing"]);
    expect(rows.map((row) => row.id)).toEqual(["missing", "older", "newer-archived"]);
  });

  it("reorders Updated rows after a status timestamp change without changing the selected mode", () => {
    const sort = { field: "updated", direction: "desc" } as const;
    const older = item({ id: "older", status_changed_at: 100 });
    const newer = item({ id: "newer", status_changed_at: 200 });
    expect(orderSessionListItems([older, newer], {}, sort).map((row) => row.id)).toEqual(["newer", "older"]);

    const advancedOlder = { ...older, status_changed_at: 300 };
    expect(orderSessionListItems([advancedOlder, newer], {}, sort).map((row) => row.id)).toEqual(["older", "newer"]);
    expect(sort).toEqual({ field: "updated", direction: "desc" });
  });

  it("sorts Updated fallbacks both ways with missing values last", () => {
    const rows = [
      item({ id: "created", created: 10 }),
      item({ id: "started", created: 1, started_at: 20 }),
      item({ id: "ended", created: 1, ended_at: 30 }),
      item({ id: "semantic", created: 1, semantic: { phase_completed_at: 40 } }),
      item({ id: "status", created: 1, status_changed_at: 50 }),
      item({ id: "missing", created: 0 }),
    ];
    expect(orderSessionListItems(rows, {}, { field: "updated", direction: "desc" }).map((row) => row.id)).toEqual(["status", "semantic", "ended", "started", "created", "missing"]);
    expect(orderSessionListItems(rows, {}, { field: "updated", direction: "asc" }).map((row) => row.id)).toEqual(["created", "started", "ended", "semantic", "status", "missing"]);
  });

  it("uses repository-qualified durable ties independently of direction and input order", () => {
    const rows = [
      item({ repo_path: "/r/b", task_slug: "a", id: "a", status_changed_at: 100 }),
      item({ repo_path: "/r/a", task_slug: "b", id: "a", status_changed_at: 100 }),
      item({ repo_path: "/r/a", task_slug: "a", id: "b", status_changed_at: 100 }),
      item({ repo_path: "/r/a", task_slug: "a", id: "a", status_changed_at: 100 }),
    ];
    const expected = ["/r/a:a:a", "/r/a:a:b", "/r/a:b:a", "/r/b:a:a"];
    for (const direction of ["asc", "desc"] as const) {
      expect(orderSessionListItems([...rows].reverse(), {}, { field: "updated", direction }).map(statusKey)).toEqual(expected);
    }
  });

  it("sorts final task-panel rows including managers and leaves managerless history last", () => {
    const ordinary: TaskPanelRow = { kind: "session", session: session({ id: "ordinary", started_at: 100 }) };
    const manager: TaskPanelRow = {
      kind: "subtask_manager",
      session: session({ id: "manager", started_at: 200 }),
      owner_task_slug: "child",
      active_child: true,
    };
    const history: TaskPanelRow = { kind: "subtask_history", child: { slug: "history" } as TaskSummary };
    const rows = Object.freeze([history, ordinary, manager]);
    expect(orderTaskPanelRows(rows, {}, () => false, { field: "started", direction: "desc" }).map((row) => row.kind)).toEqual(["subtask_manager", "session", "subtask_history"]);
    expect(orderTaskPanelRows(rows, { manager: live("busy") }, () => false, PRIORITY_SESSION_SORT)[0]).toBe(manager);
    expect(rows[0]).toBe(history);
  });
});

describe("notification occurrence and clear projection", () => {
  const failed = observation({
    state: {
      process: { state: "alive" },
      agent: { state: "idle" },
      playbook: { state: "failed", reason: "boom" },
      adapter: "omp",
      message_adapter: "unsupported",
    },
  });

  it("uses exact live identities and never fingerprints durable-only notices", () => {
    const input = item({ id: "input" });
    const approval = item({ id: "approval" });
    const failure = item({ id: "failure", status_changed_at: 700, status_revision: 12 });
    expect(liveNoticeSuppression(input, "waiting_for_input", live("waiting_for_input"))).toEqual({
      notice: "waiting_for_input",
      occurrence: "c",
    });
    expect(liveNoticeSuppression(approval, "waiting_for_approval", live("waiting_for_approval"))).toEqual({
      notice: "waiting_for_approval",
      occurrence: "c",
    });
    expect(liveNoticeSuppression(failure, "failure", failed)).toEqual({ notice: "failure", occurrence: "12" });
    expect(liveNoticeSuppression(item({ semantic: { phase_completed_at: 10 } }), "unread_completion", undefined)).toBeNull();
    expect(liveNoticeSuppression(item({ ended_at: 10, exit_code: 2 }), "failure", undefined)).toBeNull();
  });

  it("requires an exact suppression and never hides an unread durable fact", () => {
    const waiting = item({
      notification_suppression: { notice: "waiting_for_input", occurrence: "c" },
    });
    expect(isSessionNoticeSuppressed({ item: waiting, notice: "waiting_for_input" }, live("waiting_for_input"))).toBe(true);
    expect(
      isSessionNoticeSuppressed(
        {
          item: { ...waiting, notification_suppression: { notice: "waiting_for_input", occurrence: "new" } },
          notice: "waiting_for_input",
        },
        live("waiting_for_input"),
      ),
    ).toBe(false);
    expect(
      isSessionNoticeSuppressed(
        {
          item: { ...waiting, ended_at: 10, exit_code: 2 },
          notice: "failure",
        },
        failed,
      ),
    ).toBe(false);
  });

  it("does not let a failure suppression hide the next status revision", () => {
    const suppressed = item({
      id: "failure",
      status_revision: 20,
      notification_suppression: { notice: "failure", occurrence: "20" },
    });
    expect(isSessionNoticeSuppressed({ item: suppressed, notice: "failure" }, failed)).toBe(true);
    expect(isSessionNoticeSuppressed({ item: { ...suppressed, status_revision: 21 }, notice: "failure" }, failed)).toBe(false);
  });

  it("projects Clear onto durable facts and Clear all onto exact live occurrences", () => {
    const input = item({ id: "input" });
    const failure = item({ id: "failure", status_changed_at: 700, status_revision: 12 });
    const completion = item({ id: "completion", semantic: { phase_completed_at: 20 } });
    const exited = item({ id: "exit", ended_at: 30, exit_code: 2 });
    const items = [input, failure, completion, exited];
    const observations = {
      [statusKey(input)]: live("waiting_for_input"),
      [statusKey(failure)]: failed,
    };
    const rows = sessionNoticeRows(items, observations);

    const cleared = applyNotificationClearProjection(items, rows, observations, false);
    expect(cleared.find((row) => row.id === "completion")?.notification_read_at).toBe(20);
    expect(cleared.find((row) => row.id === "exit")?.exit_notification_read_at).toBe(30);
    expect(filterSuppressedNoticeRows(sessionNoticeRows(cleared, observations), observations).map((row) => row.item.id)).toEqual(["input", "failure"]);

    const clearedAll = applyNotificationClearProjection(items, rows, observations, true);
    expect(filterSuppressedNoticeRows(sessionNoticeRows(clearedAll, observations), observations)).toEqual([]);
    const changedWait = live("waiting_for_input");
    if (!changedWait.state) throw new Error("live wait observation must include state");
    const changed = {
      ...observations,
      [statusKey(input)]: {
        ...changedWait,
        state: {
          ...changedWait.state,
          agent: { state: "waiting_for_input" as const, correlation_id: "new" },
        },
      },
    };
    expect(filterSuppressedNoticeRows(sessionNoticeRows(clearedAll, changed), changed).map((row) => row.item.id)).toContain("input");
  });
});
