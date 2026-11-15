import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecFile, Specs } from "../sync/specs";
import { SettingsSpecs } from "./SettingsSpecs";

const sync = vi.hoisted(() => ({ readSpecs: vi.fn(), writeSpec: vi.fn() }));
vi.mock("../sync/specs", () => sync);

const file = (name: string, over: Partial<SpecFile> = {}): SpecFile => ({ name, present: false, text: "", committed: false, tooLarge: false, ...over });
const specs = (files: SpecFile[], maxChars = 100): Specs => ({ files, maxChars });
const three = (over: Record<string, Partial<SpecFile>> = {}) => specs(["requirements.md", "tooling.md", "architecture.md"].map((name) => file(name, over[name])));

beforeEach(() => {
  sync.readSpecs.mockReset();
  sync.writeSpec.mockReset();
  sync.writeSpec.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("SettingsSpecs", () => {
  it("offers to create each missing file, writing a template in place and then showing the editor", async () => {
    sync.readSpecs.mockResolvedValueOnce(three()).mockResolvedValueOnce(three({ "tooling.md": { present: true, text: "# Tooling\n" } }));
    render(<SettingsSpecs repo="/r" />);
    expect(await screen.findAllByText("Not created")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Create specs/tooling.md" }));
    await waitFor(() => expect(sync.writeSpec).toHaveBeenCalledWith("/r", "tooling.md", expect.stringContaining("# Tooling")));
    expect(await screen.findByLabelText("Tooling (specs/tooling.md)")).toHaveProperty("value", "# Tooling\n");
  });

  it("says whether a file is committed, and saves only an edited draft", async () => {
    sync.readSpecs.mockResolvedValue(three({ "requirements.md": { present: true, text: "Use ruff.", committed: true }, "tooling.md": { present: true, text: "ruff 0.4" } }));
    render(<SettingsSpecs repo="/r" />);
    expect(await screen.findByText("Committed")).toBeTruthy();
    expect(screen.getByText(/Not committed yet/)).toBeTruthy();

    const [save] = screen.getAllByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Requirements (specs/requirements.md)"), { target: { value: "Use ruff 0.5." } });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(sync.writeSpec).toHaveBeenCalledWith("/r", "requirements.md", "Use ruff 0.5."));
  });

  it("will not save past the limit and shows no editor for a file that is already over it", async () => {
    sync.readSpecs.mockResolvedValue(three({ "requirements.md": { present: true, text: "ok" }, "architecture.md": { present: true, tooLarge: true } }));
    render(<SettingsSpecs repo="/r" />);
    await screen.findByLabelText("Requirements (specs/requirements.md)");
    expect(screen.queryByLabelText("Architecture (specs/architecture.md)")).toBeNull();
    expect(screen.getByText(/Edit it in your editor/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Requirements (specs/requirements.md)"), { target: { value: "x".repeat(101) } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByText("101 / 100")).toBeTruthy();
  });

  it("shows a failed read or write instead of hiding it", async () => {
    sync.readSpecs.mockRejectedValueOnce(new Error("the daemon is not reachable"));
    render(<SettingsSpecs repo="/r" />);
    expect((await screen.findByRole("alert")).textContent).toContain("not reachable");

    cleanup();
    sync.readSpecs.mockResolvedValue(three());
    sync.writeSpec.mockRejectedValueOnce(new Error("specs exists but is not a plain directory"));
    render(<SettingsSpecs repo="/r" />);
    fireEvent.click(await screen.findByRole("button", { name: "Create specs/requirements.md" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not a plain directory");
  });
});
