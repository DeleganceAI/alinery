import { setHostOnboarded } from "./ipc";
import { machineOf } from "./remoteRepo";
import type { AppConfig, PlaybookRef } from "./types";

export const ONBOARDING_STEP_KEY = "alinery.onboardingStep.v1";

// The repository is chosen on the setup screen before onboarding opens, so the wizard starts at Models.
export type OnboardingStepId = "playbooks" | "models";

export const ONBOARDING_STEPS: { id: OnboardingStepId; number: string; label: string; title: string }[] = [
  { id: "models", number: "01", label: "Models", title: "Verify your agent & model provider" },
  { id: "playbooks", number: "02", label: "Playbooks", title: "How playbooks coordinate agents" },
];

/** Where the pre-S6.1 install kept its single "onboarded" flag. Read once, by `migrateLegacyOnboarding`. */
const LEGACY_COMPLETED_KEY = "alinery.onboardingCompleted.v1";

/** The onboarded mark lives in the app config, per host: the key `local` or a remote host id. */
const LOCAL_HOST = "local";
const hostOf = (repoKey: string) => machineOf(repoKey) || LOCAL_HOST;

/** Whether the host the repo lives on has run onboarding. An empty key is this computer. */
export function isHostOnboarded(cfg: AppConfig, repoKey: string): boolean {
  const host = hostOf(repoKey);
  return host === LOCAL_HOST ? cfg.local_onboarded === true : cfg.remote_hosts?.[host]?.onboarded === true;
}

/** `cfg` with the repo's host marked onboarded, so the page does not wait for a re-read. */
export function withHostOnboarded(cfg: AppConfig, repoKey: string): AppConfig {
  const host = hostOf(repoKey);
  if (host === LOCAL_HOST) return { ...cfg, local_onboarded: true };
  const entry = cfg.remote_hosts?.[host];
  return entry ? { ...cfg, remote_hosts: { ...cfg.remote_hosts, [host]: { ...entry, onboarded: true } } } : cfg;
}

/** Record in the app config that onboarding has run on the repo's host. */
export async function markHostOnboarded(repoKey: string): Promise<void> {
  clearSavedOnboardingStep();
  await setHostOnboarded(hostOf(repoKey), true);
}

/**
 * An install from before the per-host mark kept one flag in `localStorage`. Hand it to the
 * shell once as this computer's mark and delete it, so the key is read in this one place.
 * The key stays if the shell refuses, and the answer still holds for this launch.
 */
export async function migrateLegacyOnboarding(cfg: AppConfig): Promise<AppConfig> {
  let legacy = false;
  try {
    legacy = localStorage.getItem(LEGACY_COMPLETED_KEY) === "1";
  } catch {
    return cfg;
  }
  if (!legacy) return cfg;
  try {
    await setHostOnboarded(LOCAL_HOST, true);
    localStorage.removeItem(LEGACY_COMPLETED_KEY);
  } catch {
    // Retried at the next launch.
  }
  return { ...cfg, local_onboarded: true };
}

