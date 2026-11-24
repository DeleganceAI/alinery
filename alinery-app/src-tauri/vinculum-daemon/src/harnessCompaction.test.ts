import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "bun:test";
import { compactionPolicyFor, harnessCompaction, type CompactionChoice } from "./compaction.ts";
import { seedPrompt, userMessageCount } from "./conversationCounts.ts";
import { committedTurnMessages } from "./runtime/failedTurn.ts";
import { compactionFocus, toItem } from "./rpc/sessions.ts";
import { COMPACTION_ENTRY, formatTranscript, hasSpoken, spokenUserCount } from "./transcript.ts";

// selectCut is not on the package's public export map; the harness calls this same file.
const { selectCut } = createRequire(import.meta.url)(
  new URL("../node_modules/@earendil-works/pi-durable/dist/harness/compaction.js", import.meta.url).pathname,
) as { selectCut(view: unknown, keepRecentTokens: number): number | undefined };

const WINDOW = 200_000;
const SUMMARY = "folded summary for the pane";
const PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

function choice(partial: Partial<CompactionChoice> & Pick<CompactionChoice, "basis">): CompactionChoice {
  return { enabled: true, percent: 80, tokens: 128_000, ...partial };
}

/** ~N estimated tokens: chars / 3.5, the estimator the harness cuts with. Faux usage is chars / 4, so it is not this number. */
function longUser(label: string, tokens = 25_000): string {
  return `${label}\n${"word ".repeat(Math.ceil((tokens * 3.5) / 5))}`;
}

type Opened = {
  harness: Awaited<ReturnType<typeof Harness.open>>;
  conversation: Awaited<ReturnType<Awaited<ReturnType<typeof Harness.open>>["root"]>>;
  summarizerTexts: string[];
  releaseSummarizer: () => void;
  holdSummarizer: () => void;
  dir: string;
};

async function openRig(policyChoice: CompactionChoice | undefined, turn: () => AssistantMessage = () => fauxAssistantMessage("turn ok"), window = WINDOW): Promise<Opened> {
  const dir = await mkdtemp(join(tmpdir(), "vinculum-compact-"));
  const faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: window, maxTokens: 16_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const summarizerTexts: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  const release = { current: () => {} };
  const holdSummarizer = () => {
    gate = new Promise<void>((resolve) => {
      release.current = resolve;
    });
  };
  const factory: FauxResponseFactory = async (context) => {
    const system = context.messages.find((message) => message.role === "system");
    const text = String(JSON.stringify(system?.content) ?? "");
    if (text.includes("context summarization assistant")) {
      summarizerTexts.push(JSON.stringify(context.messages));
      await gate;
      return fauxAssistantMessage(SUMMARY);
    }
    return turn();
  };
  faux.setResponses(Array.from({ length: 8 }, () => factory));
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "session.pi.sqlite")), {
    models,
    registry: createRegistry(),
    env: () => new NodeExecutionEnv({ cwd: dir }),
    settings: () => ({
      ...(policyChoice ? { compaction: harnessCompaction(policyChoice, [{ provider: "faux", id: "faux-1", contextWindow: window }]) } : {}),
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    }),
  }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  return { harness, conversation, summarizerTexts, releaseSummarizer: () => release.current(), holdSummarizer, dir };
}

async function closeRig(rig: Opened | undefined) {
  if (!rig) return;
  rig.releaseSummarizer();
  await rig.harness.close(ctx).catch(() => undefined);
  await rm(rig.dir, { recursive: true, force: true });
}

async function entriesOf(conversation: Opened["conversation"]) {
  return (await conversation.entries({ order: "ascending" }, 200, undefined, ctx)).items;
}

async function pollHead(conversation: Opened["conversation"], timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = (await entriesOf(conversation)).find((entry) => entry.kind === COMPACTION_ENTRY && entry.head);
    if (hit) return hit;
    await Bun.sleep(20);
  }
  const kinds = (await entriesOf(conversation)).map((entry) => `${entry.kind}${entry.head ? ":head" : ""}`);
  throw new Error(`compaction head did not appear; entries: ${kinds.join(", ")}`);
}

function itemText(item: ReturnType<typeof toItem>): string {
  return (item.content ?? []).map((part) => (part.kind?.case === "text" ? part.kind.value : "")).join("");
}

async function paneItems(conversation: Opened["conversation"]) {
  return formatTranscript(await committedTurnMessages(conversation)).map(toItem);
}

function expectOneCompaction(items: ReturnType<typeof toItem>[], reason: string) {
  const compactions = items.filter((item) => item.role === "compaction");
  expect(compactions).toHaveLength(1);
  expect(compactions[0]).toMatchObject({ role: "compaction", compactionReason: reason });
  expect(itemText(compactions[0]!)).toBe(SUMMARY);
  expect(items.filter((item) => item.role === "user").some((item) => itemText(item).includes(SUMMARY) || itemText(item).includes(PREFIX))).toBe(false);
}

async function submit(conversation: Opened["conversation"], text: string) {
  const sent = await conversation.submit({ type: "input", content: text }, ctx);
  await sent.wait(ctx);
  await conversation.waitForIdle(ctx);
}

