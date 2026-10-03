import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { Toast } from "../toast";
import type { OmpCustomizations as Inventory } from "../types";
import { OmpCustomizations } from "./OmpCustomizations";

const mocks = vi.hoisted(() => ({
  readOmpCustomizations: vi.fn(),
  openOmpConfigDir: vi.fn(),
  ompCustomizationPrompt: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("../ipc", () => mockIpc(mocks));

const installed: Inventory = {
  items: [
    { name: "Ponytail", kind: "skill", source: "skills/ponytail/SKILL.md", path: "/config/agent/skills/ponytail/SKILL.md" },
    { name: "Alinery integration", kind: "extension", source: "Provided by Alinery (injected at launch)", path: null },
  ],
  errors: [],
};

beforeEach(() => {
  mocks.readOmpCustomizations.mockResolvedValue(installed);
  mocks.openOmpConfigDir.mockResolvedValue(undefined);
  mocks.ompCustomizationPrompt.mockResolvedValue("Inspect this installation; append your requested change.");
  mocks.revealItemInDir.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("OMP customizations", () => {
  it("shows loose skills independently of plugin packages, labels injected integration, and reveals local entries", async () => {
    render(<OmpCustomizations />);
    const inventory = await screen.findByRole("list", { name: "Installed customizations" });
    expect(within(inventory).getByText("Ponytail")).toBeTruthy();
    expect(within(inventory).getByText(/Type: skill · Source: skills\/ponytail\/SKILL.md/)).toBeTruthy();
    expect(within(inventory).getByText(/Provided by Alinery \(injected at launch\)/)).toBeTruthy();
    expect(within(inventory).queryByRole("button", { name: /Show Alinery integration/ })).toBeNull();
    expect(screen.getByText(/not a list of what running sessions have loaded/)).toBeTruthy();
    fireEvent.click(within(inventory).getByRole("button", { name: "Show Ponytail in file manager" }));
    await waitFor(() => expect(mocks.revealItemInDir).toHaveBeenCalledWith("/config/agent/skills/ponytail/SKILL.md"));
    fireEvent.click(screen.getByRole("button", { name: "Open configuration folder" }));
    await waitFor(() => expect(mocks.openOmpConfigDir).toHaveBeenCalledOnce());
  });

  it("keeps discovered items visible with partial discovery errors, including an empty partial result", async () => {
    mocks.readOmpCustomizations
      .mockResolvedValueOnce({ ...installed, errors: ["Could not read MCP definitions in mcp.json."] })
      .mockResolvedValueOnce({ items: [], errors: ["Plugin listing timed out."] });
    render(<OmpCustomizations />);
    expect(await screen.findByText("Ponytail")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not read MCP definitions in mcp.json.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Plugin listing timed out.")).toBeTruthy();
    expect(screen.queryByText("Ponytail")).toBeNull();
    expect(screen.queryByText(/No customizations found/)).toBeNull();
  });

  it("retains previous results after failed refresh and only replaces them when discovery succeeds", async () => {
    let rejectRefresh!: (reason: Error) => void;
    mocks.readOmpCustomizations
      .mockResolvedValueOnce(installed)
      .mockImplementationOnce(
        () =>
          new Promise<Inventory>((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      )
      .mockResolvedValueOnce({ items: [], errors: [] });
    render(<OmpCustomizations />);
    await screen.findByText("Ponytail");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((screen.getByRole("button", { name: "Refreshing…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Ponytail")).toBeTruthy();
    await act(async () => rejectRefresh(new Error("sensitive internal failure")));
    expect(screen.getByRole("alert").textContent).toContain("Showing previous results");
    expect(screen.getByText("Ponytail")).toBeTruthy();
    expect(screen.queryByText(/sensitive internal failure/)).toBeNull();
    expect(screen.queryByText(/No customizations found/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/No customizations found/)).toBeTruthy();
    expect(screen.queryByText("Ponytail")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports unavailable rather than empty when the initial inventory fails", async () => {
    mocks.readOmpCustomizations.mockRejectedValue(new Error("read failed"));
    render(<OmpCustomizations />);
    expect((await screen.findByRole("alert")).textContent).toContain("inventory is unavailable");
    expect(screen.queryByText(/No customizations found/)).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores a stale mount response after the effect has restarted", async () => {
    let resolveOld!: (value: Inventory) => void;
    mocks.readOmpCustomizations
      .mockImplementationOnce(
        () =>
          new Promise<Inventory>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(installed);
    render(
      <StrictMode>
        <OmpCustomizations />
      </StrictMode>,
    );
    await screen.findByText("Ponytail");
    await act(async () => resolveOld({ items: [], errors: ["Stale error"] }));
    expect(screen.getByText("Ponytail")).toBeTruthy();
    expect(screen.queryByText("Stale error")).toBeNull();
    expect(screen.queryByText(/No customizations found/)).toBeNull();
  });

  it("copies generated instructions and confirms only after the clipboard succeeds", async () => {
    let finishCopy!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <>
        <Toast />
        <OmpCustomizations />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Inspect this installation; append your requested change."));
    expect(screen.queryByText("Instructions copied")).toBeNull();
    expect((screen.getByRole("button", { name: "Copying…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finishCopy());
    expect(screen.getByText("Instructions copied")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy instructions for an AI" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("reports clipboard rejection without claiming success and permits retry", async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error("clipboard denied")).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(
      <>
        <Toast />
        <OmpCustomizations />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    expect(await screen.findByText(/Couldn't copy the OMP customization instructions/)).toBeTruthy();
    expect(screen.queryByText("Instructions copied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    expect(await screen.findByText("Instructions copied")).toBeTruthy();
  });

  it("does not touch the clipboard or expose backend details when prompt generation fails", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mocks.ompCustomizationPrompt.mockRejectedValue(new Error("private stderr"));
    render(
      <>
        <Toast />
        <OmpCustomizations />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy instructions for an AI" }));
    expect(await screen.findByText(/Couldn't copy the OMP customization instructions/)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/private stderr/)).toBeNull();
    expect(screen.queryByText("Instructions copied")).toBeNull();
  });

  it("reports file manager failures without leaking native error details", async () => {
    mocks.openOmpConfigDir.mockRejectedValue(new Error("private opener failure"));
    mocks.revealItemInDir.mockRejectedValue(new Error("private item failure"));
    render(
      <>
        <Toast />
        <OmpCustomizations />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open configuration folder" }));
    expect(await screen.findByText("Couldn't open the OMP configuration folder.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Show Ponytail in file manager" }));
    expect(await screen.findByText("Couldn't show the customization in the file manager.")).toBeTruthy();
    expect(screen.queryByText(/private opener failure|private item failure/)).toBeNull();
  });
});
