import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SessionHooks } from "./graph.ts";
import { engineExecutions, executionModel, forgetTask, handoffForStep, liveSessionCap, logHasStart, prepareGraphs, resetGraphs, runTask, sessionHarnessStatus, taskShouldHold, tickGraphs } from "./graph.ts";

describe("execution model", () => {
  test("uses the task default when the playbook leaves the model blank", () => {
    expect(executionModel("", "build", "azure/deepseek-v4-pro", {})).toBe("azure/deepseek-v4-pro");
  });

  test("a step override beats the playbook and the task default", () => {
    expect(executionModel("alinery/DeepSeek-V4.1-Flash", "build", "azure/deepseek-v4-pro", { build: "azure/other" })).toBe("azure/other");
  });

  test("a playbook model beats the task default", () => {
    expect(executionModel("playbook/model", "build", "azure/deepseek-v4-pro", {})).toBe("playbook/model");
  });

  test("settings come after the task, and a blank is left for the hosted fallback", () => {
    expect(executionModel("", "build", "", {}, "settings/model")).toBe("settings/model");
    expect(executionModel("", "build", "azure/deepseek-v4-pro", {}, "settings/model")).toBe("azure/deepseek-v4-pro");
    expect(executionModel("", "build", "", {}, "")).toBe("");
  });
});

describe("task record", () => {
  test("hold, cap, and a start already in the log", () => {
    expect(taskShouldHold(false, false)).toBe(true);
    expect(taskShouldHold(true, false)).toBe(false);
    expect(taskShouldHold(false, true)).toBe(false);
    expect(liveSessionCap(3)).toBe(3);
    expect(liveSessionCap(0)).toBe(0);
    expect(liveSessionCap(1.5)).toBe(0);
  });

  test("a handoff meta is only that step", () => {
    const root = mkdtempSync(join(tmpdir(), "vinculum-handoff-"));
    const sessions = join(root, "sessions");
    const artifacts = join(root, "artifacts");
    mkdirSync(sessions);
    mkdirSync(artifacts);
    writeFileSync(join(sessions, "review.meta.json"), JSON.stringify({ phase: "review", prompt_extra: "keep the tests", handoff_artifact: "review-handoff-001.md" }));
    writeFileSync(join(sessions, "later.meta.json"), JSON.stringify({ phase: "review", started_at: 4, prompt_extra: "too late" }));
    const review = handoffForStep(sessions, artifacts, "review");
    expect(review.PROMPT_EXTRA).toBe("keep the tests");
    expect(review.REVIEW_HANDOFF_FILE).toBe(join(artifacts, "review-handoff-001.md"));
    expect(handoffForStep(sessions, artifacts, "build")).toEqual({ PROMPT_EXTRA: "", REVIEW_HANDOFF_FILE: "" });
    expect(logHasStart(join(root, "missing.jsonl"))).toBe(false);
  });

  test("a failed row is failed, and waiting is not", () => {
    expect(sessionHarnessStatus(undefined)).toEqual({ kind: "unknown" });
    expect(sessionHarnessStatus({ process: "alive", playbook: { state: "failed" }, agent: { state: "idle" }, liveRun: false })).toEqual({ kind: "failed", reason: "session failed" });
    expect(sessionHarnessStatus({ process: "alive", playbook: { state: "in_progress" }, agent: { state: "waiting_for_approval" }, liveRun: false })).toEqual({ kind: "idle" });
    expect(sessionHarnessStatus({ process: "alive", playbook: { state: "in_progress" }, agent: { state: "idle" }, liveRun: false })).toEqual({ kind: "idle" });
  });
});

function taskFixture(repo: string, slug: string, options: { start?: boolean; cap?: number; enabled?: string[]; approve?: boolean; model?: string; steps?: string; keys?: string[]; prompt?: string }) {
  const dir = join(repo, ".alinery", "tasks", slug);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "ticket.md"), "the task");
  const steps =
    options.steps ??
    `[[step]]\nkey = "work"\ntitle = "Work"\nshort = ""\ninputs = [{ path = "ticket.md", mode = "single" }]\noutputs = [{ path = "out.md" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true`;
  const prompt = options.prompt ?? "Do the step.\n";
  const sections = (options.keys ?? ["work"]).map((key) => `<!-- alinery:step ${key} -->\n${prompt}`).join("\n");
  writeFileSync(join(dir, "playbook.md"), `+++\nversion = 2\nkey = "fixture"\ntitle = "Fixture"\ndescription = ""\ndefault_model = ""\ndefault_harness = "omp"\n\n${steps}\n+++\n${sections}\n`);
  writeFileSync(join(dir, "task.md"), `name = "Fixture"\nworktree = ${JSON.stringify(repo)}\nhas_worktree = true\n\n[launch_defaults]\nmodel = ${JSON.stringify(options.model ?? "")}\n`);
  writeFileSync(
    join(dir, "execution.json"),
    JSON.stringify({
      creation: "ready",
      initial_start_requested: options.start ?? true,
      max_live_sessions: options.cap ?? 10,
      enabled_steps: options.enabled ?? ["work"],
      auto_approve_all: options.approve ?? false,
    }),
  );
}

function recordingHooks(): SessionHooks & { opened: Array<{ id: string; model: string; prompt: string }> } {
  const opened: Array<{ id: string; model: string; prompt: string }> = [];
  return {
    opened,
    async open(id, _slug, model, prompt) {
      opened.push({ id, model, prompt });
    },
    async status() {
      return { kind: "idle" };
    },
    async send() {},
    async stop() {},
    bind() {},
  };
}