test("threshold, background, overflow and manual compactions each land as one unwrapped compaction item", async () => {
  let rig: Opened | undefined;
  try {
    const policy = compactionPolicyFor(choice({ basis: "percent", percent: 20 }), WINDOW);
    expect(policy.keepRecentTokens).toBe(20_000);
    // The cut is read on an uncut transcript. Once compaction runs, the head moves and selectCut no longer returns 2.
    rig = await openRig(undefined);
    await submit(rig.conversation, longUser("first question"));
    await submit(rig.conversation, longUser("second question"));
    expect(selectCut(await rig.conversation.context(ctx), policy.keepRecentTokens)).toBe(2);
    await closeRig(rig);

    rig = await openRig(choice({ basis: "percent", percent: 20 }));
    await submit(rig.conversation, longUser("first question"));
    await submit(rig.conversation, longUser("second question"));
    expect((await pollHead(rig.conversation)).data).toMatchObject({ reason: "threshold" });
    expectOneCompaction(await paneItems(rig.conversation), "threshold");
  } finally {
    await closeRig(rig);
  }

  rig = undefined;
  try {
    // percent 20's daemon band is 30k–40k. backgroundTokens is min(32768, threshold/4) = 10k, not the raw 32768.
    const backgroundChoice = choice({ basis: "percent", percent: 20 });
    const policy = compactionPolicyFor(backgroundChoice, WINDOW);
    expect(WINDOW - policy.reserveTokens).toBe(40_000);
    expect(policy.backgroundTokens).toBe(10_000);
    rig = await openRig(backgroundChoice);
    await submit(rig.conversation, longUser("background a", 2_000));
    await submit(rig.conversation, longUser("background b", 8_000));
    await submit(rig.conversation, longUser("background c", 12_000));
    rig.holdSummarizer();
    await rig.conversation.submit({ type: "input", content: longUser("background tail", 6_000) }, ctx);
    await rig.conversation.waitForIdle(ctx);
    expect((await entriesOf(rig.conversation)).some((entry) => entry.kind === COMPACTION_ENTRY && entry.head)).toBe(false);
    const live = await rig.harness.documentState(LiveDoc, rig.conversation.id, ctx);
    expect(live?.value?.run).toBeUndefined();
    expect(live?.value?.compactions?.map((item) => ({ reason: item.reason, blocking: item.blocking }))).toEqual([{ reason: "threshold", blocking: false }]);
    live?.dispose();
    rig.releaseSummarizer();
    expect((await pollHead(rig.conversation)).data).toMatchObject({ reason: "threshold" });
    expectOneCompaction(await paneItems(rig.conversation), "threshold");
  } finally {
    await closeRig(rig);
  }

  rig = undefined;
  try {
    const overflowChoice = choice({ basis: "tokens", tokens: WINDOW });
    expect(compactionPolicyFor(overflowChoice, WINDOW).reserveTokens).toBe(0);
    let turns = 0;
    const overflow = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 250000 tokens > 200000 maximum" });
    rig = await openRig(overflowChoice, () => {
      turns += 1;
      return turns === 2 ? overflow : fauxAssistantMessage("turn ok");
    });
    await submit(rig.conversation, longUser("overflow first"));
    await submit(rig.conversation, longUser("overflow second"));
    expect((await pollHead(rig.conversation)).data).toMatchObject({ reason: "overflow" });
    expectOneCompaction(await paneItems(rig.conversation), "overflow");
  } finally {
    await closeRig(rig);
  }

  rig = undefined;
  try {
    // percent 80 stays under the auto-compaction line for these two messages; manual compact still cuts on keepRecentTokens.
    rig = await openRig(choice({ basis: "percent", percent: 80 }));
    await submit(rig.conversation, longUser("first question"));
    await submit(rig.conversation, longUser("second question"));
    rig.holdSummarizer();
    await rig.conversation.compact(compactionFocus("  keep the names  "), ctx);
    expect((await entriesOf(rig.conversation)).some((entry) => entry.kind === COMPACTION_ENTRY)).toBe(false);
    rig.releaseSummarizer();
    expect((await pollHead(rig.conversation)).data).toMatchObject({ reason: "manual" });
    expect(rig.summarizerTexts.some((text) => text.includes("Additional focus:   keep the names  "))).toBe(true);
    expectOneCompaction(await paneItems(rig.conversation), "manual");

    const page = await entriesOf(rig.conversation);
    const spoken = spokenUserCount(page);
    const naive = page.reduce((count, entry) => count + (entry.model ?? []).filter((message) => message.role === "user").length, 0);
    expect(await userMessageCount(rig.conversation)).toBe(spoken);
    expect(spoken).toBeLessThan(naive);
    const before = page.length;
    await seedPrompt(rig.conversation, "do not seed over a compaction");
    expect((await entriesOf(rig.conversation)).length).toBe(before);
    const onlySummary = page.filter((entry) => entry.kind === COMPACTION_ENTRY);
    expect(hasSpoken(onlySummary)).toBe(false);
    expect(spokenUserCount(onlySummary)).toBe(0);
  } finally {
    await closeRig(rig);
  }
}, 30_000);

test("blank and whitespace instructions add no additional-focus line", async () => {
  let rig: Opened | undefined;
  try {
    rig = await openRig(choice({ basis: "percent", percent: 80 }));
    await submit(rig.conversation, longUser("first"));
    await submit(rig.conversation, longUser("second"));
    await rig.conversation.compact(compactionFocus("   "), ctx);
    await pollHead(rig.conversation);
    expect(rig.summarizerTexts.some((text) => text.includes("Additional focus:"))).toBe(false);
  } finally {
    await closeRig(rig);
  }

  rig = undefined;
  try {
    rig = await openRig(choice({ basis: "percent", percent: 80 }));
    await submit(rig.conversation, longUser("first"));
    await submit(rig.conversation, longUser("second"));
    await rig.conversation.compact(compactionFocus(""), ctx);
    await pollHead(rig.conversation);
    expect(rig.summarizerTexts.some((text) => text.includes("Additional focus:"))).toBe(false);
  } finally {
    await closeRig(rig);
  }
}, 30_000);
