import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import * as ipc from "../ipc";
import { CURATED_PLAYBOOK_ARCHETYPES, ONBOARDING_STEPS, readSavedOnboardingStep, writeSavedOnboardingStep } from "../onboarding";
import * as sessions from "../sync/sessions";
import * as tasks from "../sync/tasks";
import { fakeBoard } from "../test/boardHooks";
import type { AppConfig, BoardTask, NormalizedPlaybook, NormalizedStep, PlaybookRef, RepoOverrides, ScopedPlaybook } from "../types";
import { Grid } from "./Grid";
import { OnboardingFlow } from "./OnboardingFlow";

const settingsMocks = vi.hoisted(() => ({ readEffectiveConfig: vi.fn(), readRepoSettings: vi.fn(), writeRepoOverrides: vi.fn() }));
vi.mock("../sync/settings", async (actual) => ({ ...(await actual<typeof import("../sync/settings")>()), ...settingsMocks }));
const playbookMock = vi.hoisted(() => ({ readPlaybook: vi.fn<(reference: PlaybookRef) => Promise<ScopedPlaybook>>() }));
vi.mock("../sync/playbooks", async (actual) => ({ ...(await actual<typeof import("../sync/playbooks")>()), ...playbookMock }));
vi.mock("../sync/git", () => ({ listTaskPullRequests: async () => ({}) }));
vi.mock("../sync/providers", () => ({ listModels: async () => ["anthropic/claude-sonnet-4-5"] }));
vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
vi.mock("../sync/execution", async (actual) => (await import("../test/executionFeed")).executionHooks(await actual()));
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
    harness: "vinculum",
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
  return { version: 2, key, title, description: "", default_model: "", default_harness: "vinculum", step: steps, preamble: "", section_order: [] };
}

