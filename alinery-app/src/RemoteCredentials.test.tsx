import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { RemoteCredentialsForm } from "./RemoteCredentials";
import type * as IpcFixtures from "./test/mockIpc";
import type { RemoteSharingView } from "./types";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc({ remoteSharing: vi.fn(), remoteSetSharing: vi.fn() });
});

const view = (over: Partial<RemoteSharingView> = {}): RemoteSharingView => ({
  reviewed: false,
  shared: ["hosted-models"],
  keys: ["anthropic", "openai"],
  sign_ins: ["openai-codex"],
  custom_providers: true,
  grok: true,
  hosted: true,
  hosted_expires_at: Math.floor(Date.now() / 1000) + 90 * 86_400,
  erased_sign_ins: [],
  ...over,
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
beforeEach(() => {
  vi.mocked(ipc.remoteSharing).mockResolvedValue(view());
  vi.mocked(ipc.remoteSetSharing).mockImplementation(async () => view({ reviewed: true }));
});

function mount(onDone = vi.fn()) {
  render(<RemoteCredentialsForm hostId="box" hostLabel="Build box" confirmLabel="Continue" onDone={onDone} onCancel={vi.fn()} />);
  return onDone;
}

describe("RemoteCredentialsForm", () => {
  it("leaves every API key unticked, proposes hosted models, and says keys are the dependable choice", async () => {
    mount();
    expect(await screen.findByText("Recommended")).toBeTruthy();
    expect(screen.getByText(/most reliable way to keep a host running/)).toBeTruthy();
    expect((screen.getByLabelText("Anthropic") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("OpenAI") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Let this host use Alinery hosted models") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/valid for about 90 days/)).toBeTruthy();
    expect(screen.getByText(/connect from a Mac before it runs out/)).toBeTruthy();
  });

  it("says browser sign-ins are not copied and names the ones this Mac has", async () => {
    mount();
    await screen.findByText("Sign-ins");
    expect(screen.getByText(/Browser sign-ins are not copied/)).toBeTruthy();
    expect(screen.getByText(/not copied: OpenAI Codex/)).toBeTruthy();
    expect(screen.queryByLabelText("OpenAI Codex")).toBeNull();
  });

  it("saves exactly what was ticked, then continues", async () => {
    const onDone = mount();
    fireEvent.click(await screen.findByLabelText("Anthropic"));
    fireEvent.click(screen.getByLabelText("Grok API key"));
    fireEvent.click(screen.getByLabelText("Let this host use Alinery hosted models"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(vi.mocked(ipc.remoteSetSharing).mock.calls[0][0]).toBe("box");
    expect([...vi.mocked(ipc.remoteSetSharing).mock.calls[0][1]].sort()).toEqual(["grok", "key:anthropic"]);
  });

  it("selects and clears every API key at once", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Select all" }));
    expect((screen.getByLabelText("Anthropic") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("OpenAI") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Select none" }));
    expect((screen.getByLabelText("Anthropic") as HTMLInputElement).checked).toBe(false);
  });

  it("explains how to get hosted models when this Mac has no token, and offers no key list when it has no keys", async () => {
    vi.mocked(ipc.remoteSharing).mockResolvedValue(view({ hosted: false, hosted_expires_at: null, shared: [], keys: [], grok: false, custom_providers: false }));
    mount();
    expect(await screen.findByText(/Sign in to Alinery on this Mac with a paid plan/)).toBeTruthy();
    expect(screen.getByText(/No API keys are saved on this Mac/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
  });

  it("says plainly which sign-ins were removed from the host", async () => {
    vi.mocked(ipc.remoteSharing).mockResolvedValue(view({ reviewed: true, erased_sign_ins: ["openai-codex", "anthropic"] }));
    mount();
    const notice = await screen.findByText(/were removed from this host/);
    expect(notice.textContent).toContain("OpenAI Codex, Anthropic");
    expect(notice.textContent).toContain("sign in again");
  });

  it("shows a failed save and stays on the step", async () => {
    vi.mocked(ipc.remoteSetSharing).mockRejectedValue("the host is not connected");
    const onDone = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not connected");
    expect(onDone).not.toHaveBeenCalled();
  });
});
