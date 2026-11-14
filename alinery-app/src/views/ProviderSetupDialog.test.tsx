import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoginStatus } from "../chat/providers";
import { mockIpc } from "../test/mockIpc";
import type { HostedCatalogView } from "../types";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

const mocks = vi.hoisted(() => ({
  readModelRoles: vi.fn(),
  readModelFavorites: vi.fn(),
  hostedCatalog: vi.fn(),
  providerCatalog: vi.fn(),
  grokKeyReady: vi.fn(),
  accountSignIn: vi.fn(),
  accountRefresh: vi.fn(),
  openUrl: vi.fn(),
  providerLoginStart: vi.fn(),
  providerLoginPoll: vi.fn(),
  providerLoginReply: vi.fn(),
}));
vi.mock("../ipc", () => mockIpc(mocks));
// The catalog is the host daemon's ProviderService (sync/providers).
vi.mock("../sync/providers", () => ({
  providerCatalog: mocks.providerCatalog,
  providerLoginStart: mocks.providerLoginStart,
  providerLoginPoll: mocks.providerLoginPoll,
  providerLoginReply: mocks.providerLoginReply,
}));
// The model roles are the host daemon's (sync/agent).
vi.mock("../sync/agent", () => ({ readModelRoles: mocks.readModelRoles, writeModelRoles: vi.fn(async (roles: Record<string, string>) => roles) }));

const emptyHosted: HostedCatalogView = {
  provider: "alinery",
  defaultModel: "alinery/Qwen3.6-35B-A3B",
  baseUrl: "https://inference.alinery.ai/v1",
  plansUrl: "https://accounts.alinery.ai/plans",
  models: [],
  ready: false,
  upsell: "sign-in",
  source: "empty",
};

const readyHosted: HostedCatalogView = {
  ...emptyHosted,
  models: [{ id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B", contextWindow: 1, maxTokens: 1, price: 1 }],
  ready: true,
  upsell: null,
  source: "live",
};

function settleIpc(hosted: HostedCatalogView = emptyHosted, grok = false) {
  mocks.readModelRoles.mockResolvedValue({});
  mocks.readModelFavorites.mockResolvedValue([]);
  mocks.hostedCatalog.mockResolvedValue(hosted);
  mocks.providerCatalog.mockResolvedValue({ providers: [], models: [], custom: [] });
  mocks.grokKeyReady.mockResolvedValue(grok);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderSetupDialog", () => {
  it("lists hosted models without opening a Vinculum session", async () => {
    settleIpc(readyHosted);
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /^alinery\/Qwen3\.6-35B-A3B/ })).toBeTruthy();
  });

  it("adds Grok models when a key is saved", async () => {
    settleIpc(readyHosted, true);
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "xai/grok-4.7" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^alinery\/Qwen3\.6-35B-A3B/ })).toBeTruthy();
  });

  it("shows Connecting… until the hosted catalog returns", async () => {
    let resolveHosted: (view: HostedCatalogView) => void = () => undefined;
    mocks.readModelRoles.mockResolvedValue({});
    mocks.readModelFavorites.mockResolvedValue([]);
    mocks.grokKeyReady.mockResolvedValue(false);
    mocks.providerCatalog.mockResolvedValue({ providers: [], models: [], custom: [] });
    mocks.hostedCatalog.mockReturnValue(
      new Promise<HostedCatalogView>((resolve) => {
        resolveHosted = resolve;
      }),
    );
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    await act(async () => {
      resolveHosted(readyHosted);
    });
    expect(await screen.findByRole("button", { name: /^alinery\/Qwen3\.6-35B-A3B/ })).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("closes an automatic offer once the catalog has loaded and no Vinculum login is required", async () => {
    settleIpc(readyHosted);
    const onClose = vi.fn();
    render(<ProviderSetupDialog mode="auto" onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("not-needed"));
  });

  it("refreshes entitlement after Alinery sign-in before reloading the catalog", async () => {
    settleIpc(emptyHosted);
    mocks.accountSignIn.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    mocks.accountRefresh.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: "Founders Edition", paid: true, unavailable: false });
    render(<ProviderSetupDialog mode="manual" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Alinery/ }));
    await waitFor(() => expect(mocks.accountSignIn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.accountRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.hostedCatalog).toHaveBeenCalledTimes(2));
    const signInOrder = mocks.accountSignIn.mock.invocationCallOrder[0];
    const refreshOrder = mocks.accountRefresh.mock.invocationCallOrder[0];
    const catalogOrder = mocks.hostedCatalog.mock.invocationCallOrder[1];
    expect(signInOrder).toBeLessThan(refreshOrder);
    expect(refreshOrder).toBeLessThan(catalogOrder);
  });
});

