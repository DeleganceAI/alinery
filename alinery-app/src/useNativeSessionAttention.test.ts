import { describe, expect, it } from "vitest";
import type { NotificationPrefs, SessionListItem, SessionObservation } from "./types";
import { nativeAttentionRequests } from "./useNativeSessionAttention";

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  enabled: true,
  sound: true,
  bounce: false,
  banner: true,
  dock_badge: true,
  dock_badge_input_waits: true,
  dock_badge_approval_waits: true,
  dock_badge_failures: true,
  dock_badge_completions: true,
  dock_badge_interruptions: true,
  native_input_waits: true,
  native_approval_waits: true,
  native_failures: true,
  native_interruptions: true,
  native_final_completions: true,
  ...over,
});

const item = (over: Partial<SessionListItem> = {}): SessionListItem =>
  ({
    id: "session",
    repo_path: "/repo",
    task_slug: "task",
    task_name: "Task",
    created: 1,
    archived: false,
    phase: "work",
    harness: "omp",
    model: "",
    playbook: "playbook",
    generic: false,
    execution_id: "execution",
    is_playbook_step: true,
    task_worktree: "/work",
    playbook_title: "Playbook",
    step_title: "Work",
    semantic: { phase_completed_at: 20 },
    ...over,
  }) as SessionListItem;

const observation = (execution: NonNullable<SessionObservation["execution"]>): SessionObservation => ({
  lifecycle: { state: "exited", code: 0 },
  state: null,
  checkpoint: { phase_completed_at: 20 },
  execution,
});

describe("native attention eligibility", () => {
  it("alerts a pending failure once per occurrence and skips intermediate completion", () => {
    const failed = item({ id: "failed" });
    const finishing = item({ id: "finishing" });
    const intermediate = item({ id: "middle" });
    const final = item({ id: "final" });
    const rows = [
      { item: failed, notice: "failure" as const },
      { item: finishing, notice: "unread_completion" as const },
      { item: intermediate, notice: "unread_completion" as const },
      { item: final, notice: "unread_completion" as const },
    ];
    const observations = {
      "/repo:task:failed": observation({ lifecycle: "failed", status: "failed", error: null, failure_occurrence: "execution:failed" }),
      "/repo:task:finishing": observation({ lifecycle: "finishing", status: "finishing", error: null, failure_occurrence: null }),
      "/repo:task:middle": observation({ lifecycle: "completed", status: "completed", error: null, failure_occurrence: null, final_completion: false }),
      "/repo:task:final": observation({ lifecycle: "completed", status: "completed", error: null, failure_occurrence: null, final_completion: true }),
    };
    expect(nativeAttentionRequests(rows, observations, prefs()).map((request) => request.reason)).toEqual(["failure", "completed"]);
    expect(nativeAttentionRequests(rows, observations, prefs({ native_failures: false })).map((request) => request.reason)).toEqual(["completed"]);
    expect(nativeAttentionRequests(rows, observations, prefs({ banner: false, sound: false }))).toEqual([]);
  });
});
