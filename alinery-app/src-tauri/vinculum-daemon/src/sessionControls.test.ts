import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AgentDoc, Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "bun:test";
import {
  changeSessionModel,
  changeThinkingLevel,
  ensureModel,
  launchThinkingFromFiles,
  offeredThinkingLevels,
  seedLevel,
  seedUnsetThinking,
  setModelRefusal,
  turnControls,
} from "./sessionControls.ts";

test("a blank or unknown thinking default is high, and a repo override wins", () => {
  expect(launchThinkingFromFiles(null, null)).toBe("high");
  expect(launchThinkingFromFiles("[global.defaults]\nthinking = \"turbo\"\n", null)).toBe("high");
  expect(launchThinkingFromFiles("[global.defaults]\nthinking = \"low\"\n", null)).toBe("low");
  expect(launchThinkingFromFiles("[global.defaults]\nthinking = \"low\"\n", "[defaults]\nthinking = \"medium\"\n")).toBe("medium");
  expect(launchThinkingFromFiles("[global.defaults]\nthinking = \"low\"\n", "[defaults]\nthinking = \"\"\n")).toBe("high");
});

test("a model that cannot think offers nothing and reports off", () => {
  expect(offeredThinkingLevels({ reasoning: false })).toEqual([]);
  expect(turnControls("alinery/DeepSeek", "high", { reasoning: false })).toEqual({
    model: "alinery/DeepSeek",
    thinking: "off",
    thinking_levels: [],
  });
});

test("a map drops an explicit null and keeps a missing key, and the stored level is still reported", () => {
  const catalog = { reasoning: true, thinkingLevelMap: { minimal: null, max: null } };
  expect(offeredThinkingLevels(catalog)).toEqual(["off", "low", "medium", "high", "xhigh"]);
  expect(turnControls("xai/grok", "max", catalog)).toEqual({
    model: "xai/grok",
    thinking: "max",
    thinking_levels: ["off", "low", "medium", "high", "xhigh"],
  });
  expect(offeredThinkingLevels({ reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const cannotStop = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } };
  expect(offeredThinkingLevels(cannotStop)).toEqual(["low", "high", "max"]);
  expect(seedLevel("high", cannotStop)).toBe("high");
  expect(seedLevel("high", { reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null } })).toBe("xhigh");
  expect(seedLevel("high", { reasoning: false })).toBe("high");
});

test("a missing session or a blank model is refused before anything is written", () => {
  expect(setModelRefusal(false, "xai/grok")).toBe("unknown-session");
  expect(setModelRefusal(true, "  ")).toBe("no model is configured");
  expect(setModelRefusal(true, "xai/grok")).toBeNull();
});

test("set_model sticks, a later prompt does not put the old model back, and thinking does not touch the meta", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vinculum-controls-"));
  const models = builtinModels();
  const catalog = models.getModels();
  const first = catalog.find((model) => model.reasoning);
  const second = catalog.find((model) => model.reasoning && (model.provider !== first?.provider || model.id !== first.id));
  if (!first || !second) throw new Error("builtin catalog has no two reasoning models");
  const storage = await openNodeSqliteStorage(join(dir, "session.pi.sqlite"));
  const harness = await Harness.open(storage, { models, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: dir }) }, BACKGROUND_CONTEXT);
  try {
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: first.provider, modelId: first.id } } });
    const meta: { model?: string } = {};
    const doc = await harness.documentState(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    const stored = doc?.value?.thinkingLevel;
    doc?.dispose();
    await seedUnsetThinking(stored, conversation, launchThinkingFromFiles(null, null), BACKGROUND_CONTEXT);
    expect((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
    await changeThinkingLevel(conversation, "low", { reasoning: true }, BACKGROUND_CONTEXT);
    await seedUnsetThinking("low", conversation, "high", BACKGROUND_CONTEXT);
    expect((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("low");

    await changeSessionModel(conversation, { provider: second.provider, modelId: second.id }, BACKGROUND_CONTEXT, (patch) => {
      meta.model = patch.model;
    });
    const switched = await conversation.agent(BACKGROUND_CONTEXT);
    expect(switched.model).toEqual({ provider: second.provider, modelId: second.id });
    expect(meta.model).toBe(`${second.provider}/${second.id}`);
    expect(switched.thinkingLevel).toBe("low");

    await ensureModel(conversation, { provider: first.provider, modelId: first.id }, BACKGROUND_CONTEXT);
    expect((await conversation.agent(BACKGROUND_CONTEXT)).model).toEqual({ provider: second.provider, modelId: second.id });

    const before = meta.model;
    await changeThinkingLevel(conversation, "medium", { reasoning: true }, BACKGROUND_CONTEXT);
    expect((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("medium");
    expect(meta.model).toBe(before);
    await expect(changeThinkingLevel(conversation, "turbo", { reasoning: true }, BACKGROUND_CONTEXT)).rejects.toThrow("unknown thinking level");
    expect((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("medium");
    await expect(changeThinkingLevel(conversation, "minimal", { reasoning: true, thinkingLevelMap: { minimal: null } }, BACKGROUND_CONTEXT)).rejects.toThrow("does not offer");
    expect((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("medium");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await rm(dir, { recursive: true, force: true });
  }
});
