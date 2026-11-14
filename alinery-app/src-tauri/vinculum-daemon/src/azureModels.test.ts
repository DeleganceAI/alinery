import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { openProviderRuntime } from "./runtime.ts";

test("azure lists DeepSeek V4 Flash and Grok 4.7 beside Pro", () => {
  const dir = join(tmpdir(), `alinery-azure-models-${crypto.randomUUID()}`, "config");
  mkdirSync(dir, { recursive: true });
  const models = openProviderRuntime(join(dir, "config.toml")).models;
  const pro = models.getModel("azure", "deepseek-v4-pro");
  const flash = models.getModel("azure", "deepseek-v4-flash");
  const grok = models.getModel("azure", "grok-4.7");
  const gpt = models.getModel("azure", "gpt-4o");

  expect(flash?.name).toBe("DeepSeek V4 Flash");
  expect(flash?.api).toBe("openai-completions");
  expect(flash?.provider).toBe("azure");
  expect(flash?.baseUrl).toBe("");
  expect(flash?.compat).toEqual(pro?.compat);

  expect(grok?.name).toBe("Grok 4.7");
  expect(grok?.api).toBe("openai-completions");
  expect(grok?.provider).toBe("azure");
  expect(grok?.baseUrl).toBe("");
  expect(grok?.input).toEqual(["text", "image"]);
  expect(grok?.thinkingLevelMap?.high).toBe("high");
  expect(grok?.thinkingLevelMap?.xhigh).toBe("xhigh");

  expect(gpt?.api).toBe("azure-openai-responses");
  expect(models.getProvider("azure")?.getModels().filter((model) => model.id === "deepseek-v4-flash")).toHaveLength(1);
});
