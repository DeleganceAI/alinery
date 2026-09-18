import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { NormalizedStep } from "./types";
import { PlaybookGraph } from "./PlaybookGraph";

const step = (key: string, inputs: string[], outputs: string[]): NormalizedStep => ({ key, title: key, short: key, inputs: inputs.map((path) => ({ path, mode: path.includes("*") ? "complete" : "single" })), outputs: outputs.map((path) => ({ path })), model: "", harness: "", prompt: "", is_coding_step: false, auto_advance_default: false });
afterEach(cleanup);

it("renders shuffled selector forks, joins, cycles and concurrent active counts without document-neighbor edges", () => {
  render(<PlaybookGraph title="Numbers" steps={[
    step("join", ["sum.md", "product.md"], ["done.md"]),
    step("sum", ["numbers.md"], ["sum.md"]),
    step("continue", ["done.md"], ["ticket.md"]),
    step("seed", ["ticket.md"], ["numbers.md"]),
    step("product", ["numbers.md"], ["product.md"]),
  ]} countsByStep={{ sum: 2, product: 1 }} />);
  const relationships = within(screen.getByRole("list", { name: "Artifact dependencies" }));
  expect(relationships.getAllByRole("listitem")).toHaveLength(6);
  for (const name of ["seed to sum: single", "seed to product: single", "sum to join: single", "product to join: single", "join to continue: single", "continue to seed: single"]) {
    expect(relationships.getByRole("listitem", { name })).toBeTruthy();
  }
  expect(relationships.queryByRole("listitem", { name: "sum to continue: single" })).toBeNull();
  expect(screen.getByLabelText("sum: 2 active sessions")).toBeTruthy();
  expect(screen.getByLabelText("product: 1 active sessions")).toBeTruthy();
});

it("relates wildcard families only within the declared directory", () => {
  render(<PlaybookGraph title="Families" steps={[
    step("fanout", [], ["a/request-*.md"]),
    step("worker", ["a/request-*.md"], ["a/result-*.md"]),
    step("merge", ["a/result-*.md"], ["summary.md"]),
    step("unrelated", ["b/result-*.md"], ["other.md"]),
  ]} />);
  const relationships = within(screen.getByRole("list", { name: "Artifact dependencies" }));
  expect(relationships.getAllByRole("listitem")).toHaveLength(2);
  expect(relationships.getByRole("listitem", { name: "fanout to worker: complete" })).toBeTruthy();
  expect(relationships.getByRole("listitem", { name: "worker to merge: complete" })).toBeTruthy();
});
