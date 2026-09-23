import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import {
  finalizedSubtaskNotice,
  formatAbsolute,
  formatAge,
  harnessDisplayName,
  isAllowedLaunchHarness,
  KillButton,
  ompDefaultModel,
  repoName,
  SessionTimestamp,
  sameBoardTasks,
  sameKanbanColumns,
  sameLifecycleMaps,
  sameSessionMetas,
  sameTaskActivityMaps,
  TaskActivityIndicators,
  taskKey,
  useMinuteNow,
} from "./shared";
import type { BoardTask, KanbanColumn, LifecycleState, SessionMeta, Task, TaskActivityMap, TaskActivitySummary } from "./types";

// shared.tsx imports ipc at module scope. Before the IPC seam existed that made this file
// unimportable in a test at all — there was no single module to stub.
vi.mock("./ipc");
vi.mock("./WindowChrome", () => ({ WindowControls: () => null, useWindowFullscreen: () => false, ResizeHandles: () => null }));

describe("KillButton presentation", () => {
  it("keeps the ghost treatment when danger is omitted or false", () => {
    const defaultMarkup = renderToStaticMarkup(createElement(KillButton, { id: "session-1", live: true }));
    const falseMarkup = renderToStaticMarkup(createElement(KillButton, { id: "session-1", live: true, danger: false }));

    for (const markup of [defaultMarkup, falseMarkup]) {
      expect(markup).toContain('class="btn ghost small"');
      expect(markup).not.toContain("danger");
    }
    expect(ipc.sessionStatus).not.toHaveBeenCalled();
    expect(ipc.killSession).not.toHaveBeenCalled();
    expect(ipc.killSessionForRepo).not.toHaveBeenCalled();
  });

  it("selects the danger treatment when requested", () => {
    const markup = renderToStaticMarkup(createElement(KillButton, { id: "session-1", live: true, danger: true }));

    expect(markup).toContain('class="btn danger small"');
    expect(markup).not.toContain("ghost");
    expect(ipc.sessionStatus).not.toHaveBeenCalled();
    expect(ipc.killSession).not.toHaveBeenCalled();
    expect(ipc.killSessionForRepo).not.toHaveBeenCalled();
  });
});

describe("repoName", () => {
  it("takes the last path segment", () => {
    expect(repoName("/Users/x/Repositories/alinery")).toBe("alinery");
    expect(repoName("C:\\Users\\x\\alinery")).toBe("alinery");
  });

  it("ignores a trailing separator", () => {
    expect(repoName("/Users/x/alinery/")).toBe("alinery");
  });

  it("falls back to the whole string when there is no segment to take", () => {
    expect(repoName("")).toBe("");
    expect(repoName("/")).toBe("/");
  });
});

describe("harnessDisplayName", () => {
  it("renames the no-harness sentinel for humans", () => {
    expect(harnessDisplayName("no-harness")).toBe("Terminal");
  });

  it("uses the bundled OMP label", () => {
    expect(harnessDisplayName("omp")).toBe("OMP CLI");
  });

  it("labels leftover and empty keys Unsupported", () => {
    expect(harnessDisplayName("")).toBe("Unsupported");
    expect(harnessDisplayName("claude")).toBe("Unsupported");
    expect(harnessDisplayName("codex")).toBe("Unsupported");
  });
});

describe("isAllowedLaunchHarness", () => {
  it("accepts only omp and Terminal", () => {
    expect(isAllowedLaunchHarness("omp")).toBe(true);
    expect(isAllowedLaunchHarness("no-harness")).toBe(true);
    expect(isAllowedLaunchHarness("claude")).toBe(false);
    expect(isAllowedLaunchHarness("codex")).toBe(false);
    expect(isAllowedLaunchHarness("")).toBe(false);
    expect(isAllowedLaunchHarness("sleep")).toBe(false);
  });
});

describe("ompDefaultModel", () => {
  it("keeps only omp-owned selectors", () => {
    expect(ompDefaultModel({ harness: "omp", model: "sonnet" })).toBe("sonnet");
    expect(ompDefaultModel({ harness: "claude", model: "sonnet" })).toBe("");
    expect(ompDefaultModel({ harness: "", model: "sonnet" })).toBe("sonnet");
    expect(ompDefaultModel({ harness: "omp", model: "" })).toBe("");
  });
});

describe("finalizedSubtaskNotice", () => {
  it.each(["merged", "finished", "killed"] as const)("names the parent and warns that %s session output is stale", (subtaskOutcome) => {
    const task = {
      archived: true,
      parent_task: "parent",
      subtask_outcome: subtaskOutcome,
    } as Pick<Task, "archived" | "parent_task" | "subtask_outcome">;
    expect(finalizedSubtaskNotice(task, { name: "Parent task", slug: "parent" })).toBe(
      `Finalized into Parent task as ${subtaskOutcome.toUpperCase()}. Any open session may be stale. Changes after finalization are not included in the parent snapshot or integrated result.`,
    );
  });

  it("stays hidden for ordinary archived tasks", () => {
    expect(finalizedSubtaskNotice({ archived: true, parent_task: "", subtask_outcome: "" })).toBe("");
  });
});