// The daemon's sign-in (ProviderService): the dialog polls LoginPoll and shows what the browser needs typed.
describe("provider sign-in", () => {
  const codex = { id: "openai-codex", name: "OpenAI Codex", authenticated: false, stored: false, apiKey: false, oauth: true, apiKeyName: "", oauthName: "" };
  const status = (patch: Partial<ProviderLoginStatus>): ProviderLoginStatus => ({ loginId: "l1", status: "pending", events: [], failure: "", ...patch });

  async function startLogin(polls: ProviderLoginStatus[]) {
    settleIpc(readyHosted);
    mocks.providerCatalog.mockResolvedValue({ providers: [codex], models: [], custom: [] });
    mocks.providerLoginStart.mockResolvedValue({ host: "alinery+ssh://host/srv/project", status: status({}) });
    for (const poll of polls) mocks.providerLoginPoll.mockResolvedValueOnce(poll);
    mocks.providerLoginPoll.mockResolvedValue(polls[polls.length - 1]);
    mocks.openUrl.mockResolvedValue(undefined);
    render(<ProviderSetupDialog mode="manual" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /OpenAI Codex/ }));
    await waitFor(() => expect(mocks.providerLoginStart).toHaveBeenCalledWith("openai-codex", "oauth"));
  }

  it("shows a device code with a copy control while the sign-in waits, and drops it when it ends", async () => {
    const device = { type: "device_code" as const, userCode: "ABCD-EFGH", verificationUri: "https://auth.openai.com/codex/device" };
    await startLogin([status({ events: [device] }), status({ events: [device] })]);
    expect(await screen.findByText(/ABCD-EFGH/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(mocks.providerLoginPoll).toHaveBeenCalledWith("l1", "alinery+ssh://host/srv/project");

    mocks.providerCatalog.mockResolvedValue({ providers: [{ ...codex, authenticated: true }], models: [], custom: [] });
    mocks.providerLoginPoll.mockResolvedValue(status({ status: "done", events: [device] }));
    await waitFor(() => expect(screen.queryByText(/ABCD-EFGH/)).toBeNull());
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
    expect(await screen.findByRole("button", { name: /OpenAI Codex.*Signed in/ })).toBeTruthy();
  });

  it("keeps a sign-in link's instructions after the browser opens, with Copy code on a trailing code", async () => {
    const link = { type: "auth_url" as const, url: "https://auth.openai.com/codex/device", instructions: "Enter code: ABCD-EFGH" };
    await startLogin([status({ events: [link] })]);
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("https://auth.openai.com/codex/device"));
    expect(screen.getByText(/ABCD-EFGH/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();

    mocks.providerLoginPoll.mockResolvedValue(status({ status: "error", failure: "Device authorization timed out", events: [link] }));
    await waitFor(() => expect(screen.queryByText(/ABCD-EFGH/)).toBeNull());
    expect(screen.getByText(/Device authorization timed out/)).toBeTruthy();
  });

  it("removes the unused manual-code prompt when browser sign-in succeeds", async () => {
    const link = { type: "auth_url" as const, url: "https://auth.openai.com/authorize" };
    const title = "Paste the authorization code (or full redirect URL):";
    await startLogin([status({ status: "prompt", events: [link], prompt: { type: "text", message: title } })]);
    expect(await screen.findByRole("textbox", { name: title })).toBeTruthy();

    mocks.providerCatalog.mockResolvedValue({ providers: [{ ...codex, authenticated: true }], models: [], custom: [] });
    mocks.providerLoginPoll.mockResolvedValue(status({ status: "done", events: [link] }));
    const provider = await screen.findByRole("button", { name: /OpenAI Codex.*Signed in/ });
    expect((provider as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("textbox", { name: title })).toBeNull();
    expect(mocks.providerLoginReply).not.toHaveBeenCalled();
  });
});
