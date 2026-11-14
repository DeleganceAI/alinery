import { expect, test } from "bun:test";
import { compactionChoiceFromConfig, compactionPolicyFor, compactionThreshold, harnessCompaction } from "./compaction.ts";

const on = { enabled: true, basis: "percent" as const, percent: 80, tokens: 128_000 };

test("a blank config compacts at 80 percent", () => {
  expect(compactionChoiceFromConfig("")).toEqual({ enabled: true, basis: "percent", percent: 80, tokens: 128_000 });
  expect(compactionChoiceFromConfig("[appearance]\nchat_auto_compaction = false\n")).toMatchObject({ enabled: false });
});

test("percent and token limits become the free room Pi keeps", () => {
  expect(compactionThreshold(100_000, on)).toBe(80_000);
  expect(compactionPolicyFor(on, 100_000).reserveTokens).toBe(20_000);
  expect(compactionThreshold(100_000, { ...on, basis: "tokens", tokens: 50_000 })).toBe(50_000);
  expect(compactionThreshold(100_000, { ...on, basis: "tokens", tokens: 900_000 })).toBe(100_000);
  expect(compactionPolicyFor({ ...on, basis: "tokens", tokens: 900_000 }, 100_000).reserveTokens).toBe(0);
});

test("turning it off disables the policy, including the model override", () => {
  const settings = harnessCompaction(
    { enabled: false, basis: "tokens", percent: 80, tokens: 10 },
    [{ provider: "alinery", id: "small", contextWindow: 32_000 }],
  );
  expect(settings.enabled).toBe(false);
  expect(settings.modelOverrides?.["alinery/small"]?.enabled).toBe(false);
});