describe("playbook host", () => {
  test("create without starting does not launch, and a log that already started does", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-hold-"));
    const hooks = recordingHooks();
    resetGraphs();
    prepareGraphs(repo, hooks);
    taskFixture(repo, "waiting", { start: false });
    await tickGraphs();
    expect(hooks.opened).toEqual([]);

    taskFixture(repo, "again", { start: false });
    writeFileSync(join(repo, ".alinery", "tasks", "again", "engine.jsonl"), `${JSON.stringify({ t: "started", execId: "gone", sessionId: "s" })}\n`);
    await tickGraphs();
    expect(hooks.opened.map((row) => row.prompt.length > 0)).toEqual([true]);
    expect(engineExecutions("waiting")).toEqual([]);
  });

  test("runTask releases a held task", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-run-"));
    const hooks = recordingHooks();
    resetGraphs();
    prepareGraphs(repo, hooks);
    taskFixture(repo, "later", { start: false });
    await tickGraphs();
    expect(hooks.opened).toEqual([]);
    await runTask("later");
    expect(hooks.opened).toHaveLength(1);
  });

  test("max_live_sessions of 1 does not launch a second execution", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-cap-"));
    const hooks = recordingHooks();
    resetGraphs();
    prepareGraphs(repo, hooks);
    taskFixture(repo, "capped", {
      cap: 1,
      keys: ["work", "review"],
      steps: [
        ["work", "out.md"],
        ["review", "review.md"],
      ]
        .map(
          ([key, output]) =>
            `[[step]]\nkey = "${key}"\ntitle = "${key}"\nshort = ""\ninputs = [{ path = "ticket.md", mode = "single" }]\noutputs = [{ path = "${output}" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true`,
        )
        .join("\n"),
    });
    await tickGraphs();
    expect(hooks.opened).toHaveLength(1);
    expect(engineExecutions("capped").filter((row) => row.status === "reserved")).toHaveLength(1);
  });

  test("a handoff is in that step's prompt only, and history is every step", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-prompt-"));
    const hooks = recordingHooks();
    resetGraphs();
    prepareGraphs(repo, hooks);
    const prompt = "extra {{PROMPT_EXTRA}} handoff {{REVIEW_HANDOFF_FILE}} history {{SESSION_HISTORY_DIR}}";
    taskFixture(repo, "tokens", {
      prompt,
      keys: ["review", "build"],
      enabled: ["review", "build"],
      steps: ["review", "build"]
        .map(
          (key) =>
            `[[step]]\nkey = "${key}"\ntitle = "${key}"\nshort = ""\ninputs = [{ path = "ticket.md", mode = "single" }]\noutputs = [{ path = "${key}.md" }]\nmodel = ""\nharness = ""\nis_coding_step = false\nauto_advance_default = true`,
        )
        .join("\n"),
    });
    const sessions = join(repo, ".alinery", "tasks", "tokens", "sessions");
    writeFileSync(join(sessions, "handoff.meta.json"), JSON.stringify({ phase: "review", prompt_extra: "keep the tests", handoff_artifact: "review-handoff-001.md" }));
    await tickGraphs();
    const review = hooks.opened.find((row) => row.prompt.includes("keep the tests"));
    const build = hooks.opened.find((row) => !row.prompt.includes("keep the tests"));
    expect(review?.prompt).toContain(join(repo, ".alinery", "tasks", "tokens", "artifacts", "review-handoff-001.md"));
    expect(review?.prompt).toContain(join(repo, ".alinery", "tasks", "tokens", "sessions"));
    expect(build?.prompt).not.toContain("review-handoff-001");
    expect(build?.prompt).toContain(join(repo, ".alinery", "tasks", "tokens", "sessions"));
  });

  test("a blank task model uses settings, and a leftover harness does not", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-model-"));
    const appConfig = join(repo, "app.toml");
    writeFileSync(appConfig, `[global.defaults]\nharness = "omp"\nmodel = "settings/model"\n`);
    const hooks = recordingHooks();
    resetGraphs();
    prepareGraphs(repo, hooks, appConfig);
    taskFixture(repo, "settings-model", { model: "" });
    await tickGraphs();
    expect(hooks.opened[0]?.model).toBe("settings/model");

    writeFileSync(join(repo, ".alinery", "config.toml"), `[defaults]\nharness = "claude"\nmodel = "repo/model"\n`);
    resetGraphs();
    prepareGraphs(repo, hooks, appConfig);
    taskFixture(repo, "leftover", { model: "" });
    await tickGraphs();
    expect(hooks.opened.find((row) => row.model === "repo/model")).toBeUndefined();
    expect(hooks.opened.at(-1)?.model).toBe("");
  });

  test("an ended session confirms the exit instead of resuming", async () => {
    const repo = mkdtempSync(join(tmpdir(), "vinculum-ended-"));
    const hooks = recordingHooks();
    resetGraphs();
    prepareGraphs(repo, hooks);
    taskFixture(repo, "ended", { start: true });
    await tickGraphs();
    const id = hooks.opened[0]?.id ?? "";
    writeFileSync(join(repo, ".alinery", "tasks", "ended", "sessions", `${id}.meta.json`), JSON.stringify({ id, ended_at: 9 }));
    forgetTask("ended");
    const before = hooks.opened.length;
    await tickGraphs();
    expect(hooks.opened).toHaveLength(before);
    expect(engineExecutions("ended")[0]?.status).toBe("failed");
  });
});
