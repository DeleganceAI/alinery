import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { Toast } from "../toast";
import type { VinculumCustomizations as Inventory, VinculumDaemonCustomizations } from "../types";
import { VinculumCustomizations } from "./VinculumCustomizations";

const mocks = vi.hoisted(() => ({
  readVinculumCustomizations: vi.fn(),
  vinculumCustomizations: vi.fn(),
  openVinculumAgentDir: vi.fn(),
  vinculumCustomizationPrompt: vi.fn(),
  revealItemInDir: vi.fn(),
  pickVinculumSkillDialog: vi.fn(),
  installVinculumSkill: vi.fn(),
  deleteVinculumSkill: vi.fn(),
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "replace"),
}));
vi.mock("../ipc", () => mockIpc(mocks));
vi.mock("../confirm", () => ({ confirmDanger: mocks.confirmDanger, askConfirm: mocks.askConfirm }));

const installed: Inventory = {
  items: [{ name: "Ponytail", kind: "Skill", source: "/config/agent/skills/ponytail/SKILL.md", path: "/config/agent/skills/ponytail/SKILL.md", offered: true }],
  errors: [],
};
const live: VinculumDaemonCustomizations = {
  tools: ["read", "write", "edit", "bash", "alinery_phase_complete", "alinery_set_session_name"],
  servers: [{ name: "alinery", builtin: true, state: "connected" }],
};

beforeEach(() => {
  mocks.readVinculumCustomizations.mockResolvedValue(installed);
  mocks.vinculumCustomizations.mockResolvedValue(live);
  mocks.openVinculumAgentDir.mockResolvedValue(undefined);
  mocks.vinculumCustomizationPrompt.mockResolvedValue("Inspect this Vinculum installation; append your requested change.");
  mocks.revealItemInDir.mockResolvedValue(undefined);
  mocks.pickVinculumSkillDialog.mockResolvedValue(null);
  mocks.installVinculumSkill.mockResolvedValue({ name: "demo-skill", exists: false });
  mocks.deleteVinculumSkill.mockResolvedValue(undefined);
  mocks.confirmDanger.mockResolvedValue(true);
  mocks.askConfirm.mockResolvedValue("replace");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Vinculum customizations", () => {
  it("shows read and the built-in alinery server even when no user MCP file is installed", async () => {
    render(<VinculumCustomizations />);
    const tools = await screen.findByRole("list", { name: "Built-in tools" });
    expect(within(tools).getByText("read")).toBeTruthy();
    const mcp = screen.getByRole("list", { name: "MCP servers" });
    expect(within(mcp).getByText("alinery")).toBeTruthy();
    expect(screen.getByText(/whose agent runtime is Pi/)).toBeTruthy();
    expect(screen.queryByText(/this OMP installation/)).toBeNull();
    expect(screen.getByText(/vinculum agent directory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Ponytail in file manager" }));
    await waitFor(() => expect(mocks.revealItemInDir).toHaveBeenCalledWith("/config/agent/skills/ponytail/SKILL.md"));
  });

  it("uploads a skill and deletes one after confirmation", async () => {
    mocks.pickVinculumSkillDialog.mockResolvedValue("/tmp/demo.md");
    mocks.installVinculumSkill.mockResolvedValueOnce({ name: "demo-skill", exists: true }).mockResolvedValueOnce({ name: "demo-skill", exists: false });
    render(<VinculumCustomizations />);
    await screen.findByText("Ponytail");
    fireEvent.click(screen.getByRole("button", { name: "Upload skill" }));
    await waitFor(() => expect(mocks.installVinculumSkill).toHaveBeenCalledWith("/tmp/demo.md", true));
    fireEvent.click(screen.getByRole("button", { name: "Delete Ponytail" }));
    await waitFor(() => expect(mocks.deleteVinculumSkill).toHaveBeenCalledWith("ponytail"));
  });

  it("keeps discovered items visible with partial discovery errors", async () => {
    mocks.readVinculumCustomizations.mockResolvedValueOnce({ ...installed, errors: ["Could not read MCP definitions in mcp.json."] });
    render(<VinculumCustomizations />);
    expect(await screen.findByText("Ponytail")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not read MCP definitions in mcp.json.");
  });

  it("retains previous results after a failed refresh", async () => {
    mocks.readVinculumCustomizations.mockResolvedValueOnce(installed).mockRejectedValueOnce(new Error("sensitive internal failure"));
    render(<VinculumCustomizations />);
    await screen.findByText("Ponytail");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Showing previous results/)).toBeTruthy();
    expect(screen.getByText("Ponytail")).toBeTruthy();
    expect(screen.queryByText(/sensitive internal failure/)).toBeNull();
  });

  it("reports unavailable rather than empty when the initial inventory fails", async () => {
    mocks.readVinculumCustomizations.mockRejectedValue(new Error("read failed"));
    render(<VinculumCustomizations />);
    expect((await screen.findByRole("alert")).textContent).toContain("inventory is unavailable");
    expect(screen.queryByText("read")).toBeNull();
  });

  it("ignores a stale mount response after the effect has restarted", async () => {
    let resolveOld!: (value: Inventory) => void;
    mocks.readVinculumCustomizations
      .mockImplementationOnce(
        () =>
          new Promise<Inventory>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(installed);
    render(
      <StrictMode>
        <VinculumCustomizations />
      </StrictMode>,
    );
    await screen.findByText("Ponytail");
    await act(async () => resolveOld({ items: [], errors: ["Stale error"] }));
    expect(screen.getByText("Ponytail")).toBeTruthy();
    expect(screen.queryByText("Stale error")).toBeNull();
  });

  it("copies generated instructions and does not mention OMP when that fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <>
        <Toast />
        <VinculumCustomizations />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Inspect this Vinculum installation; append your requested change."));
    expect(await screen.findByText("Instructions copied")).toBeTruthy();
    mocks.vinculumCustomizationPrompt.mockRejectedValue(new Error("private stderr"));
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    expect(await screen.findByText(/Couldn't copy the customization instructions/)).toBeTruthy();
    expect(screen.queryByText(/OMP/)).toBeNull();
    expect(screen.queryByText(/private stderr/)).toBeNull();
  });

  it("says the session daemon is not running instead of inventing tools", async () => {
    mocks.vinculumCustomizations.mockRejectedValue(new Error("daemon not connected"));
    render(<VinculumCustomizations />);
    expect(await screen.findByText("The session daemon is not running.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Built-in tools" })).toBeNull();
    expect(screen.getByText("alinery")).toBeTruthy();
  });
});
