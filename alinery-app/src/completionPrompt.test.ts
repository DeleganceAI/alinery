import { describe, expect, it } from "vitest";
import { completionPrompt } from "./completionPrompt";
import type { NormalizedStep } from "./types";
import { executionRecord, executionReply } from "./views/executionTestFixture";

const worker = executionReply().definition.step[0];
function step(key: string, inputs: string[], outputs: string[]): NormalizedStep {
  return { ...worker, key, title: key, inputs: inputs.map((path) => ({ path, mode: "single" })), outputs: outputs.map((path) => ({ path })) };
}
function promptForSteps(steps: NormalizedStep[]) {
  return completionPrompt({ ...executionReply().definition, step: steps }, executionRecord());
}

describe("completion destinations", () => {
  it("uses immediate dependencies, not definition order or every downstream consumer", () => {
    const result = promptForSteps([step("publish", ["result.md", "review.md"], []), step("review", ["result.md"], ["review.md"]), worker]);
    expect(result.allowLabel).toBe("Move to review");
    expect(result.scope).not.toContain("publish");
  });

  it("shows all branches, including wildcard consumers, without selecting one", () => {
    const result = promptForSteps([{ ...worker, outputs: [{ path: "reviews/*.md" }] }, step("summary", ["reviews/*.md"], []), step("security", ["reviews/security.md"], [])]);
    expect(result.allowLabel).toBe("Move to next steps");
    expect(result.scope).toContain("summary, security");
  });

  it("does not claim the task is complete when a terminal step or manual execution finishes", () => {
    expect(promptForSteps([worker, step("unrelated", ["other.md"], [])]).allowLabel).toBe("Finish step");
    const execution = executionRecord();
    execution.candidate.manual = true;
    const definition = { ...executionReply().definition, step: [worker, step("review", ["result.md"], [])] };
    expect(completionPrompt(definition, execution).allowLabel).toBe("Finish step");
    expect(completionPrompt(undefined, undefined).allowLabel).toBe("Finish step");
  });

  it("preserves loop destinations instead of treating the last listed step as terminal", () => {
    const result = promptForSteps([{ ...worker, inputs: [{ path: "review.md", mode: "single" }] }, step("review", ["result.md"], ["review.md"])]);
    expect(result.allowLabel).toBe("Move to review");
  });
});
