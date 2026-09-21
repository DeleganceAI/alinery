import { describe, expect, it } from "vitest";
import type { Task, View } from "../types";
import { nextViewAfterCreate } from "./create-landing";

const task = (slug: string): Task => ({
  name: "New Task",
  slug,
  branch: slug,
  worktree: "",
  has_worktree: false,
  created: 0,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "rpi",
  auto_advance: [],
  draft: false,
});

describe("nextViewAfterCreate", () => {
  // 6.4 — the Orbitron half. Landing in TaskDetail here loses the drop target the user
  // picked before opening the create form.
  it("returns to the canvas and reports the slug to place", () => {
    const from: View = { kind: "canvas" };
    expect(nextViewAfterCreate(from, task("login-form"))).toEqual({ view: { kind: "canvas" }, placeSlug: "login-form" });
  });

  // 6.4 — the regression half: every other origin keeps opening the new task.
  it("opens the new task for every other origin", () => {
    const from: View = { kind: "kanban" };
    const created = task("login-form");
    expect(nextViewAfterCreate(from, created)).toEqual({ view: { kind: "task", slug: "login-form", from, initialTask: created } });
  });

  it("keeps the original origin as the task view's back target", () => {
    const from: View = { kind: "list" };
    const landing = nextViewAfterCreate(from, task("api-audit"));
    expect(landing.view.kind).toBe("task");
    expect(landing.placeSlug).toBeUndefined();
    if (landing.view.kind === "task") expect(landing.view.from).toBe(from);
  });
});
