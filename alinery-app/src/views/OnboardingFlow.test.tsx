import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import * as ipc from "../ipc";
import {
  CURATED_PLAYBOOK_ARCHETYPES,
  isOnboardingCompleted,
  markOnboardingCompleted,
  ONBOARDING_COMPLETED_KEY,
  readSavedOnboardingStep,
  writeSavedOnboardingStep,
} from "../onboarding";
import type { AppConfig, BoardTask, KanbanColumn, NormalizedPlaybook, NormalizedStep, RepoOverrides, ScopedSettings } from "../types";
import { Grid, resetGridBoardSnapshots } from "./Grid";
import { OnboardingFlow } from "./OnboardingFlow";

vi.mock("../WindowChrome", () => ({
  ResizeHandles: () => null,
  WindowControls: () => null,
  useWindowFullscreen: () => false,
}));

const baseConfig: AppConfig = {
  active_repo: "/Users/dev/project",
  known_repos: ["/Users/dev/project"],
  mcp_enabled: true,
  appearance: DEFAULT_APPEARANCE,
};

function previewDefinition(key: string, title: string): NormalizedPlaybook {
  const step = (name: string, autoAdvance = true): NormalizedStep => ({
    key: name.toLowerCase().replace(/ /g, "-"),
    title: name,
    short: name,
    is_coding_step: false,
    auto_advance_default: autoAdvance,
    inputs: [],
    outputs: [{ path: `${name.toLowerCase()}.md` }],
    model: "",
    harness: "omp",
    prompt: "",
  });
  const steps =
    key === "academic-survey"
      ? [
          { ...step("Queries"), outputs: [{ path: "query-*.md" }] },
          { ...step("Gather Candidate Sources"), inputs: [{ path: "query-*.md", mode: "each" as const }], outputs: [{ path: "source-*.md" }] },
          { ...step("Deduplicate and Dispatch Sources"), inputs: [{ path: "source-*.md", mode: "complete" as const }] },
        ]
      : [step("Clarify"), step("Investigate"), step("Decide", false), step("Plan"), step("Define Tests"), step("Build"), step("Prepare Review", false)];
  return { version: 2, key, title, description: "", default_model: "", default_harness: "omp", step: steps, preamble: "", section_order: [] };
}

