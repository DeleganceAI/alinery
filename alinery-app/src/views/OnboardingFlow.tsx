import "../onboarding.css";
import { ArrowRight, Check, Cpu, FolderPlus, Layers, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { ORB_SPEED } from "../Indicators";
import * as ipc from "../ipc";
import { BrandMark } from "../Logo";
import { CURATED_PLAYBOOK_ARCHETYPES, ONBOARDING_STEPS, type OnboardingStepId, readSavedOnboardingStep, type StarterTaskPreset, writeSavedOnboardingStep } from "../onboarding";
import { PlaybookGraph, type SimulatedStepStatus } from "../PlaybookGraph";
import { InlineStatus, ModelInput, repoName, samePlaybookRef } from "../shared";
import type { AppConfig, Config, NormalizedPlaybook, PlaybookRef } from "../types";

const INPUT_MODE_LABELS: Record<"single" | "each" | "complete", string> = {
  single: "single",
  each: "each — spawns parallel sessions",
  complete: "complete — waits for all upstream outputs",
};
const EMPTY_STEPS: NormalizedPlaybook["step"] = [];
const EXAMPLE_ARCHETYPES = CURATED_PLAYBOOK_ARCHETYPES.filter((item) => item.reference.key !== "build-playbook");
const BUILD_ARCHETYPE = CURATED_PLAYBOOK_ARCHETYPES.find((item) => item.reference.key === "build-playbook");

export function OnboardingFlow({
  appConfig,
  repoError,
  initialStep,
  onSelectRepo,
  onAddRepo,
  onRemoveRepo,
  onOpenProviderSetup,
  onCompleteToWorkspace,
  onOpenCreateWithPlaybook,
}: {
  appConfig: AppConfig;
  repoError: string;
  initialStep?: OnboardingStepId;
  onSelectRepo: (path: string) => Promise<boolean>;
  onAddRepo: () => Promise<boolean>;
  onRemoveRepo: (path: string) => void;
  onOpenProviderSetup: (tab: "models" | "accounts", onPick?: (model: string) => void) => void;
  onCompleteToWorkspace: () => void;
  onOpenCreateWithPlaybook: (playbook: PlaybookRef, preset?: StarterTaskPreset) => void;
}) {
  const hasActiveRepo = Boolean(appConfig.active_repo);
  const [step, setStep] = useState<OnboardingStepId>(() => initialStep ?? readSavedOnboardingStep(Boolean(appConfig.active_repo)));
  const [selectedArchetypeKey, setSelectedArchetypeKey] = useState<string>(CURATED_PLAYBOOK_ARCHETYPES[0].reference.key);
  const [liveDefinitions, setLiveDefinitions] = useState<Record<string, NormalizedPlaybook>>({});
  const [definitionErrors, setDefinitionErrors] = useState<Record<string, string>>({});
  const [definitionRefresh, setDefinitionRefresh] = useState(0);
  const [selectedStepKey, setSelectedStepKey] = useState<string | null>(null);
  const [simStepIndex, setSimStepIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Step 02: Agent & model readiness state
  const [agentStatus, setAgentStatus] = useState<"checking" | "ready" | "attention">("checking");
  const [agentDetail, setAgentDetail] = useState<string>("Checking OMP installation…");
  const [repoConfig, setRepoConfig] = useState<Config | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [modelError, setModelError] = useState("");
  const [probeTick, setProbeTick] = useState<number>(0);

  const selectedArchetype = useMemo(
    () => CURATED_PLAYBOOK_ARCHETYPES.find((item) => item.reference.key === selectedArchetypeKey) ?? CURATED_PLAYBOOK_ARCHETYPES[0],
    [selectedArchetypeKey],
  );
  useEffect(() => {
    if (initialStep) {
      setStep(initialStep);
    }
  }, [initialStep]);

  useEffect(() => {
    if (!hasActiveRepo && step === "models") {
      setStep("workspace");
    }
  }, [hasActiveRepo, step]);

  // The bundled catalog is readable before repository selection; previews use its actual definitions.
  useEffect(() => {
    let cancelled = false;
    setDefinitionErrors({});
    void Promise.all(
      CURATED_PLAYBOOK_ARCHETYPES.map(async ({ reference }) => {
        try {
          const scoped = await ipc.readPlaybook(reference, appConfig.active_repo || undefined);
          return { key: reference.key, definition: scoped.definition, error: "" };
        } catch (error) {
          return { key: reference.key, definition: null, error: String(error) };
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      const definitions: Record<string, NormalizedPlaybook> = {};
      const errors: Record<string, string> = {};
      for (const result of results) {
        if (result.definition) definitions[result.key] = result.definition;
        else errors[result.key] = result.error;
      }
      setLiveDefinitions(definitions);
      setDefinitionErrors(errors);
    });
    return () => {
      cancelled = true;
    };
  }, [appConfig.active_repo, definitionRefresh]);

  const activePlaybook = liveDefinitions[selectedArchetype.reference.key] ?? null;
  const playbookSteps = activePlaybook?.step ?? EMPTY_STEPS;

  // Ensure selectedStepKey always belongs to activePlaybook
  useEffect(() => {
    if (!playbookSteps.some((s) => s.key === selectedStepKey)) {
      setSelectedStepKey(playbookSteps[0]?.key ?? null);
    }
  }, [playbookSteps, selectedStepKey]);

  // Check installation without creating a reserved setup process with no attached client.
  useEffect(() => {
    if (step !== "models" || !appConfig.active_repo) return;
    let cancelled = false;
    setAgentStatus("checking");
    setAgentDetail("Checking OMP installation…");
    setModelError("");
    setRepoConfig(null);

    void ipc
      .readConfigForRepo(appConfig.active_repo)
      .then((cfg) => {
        if (cancelled) return;
        setRepoConfig(cfg);
        setDefaultModel(cfg.defaults?.model ?? "");
      })
      .catch((error) => {
        if (!cancelled) setModelError(String(error));
      });

    void ipc
      .checkOmpUpdate()
      .then((status) => {
        if (cancelled) return;
        setAgentStatus(status.installed ? "ready" : "attention");
        setAgentDetail(status.installed ? `Installed: ${status.installed}` : `OMP could not be started at ${status.binary_path || "the configured location"}.`);
      })
      .catch((error) => {
        if (cancelled) return;
        const msg = String(error);
        setAgentStatus("attention");
        setAgentDetail(msg || "Could not check the OMP installation.");
      });

    return () => {
      cancelled = true;
    };
  }, [step, appConfig.active_repo, probeTick]);

  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const goToStep = (next: OnboardingStepId) => {
    if (next === "models" && !hasActiveRepo) return;
    const from = ONBOARDING_STEPS.findIndex((item) => item.id === step);
    const to = ONBOARDING_STEPS.findIndex((item) => item.id === next);
    setDirection(to < from ? "back" : "forward");
    setStep(next);
    if (hasActiveRepo) writeSavedOnboardingStep(next);
  };

  const handleSelectRepo = async (path: string) => {
    writeSavedOnboardingStep("workspace");
    await onSelectRepo(path);
  };

  const handleAddRepo = async () => {
    writeSavedOnboardingStep("workspace");
    await onAddRepo();
  };

  const handleSelectArchetype = (key: string) => {
    setSelectedArchetypeKey(key);
    const nextDef = liveDefinitions[key];
    setSelectedStepKey(nextDef?.step[0]?.key ?? null);
    setSimStepIndex(0);
    setPlaying(!reducedMotion);
  };

  const simulatedStatuses = useMemo<Record<string, SimulatedStepStatus>>(() => {
    if (simStepIndex === null) return {};
    const statuses: Record<string, SimulatedStepStatus> = {};
    playbookSteps.forEach((s, index) => {
      if (index < simStepIndex) {
        statuses[s.key] = "completed";
      } else if (index === simStepIndex) {
        statuses[s.key] = s.auto_advance_default ? "running" : "waiting_for_approval";
      } else {
        statuses[s.key] = "idle";
      }
    });
    return statuses;
  }, [playbookSteps, simStepIndex]);

  const currentSimStep = simStepIndex !== null && simStepIndex < playbookSteps.length ? playbookSteps[simStepIndex] : null;
  // This preview only changes local state; real checkpoint approval remains explicit.
  useEffect(() => {
    setSimStepIndex(playbookSteps.length ? 0 : null);
    setSelectedStepKey(playbookSteps[0]?.key ?? null);
    setPlaying(step === "playbooks" && !reducedMotion);
  }, [step, appConfig.active_repo, selectedArchetypeKey, playbookSteps, reducedMotion]);

  useEffect(() => {
    if (step !== "playbooks" || !playing || simStepIndex === null || playbookSteps.length === 0) return;
    const complete = simStepIndex >= playbookSteps.length;
    const delay = complete || !currentSimStep?.auto_advance_default ? 2400 : 1400;
    const timer = window.setTimeout(() => {
      const next = complete ? 0 : simStepIndex + 1;
      setSimStepIndex(next);
      if (playbookSteps[next]) setSelectedStepKey(playbookSteps[next].key);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [step, appConfig.active_repo, selectedArchetypeKey, playing, simStepIndex, currentSimStep, playbookSteps]);

  const handleCommitDefaultModel = (nextModel: string) => {
    setModelError("");
    setDefaultModel(nextModel);
    if (!appConfig.active_repo || !repoConfig) return;
    const trimmed = nextModel.trim();
    const updated: Config = {
      ...repoConfig,
      defaults: {
        ...repoConfig.defaults,
        model: trimmed,
      },
    };
    setRepoConfig(updated);
    void ipc
      .readScopedSettingsForRepo(appConfig.active_repo)
      .then(({ overrides }) =>
        ipc.writeRepoOverridesForRepo(appConfig.active_repo, {
          ...overrides,
          defaults: { ...overrides.defaults, model: trimmed || null },
        }),
      )
      .catch((error) => setModelError(String(error)));
  };

  const stepIndex = ONBOARDING_STEPS.findIndex((item) => item.id === step);
  const currentStepMeta = ONBOARDING_STEPS[stepIndex] ?? ONBOARDING_STEPS[0];
  const selectedStepIndex = Math.max(
    0,
    playbookSteps.findIndex((s) => s.key === selectedStepKey),
  );
  const selectedStep = playbookSteps[selectedStepIndex] ?? playbookSteps[0];

  const simStatusCopy = (() => {
    if (simStepIndex === null) {
      return "Select a node to inspect its artifact contract. This demo does not run agents or create tasks.";
    }
    if (simStepIndex >= playbookSteps.length) {
      return "Demo complete · All example steps finished";
    }
    if (!currentSimStep) return "";
    if (currentSimStep.inputs.some((input) => input.mode === "each")) {
      return "Fan-out wave · 1 session per matching artifact (mode: each)";
    }
    if (!currentSimStep.auto_advance_default) {
      return "Human checkpoint · Real runs wait for your approval; this demo continues automatically";
    }
    return "Auto-advances on non-empty output artifact";
  })();

  return (
    <div className="view scroll onboarding-view" data-testid="onboarding-flow">
      <div className="onboarding-shell">
        <header className="onboarding-header">
          <div className="onboarding-brand">
            <BrandMark />
            <span className="onboarding-brand-name">Alinery</span>
            <span className="onboarding-brand-sep" aria-hidden="true">
              /
            </span>
            <span className="onboarding-step-counter">
              Step {currentStepMeta.number} of 0{ONBOARDING_STEPS.length}
            </span>
          </div>

          <div className="onboarding-steps" role="tablist" aria-label="Onboarding steps">
            {ONBOARDING_STEPS.map((item, idx) => {
              const active = item.id === step;
              const completed = hasActiveRepo && (idx < stepIndex || item.id === "workspace");
              const disabled = item.id === "models" && !hasActiveRepo;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-autofocus={active ? "" : undefined}
                  disabled={disabled}
                  className={`onboarding-step-pill${active ? " active" : ""}${completed ? " completed" : ""}`}
                  onClick={() => goToStep(item.id)}
                >
                  <span className="onboarding-step-num">{item.number}</span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>

          <div className="onboarding-header-actions">
            {hasActiveRepo ? (
              <button type="button" className="btn ghost small" onClick={onCompleteToWorkspace}>
                Skip Onboarding
              </button>
            ) : (
              <span className="onboarding-header-caption">Pick a repository to continue</span>
            )}
          </div>
        </header>

        {step === "workspace" && (
          <div className="onboarding-body onboarding-body-focus" data-dir={direction} data-testid="onboarding-step-workspace">
            <div className="onboarding-focus">
              <h2>{hasActiveRepo ? "Repository connected" : "Select a repository"}</h2>
              <p className="onboarding-lede">
                {hasActiveRepo
                  ? "Add another repository now or continue to connect your model provider."
                  : "Alinery keeps tasks, artifacts, and playbook state in .alinery/ inside the repository you choose."}
              </p>

              {appConfig.known_repos.length > 0 && (
                <ul className="onboarding-repo-list" aria-label="Your repositories">
                  {appConfig.known_repos.map((repo) => {
                    const isCurrent = repo === appConfig.active_repo;
                    return (
                      <li key={repo} className="onboarding-repo-row">
                        <button type="button" className={`onboarding-repo${isCurrent ? " active" : ""}`} title={repo} onClick={() => void handleSelectRepo(repo)}>
                          <strong>{repoName(repo)}</strong>
                          {isCurrent && <span className="onboarding-repo-connected">Connected</span>}
                          <span className="onboarding-repo-path">{repo}</span>
                          {!isCurrent && <ArrowRight size={16} strokeWidth={1.6} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className="onboarding-repo-remove"
                          title={`Remove ${repoName(repo)} from Alinery (repo files are untouched)`}
                          aria-label={`Remove ${repoName(repo)}`}
                          onClick={() => onRemoveRepo(repo)}
                        >
                          <X size={16} strokeWidth={1.5} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {repoError && (
                <InlineStatus tone="error" detail={repoError}>
                  Couldn't open the repository. Choose another folder or initialize Git when prompted.
                </InlineStatus>
              )}

              <div className="onboarding-focus-actions">
                {hasActiveRepo ? (
                  <>
                    <button type="button" className="btn ghost onboarding-add-repo" onClick={() => void handleAddRepo()}>
                      <FolderPlus size={16} strokeWidth={1.6} aria-hidden="true" />
                      Add another repository
                    </button>
                    <button type="button" className="btn onboarding-add-repo" data-autofocus onClick={() => goToStep("models")}>
                      Continue
                      <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn onboarding-add-repo" data-autofocus onClick={() => void handleAddRepo()}>
                    <FolderPlus size={16} strokeWidth={1.6} aria-hidden="true" />
                    Add a repository
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === "playbooks" && (
          <div className="onboarding-body onboarding-body-playbooks" data-dir={direction} data-testid="onboarding-step-playbooks">
            <div className="onboarding-playbook-rail">
              <h2>How playbooks work</h2>
              <p className="onboarding-lede">A playbook is a fixed sequence of steps. Each step reads and writes named markdown files, and some steps wait for you.</p>

              <div
                className="onboarding-archetype-list"
                role="radiogroup"
                aria-label="Explore starter playbooks"
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                  event.preventDefault();
                  const currentIdx = EXAMPLE_ARCHETYPES.findIndex((item) => item.reference.key === selectedArchetypeKey);
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  const nextIdx = currentIdx < 0 ? (delta === 1 ? 0 : EXAMPLE_ARCHETYPES.length - 1) : (currentIdx + delta + EXAMPLE_ARCHETYPES.length) % EXAMPLE_ARCHETYPES.length;
                  handleSelectArchetype(EXAMPLE_ARCHETYPES[nextIdx].reference.key);
                }}
              >
                {EXAMPLE_ARCHETYPES.map((archetype) => {
                  const selected = samePlaybookRef(archetype.reference, selectedArchetype.reference);
                  const def = liveDefinitions[archetype.reference.key];
                  return (
                    <button
                      key={archetype.reference.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`onboarding-archetype-card${selected ? " selected" : ""}`}
                      onClick={() => handleSelectArchetype(archetype.reference.key)}
                    >
                      <div className="onboarding-archetype-top">
                        <strong>{def?.title ?? archetype.title}</strong>
                        {def && <span className="onboarding-step-count">{def.step.length} steps</span>}
                      </div>
                      {def && (
                        <span className="onboarding-mini-chain" aria-label={def.step.map((item, i) => `${i + 1}. ${item.title}`).join(", ")}>
                          {def.step.map((item, stepNumber) => (
                            <span className="onboarding-mini-step" key={item.key} title={`${stepNumber + 1}. ${item.title}${item.auto_advance_default ? "" : " — waits for you"}`}>
                              <span className="onboarding-mini-number" data-checkpoint={!item.auto_advance_default || undefined}>
                                {stepNumber + 1}
                              </span>
                            </span>
                          ))}
                        </span>
                      )}
                      <span className="onboarding-card-detail">
                        <span>{archetype.checkpointNote}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="onboarding-build-playbook">
                <h3>Make it your own</h3>
                <p>Design steps, artifacts, and checkpoints for your team's workflow.</p>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    if (BUILD_ARCHETYPE) onOpenCreateWithPlaybook(BUILD_ARCHETYPE.reference, BUILD_ARCHETYPE.starterPreset);
                  }}
                  disabled={!hasActiveRepo || !BUILD_ARCHETYPE}
                >
                  Build a new playbook
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>

              <div className="onboarding-mechanics-strip" aria-label="Core playbook mechanics">
                <div className="onboarding-mechanic-item">
                  <span className="pill onboarding-pill-accent">Auto-advance</span>
                  <span>Agent moves to the next step automatically once its output artifact is validated.</span>
                </div>
                <div className="onboarding-mechanic-item">
                  <span className="pill onboarding-pill-warning">Human checkpoint</span>
                  <span>Execution pauses so you can read or comment on the markdown artifact before continuing.</span>
                </div>
                <div className="onboarding-mechanic-item">
                  <span className="pill">Swarm fan-out (each)</span>
                  <span>
                    One step emits wildcard files (<code>request-*.md</code>), spawning a parallel agent per file and joining on <code>complete</code>.
                  </span>
                </div>
              </div>
            </div>

            {activePlaybook ? (
              <div className="onboarding-playbook-stage">
                <div className="onboarding-sim-bar">
                  <div className="onboarding-sim-status">
                    <span
                      className={`pill${
                        currentSimStep && !currentSimStep.auto_advance_default
                          ? " onboarding-pill-warning"
                          : simStepIndex !== null && simStepIndex >= playbookSteps.length
                            ? " onboarding-pill-success"
                            : " onboarding-pill-accent"
                      }`}
                    >
                      {simStepIndex === null
                        ? "Interactive graph"
                        : simStepIndex >= playbookSteps.length
                          ? "Finished"
                          : currentSimStep && !currentSimStep.auto_advance_default
                            ? "Checkpoint gate"
                            : `Wave ${simStepIndex + 1} of ${playbookSteps.length}`}
                    </span>
                    <span className="onboarding-sim-copy">{simStatusCopy}</span>
                  </div>
                  <div className="onboarding-sim-actions">
                    <button type="button" className="btn ghost small" onClick={() => setPlaying((value) => !value)}>
                      {playing ? "Pause demo" : "Resume demo"}
                    </button>
                  </div>
                </div>

                <div className="onboarding-graph-frame">
                  <PlaybookGraph
                    key={activePlaybook.key}
                    title={activePlaybook.title}
                    steps={playbookSteps}
                    variant="definition"
                    showInspector={false}
                    hideToolbar={true}
                    minScale={0.72}
                    selectedStepKey={selectedStep?.key ?? null}
                    onSelectStep={(key) => {
                      setPlaying(false);
                      setSelectedStepKey(key);
                    }}
                    simulatedStatuses={simulatedStatuses}
                  />
                </div>

                {selectedStep && (
                  <section className="onboarding-step-inspector" aria-label={`${selectedStep.title} step contract`}>
                    <div className="onboarding-step-inspector-header">
                      <div className="onboarding-step-inspector-title">
                        <span className="onboarding-step-ordinal">Step 0{selectedStepIndex + 1}</span>
                        <h3>{selectedStep.title}</h3>
                        <code>{selectedStep.key}</code>
                      </div>
                      <div className="onboarding-step-badges">
                        <span className={`pill ${selectedStep.auto_advance_default ? "onboarding-pill-accent" : "onboarding-pill-warning"}`}>
                          {selectedStep.auto_advance_default ? "Auto-advances" : "Human checkpoint"}
                        </span>
                        <span className="pill">{selectedStep.is_coding_step ? "Coding step" : "Read-only / artifact step"}</span>
                      </div>
                    </div>

                    <div className="onboarding-contract-grid">
                      <div className="onboarding-contract-col">
                        <h4>Reads (inputs)</h4>
                        {selectedStep.inputs.length > 0 ? (
                          <ul className="onboarding-contract-list">
                            {selectedStep.inputs.map((input) => (
                              <li key={`${input.path}:${input.mode}`}>
                                <code>{input.path}</code>
                                <span className="pill">{INPUT_MODE_LABELS[input.mode]}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="onboarding-contract-empty">Reads initial task ticket (ticket.md)</p>
                        )}
                      </div>
                      <div className="onboarding-contract-col">
                        <h4>Writes (outputs)</h4>
                        {selectedStep.outputs.length > 0 ? (
                          <ul className="onboarding-contract-list">
                            {selectedStep.outputs.map((output) => (
                              <li key={output.path}>
                                <code>{output.path}</code>
                                <span className="onboarding-artifact-path">.alinery/tasks/&lt;slug&gt;/artifacts/</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="onboarding-contract-empty">No declared output artifacts</p>
                        )}
                      </div>
                    </div>

                    <details className="onboarding-prompt-preview">
                      <summary>View step prompt instructions</summary>
                      <pre>{selectedStep.prompt}</pre>
                    </details>
                  </section>
                )}
              </div>
            ) : (
              <div className="onboarding-playbook-stage">
                {definitionErrors[selectedArchetype.reference.key] ? (
                  <>
                    <InlineStatus tone="error" detail={definitionErrors[selectedArchetype.reference.key]}>
                      Couldn't load the playbook preview.
                    </InlineStatus>
                    <button type="button" className="btn small" onClick={() => setDefinitionRefresh((value) => value + 1)}>
                      Retry preview
                    </button>
                  </>
                ) : (
                  <p role="status">Loading playbook preview…</p>
                )}
              </div>
            )}
          </div>
        )}

        {step === "models" && (
          <div className="onboarding-body onboarding-body-models" data-dir={direction} data-testid="onboarding-step-models">
            <div className="onboarding-model-setup">
              <h2>Choose your default model</h2>
              <p className="onboarding-lede">Connect a provider, then pick the model your agents will use in {repoName(appConfig.active_repo)}. You can change it later.</p>

              <div className="onboarding-readiness-stack">
                <div className="onboarding-readiness-card">
                  <div className="onboarding-readiness-title">
                    <Layers size={16} aria-hidden="true" />
                    <strong>Subscriptions and API keys</strong>
                  </div>
                  <p className="onboarding-readiness-detail">
                    Connect a supported provider subscription, or use Alinery plans and credits. Accounts shows available sign-in options and instructions for API key setup.
                  </p>
                  <div className="onboarding-readiness-actions">
                    <button type="button" className="btn small" onClick={() => onOpenProviderSetup("accounts")}>
                      Set up accounts and API keys
                    </button>
                  </div>
                </div>
                <div className="onboarding-readiness-card">
                  <div className="onboarding-readiness-row">
                    <div className="onboarding-readiness-title">
                      <Layers size={16} aria-hidden="true" />
                      <strong>Default model</strong>
                    </div>
                  </div>
                  <div className="onboarding-model-control">
                    <ModelInput
                      harness="omp"
                      repoPath={appConfig.active_repo}
                      value={defaultModel}
                      onChange={setDefaultModel}
                      onCommit={handleCommitDefaultModel}
                      onOpenPicker={() =>
                        onOpenProviderSetup("models", (model) => {
                          setDefaultModel(model);
                          handleCommitDefaultModel(model);
                        })
                      }
                      ariaLabel="Default repository model"
                    />
                  </div>
                  {modelError && (
                    <div>
                      <InlineStatus tone="error" detail={modelError}>
                        Couldn't load or save the repository model.
                      </InlineStatus>
                      <button type="button" className="btn ghost small" onClick={() => setProbeTick((value) => value + 1)}>
                        Retry model settings
                      </button>
                    </div>
                  )}
                  <div className="onboarding-readiness-foot">
                    <p className="onboarding-readiness-detail">Used by every playbook step in {repoName(appConfig.active_repo)} unless a step overrides it.</p>
                  </div>
                </div>
                <div className="onboarding-readiness-card">
                  <div className="onboarding-readiness-row">
                    <div className="onboarding-readiness-title">
                      <Cpu size={16} aria-hidden="true" />
                      <strong>Agent installation</strong>
                    </div>
                    {agentStatus === "checking" && (
                      <span className="pill">
                        <ThinkingOrb state="searching" size={20} speed={ORB_SPEED} />
                        Checking…
                      </span>
                    )}
                    {agentStatus === "ready" && (
                      <span className="pill onboarding-pill-success">
                        <Check size={12} aria-hidden="true" />
                        Ready
                      </span>
                    )}
                    {agentStatus === "attention" && <span className="pill onboarding-pill-warning">Needs attention</span>}
                  </div>
                  <p className="onboarding-readiness-detail">
                    {agentStatus === "attention" ? "OMP isn't available. Review the details below, resolve the issue, then retry." : agentDetail}
                  </p>
                  {agentStatus === "attention" && (
                    <details className="onboarding-prompt-preview">
                      <summary>Technical details</summary>
                      <pre>{agentDetail}</pre>
                    </details>
                  )}
                  {agentStatus === "attention" && (
                    <div className="onboarding-readiness-actions">
                      <button type="button" className="btn ghost small" onClick={() => setProbeTick((n) => n + 1)}>
                        Retry check
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <details className="onboarding-model-help">
              <summary>Can different steps use different models?</summary>
              <p>Yes. A step’s model takes priority, followed by the playbook’s default, then this repository’s default. Leave the selection empty to use the harness default.</p>
            </details>
          </div>
        )}

        {step !== "workspace" && (
          <footer className="onboarding-footer">
            <div className="onboarding-footer-left">
              <button type="button" className="btn ghost" onClick={() => goToStep(hasActiveRepo ? ONBOARDING_STEPS[stepIndex - 1].id : "workspace")}>
                Back
              </button>
            </div>
            <div className="onboarding-footer-right">
              <button
                type="button"
                className="btn"
                disabled={!hasActiveRepo}
                onClick={() => {
                  const next = ONBOARDING_STEPS[stepIndex + 1];
                  if (next) goToStep(next.id);
                  else onCompleteToWorkspace();
                }}
              >
                {step === "playbooks" ? "Finish onboarding" : "Continue"}
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
