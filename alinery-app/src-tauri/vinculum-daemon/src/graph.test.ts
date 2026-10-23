import { describe, expect, test } from "bun:test";
import { executionModel } from "./graph.ts";

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
});