beforeEach(() => {
  window.localStorage.clear();
  fakeBoard.reset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  playbookMock.readPlaybook.mockImplementation(async (reference) => {
    const found = CURATED_PLAYBOOK_ARCHETYPES.find((item) => item.reference.key === reference.key) ?? CURATED_PLAYBOOK_ARCHETYPES[0];
    return {
      source: { reference: found.reference, path: null },
      definition: previewDefinition(found.reference.key, found.title),
      source_text: "+++ version = 2 +++",
      modified_at_ms: null,
    };
  });
  settingsMocks.readEffectiveConfig.mockResolvedValue({
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
    defaults: { harness: "vinculum", model: "anthropic/claude-sonnet-4-5", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
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
  vi.spyOn(ipc, "readModelFavorites").mockResolvedValue([]);
  vi.spyOn(ipc, "accountStatus").mockResolvedValue({ signedIn: false, email: null, plan: null, paid: false, unavailable: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("onboarding step persistence", () => {
  it("persists the step and rejects prototype keys", () => {
    expect(readSavedOnboardingStep()).toBe("models");
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual(["models", "playbooks"]);

    writeSavedOnboardingStep("playbooks");
    expect(readSavedOnboardingStep()).toBe("playbooks");

    // The First task step is gone: a saved "launch" resumes on the last remaining step.
    window.localStorage.setItem("alinery.onboardingStep.v1", "launch");
    expect(readSavedOnboardingStep()).toBe("playbooks");
    // The repository step is gone too: a saved "workspace" falls back to the first step.
    window.localStorage.setItem("alinery.onboardingStep.v1", "workspace");
    expect(readSavedOnboardingStep()).toBe("models");
    window.localStorage.setItem("alinery.onboardingStep.v1", "toString");
    expect(readSavedOnboardingStep()).toBe("models");
  });
});

describe("OnboardingFlow wizard", () => {
  it.each(["openai/private-deployment", ""])("preserves unrelated repository overrides when choosing model %j", async (model) => {
    const effective = await settingsMocks.readEffectiveConfig(baseConfig.active_repo);
    const original: RepoOverrides = {
      github: { token: "repository-credential-fixture" },
      defaults: { thinking: "high", playbook: { scope: "repo", key: "custom" }, draft_autosave: false },
      backup: { destination: "/backup", enabled: false, retention: 13 },
    };
    let persisted = structuredClone(original);
    settingsMocks.readRepoSettings.mockResolvedValue({ overrides: original, effective, revision: 3n });
    let sentRevision: bigint | undefined;
    settingsMocks.writeRepoOverrides.mockImplementation(async (_repo: string, overrides: RepoOverrides, revision?: bigint) => {
      persisted = structuredClone(overrides);
      sentRevision = revision;
      return undefined;
    });
    let pick: ((value: string) => void) | undefined;
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        initialStep="models"
        onChangeRepo={vi.fn()}
        onOpenProviderSetup={(_tab, onPick) => {
          pick = onPick;
        }}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Default repository model")).toHaveProperty("value", effective.defaults.model));
    fireEvent.click(screen.getByRole("combobox", { name: "Default repository model" }));
    act(() => pick?.(model));
    await waitFor(() => expect(persisted.defaults.model).toBe(model || null));
    expect(persisted.github).toEqual(original.github);
    expect(persisted.backup).toEqual(original.backup);
    expect(persisted.defaults).toEqual({ ...original.defaults, model: model || null });
    expect(sentRevision).toBe(3n);
  });

  it("takes a signed-out user from the Founder plan card to sign-in and then billing", async () => {
    const signIn = vi.spyOn(ipc, "accountSignIn").mockResolvedValue({ signedIn: true, email: "dev@example.com", plan: null, paid: false, unavailable: false });
    const refresh = vi.spyOn(ipc, "accountRefresh").mockResolvedValue({ signedIn: true, email: "dev@example.com", plan: null, paid: false, unavailable: false });
    const openPlans = vi.spyOn(ipc, "accountOpenPlans").mockResolvedValue(undefined);
    const onOpenProviderSetup = vi.fn();
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        initialStep="models"
        onChangeRepo={vi.fn()}
        onOpenProviderSetup={onOpenProviderSetup}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Get the Founder plan" }));
    await waitFor(() => expect(openPlans).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // Paired but unpaid: the card now offers checkout directly, no second sign-in.
    expect(await screen.findByRole("button", { name: "Subscribe" })).toBeTruthy();
    expect(screen.getByText("Opens billing for dev@example.com.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Claude/ }));
    expect(onOpenProviderSetup).toHaveBeenLastCalledWith("accounts", undefined, "anthropic");
  });

  it.each([false, true])("refreshes a paid subscriber before offering billing (already signed in: %s)", async (signedIn) => {
    const paired = { signedIn: true, email: "subscriber@example.com", plan: null, paid: false, unavailable: false };
    if (signedIn) vi.mocked(ipc.accountStatus).mockResolvedValue(paired);
    const signIn = vi.spyOn(ipc, "accountSignIn").mockResolvedValue(paired);
    const paid = { ...paired, plan: "founder", paid: true };
    let finishRefresh!: (status: typeof paid) => void;
    const refresh = vi.spyOn(ipc, "accountRefresh").mockReturnValue(new Promise((resolve) => (finishRefresh = resolve)));
    const openPlans = vi.spyOn(ipc, "accountOpenPlans").mockResolvedValue(undefined);
    render(<OnboardingFlow {...flowProps()} initialStep="models" />);
    fireEvent.click(await screen.findByRole("button", { name: signedIn ? "Subscribe" : "Get the Founder plan" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(openPlans).not.toHaveBeenCalled();
    expect(screen.getByText("Checking your plan…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => finishRefresh(paid));
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(signIn).toHaveBeenCalledTimes(signedIn ? 0 : 1);
    expect(openPlans).not.toHaveBeenCalled();
  });

  it("still lets users cancel browser pairing before checking their plan", async () => {
    let cancel!: (error: Error) => void;
    vi.spyOn(ipc, "accountSignIn").mockReturnValue(new Promise((_resolve, reject) => (cancel = reject)));
    const cancelSignIn = vi.spyOn(ipc, "accountCancelSignIn").mockImplementation(async () => cancel(new Error("Sign-in cancelled")));
    const refresh = vi.spyOn(ipc, "accountRefresh");
    const openPlans = vi.spyOn(ipc, "accountOpenPlans");
    render(<OnboardingFlow {...flowProps()} initialStep="models" />);
    fireEvent.click(await screen.findByRole("button", { name: "Get the Founder plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Get the Founder plan" })).toBeTruthy();
    expect(cancelSignIn).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(openPlans).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "signed out", "request failed"])("keeps billing closed when the plan refresh is %s", async (outcome) => {
    const paired = { signedIn: true, email: "subscriber@example.com", plan: null, paid: false, unavailable: false };
    vi.spyOn(ipc, "accountSignIn").mockResolvedValue(paired);
    const refresh = vi.spyOn(ipc, "accountRefresh").mockImplementation(async () => {
      if (outcome === "request failed") throw new Error("Plan service offline");
      return { ...paired, signedIn: outcome !== "signed out", unavailable: outcome === "unavailable" };
    });
    const openPlans = vi.spyOn(ipc, "accountOpenPlans").mockResolvedValue(undefined);
    render(<OnboardingFlow {...flowProps()} initialStep="models" />);
    fireEvent.click(await screen.findByRole("button", { name: "Get the Founder plan" }));
    expect(await screen.findByText(outcome === "request failed" ? /Plan service offline/ : /Couldn't check your plan/)).toBeTruthy();
    expect(openPlans).not.toHaveBeenCalled();
    refresh.mockResolvedValue({ ...paired, plan: "founder", paid: true });
    fireEvent.click(screen.getByRole("button", { name: outcome === "signed out" ? "Get the Founder plan" : "Subscribe" }));
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(openPlans).not.toHaveBeenCalled();
  });

  it("shows a failed preview without fabricated steps and reloads it on retry", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    playbookMock.readPlaybook.mockRejectedValueOnce(new Error("Bundled definition could not be read"));
    render(
      <OnboardingFlow
        appConfig={baseConfig}
        initialStep="playbooks"
        onChangeRepo={vi.fn()}
        onOpenProviderSetup={vi.fn()}
        onCompleteToWorkspace={vi.fn()}
        onOpenCreateWithPlaybook={vi.fn()}
      />,
    );
    const retry = await screen.findByRole("button", { name: "Retry preview" });
    expect(screen.queryByRole("region", { name: "Dependency graph canvas" })).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByRole("region", { name: "Dependency graph canvas" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
  });

  const flowProps = () => ({
    appConfig: baseConfig,
    onChangeRepo: vi.fn(),
    onOpenProviderSetup: vi.fn(),
    onCompleteToWorkspace: vi.fn(),
    onOpenCreateWithPlaybook: vi.fn(),
  });
  const advanceDemo = async (milliseconds: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  };

  it("pauses autoplay when selecting a graph node so its contract stays available", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(2600);
    fireEvent.click(within(screen.getByRole("region", { name: "Dependency graph canvas" })).getByRole("button", { name: "Highlight Plan" }));
    expect(screen.getByRole("button", { name: "Resume demo" })).toBeTruthy();
    await advanceDemo(6000);
    expect(screen.getByRole("region", { name: "Plan step contract" })).toBeTruthy();
    expect(screen.getByText("Step 4 of 7")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "Playbook demo" });
    expect(progress.getAttribute("aria-valuenow")).toBe("4");
    expect(progress.getAttribute("aria-valuetext")).toBe("Plan, step 4 of 7");
  });

  it.each([
    { step: 1, precedingSteps: 0, duration: 2600 },
    { step: 3, precedingSteps: 2, duration: 3800 },
  ])("resumes step $step after only its remaining playback time", async ({ step, precedingSteps, duration }) => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    for (let index = 0; index < precedingSteps; index += 1) await advanceDemo(2600);
    await advanceDemo(1000);
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    await advanceDemo(10000);
    expect(screen.getByText(`Step ${step} of 7`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await advanceDemo(500);
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    await advanceDemo(5000);
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await advanceDemo(duration - 1501);
    expect(screen.getByText(`Step ${step} of 7`)).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText(`Step ${step + 1} of 7`)).toBeTruthy();
  });

  it("returns from manual inspection to the active step when resuming", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(2600);
    await advanceDemo(900);
    fireEvent.click(within(screen.getByRole("region", { name: "Dependency graph canvas" })).getByRole("button", { name: "Highlight Plan" }));
    expect(screen.getByRole("region", { name: "Plan step contract" })).toBeTruthy();
    await advanceDemo(5000);
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    expect(screen.getByRole("region", { name: "Investigate step contract" })).toBeTruthy();
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Playbook demo" }).getAttribute("aria-valuetext")).toBe("Investigate, step 2 of 7");
    await advanceDemo(1699);
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByRole("region", { name: "Decide step contract" })).toBeTruthy();
  });

  it("starts a fresh step duration when switching playbooks during a paused partial step", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(1000);
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    fireEvent.click(screen.getByRole("radio", { name: /Academic Survey/i }));
    await act(async () => {});
    await advanceDemo(2599);
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("moves playbook selection and focus with the keyboard without restarting a paused demo", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    const radios = within(screen.getByRole("radiogroup", { name: "Explore starter playbooks" })).getAllByRole("radio");
    radios[0].focus();
    for (const [key, index] of [
      ["ArrowDown", 1],
      ["ArrowUp", 0],
      ["End", 3],
      ["Home", 0],
    ] as const) {
      fireEvent.keyDown(document.activeElement ?? radios[0], { key });
      expect(document.activeElement).toBe(radios[index]);
      expect(radios[index].getAttribute("aria-checked")).toBe("true");
      expect(radios[index].getAttribute("tabindex")).toBe("0");
      expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([radios[index]]);
      expect(screen.getByRole("button", { name: "Resume demo" })).toBeTruthy();
    }
    await advanceDemo(10000);
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
  });

  it("continues through exactly two steps and opens task creation without executing a task", async () => {
    const props = flowProps();
    const createTask = vi.spyOn(tasks, "createTaskForRepo");
    const createSession = vi.spyOn(sessions, "createSession");
    render(<OnboardingFlow {...props} />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByText("First task")).toBeNull();
    expect(screen.getByTestId("onboarding-step-models")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change repository" }));
    expect(props.onChangeRepo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("onboarding-step-playbooks")).toBeTruthy();
    expect(readSavedOnboardingStep()).toBe("playbooks");
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Skip Onboarding" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish onboarding" }));
    expect(props.onCompleteToWorkspace).not.toHaveBeenCalled();
    expect(props.onOpenCreateWithPlaybook).toHaveBeenCalledWith({ scope: "bundled", key: "superdevelop" });
    expect(createTask).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("onboarding-step-models")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip Onboarding" })).toBeTruthy();
  });
  it("makes provider subscriptions and API-key setup visible before the model choice", async () => {
    const props = flowProps();
    render(<OnboardingFlow {...props} initialStep="models" />);
    fireEvent.click(screen.getByRole("button", { name: /^API keys/ }));
    expect(props.onOpenProviderSetup).toHaveBeenCalledWith("accounts", undefined, "");
    expect(screen.getByText(/Connect every one you have and use them all here/)).toBeTruthy();
    await act(async () => {});
  });

  it("autoplays every step, briefly shows human checkpoints, and loops without executing tasks", async () => {
    vi.useFakeTimers();
    const props = flowProps();
    const createTask = vi.spyOn(tasks, "createTaskForRepo");
    const createSession = vi.spyOn(sessions, "createSession");
    const openSession = vi.spyOn(sessions, "openSession");
    render(<OnboardingFlow {...props} initialStep="playbooks" />);
    await act(async () => {});
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "Playbook demo" });
    expect(progress.getAttribute("aria-valuemin")).toBe("1");
    expect(progress.getAttribute("aria-valuemax")).toBe("7");
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    expect(progress.getAttribute("aria-valuetext")).toBe("Clarify, step 1 of 7");
    expect(screen.getByRole("button", { name: "Pause demo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Simulate|Advance step|Approve|Reset/ })).toBeNull();
    await advanceDemo(2600);
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuetext")).toBe("Investigate, step 2 of 7");
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    await advanceDemo(4000);
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await advanceDemo(2600);
    expect(screen.getByText(/Real runs wait for your approval/)).toBeTruthy();
    await advanceDemo(3799);
    expect(screen.getByText("Step 3 of 7")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText("Step 4 of 7")).toBeTruthy();
    for (const wave of [5, 6]) {
      await advanceDemo(2600);
      expect(screen.getByText(`Step ${wave} of 7`)).toBeTruthy();
    }
    await advanceDemo(2600);
    expect(screen.getByText("Step 7 of 7")).toBeTruthy();
    await advanceDemo(3800);
    expect(screen.getByText("Demo complete")).toBeTruthy();
    expect(progress.getAttribute("aria-valuenow")).toBe("7");
    expect(progress.getAttribute("aria-valuetext")).toBe("Demo complete");
    await advanceDemo(2799);
    expect(screen.getByText("Demo complete")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    expect(props.onOpenCreateWithPlaybook).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
  });

  it("restarts when changing archetypes and keeps fan-out contracts inspectable", async () => {
    vi.useFakeTimers();
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(2600);
    fireEvent.click(screen.getByRole("radio", { name: /Academic Survey/i }));
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause demo" }));
    const graph = screen.getByRole("region", { name: "Dependency graph canvas" });
    fireEvent.click(within(graph).getByRole("button", { name: /Gather Candidate Sources — example 1/i }));
    expect(screen.getByText("each — spawns parallel sessions")).toBeTruthy();
    fireEvent.click(within(graph).getByRole("button", { name: /Deduplicate and Dispatch Sources/i }));
    expect(screen.getByText("complete — waits for all upstream outputs")).toBeTruthy();
    await advanceDemo(4000);
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
  });

  it("clears autoplay timers when leaving, changing repositories, or unmounting", async () => {
    vi.useFakeTimers();
    const props = flowProps();
    const view = render(<OnboardingFlow {...props} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(1000);
    view.rerender(<OnboardingFlow {...props} appConfig={{ ...baseConfig, active_repo: "/other/repo" }} initialStep="playbooks" />);
    await act(async () => {});
    await advanceDemo(2599);
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    await advanceDemo(1);
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Models/ }));
    await advanceDemo(4000);
    fireEvent.click(screen.getByRole("tab", { name: /Playbooks/ }));
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
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
    expect(screen.getByText("Step 1 of 7")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume demo" }));
    await advanceDemo(2600);
    expect(screen.getByText("Step 2 of 7")).toBeTruthy();
  });

  it("opens the mechanics guide by default and lets users collapse and reopen it", async () => {
    render(<OnboardingFlow {...flowProps()} initialStep="playbooks" />);
    await act(async () => {});
    const guide = screen.getByLabelText("Core playbook mechanics") as HTMLDetailsElement;
    expect(guide.open).toBe(true);
    fireEvent.click(within(guide).getByText("How work moves"));
    expect(guide.open).toBe(false);
    fireEvent.click(within(guide).getByText("How work moves"));
    expect(guide.open).toBe(true);
    expect(within(guide).getAllByRole("listitem")).toHaveLength(3);
    expect(within(guide).getByRole("heading", { name: "Auto-advance" })).toBeTruthy();
    expect(within(guide).getByRole("heading", { name: "Human checkpoint" })).toBeTruthy();
    expect(within(guide).getByRole("heading", { name: "Parallel agents" })).toBeTruthy();
  });

  it("offers building a new playbook separately through the existing creation form", async () => {
    const props = flowProps();
    render(<OnboardingFlow {...props} initialStep="playbooks" />);
    await act(async () => {});
    const examples = screen.getByRole("radiogroup", { name: "Explore starter playbooks" });
    expect(within(examples).queryByText("Build a New Playbook")).toBeNull();
    expect(within(examples).getAllByRole("radio")).toHaveLength(4);
    expect(screen.queryByText("Make it your own")).toBeNull();
    const footer = screen.getByRole("contentinfo");
    const builderButton = within(footer).getByRole("button", { name: "Build a new playbook" });
    expect(
      within(footer)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Back", "Build a new playbook", "Finish onboarding"]);
    fireEvent.click(builderButton);
    const builder = CURATED_PLAYBOOK_ARCHETYPES.find((item) => item.reference.key === "build-playbook");
    expect(props.onOpenCreateWithPlaybook).toHaveBeenCalledWith({ scope: "bundled", key: "build-playbook" }, builder?.starterPreset);
    expect(props.onCompleteToWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId("onboarding-step-playbooks")).toBeTruthy();
    expect(screen.queryByLabelText("Starter task title")).toBeNull();
  });
});

describe("Empty Grid Playbook Starter Gate", () => {
  beforeEach(() => {});

  it("selects a playbook without creating a task and uses that selection for both shared actions", async () => {
    fakeBoard.set({ tasks: [] });
    const onCreate = vi.fn();
    render(<Grid allRepos={false} repoPaths={["/Users/dev/project"]} onOpen={vi.fn()} registerNav={vi.fn()} onCreate={onCreate} />);

    const gate = await screen.findByTestId("grid-starter-gate");
    expect(within(gate).getAllByRole("radio")).toHaveLength(4);
    expect((within(gate).getByRole("radio", { name: /SuperDevelop/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(gate).getAllByRole("button", { name: /Use playbook/ })).toHaveLength(1);
    expect(within(gate).getAllByRole("button", { name: "Try starter preset" })).toHaveLength(1);

    for (const archetype of CURATED_PLAYBOOK_ARCHETYPES.slice(0, 4)) {
      onCreate.mockClear();
      const choice = within(gate).getByRole("radio", { name: new RegExp(archetype.title) });
      fireEvent.click(choice);
      expect((choice as HTMLInputElement).checked).toBe(true);
      expect(onCreate).not.toHaveBeenCalled();

      fireEvent.click(within(gate).getByRole("button", { name: /Use playbook/ }));
      expect(onCreate.mock.calls).toEqual([[archetype.reference]]);

      fireEvent.click(within(gate).getByRole("button", { name: "Try starter preset" }));
      expect(onCreate.mock.calls).toEqual([[archetype.reference], [archetype.reference, archetype.starterPreset]]);
    }

    expect(within(gate).queryByRole("button", { name: "New task" })).toBeNull();
    expect(within(gate).getByRole("link", { name: "Browse the Playbook Library" }).getAttribute("href")).toBe("https://alinery.ai/playbooks");
    expect(within(gate).queryByRole("button", { name: "How playbooks work" })).toBeNull();
  });

  it("keeps library and guide actions available independently of task creation", async () => {
    fakeBoard.set({ tasks: [] });
    const openUrl = vi.spyOn(ipc, "openUrl").mockResolvedValue();
    const onReplayOnboarding = vi.fn();
    render(<Grid allRepos={false} repoPaths={["/Users/dev/project"]} onOpen={vi.fn()} registerNav={vi.fn()} onReplayOnboarding={onReplayOnboarding} />);

    const gate = await screen.findByTestId("grid-starter-gate");
    for (const name of [/Use playbook/, "Try starter preset"]) {
      expect((within(gate).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    const libraryLink = within(gate).getByRole("link", { name: "Browse the Playbook Library" });
    expect(libraryLink.getAttribute("href")).toBe("https://alinery.ai/playbooks");
    fireEvent.click(libraryLink);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://alinery.ai/playbooks");
    fireEvent.click(within(gate).getByRole("button", { name: "How playbooks work" }));
    expect(onReplayOnboarding).toHaveBeenCalledOnce();
  });

  it("renders GridPlaybookStarterGate when repository has 0 tasks, and filter empty message when tasks are filtered out", async () => {
    fakeBoard.set({ tasks: [] });
    const onCreate = vi.fn();
    const onReplayOnboarding = vi.fn();

    const { unmount } = render(
      <Grid allRepos={false} repoPaths={["/Users/dev/project"]} onOpen={vi.fn()} registerNav={vi.fn()} onCreate={onCreate} onReplayOnboarding={onReplayOnboarding} />,
    );

    const gate = await screen.findByTestId("grid-starter-gate");
    expect(within(gate).getByRole("heading", { name: "Start your first task with a playbook" })).toBeTruthy();
    expect(screen.queryByText("No tasks match this grid configuration.")).toBeNull();

    fireEvent.click(within(gate).getByRole("button", { name: /Use playbook/ }));
    expect(onCreate).toHaveBeenCalledWith({ scope: "bundled", key: "superdevelop" });

    fireEvent.click(within(gate).getByRole("button", { name: "How playbooks work" }));
    expect(onReplayOnboarding).toHaveBeenCalled();

    unmount();
    fakeBoard.reset();

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
    fakeBoard.set({ tasks: [completedTask], activity: { "/Users/dev/project:existing-task": { status: "completed", active_session: null } } });

    render(<Grid allRepos={false} repoPaths={["/Users/dev/project"]} onOpen={vi.fn()} registerNav={vi.fn()} />);

    await screen.findByText("Existing task");
    fireEvent.click(screen.getByRole("button", { name: "Open grid settings" }));
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "active" } });
    expect(await screen.findByText("No tasks match this grid configuration.")).toBeTruthy();
    expect(screen.queryByTestId("grid-starter-gate")).toBeNull();
  });
});
