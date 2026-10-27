import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import * as ipc from "../ipc";
import {
  CURATED_PLAYBOOK_ARCHETYPES,
  isOnboardingCompleted,
  markOnboardingCompleted,
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_STEPS,
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
    expect(readSavedOnboardingStep(true)).toBe("models");

    for (const step of ["workspace", "models", "playbooks", "launch"] as const) {
      writeSavedOnboardingStep(step);
      expect(readSavedOnboardingStep(true)).toBe(step);
    }
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual(["workspace", "models", "playbooks", "launch"]);

    window.localStorage.setItem("alinery.onboardingStep.v1", "toString");
    expect(readSavedOnboardingStep(true)).toBe("models");

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
    fireEvent.click(screen.getByRole("combobox", { name: "Default repository model" }));
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

  const flowProps = () => ({
    appConfig: baseConfig,
    repoError: "",
    onSelectRepo: vi.fn(async () => true),
    onAddRepo: vi.fn(async () => true),
    onRemoveRepo: vi.fn(),
    onOpenProviderSetup: vi.fn(),
    onCompleteToWorkspace: vi.fn(),
    onOpenCreateWithPlaybook: vi.fn(),
    onLaunchStarterTask: vi.fn(async () => {}),
  });
  const advanceDemo = async (milliseconds: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  };

  it("returns a repository-free preview to repository selection without offering a blocked launch", async () => {
    render(<OnboardingFlow {...flowProps()} appConfig={{ ...baseConfig, active_repo: "", known_repos: [] }} initialStep="workspace" />);
    fireEvent.click(screen.getByRole("tab", { name: /Playbooks/ }));
    expect(screen.getByTestId("onboarding-step-playbooks")).toBeTruthy();
    expect(window.localStorage.getItem("alinery.onboardingStep.v1")).toBeNull();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("tab", { name: /Models/ }).classList.contains("completed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("onboarding-step-workspace")).toBeTruthy();
    await act(async () => {});
  });

  it("pauses autoplay when selecting a graph node so its contract stays available", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(1400);
    fireEvent.click(within(screen.getByRole("region", { name: "Dependency graph canvas" })).getByRole("button", { name: "Highlight Plan" }));
    expect(screen.getByRole("button", { name: "Resume demo" })).toBeTruthy();
    await advanceDemo(6000);
    expect(screen.getByRole("region", { name: "Plan step contract" })).toBeTruthy();
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
  });

  it.each([
    ["ArrowUp", /Academic Survey/],
    ["ArrowDown", /SuperDevelop/],
  ] as const)("preserves the custom starter on Back and enters the example list with %s", async (key, example) => {
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Build a new playbook" }));
    fireEvent.change(screen.getByLabelText("Starter task title"), { target: { value: "My custom workflow" } });
    fireEvent.change(screen.getByLabelText("Starter task description"), { target: { value: "Keep my edited instructions." } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((screen.getByLabelText("Starter task title") as HTMLInputElement).value).toBe("My custom workflow");
    expect((screen.getByLabelText("Starter task description") as HTMLTextAreaElement).value).toBe("Keep my edited instructions.");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const examples = screen.getByRole("radiogroup", { name: "Explore starter playbooks" });
    fireEvent.keyDown(examples, { key });
    expect(within(examples).getByRole("radio", { name: example }).getAttribute("aria-checked")).toBe("true");
  });

  it("continues from repository through models, playbooks, and first task", async () => {
    render(<OnboardingFlow {...flowProps()} initialStep="workspace" />);
    for (const next of ["models", "playbooks", "launch"]) {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(screen.getByTestId(`onboarding-step-${next}`)).toBeTruthy();
      expect(readSavedOnboardingStep(true)).toBe(next);
      await act(async () => {});
    }
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("onboarding-step-playbooks")).toBeTruthy();
  });

  it("makes provider subscriptions and API-key setup visible before the model choice", async () => {
    const props = flowProps();
    render(<OnboardingFlow {...props} initialStep="models" />);
    fireEvent.click(screen.getByRole("button", { name: "Set up accounts and API keys" }));
    expect(props.onOpenProviderSetup).toHaveBeenCalledWith("accounts");
    expect(screen.getByText(/Accounts shows available sign-in options and instructions for API key setup/)).toBeTruthy();
    expect(ipc.ompSetupSession).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("autoplays every step, briefly shows human checkpoints, and loops without executing tasks", async () => {
    vi.useFakeTimers();
    const props = flowProps();
    const createTask = vi.spyOn(ipc, "createTaskForRepo");
    const createSession = vi.spyOn(ipc, "createSession");
    const createSessionForRepo = vi.spyOn(ipc, "createSessionForRepo");
    const openSession = vi.spyOn(ipc, "openSession");
    render(<OnboardingFlow {...props} initialStep="playbooks" />);
    await act(async () => {});
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause demo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Simulate|Advance step|Approve|Reset/ })).toBeNull();
    await advanceDemo(1400);
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    await advanceDemo(4000);
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await advanceDemo(1400);
    expect(screen.getByText(/Real runs wait for your approval/)).toBeTruthy();
    await advanceDemo(2399);
    expect(screen.getByText("Checkpoint gate")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText("Wave 4 of 7")).toBeTruthy();
    for (const wave of [5, 6]) {
      await advanceDemo(1400);
      expect(screen.getByText(`Wave ${wave} of 7`)).toBeTruthy();
    }
    await advanceDemo(1400);
    expect(screen.getByText("Checkpoint gate")).toBeTruthy();
    await advanceDemo(2400);
    expect(screen.getByText("Finished")).toBeTruthy();
    await advanceDemo(2399);
    expect(screen.getByText("Finished")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    expect(props.onLaunchStarterTask).not.toHaveBeenCalled();
    expect(props.onOpenCreateWithPlaybook).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(createSessionForRepo).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(ipc.ompSetupSession).not.toHaveBeenCalled();
  });

  it("restarts when changing archetypes and keeps fan-out contracts inspectable", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(1400);
    fireEvent.click(screen.getByRole("radio", { name: /Academic Survey/i }));
    expect(screen.getByText("Wave 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    const graph = screen.getByRole("region", { name: "Dependency graph canvas" });
    fireEvent.click(within(graph).getByRole("button", { name: /Gather Candidate Sources — example 1/i }));
    expect(screen.getByText("each — spawns parallel sessions")).toBeTruthy();
    fireEvent.click(within(graph).getByRole("button", { name: /Deduplicate and Dispatch Sources/i }));
    expect(screen.getByText("complete — waits for all upstream outputs")).toBeTruthy();
    await advanceDemo(4000);
    expect(screen.getByText("Wave 1 of 3")).toBeTruthy();
  });

  it("clears autoplay timers when leaving, changing repositories, or unmounting", async () => {
    vi.useFakeTimers();
    const props = flowProps();
    const view = render(<OnboardingFlow {...props} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(1000);
    view.rerender(<OnboardingFlow {...props} appConfig={{ ...baseConfig, active_repo: "/other/repo" }} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(400);
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Models/ }));
    await advanceDemo(4000);
    fireEvent.click(screen.getByRole("tab", { name: /Playbooks/ }));
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    view.unmount();
    await advanceDemo(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("respects reduced motion until demo playback is explicitly requested", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume demo" })).toBeTruthy();
    await advanceDemo(10000);
    expect(screen.getByText("Wave 1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await advanceDemo(1400);
    expect(screen.getByText("Wave 2 of 7")).toBeTruthy();
  });

  it("offers building a new playbook separately and prepares the existing editable starter", async () => {
    const props = flowProps();
    render(<OnboardingFlow {...props} initialStep="playbooks" />);
    await act(async () => {});
    const examples = screen.getByRole("radiogroup", { name: "Explore starter playbooks" });
    expect(within(examples).queryByText("Build a New Playbook")).toBeNull();
    expect(within(examples).getAllByRole("radio")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Build a new playbook" }));
    expect(screen.getByTestId("onboarding-step-launch")).toBeTruthy();
    expect((screen.getByLabelText("Starter task title") as HTMLInputElement).value).toBe("Design a custom playbook for this repository");
    expect(props.onLaunchStarterTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Build a custom playbook" }));
    await waitFor(() =>
      expect(props.onLaunchStarterTask).toHaveBeenCalledWith(
        { scope: "bundled", key: "build-playbook" },
        expect.objectContaining({ name: "Design a custom playbook for this repository" }),
      ),
    );
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
