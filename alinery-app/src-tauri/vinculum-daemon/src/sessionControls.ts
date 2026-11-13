import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { defaultGlobal, effectiveSettings, emptyOverrides, parseGlobal, parseOverrides } from "./domain/settings.ts";
import type { ResolvedModel } from "./provider.ts";

/** The seven names `alinery-core` `THINKING_LEVELS` launches with. An unknown value is not one of them. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** What the model catalog says about thinking. A missing map key is the provider default, not a refusal. */
export type ThinkingCatalog = {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
};

export type SessionControls = {
  model: string;
  thinking: string;
  thinking_levels: string[];
  /** What the next request carries and the model's limit (0 when unknown); the daemon adds these from the conversation. */
  context_tokens?: number;
  context_window?: number;
};

export function thinkingLaunchLevel(raw: string | undefined): ThinkingLevel {
  const level = raw?.trim() ?? "";
  return (THINKING_LEVELS as readonly string[]).includes(level) ? (level as ThinkingLevel) : "high";
}

/** The effective defaults for a launch: the repo file over the global one, by the one precedence in `domain/settings.ts`.
 * A file serde would refuse reads as absent (the defaults), as it does in Rust. */
function launchDefaults(globalText: string | null, repoText: string | null) {
  const global = (globalText ? parseGlobal(globalText) : undefined) ?? defaultGlobal();
  const overrides = (repoText ? parseOverrides(repoText) : undefined) ?? emptyOverrides();
  return effectiveSettings(global, overrides).defaults;
}

/** Repo `defaults.thinking` wins when the key is present, including a blank. A blank or unknown name is `high`. */
export function launchThinkingFromFiles(globalText: string | null, repoText: string | null): ThinkingLevel {
  return thinkingLaunchLevel(launchDefaults(globalText, repoText)?.thinking);
}

/** Settings `defaults.model`, kept only for an empty harness or a launch harness. A leftover key drops it. */
export function launchModelFromChoice(harness: string, model: string): string {
  const key = harness.trim();
  if (key === "" || key === "omp" || key === "vinculum" || key === "no-harness") return model.trim();
  return "";
}

/** Repo keys win when present, including a blank. Same file split as `launchThinkingFromFiles`. */
export function launchModelFromFiles(globalText: string | null, repoText: string | null): string {
  const defaults = launchDefaults(globalText, repoText);
  return launchModelFromChoice(defaults?.harness ?? "", defaults?.model ?? "");
}

/** Every launch. A blank here is not the hosted fallback; that stays in `resolveModel`. */
export function readLaunchModel(repo: string, appConfig: string): string {
  const text = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return launchModelFromFiles(text(appConfig), text(join(repo, ".alinery", "config.toml")));
}

/** Once, at open. Later turns do not read this again. */
export function readLaunchThinking(repo: string, appConfig: string): ThinkingLevel {
  const text = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  return launchThinkingFromFiles(text(appConfig), text(join(repo, ".alinery", "config.toml")));
}

/** `reasoning: false` offers nothing. A map drops an explicit null, including `off`. A missing key stays. */
export function offeredThinkingLevels(model: ThinkingCatalog | undefined): ThinkingLevel[] {
  if (!model?.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (!map) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((name) => map[name] !== null);
}

/**
 * The level to store when a session has none yet. A model that cannot think keeps the settings
 * value for a later switch. A thinking model that does not offer that value stores the next
 * offered level above it, then the nearest one below, which is the same walk Pi uses when it sends.
 */
export function seedLevel(requested: ThinkingLevel, catalog: ThinkingCatalog | undefined): ThinkingLevel {
  const offered = offeredThinkingLevels(catalog);
  if (offered.length === 0 || offered.includes(requested)) return requested;
  const index = THINKING_LEVELS.indexOf(requested);
  for (let i = index + 1; i < THINKING_LEVELS.length; i++) {
    const name = THINKING_LEVELS[i];
    if (name && offered.includes(name)) return name;
  }
  for (let i = index - 1; i >= 0; i--) {
    const name = THINKING_LEVELS[i];
    if (name && offered.includes(name)) return name;
  }
  return requested;
}

/**
 * What the next turn will use. A model that cannot think reports `off` and no menu, and leaves the
 * stored level on the agent so switching back shows it again.
 */
export function turnControls(modelId: string, stored: string | undefined, catalog: ThinkingCatalog | undefined): SessionControls {
  if (!catalog?.reasoning) return { model: modelId, thinking: "off", thinking_levels: [] };
  const thinking = stored && (THINKING_LEVELS as readonly string[]).includes(stored) ? stored : "off";
  return { model: modelId, thinking, thinking_levels: offeredThinkingLevels(catalog) };
}

export function setModelRefusal(open: boolean, requested: string): string | null {
  if (!open) return "unknown-session";
  if (!requested.trim()) return "no model is configured";
  return null;
}

export function rejectThinkingLevel(level: string, catalog: ThinkingCatalog | undefined): string | null {
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) return "unknown thinking level";
  if (!catalog?.reasoning) return "this model does not think";
  if (!offeredThinkingLevels(catalog).includes(level as ThinkingLevel)) return "this model does not offer that thinking level";
  return null;
}

export async function ensureModel(conversation: Conversation, resolved: ResolvedModel, context: Context, force = false) {
  const agent = await conversation.agent(context);
  const current = agent.model;
  if (current?.provider === resolved.provider && current.modelId === resolved.modelId) return;
  // An old `alinery/grok-*` meta is xAI at read time. Reconfigure that session without rewriting the file.
  const remap = current?.provider === "alinery" && resolved.provider === "xai" && current.modelId === resolved.modelId;
  if (!force && current?.modelId && !remap) return;
  await conversation.configure({ model: resolved }, context);
}

export async function changeSessionModel(conversation: Conversation, resolved: ResolvedModel, context: Context, write: (patch: { model: string }) => void) {
  await ensureModel(conversation, resolved, context, true);
  write({ model: `${resolved.provider}/${resolved.modelId}` });
}

export async function changeThinkingLevel(conversation: Conversation, level: string, catalog: ThinkingCatalog | undefined, context: Context) {
  const error = rejectThinkingLevel(level, catalog);
  if (error) throw new Error(error);
  await conversation.configure({ thinkingLevel: level as ModelThinkingLevel }, context);
}

/** A new conversation, and a resumed one whose agent document has no level, takes the launch level. An explicit `off` is stored and stays. */
export async function seedUnsetThinking(stored: string | undefined, conversation: Conversation, level: ThinkingLevel, context: Context) {
  if (typeof stored === "string") return;
  await conversation.configure({ thinkingLevel: level }, context);
}
