import type { PlaybookRef } from "./types";

export const ONBOARDING_COMPLETED_KEY = "alinery.onboardingCompleted.v1";
export const ONBOARDING_STEP_KEY = "alinery.onboardingStep.v1";

export type OnboardingStepId = "workspace" | "playbooks" | "models" | "launch";

export const ONBOARDING_STEPS: { id: OnboardingStepId; number: string; label: string; title: string }[] = [
  { id: "workspace", number: "01", label: "Repository", title: "Connect a repository" },
  { id: "playbooks", number: "02", label: "Playbooks", title: "How playbooks coordinate agents" },
  { id: "models", number: "03", label: "Models", title: "Verify your agent & model provider" },
  { id: "launch", number: "04", label: "First task", title: "Launch your first playbook task" },
];

export function isOnboardingCompleted(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingCompleted(): void {
  try {
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, "1");
    localStorage.removeItem(ONBOARDING_STEP_KEY);
  } catch {
    // Ignore storage quota / privacy mode failures.
  }
}

export function readSavedOnboardingStep(hasActiveRepo: boolean): OnboardingStepId {
  if (!hasActiveRepo) return "workspace";
  try {
    const raw = localStorage.getItem(ONBOARDING_STEP_KEY);
    if (raw && ONBOARDING_STEPS.some((step) => step.id === raw)) {
      return raw as OnboardingStepId;
    }
  } catch {
    // Fall through to default.
  }
  return "playbooks";
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
    patternSummary:
      "7-stage engineering pipeline. Agents clarify and investigate automatically, then pause at Decide so you approve the design artifact before any code is written.",
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
    patternSummary: "Separates root-cause proof from fix implementation. Proves the bug first, proposes resolution options, and waits for you to choose the fix.",
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
    patternSummary: "Evidence-backed code review on the latest commit or branch diff. Collects verification evidence first, then surfaces findings for human sign-off.",
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
    badge: "Parallel swarm (each → complete)",
    tagline: "Frame Review → Plan Wave → Gather Sources (×N) → Assess Each Source (×N) → Consolidate",
    patternSummary:
      "Demonstrates dynamic swarm generation: Plan Wave emits search-request-*.md files, spawning one parallel agent session per request (mode = 'each') and waiting for all of them to finish (mode = 'complete') before consolidating.",
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
