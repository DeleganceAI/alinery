import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatModelBar, ComposerStats } from "./ChatModelBar";

const mocks = vi.hoisted(() => ({
  readModelFavorites: vi.fn(async () => [] as string[]),
  providerCatalog: vi.fn<() => Promise<unknown>>(async () => {
    throw new Error("no catalog");
  }),
}));
vi.mock("../ipc", () => ({ readModelFavorites: mocks.readModelFavorites, accountTeams: async () => ({ pots: [], pendingInvites: [] }) }));
// The catalog is the host daemon's ProviderService (sync/providers), not ipc.
vi.mock("../sync/providers", () => ({ providerCatalog: mocks.providerCatalog }));

function bar() {
  return (
    <ChatModelBar model="xai/grok-4.6" thinking="high" thinkingLevels={["high"]} disabledReason={null} onPickModel={() => {}} onPickThinking={() => {}} onProviders={() => {}} />
  );
}

describe("ChatModelBar", () => {
  afterEach(cleanup);

  it("reads the favorites again on every open, and drops the ones whose provider is gone", async () => {
    mocks.readModelFavorites.mockResolvedValue(["alinery/DeepSeek-V4.1-Flash", "phdeepinfra/DeepSeek-V4.1-Flash-1017", "xai/grok-4.6"]);
    mocks.providerCatalog.mockResolvedValue({
      providers: [{ id: "xai", name: "xAI", authenticated: true, stored: true, apiKey: true, oauth: false, apiKeyName: "", oauthName: "" }],
      models: [
        { provider: "alinery", id: "DeepSeek-V4.1-Flash" },
        { provider: "xai", id: "grok-4.6" },
      ],
      custom: [],
    });
    render(bar());
    fireEvent.click(screen.getByRole("button", { name: /xai\/grok-4\.6/ }));
    // The stale favorite (its endpoint was removed) leaves the dropup; the live ones stay.
    await waitFor(() => expect(screen.queryByRole("menuitemradio", { name: /phdeepinfra/ })).toBeNull());
    expect(screen.getByRole("menuitemradio", { name: /alinery\/DeepSeek-V4\.1-Flash/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /xai\/grok-4\.6/ })).toBeTruthy();
    expect(mocks.readModelFavorites).toHaveBeenCalledTimes(1);
    // Closing and opening reads them again.
    fireEvent.click(screen.getByRole("button", { name: /xai\/grok-4\.6/ }));
    fireEvent.click(screen.getByRole("button", { name: /xai\/grok-4\.6/ }));
    await waitFor(() => expect(mocks.readModelFavorites).toHaveBeenCalledTimes(2));
  });

  it("keeps every favorite when the catalog does not answer", async () => {
    mocks.readModelFavorites.mockResolvedValue(["gone/model"]);
    mocks.providerCatalog.mockRejectedValue(new Error("daemon down"));
    render(bar());
    fireEvent.click(screen.getByRole("button", { name: /xai\/grok-4\.6/ }));
    expect(await screen.findByRole("menuitemradio", { name: "gone/model" })).toBeTruthy();
  });
});

describe("ComposerStats", () => {
  it("shows used/limit ctx with a meter, and the used count alone when the provider sends no limit", () => {
    const { container, rerender } = render(<ComposerStats usage={{ tokens: 20_000, contextWindow: 120_000 }} events={43} />);
    expect(container.textContent).toBe("20k/120k ctx43 events");
    expect(container.querySelector("meter")?.getAttribute("value")).toBe("20000");
    rerender(<ComposerStats usage={{ tokens: 1_500, contextWindow: 0 }} events={1} />);
    expect(container.textContent).toBe("1.5k/? ctx1 event");
    expect(container.querySelector("meter")).toBeNull();
  });
});
