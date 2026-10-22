import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { resolveModel, thinkingForHosted } from "./provider.ts";
import { vinculumAuthContext } from "./runtime.ts";

test("an old alinery grok id is xAI and a real provider prefix is kept", () => {
  expect(resolveModel("/missing.toml", "alinery/grok-4.7")).toEqual({ provider: "xai", modelId: "grok-4.7" });
  expect(resolveModel("/missing.toml", "anthropic/claude-sonnet")).toEqual({ provider: "anthropic", modelId: "claude-sonnet" });
  expect(resolveModel("/missing.toml", "openrouter/anthropic/claude")).toEqual({ provider: "openrouter", modelId: "anthropic/claude" });
});

test("a blank model prefers the hosted catalog", () => {
  const dir = join(tmpdir(), `alinery-resolve-${crypto.randomUUID()}`);
  mkdirSync(join(dir, "instances", "one"), { recursive: true });
  writeFileSync(
    join(dir, "inference.json"),
    JSON.stringify({ token: "t", expires_at: 1, catalog: { base_url: "https://inference.example/v1", models: [{ id: "DeepSeek-V4.1-Flash", name: "DeepSeek", context_window: 1, max_tokens: 1 }] } }),
  );
  const appConfig = join(dir, "instances", "one", "config.toml");
  expect(resolveModel(appConfig, "")).toEqual({ provider: "alinery", modelId: "DeepSeek-V4.1-Flash" });
});

test("hosted thinking becomes the Pi map, and a model without it does not think", () => {
  const flash = {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  };
  expect(thinkingForHosted({ reasoning: true, levels: flash })).toEqual({ reasoning: true, thinkingLevelMap: flash });
  expect(thinkingForHosted({ reasoning: true, levels: { off: "  ", high: "high" } }).thinkingLevelMap).toMatchObject({ off: null, high: "high", low: null });
  expect(thinkingForHosted(undefined)).toEqual({ reasoning: false });
  expect(thinkingForHosted({ reasoning: false, levels: flash })).toEqual({ reasoning: false });
});

test("provider auth cannot see a shell key", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  const previousGrok = process.env.XAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "from-the-shell";
  process.env.XAI_API_KEY = "injected";
  try {
    const auth = vinculumAuthContext();
    expect(await auth.env("ANTHROPIC_API_KEY")).toBeUndefined();
    expect(await auth.env("XAI_API_KEY")).toBe("injected");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
    if (previousGrok === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousGrok;
  }
});