describe("taskKey", () => {
  it("scopes the slug by repo, since slugs are only unique within a repo", () => {
    expect(taskKey({ repo_path: "/a", slug: "x" } as BoardTask)).toBe("/a:x");
    expect(taskKey({ repo_path: "/a", slug: "x" } as BoardTask)).not.toBe(taskKey({ repo_path: "/b", slug: "x" } as BoardTask));
  });
});

describe("formatAge", () => {
  const NOW = 1_700_000_000;
  afterEach(() => vi.useRealTimers());
  const at = (secondsAgo: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    return formatAge(NOW - secondsAgo);
  };

  it("renders an em dash for a missing timestamp", () => {
    expect(formatAge(0)).toBe("—");
  });

  // There is deliberately no seconds unit — the boundary is the whole contract.
  it("reads anything under a minute as now", () => {
    expect(at(0)).toBe("now");
    expect(at(59)).toBe("now");
    expect(at(60)).toBe("1m");
  });

  it("walks the unit ladder", () => {
    expect(at(60 * 5)).toBe("5m");
    expect(at(3600)).toBe("1h");
    expect(at(86400)).toBe("1d");
    expect(at(604800)).toBe("1w");
    expect(at(2592000)).toBe("1mo");
    expect(at(31536000)).toBe("1y");
  });

  it("never renders a negative age from a clock skew", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    expect(formatAge(NOW + 10_000)).toBe("now");
  });

  it("accepts an explicit shared clock", () => {
    expect(formatAge(NOW - 59, NOW)).toBe("now");
    expect(formatAge(NOW - 60, NOW)).toBe("1m");
    expect(formatAge(NOW + 60, NOW)).toBe("now");
  });
});

describe("formatAbsolute", () => {
  it("returns an empty string rather than the epoch for a missing timestamp", () => {
    expect(formatAbsolute(0)).toBe("");
  });

  it("formats a real timestamp", () => {
    expect(formatAbsolute(1_700_000_000)).not.toBe("");
  });
});

