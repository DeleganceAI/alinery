import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { HostedCatalogView } from "../types";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

const mocks = vi.hoisted(() => ({
  ompSetupSession: vi.fn(),
  rpcAttachSession: vi.fn(),
  rpcWriteSession: vi.fn(),
  readOmpModelRoles: vi.fn(),
  readModelFavorites: vi.fn(),
  hostedCatalog: vi.fn(),
  grokKeyReady: vi.fn(),
  accountSignIn: vi.fn(),
  accountRefresh: vi.fn(),
}));
vi.mock("../ipc", () => mockIpc(mocks));

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
  mocks.readOmpModelRoles.mockResolvedValue({});
  mocks.readModelFavorites.mockResolvedValue([]);
  mocks.hostedCatalog.mockResolvedValue(hosted);
  mocks.grokKeyReady.mockResolvedValue(grok);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderSetupDialog", () => {
  it("lists hosted models without opening an OMP session", async () => {
    settleIpc(readyHosted);
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /^alinery\/Qwen3\.6-35B-A3B/ })).toBeTruthy();
    expect(screen.queryByText(/OMP process sessions are not available/)).toBeNull();
    expect(mocks.ompSetupSession).not.toHaveBeenCalled();
    expect(mocks.rpcAttachSession).not.toHaveBeenCalled();
    expect(mocks.rpcWriteSession).not.toHaveBeenCalled();
  });

  it("adds Grok models when a key is saved", async () => {
    settleIpc(readyHosted, true);
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "xai/grok-4.7" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^alinery\/Qwen3\.6-35B-A3B/ })).toBeTruthy();
  });

  it("shows Connecting… until the hosted catalog returns", async () => {
    let resolveHosted: (view: HostedCatalogView) => void = () => undefined;
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.readModelFavorites.mockResolvedValue([]);
    mocks.grokKeyReady.mockResolvedValue(false);
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
    expect(await screen.findByText("alinery/Qwen3.6-35B-A3B")).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("closes an automatic offer once the catalog has loaded and no OMP login is required", async () => {
    settleIpc(readyHosted);
    const onClose = vi.fn();
    render(<ProviderSetupDialog mode="auto" onClose={onClose} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("not-needed"));
    expect(mocks.ompSetupSession).not.toHaveBeenCalled();
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