function clearSavedOnboardingStep(): void {
  try {
    localStorage.removeItem(ONBOARDING_STEP_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function readSavedOnboardingStep(): OnboardingStepId {
  try {
    const raw = localStorage.getItem(ONBOARDING_STEP_KEY);
    // The First task step is gone; a run saved there resumes at the step that now ends onboarding.
    if (raw === "launch") return "playbooks";
    if (raw && ONBOARDING_STEPS.some((step) => step.id === raw)) {
      return raw as OnboardingStepId;
    }
  } catch {
    // Fall through to default.
  }
  return "models";
}

export function writeSavedOnboardingStep(step: OnboardingStepId): void {
  try {
    localStorage.setItem(ONBOARDING_STEP_KEY, step);
  } catch {
    // Ignore storage errors.
  }
}

export type StarterTaskPreset = {
  name: string;
  description: string;
  evidence: string;
  ctaLabel: string;
};

export type CuratedPlaybookArchetype = {
  reference: PlaybookRef;
  badge: string;
  tagline: string;
  patternSummary: string;
  checkpointNote: string;
  title: string;
  starterPreset: StarterTaskPreset;
};

export const CURATED_PLAYBOOK_ARCHETYPES: CuratedPlaybookArchetype[] = [
  {
    reference: { scope: "bundled", key: "superdevelop" },
    badge: "Feature workflow",
    tagline: "Clarify → Investigate → Decide → Plan → Define Tests → Build → Prepare Review",
    patternSummary: "Build a change step by step, with your approval before coding.",
    checkpointNote: "Pauses at Decide (decide.md) before any code is written, and again at Prepare Review (review-package.md).",
    title: "SuperDevelop",
    starterPreset: {
      name: "Map architecture and improvement opportunities",
      description:
        "Investigate this repository's core modules, entrypoints, and test coverage, then propose one high-leverage architectural or UX improvement for review before touching any code.",
      evidence: "Starter onboarding task — stop at the Decide checkpoint so the human can inspect clarify.md and investigate.md.",
      ctaLabel: "Run SuperDevelop starter task",
    },
  },
  {
    reference: { scope: "bundled", key: "bug-hunting" },
    badge: "Root cause & fix",
    tagline: "Root Cause Analysis → Evaluate Resolutions → Design the Fix → Implement → PR",
    patternSummary: "Find the root cause, choose a fix, then implement and verify it.",
    checkpointNote: "Pauses at Evaluate Resolutions (selected-fix.md) and every step after it, including Design the Fix.",
    title: "Bug Hunting",
    starterPreset: {
      name: "Audit error handling and edge-case failure modes",
      description:
        "Scan recent error paths and boundary conditions in this repository, document reproducible failure modes in root-cause-analysis.md, and propose candidate resolutions without modifying source files until approved.",
      evidence: "Starter onboarding bug-hunt — pause at Evaluate Resolutions for human selection.",
      ctaLabel: "Run Bug Hunting starter task",
    },
  },
  {
    reference: { scope: "bundled", key: "review" },
    badge: "Code review",
    tagline: "Confirm Scope → Run Review Checks → Inspect the Change → Prepare Response",
    patternSummary: "Review a commit or branch with evidence and a final sign-off.",
    checkpointNote: "Pauses at Inspect the Change (review-findings.md) before drafting the review response.",
    title: "Code Review",
    starterPreset: {
      name: "Review latest commit and repository health",
      description: "Bind the latest commit on the current branch, run read-only verification checks, and produce an evidence-backed review report in review-findings.md.",
      evidence: "Starter onboarding review task — inspect HEAD commit.",
      ctaLabel: "Run Code Review on latest commit",
    },
  },
  {
    reference: { scope: "bundled", key: "academic-survey" },
    badge: "Parallel swarm",
    tagline: "Frame Review → Plan Wave → Gather Sources (×N) → Assess Each Source (×N) → Consolidate",
    patternSummary: "Research a topic in parallel, then bring sources and citations into one survey.",
    checkpointNote: "Spawns parallel worker waves automatically; the final step checks stopping criteria with you before another wave.",
    title: "Academic Survey",
    starterPreset: {
      name: "Survey codebase domain concepts and prior art",
      description: "Frame a technical survey of the core domain problems solved by this repository, fan out parallel source-gathering lanes, and consolidate a traceable summary.",
      evidence: "Starter onboarding swarm task.",
      ctaLabel: "Run Parallel Survey starter task",
    },
  },
  {
    reference: { scope: "bundled", key: "build-playbook" },
    badge: "Meta-playbook",
    tagline: "Define → Draft & Refine → Verify & Save",
    patternSummary:
      "A playbook that builds new playbooks. Collaborates with you to define steps, artifact contracts, and human gates, then validates and saves the new playbook to your repository or global library.",
    checkpointNote: "Every stage is human-steered so you can shape the prompts before saving.",
    title: "Build a New Playbook",
    starterPreset: {
      name: "Design a custom playbook for this repository",
      description: "Inspect this repository's workflow conventions and help me draft a reusable custom playbook tailored to our team's recurring tasks.",
      evidence: "Starter meta-playbook task.",
      ctaLabel: "Build a custom playbook",
    },
  },
];