describe("session timestamps", () => {
  const NOW = 1_700_000_120;
  afterEach(() => vi.useRealTimers());

  it("renders compact relative values with exact status-aware descriptions", () => {
    const value = 1_700_000_000;
    const exact = formatAbsolute(value);
    const started = renderToStaticMarkup(createElement(SessionTimestamp, { kind: "started", value, now: NOW }));
    const updated = renderToStaticMarkup(createElement(SessionTimestamp, { kind: "updated", value, now: NOW }));
    const missing = renderToStaticMarkup(createElement(SessionTimestamp, { kind: "updated", value: null, now: NOW }));
    expect(started).toContain("Started");
    expect(started).toContain("2m");
    expect(started).toContain(`title="Started ${exact}"`);
    expect(updated).toContain(`Status changed ${exact}`);
    expect(missing).toContain("Updated");
    expect(missing).toContain("—");
    expect(missing).not.toContain("1970");
  });

  it("updates every supplied row from one minute clock and cleans it up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    const Harness = () => {
      const now = useMinuteNow();
      return createElement(
        "div",
        null,
        createElement(SessionTimestamp, { kind: "started", value: NOW - 119, now }),
        createElement(SessionTimestamp, { kind: "updated", value: NOW - 119, now }),
      );
    };
    const view = render(createElement(Harness));
    expect(vi.getTimerCount()).toBe(1);
    expect(view.container.textContent).toContain("1m");
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.container.textContent).toContain("2m");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// These gate setState in 3s board pollers. A wrongly-true comparator means the board stops
// updating and shows stale data indefinitely — a silent failure with no error anywhere.
describe("re-render comparators", () => {
  const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
    ({
      id: "s1",
      worktree: "/w",
      created: 1,
      archived: false,
      phase: "design",
      harness: "claude",
      model: "m",
      playbook: "superdevelop",
      generic: false,
      artifact: "",
      handoff_artifact: "",
      prompt_extra: "",
      prompt: "",
      started_at: 0,
      status_changed_at: null,
      ended_at: 0,
      exit_code: null,
      harness_resume_token: "",
      resume_of: "",
      notification_read_at: null,
      exit_notification_read_at: null,
      ...over,
    }) as SessionMeta;
  const task = (over: Partial<BoardTask> = {}): BoardTask =>
    ({
      name: "n",
      slug: "s",
      requested_slug: "s",
      branch: "s",
      worktree: "/w",
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
      current_phase: "design",
      current_step_title: "Design",
      current_column_key: "research-design",
      current_column_title: "Research & Design",
      ...over,
    }) as BoardTask;

  it("sameSessionMetas is false when any tracked field moves", () => {
    expect(sameSessionMetas([meta()], [meta()])).toBe(true);
    expect(sameSessionMetas([meta()], [meta({ phase: "review" })])).toBe(false);
    expect(sameSessionMetas([meta()], [meta({ ended_at: 5 })])).toBe(false);
    expect(sameSessionMetas([meta({ status_changed_at: null })], [meta({ status_changed_at: 500 })])).toBe(false);
    expect(sameSessionMetas([meta({ status_changed_at: 500 })], [meta({ status_changed_at: 500 })])).toBe(true);
    expect(sameSessionMetas([meta({ notification_read_at: null })], [meta({ notification_read_at: 500 })])).toBe(false);
    expect(sameSessionMetas([meta({ notification_read_at: 500 })], [meta({ notification_read_at: 500 })])).toBe(true);
    expect(sameSessionMetas([meta({ exit_notification_read_at: null })], [meta({ exit_notification_read_at: 500 })])).toBe(false);
    expect(sameSessionMetas([meta({ exit_notification_read_at: 500 })], [meta({ exit_notification_read_at: 500 })])).toBe(true);
    expect(sameSessionMetas([meta()], [])).toBe(false);
  });

  it("sameSessionMetas notices sub-task manager authorization changes", () => {
    const manager = { ...meta(), subtask_manager: true, subtask_slug: "child" } as SessionMeta;
    expect(sameSessionMetas([meta()], [manager])).toBe(false);
    expect(sameSessionMetas([manager], [{ ...manager, subtask_slug: "other-child" } as SessionMeta])).toBe(false);
  });

  it("sameKanbanColumns notices a renamed or reordered column", () => {
    const a: KanbanColumn[] = [
      { key: "a", title: "A" },
      { key: "b", title: "B" },
    ] as KanbanColumn[];
    expect(sameKanbanColumns(a, [...a])).toBe(true);
    expect(
      sameKanbanColumns(a, [
        { key: "a", title: "Renamed" },
        { key: "b", title: "B" },
      ] as KanbanColumn[]),
    ).toBe(false);
    expect(sameKanbanColumns(a, [a[1], a[0]])).toBe(false);
  });

  it("sameBoardTasks notices a phase move, which is the whole point of the board", () => {
    expect(sameBoardTasks([task()], [task()])).toBe(true);
    expect(sameBoardTasks([task()], [task({ current_phase: "review" })])).toBe(false);
    expect(sameBoardTasks([task()], [task({ auto_advance: ["x"] })])).toBe(false);
  });

  it("sameBoardTasks notices sub-task pointer changes", () => {
    const parent = { ...task(), active_subtask_slugs: ["child"] } as BoardTask;
    const child = { ...task(), slug: "child", parent_task: "s" } as BoardTask;
    expect(sameBoardTasks([task()], [parent])).toBe(false);
    expect(sameBoardTasks([child], [{ ...child, parent_task: "other-parent" } as BoardTask])).toBe(false);
  });

  it("sameLifecycleMaps compares the exit code only when both sides exited", () => {
    const exited = (code: number): Record<string, LifecycleState> => ({ s1: { state: "exited", code } });
    const live: Record<string, LifecycleState> = { s1: { state: "live" } };
    expect(sameLifecycleMaps(exited(0), exited(0))).toBe(true);
    // Two sessions that both exited but with different codes are not the same state.
    expect(sameLifecycleMaps(exited(0), exited(1))).toBe(false);
    expect(sameLifecycleMaps(live, exited(0))).toBe(false);
    expect(sameLifecycleMaps(live, {})).toBe(false);
  });

  it("sameTaskActivityMaps compares the selected status and every active-session field", () => {
    const summary = (over: Partial<TaskActivitySummary> = {}): TaskActivitySummary => ({
      status: "waiting_for_input",
      active_session: {
        id: "s1",
        worktree: "/w",
        phase: "design",
        harness: "omp",
        model: "m",
        playbook: "superdevelop",
        generic: false,
        step_title: "Design",
      },
      ...over,
    });
    const map = (value: TaskActivitySummary): TaskActivityMap => ({ "/r:x": value });
    expect(sameTaskActivityMaps(map(summary()), map(summary()))).toBe(true);
    expect(sameTaskActivityMaps(map(summary()), map(summary({ status: "running" })))).toBe(false);
    expect(sameTaskActivityMaps(map(summary()), map(summary({ active_session: null })))).toBe(false);
    for (const [field, value] of [
      ["id", "s2"],
      ["worktree", "/other"],
      ["phase", "tdd"],
      ["harness", "claude"],
      ["model", "other"],
      ["playbook", "external"],
      ["generic", true],
      ["step_title", "TDD"],
    ] as const) {
      const active = summary().active_session;
      if (!active) throw new Error("test fixture must include an active session");
      expect(sameTaskActivityMaps(map(summary()), map(summary({ active_session: { ...active, [field]: value } })))).toBe(false);
    }
    expect(sameTaskActivityMaps(map(summary()), {})).toBe(false);
  });
});

describe("TaskActivityIndicators", () => {
  it("renders card statuses as accessible icons without visible status text", () => {
    for (const [status, label] of [
      ["waiting_for_input", "Needs input"],
      ["waiting_for_approval", "Needs approval"],
      ["failed", "Failed"],
      ["completed", "Completed"],
    ] as const) {
      const markup = renderToStaticMarkup(createElement(TaskActivityIndicators, { activity: { status, active_session: null } }));
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).not.toContain(`>${label}<`);
    }
  });
});
