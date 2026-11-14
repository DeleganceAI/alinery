import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { Toast } from "../toast";
import type { VinculumCustomizations as Inventory, VinculumDaemonCustomizations } from "../types";
import { skillCounter, VinculumCustomizations } from "./VinculumCustomizations";

const mocks = vi.hoisted(() => ({
  readCustomizations: vi.fn(),
  agentHost: vi.fn(),
  agentDirIsLocal: vi.fn(),
  readMcpStatus: vi.fn(),
  openVinculumAgentDir: vi.fn(),
  customizationPrompt: vi.fn(),
  revealItemInDir: vi.fn(),
  pickVinculumSkillDialog: vi.fn(),
  installSkill: vi.fn(),
  deleteSkill: vi.fn(),
  setSkillEnabled: vi.fn(),
  restoreIncludedSkills: vi.fn(),
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "replace"),
}));
vi.mock("../ipc", () => mockIpc(mocks));
// The agent directory is the host daemon's (sync/agent, daemon agent.test.ts); the page reads and edits it through these calls.
vi.mock("../sync/agent", () => ({
  readCustomizations: mocks.readCustomizations,
  agentHost: mocks.agentHost,
  agentDirIsLocal: mocks.agentDirIsLocal,
  readMcpStatus: mocks.readMcpStatus,
  customizationPrompt: mocks.customizationPrompt,
  installSkill: mocks.installSkill,
  deleteSkill: mocks.deleteSkill,
  setSkillEnabled: mocks.setSkillEnabled,
  restoreIncludedSkills: mocks.restoreIncludedSkills,
}));
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
  mocks.readCustomizations.mockResolvedValue(installed);
  mocks.agentHost.mockResolvedValue("/repo");
  mocks.agentDirIsLocal.mockReturnValue(true);
  mocks.readMcpStatus.mockResolvedValue(live);
  mocks.openVinculumAgentDir.mockResolvedValue(undefined);
  mocks.customizationPrompt.mockResolvedValue("Inspect this Vinculum installation; append your requested change.");
  mocks.revealItemInDir.mockResolvedValue(undefined);
  mocks.pickVinculumSkillDialog.mockResolvedValue(null);
  mocks.installSkill.mockResolvedValue({ name: "demo-skill", exists: false });
  mocks.deleteSkill.mockResolvedValue(undefined);
  mocks.setSkillEnabled.mockResolvedValue(undefined);
  mocks.restoreIncludedSkills.mockResolvedValue(undefined);
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
    expect(screen.getByText(/Vinculum harness/)).toBeTruthy();
    expect(screen.queryByText(/\bPi\b|\.pi\b/)).toBeNull();
    expect(screen.queryByText(/this Vinculum installation/)).toBeNull();
    expect(screen.getByText(/Vinculum agent directory/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show Ponytail in file manager" }));
    await waitFor(() => expect(mocks.revealItemInDir).toHaveBeenCalledWith("/config/agent/skills/ponytail/SKILL.md"));
  });

  it("switches skills, removes and restores included ones, and blocks one more at the limit", async () => {
    mocks.readCustomizations.mockResolvedValue({
      items: [
        { name: "pdf", kind: "Skill", source: "Included", path: "/rt/skills/pdf/SKILL.md", offered: true, included: true, enabled: true },
        { name: "nda-generator", kind: "Skill", source: "Included", path: "/rt/skills/nda-generator/SKILL.md", offered: false, included: true, enabled: false },
        { name: "Ponytail", kind: "Skill", source: "/config/agent/skills/ponytail/SKILL.md", path: "/config/agent/skills/ponytail/SKILL.md", offered: true, enabled: true },
      ],
      errors: [],
      skills: { on: 64, limit: 64, catalogChars: 8000, removed: ["docx"] },
    } satisfies Inventory);
    render(<VinculumCustomizations />);
    expect(await screen.findByText("64 of 64 on · about 2,000 tokens in every prompt")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "nda-generator on" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "pdf on" }));
    await waitFor(() => expect(mocks.setSkillEnabled).toHaveBeenCalledWith("pdf", false));
    expect(screen.queryByRole("button", { name: "Delete pdf" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove pdf" }));
    await waitFor(() => expect(mocks.deleteSkill).toHaveBeenCalledWith("pdf", undefined, true));
    fireEvent.click(screen.getByRole("button", { name: "Restore 1 removed included skill" }));
    await waitFor(() => expect(mocks.restoreIncludedSkills).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Delete Ponytail" })).toBeTruthy();
  });

  it("says when more skills are on than are offered", () => {
    expect(skillCounter({ on: 70, limit: 64, catalogChars: 0, removed: [] })).toBe("70 of 64 on · only the first 64 are offered");
  });

  it("uploads a skill and deletes one after confirmation", async () => {
    mocks.pickVinculumSkillDialog.mockResolvedValue("/tmp/demo.md");
    mocks.installSkill.mockResolvedValueOnce({ name: "demo-skill", exists: true }).mockResolvedValueOnce({ name: "demo-skill", exists: false });
    render(<VinculumCustomizations />);
    await screen.findByText("Ponytail");
    fireEvent.click(screen.getByRole("button", { name: "Upload skill" }));
    await waitFor(() => expect(mocks.installSkill).toHaveBeenCalledWith("/tmp/demo.md", true));
    fireEvent.click(screen.getByRole("button", { name: "Delete Ponytail" }));
    await waitFor(() => expect(mocks.deleteSkill).toHaveBeenCalledWith("ponytail"));
  });

  it("does not offer the Finder for an agent directory on another machine", async () => {
    mocks.agentHost.mockResolvedValue("alinery+ssh://box/srv/repo");
    mocks.agentDirIsLocal.mockReturnValue(false);
    render(<VinculumCustomizations />);
    await screen.findByText("Ponytail");
    expect(screen.queryByRole("button", { name: "Open configuration folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show Ponytail in file manager" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete Ponytail" })).toBeTruthy();
  });

  it("keeps discovered items visible with partial discovery errors", async () => {
    mocks.readCustomizations.mockResolvedValueOnce({ ...installed, errors: ["Could not read MCP definitions in mcp.json."] });
    render(<VinculumCustomizations />);
    expect(await screen.findByText("Ponytail")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not read MCP definitions in mcp.json.");
  });

  it("retains previous results after a failed refresh", async () => {
    mocks.readCustomizations.mockResolvedValueOnce(installed).mockRejectedValueOnce(new Error("sensitive internal failure"));
    render(<VinculumCustomizations />);
    await screen.findByText("Ponytail");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Showing previous results/)).toBeTruthy();
    expect(screen.getByText("Ponytail")).toBeTruthy();
    expect(screen.queryByText(/sensitive internal failure/)).toBeNull();
  });

  it("reports unavailable rather than empty when the initial inventory fails", async () => {
    mocks.readCustomizations.mockRejectedValue(new Error("read failed"));
    render(<VinculumCustomizations />);
    expect((await screen.findByRole("alert")).textContent).toContain("inventory is unavailable");
    expect(screen.queryByText("read")).toBeNull();
  });

  it("ignores a stale mount response after the effect has restarted", async () => {
    let resolveOld!: (value: Inventory) => void;
    mocks.readCustomizations
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

  it("copies generated instructions and keeps the error private when that fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = render(
      <>
        <Toast />
        <VinculumCustomizations />
      </>,
    );
    await waitFor(() => expect(mocks.customizationPrompt).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    // The text was fetched when the panel loaded, so the click writes it without waiting on the daemon.
    expect(writeText).toHaveBeenCalledWith("Inspect this Vinculum installation; append your requested change.");
    expect(await screen.findByText("Instructions copied")).toBeTruthy();
    view.unmount();
    mocks.customizationPrompt.mockRejectedValue(new Error("private stderr"));
    render(
      <>
        <Toast />
        <VinculumCustomizations />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    expect(await screen.findByText(/Couldn't copy the customization instructions/)).toBeTruthy();
    expect(screen.queryByText(/private stderr/)).toBeNull();
  });

  it("says the session daemon is not running instead of inventing tools", async () => {
    mocks.readMcpStatus.mockRejectedValue(new Error("daemon not connected"));
    render(<VinculumCustomizations />);
    expect(await screen.findByText("The session daemon is not running.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Built-in tools" })).toBeNull();
    expect(screen.getByText("alinery")).toBeTruthy();
  });
});
