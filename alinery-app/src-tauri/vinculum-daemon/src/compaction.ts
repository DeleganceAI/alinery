// Pi compacts inside the harness. The Settings checkbox is the switch; the limit is a
// percent of the model window or a token ceiling, whichever the user picked.
import { readFileSync } from "node:fs";
import type { CompactionPolicy, CompactionSettings } from "@earendil-works/pi-durable";
import { parse } from "smol-toml";

export type CompactionBasis = "percent" | "tokens";

export type CompactionChoice = {
  enabled: boolean;
  basis: CompactionBasis;
  percent: number;
  tokens: number;
};

export type CompactionModel = { provider: string; id: string; contextWindow: number };

const PERCENT_MIN = 1;
const PERCENT_MAX = 100;
const TOKENS_MIN = 1;
const TOKENS_MAX = 10_000_000;
const PI_RESERVE = 16_384;
const PI_KEEP_RECENT = 20_000;
const PI_BACKGROUND = 32_768;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Missing keys keep the product defaults: on, at 80 percent, with a 128k token ceiling. */
export function compactionChoiceFromConfig(text: string): CompactionChoice {
  let appearance: Record<string, unknown> = {};
  try {
    const parsed = parse(text) as { appearance?: unknown };
    if (parsed.appearance && typeof parsed.appearance === "object" && !Array.isArray(parsed.appearance)) {
      appearance = parsed.appearance as Record<string, unknown>;
    }
  } catch {
    appearance = {};
  }
  return {
    enabled: appearance.chat_auto_compaction !== false,
    basis: appearance.chat_compaction_basis === "tokens" ? "tokens" : "percent",
    percent: clampInt(appearance.chat_compaction_percent, PERCENT_MIN, PERCENT_MAX, 80),
    tokens: clampInt(appearance.chat_compaction_tokens, TOKENS_MIN, TOKENS_MAX, 128_000),
  };
}

/** Usage level that starts compaction. A token ceiling above the window becomes the window. */
export function compactionThreshold(contextWindow: number, choice: CompactionChoice): number {
  const window = Math.floor(contextWindow);
  if (window <= 0) return 0;
  if (choice.basis === "tokens") return Math.min(choice.tokens, window);
  return Math.min(window, Math.max(1, Math.floor((window * choice.percent) / 100)));
}

/** `reserveTokens` is the room Pi keeps free, so the trigger is `contextWindow - reserve`. */
export function compactionPolicyFor(choice: CompactionChoice, contextWindow: number): CompactionPolicy {
  const window = Math.floor(contextWindow);
  if (!choice.enabled) return { enabled: false, reserveTokens: PI_RESERVE, keepRecentTokens: PI_KEEP_RECENT, backgroundTokens: 0 };
  if (window <= 0) return { enabled: true, reserveTokens: PI_RESERVE, keepRecentTokens: PI_KEEP_RECENT, backgroundTokens: PI_BACKGROUND };
  const threshold = compactionThreshold(window, choice);
  const reserveTokens = Math.max(0, window - threshold);
  return {
    enabled: true,
    reserveTokens,
    keepRecentTokens: Math.min(PI_KEEP_RECENT, Math.max(1, threshold - 1)),
    backgroundTokens: Math.min(PI_BACKGROUND, Math.max(0, Math.floor(threshold / 4))),
  };
}

export function harnessCompaction(choice: CompactionChoice, models: readonly CompactionModel[]): CompactionSettings {
  const modelOverrides: Record<string, Partial<CompactionPolicy>> = {};
  for (const model of models) {
    if (!model.provider || !model.id || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0) continue;
    modelOverrides[`${model.provider}/${model.id}`] = compactionPolicyFor(choice, model.contextWindow);
  }
  return { ...compactionPolicyFor(choice, 0), modelOverrides };
}

/** Read on each Pi request. A missing or broken config keeps Pi's own defaults. */
export function readCompactionSettings(
  appConfig: string,
  models: { getModels(): readonly CompactionModel[] },
): { compaction: CompactionSettings } | undefined {
  try {
    return { compaction: harnessCompaction(compactionChoiceFromConfig(readFileSync(appConfig, "utf8")), models.getModels()) };
  } catch {
    return undefined;
  }
}