beforeEach(() => {
  window.localStorage.clear();
  resetGridBoardSnapshots();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(ipc, "readPlaybook").mockImplementation(async (reference) => {
    const found = CURATED_PLAYBOOK_ARCHETYPES.find((item) => item.reference.key === reference.key) ?? CURATED_PLAYBOOK_ARCHETYPES[0];
    return {
      source: { reference: found.reference, path: null },
      definition: previewDefinition(found.reference.key, found.title),
      source_text: "+++ version = 2 +++",
      modified_at_ms: null,
    };
  });
  vi.spyOn(ipc, "readConfigForRepo").mockResolvedValue({
    notifications: {
      enabled: true,
      sound: true,
      bounce: false,
      banner: true,
      dock_badge: true,
      dock_badge_input_waits: true,
      dock_badge_approval_waits: true,
      dock_badge_failures: true,
      dock_badge_completions: true,
    },
    github: { token: "" },
    defaults: { harness: "omp", model: "anthropic/claude-sonnet-4-5", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
    provenance: {
      github_token: "global",
      defaults: {
        harness: "global",
        model: "global",
        thinking: "global",
        playbook: "global",
        draft_autosave: "global",
      },
    },
    backup: {
      destination: "",
      enabled: false,
      retention: 5,
      trigger_pre_archive: false,
      trigger_post_artifact_change: false,
      trigger_post_push_commit: false,
    },
    telemetry: { enabled: false, prompted: false, install_id: "", endpoint: "" },
  });
  vi.spyOn(ipc, "ompSetupSession").mockResolvedValue("setup-session-1");
  vi.spyOn(ipc, "readModelFavorites").mockResolvedValue([]);
  vi.spyOn(ipc, "listHarnessModels").mockResolvedValue(["anthropic/claude-sonnet-4-5"]);
  vi.spyOn(ipc, "listHarnessModelsForRepo").mockResolvedValue(["anthropic/claude-sonnet-4-5"]);
  vi.spyOn(ipc, "checkOmpUpdate").mockResolvedValue({ installed: "18.11.1", available: null, checked_at: 1, binary_path: "/omp", config_dir: "/config" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("onboarding persistence helpers", () => {
  it("persists onboarding completion and step state and rejects prototype keys", () => {
    expect(isOnboardingCompleted()).toBe(false);
    expect(readSavedOnboardingStep(false)).toBe("workspace");
    expect(readSavedOnboardingStep(true)).toBe("playbooks");

    writeSavedOnboardingStep("models");
    expect(readSavedOnboardingStep(true)).toBe("models");

    window.localStorage.setItem("alinery.onboardingStep.v1", "toString");
    expect(readSavedOnboardingStep(true)).toBe("playbooks");

    markOnboardingCompleted();
    expect(isOnboardingCompleted()).toBe(true);
    expect(window.localStorage.getItem(ONBOARDING_COMPLETED_KEY)).toBe("1");
    expect(window.localStorage.getItem("alinery.onboardingStep.v1")).toBeNull();
  });
});

describe("OnboardingFlow wizard", () => {
  it.each(["openai/private-deployment", ""])("preserves unrelated repository overrides when choosing model %j", async (model) => {
    const effective = await ipc.readConfigForRepo(baseConfig.active_repo);
    const original: RepoOverrides = {
      github: { token: "repository-credential-fixture" },
      defaults: { thinking: "high", playbook: { scope: "repo", key: "custom" }, draft_autosave: false },
      backup: { destination: "/backup", enabled: false, retention: 13 },
    };
    let persisted = structuredClone(original);
    const scoped: ScopedSettings = {
      global: { ...effective, harnesses: { harness: [] }, model_favorites: {}, updates: { check_enabled: true } },
      effective,
      overrides: original,
    };
    vi.spyOn(ipc, "readScopedSettingsForRepo").mockResolvedValue(scoped);
    vi.spyOn(ipc, "writeRepoOverridesForRepo").mockImplementation(async (_repo, overrides) => {
      persisted = structuredClone(overrides);
      return { ...scoped, overrides: persisted };
    });
    let pick: ((value: string) => void) | undefined;
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        repoError=""
        initialStep="models"
        onSelectRepo={vi.fn(async () => true)}
        onAddRepo={vi.fn(async () => true)}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={(_tab, onPick) => {
          pick = onPick;
        }}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
        onLaunchStarterTask={vi.fn(async () => {})}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Default repository model")).toHaveProperty("value", effective.defaults.model));
    fireEvent.click(screen.getByRole("button", { name: "Browse models" }));
    act(() => pick?.(model));
    await waitFor(() => expect(persisted.defaults.model).toBe(model || null));
    expect(persisted.github).toEqual(original.github);
    expect(persisted.backup).toEqual(original.backup);
    expect(persisted.defaults).toEqual({ ...original.defaults, model: model || null });
  });

  it("leaves no unattached setup runtime after visiting model setup without opening accounts", async () => {
    const unattached = new Set<string>();
    vi.mocked(ipc.ompSetupSession).mockImplementation(async () => {
      unattached.add("unattached-setup");
      return "unattached-setup";
    });
    const view = render(
      <OnboardingFlow
        appConfig={baseConfig}
        repoError=""
        initialStep="models"
        onSelectRepo={vi.fn(async () => true)}
        onAddRepo={vi.fn(async () => true)}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
        onLaunchStarterTask={vi.fn(async () => {})}
      />,
    );
    await act(async () => {});
    view.unmount();
    expect([...unattached]).toEqual([]);
  });

  it("shows a failed preview without fabricated steps and reloads it on retry", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.mocked(ipc.readPlaybook).mockRejectedValueOnce(new Error("Bundled definition could not be read"));
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        repoError=""
        initialStep="playbooks"
        onSelectRepo={vi.fn(async () => true)}
        onAddRepo={vi.fn(async () => true)}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
        onLaunchStarterTask={vi.fn(async () => {})}
      />,
    );
    const retry = await screen.findByRole("button", { name: "Retry preview" });
    expect(screen.queryByRole("region", { name: "Dependency graph canvas" })).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByRole("region", { name: "Dependency graph canvas" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
  });

  it("keeps repository selection on Step 01 until the user continues", async () => {
    const onSelectRepo = vi.fn(async () => true);
    const onAddRepo = vi.fn(async () => true);

    render(
      <OnboardingFlow
        appConfig={{ ...baseConfig, active_repo: "", known_repos: ["/Users/dev/project"] }}
        repoError=""
        onSelectRepo={onSelectRepo}
        onAddRepo={onAddRepo}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
        onLaunchStarterTask={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByTestId("onboarding-step-workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();

    fireEvent.click(screen.getByTitle("/Users/dev/project"));
    await waitFor(() => expect(onSelectRepo).toHaveBeenCalledWith("/Users/dev/project"));
    expect(screen.getByTestId("onboarding-step-workspace")).toBeTruthy();
    expect(readSavedOnboardingStep(true)).toBe("workspace");
  });

  it("explores playbooks and simulates auto-advance waves and human checkpoints in Step 02", async () => {
    vi.useFakeTimers();
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        repoError=""
        initialStep="playbooks"
        onSelectRepo={vi.fn(async () => true)}
        onAddRepo={vi.fn(async () => true)}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
        onLaunchStarterTask={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByTestId("onboarding-step-playbooks")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How playbooks work" })).toBeTruthy();

    expect(screen.queryByRole("radiogroup")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Simulate run/i })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.getByRole("button", { name: /Simulate run/i })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(screen.queryByRole("button", { name: "Pause demo" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1400);
    });
    expect(screen.getByText(/Paused at human checkpoint/i)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByText(/Paused at human checkpoint/i)).toBeTruthy();
    const approveBtn = screen.getByRole("button", { name: /Approve decide\.md & continue to Plan/i });
    expect(approveBtn).toBeTruthy();

    // Approving the Decide checkpoint advances simulation to Plan
    fireEvent.click(approveBtn);
    expect(screen.getByRole("button", { name: /Advance step to Define Tests/i })).toBeTruthy();

    // Switch to Academic Survey to inspect `each` fan-out and `complete` barrier bindings
    fireEvent.click(screen.getByRole("radio", { name: /Academic Survey/i }));
    const graphRegion = screen.getByRole("region", { name: "Dependency graph canvas" });
    expect(within(graphRegion).getByRole("button", { name: /Gather Candidate Sources — example 1/i })).toBeTruthy();
    expect(within(graphRegion).getByRole("button", { name: /Gather Candidate Sources — example 2/i })).toBeTruthy();

    fireEvent.click(within(graphRegion).getByRole("button", { name: /Gather Candidate Sources — example 1/i }));
    expect(screen.getByText("each — spawns parallel sessions")).toBeTruthy();

    fireEvent.click(within(graphRegion).getByRole("button", { name: /Deduplicate and Dispatch Sources/i }));
    expect(screen.getByText("complete — waits for all upstream outputs")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("button", { name: "Simulate run" })).toBeTruthy();
  });

  it("shows the explorer immediately without autoplay when reduced motion is requested", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        repoError=""
        initialStep="playbooks"
        onSelectRepo={vi.fn(async () => true)}
        onAddRepo={vi.fn(async () => true)}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
        onLaunchStarterTask={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Simulate run" }));
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Advance step to Investigate/ }));
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
  });

  it("launches a 1-click starter task or opens the full Create Task form in Step 04", async () => {
    const onLaunchStarterTask = vi.fn(async () => {});
    const onOpenCreateWithPlaybook = vi.fn();

    render(
      <OnboardingFlow
        appConfig={baseConfig}
        repoError=""
        initialStep="launch"
        onSelectRepo={vi.fn(async () => true)}
        onAddRepo={vi.fn(async () => true)}
        onRemoveRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={onOpenCreateWithPlaybook}
        onLaunchStarterTask={onLaunchStarterTask}
      />,
    );

    expect(screen.getByTestId("onboarding-step-launch")).toBeTruthy();
    const titleInput = screen.getByLabelText("Starter task title") as HTMLInputElement;
    expect(titleInput.value).toBe("Map architecture and improvement opportunities");

    fireEvent.click(screen.getByRole("button", { name: /Run SuperDevelop starter task/i }));
    await waitFor(() =>
      expect(onLaunchStarterTask).toHaveBeenCalledWith(
        { scope: "bundled", key: "superdevelop" },
        expect.objectContaining({
          name: "Map architecture and improvement opportunities",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Open full Create Task form with SuperDevelop/i }));
    expect(onOpenCreateWithPlaybook).toHaveBeenCalledWith({ scope: "bundled", key: "superdevelop" });
  });
});

describe("Empty Grid Playbook Starter Gate", () => {
  const columns: KanbanColumn[] = [
    { key: "planning", title: "Planning" },
    { key: "implementation", title: "Implementation" },
    { key: "review", title: "Review" },
  ];

  beforeEach(() => {
    vi.spyOn(ipc, "listKanbanColumns").mockResolvedValue(columns);
    vi.spyOn(ipc, "listTaskActivity").mockResolvedValue({});
    vi.spyOn(ipc, "observeTaskExecutions").mockResolvedValue([]);
    vi.spyOn(ipc, "listTaskPullRequests").mockResolvedValue({});
  });

  it("renders GridPlaybookStarterGate when repository has 0 tasks, and filter empty message when tasks are filtered out", async () => {
    vi.spyOn(ipc, "listBoardTasks").mockResolvedValue([]);
    const onCreate = vi.fn();
    const onReplayOnboarding = vi.fn();

    const { unmount } = render(
      <Grid allRepos={false} repoPaths={["/Users/dev/project"]} onOpen={vi.fn()} registerNav={vi.fn()} onCreate={onCreate} onReplayOnboarding={onReplayOnboarding} />,
    );

    const gate = await screen.findByTestId("grid-starter-gate");
    expect(within(gate).getByRole("heading", { name: "Start your first task with a playbook" })).toBeTruthy();
    expect(screen.queryByText("No tasks match this grid configuration.")).toBeNull();

    fireEvent.click(within(gate).getByRole("button", { name: "New task with SuperDevelop" }));
    expect(onCreate).toHaveBeenCalledWith({ scope: "bundled", key: "superdevelop" });

    fireEvent.click(within(gate).getByRole("button", { name: "How playbooks work" }));
    expect(onReplayOnboarding).toHaveBeenCalled();

    unmount();
    resetGridBoardSnapshots();

    // Now test with 1 completed task that gets filtered out by the "active" filter
    const completedTask: BoardTask = {
      name: "Existing task",
      slug: "existing-task",
      requested_slug: "existing-task",
      branch: "existing-task",
      worktree: "/Users/dev/project/.alinery/worktrees/existing-task",
      has_worktree: true,
      created: 1000,
      archived: false,
      pr_url: "",
      linear_id: "",
      github_issue: "",
      playbook: "superdevelop",
      engine_version: 2,
      playbook_ref: { scope: "bundled", key: "superdevelop" },
      draft: false,
      auto_advance: [],
      repo_path: "/Users/dev/project",
      session_count: 1,
      playbook_title: "SuperDevelop",
      playbook_steps: [{ key: "research", title: "Research" }],
      updated: 2000,
      current_phase: "done",
      current_step_title: "Done",
      latest_session_title: "Done",
      latest_session_column_key: "done",
      current_column_key: "done",
      current_column_title: "Done",
    };
    vi.spyOn(ipc, "listBoardTasks").mockResolvedValue([completedTask]);
    vi.spyOn(ipc, "listTaskActivity").mockResolvedValue({
      "/Users/dev/project:existing-task": { status: "completed", active_session: null },
    });

    render(<Grid allRepos={false} repoPaths={["/Users/dev/project"]} onOpen={vi.fn()} registerNav={vi.fn()} />);

    await screen.findByText("Existing task");
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "active" } });
    expect(await screen.findByText("No tasks match this grid configuration.")).toBeTruthy();
    expect(screen.queryByTestId("grid-starter-gate")).toBeNull();
  });
});
