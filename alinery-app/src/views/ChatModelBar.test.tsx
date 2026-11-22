import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { ChatModelBar, ComposerStats } from "./ChatModelBar";

const mocks = vi.hoisted(() => ({ readModelFavorites: vi.fn(), providerCatalog: vi.fn() }));
vi.mock("../ipc", () => mockIpc({ readModelFavorites: mocks.readModelFavorites }));
// The catalog is the host daemon's ProviderService (sync/providers), not ipc.
vi.mock("../sync/providers", () => ({ providerCatalog: mocks.providerCatalog }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatModelBar", () => {
  const bar = (onPickModel = vi.fn(), model = "xai/grok-4.6") => (
    <ChatModelBar
      model={model}
      repoPath="/Users/me/project"
      thinking="high"
      thinkingLevels={["high"]}
      disabledReason={null}
      onPickModel={onPickModel}
      onPickThinking={vi.fn()}
      onProviders={vi.fn()}
    />
  );

  it("reads the favorites again on every open, and drops the ones whose provider is gone", async () => {
    mocks.readModelFavorites.mockResolvedValue(["alinerey/DeepSeek-V4.1-Flash", "phdeepinfra/DeepSeek-V4.1-Flash-1017", "xai/grok-4.6"]);
    mocks.providerCatalog.mockResolvedValue({
      providers: [{ id: "xai", name: "xAI", authenticated: true, stored: true, apiKey: true, oauth: false, apiKeyName: "", oauthName: "" }],
      models: [
        { provider: "alinerey", id: "DeepSeek-V4.1-Flash" },
        { provider: "xai", id: "grok-4.6" },
      ],
      custom: [],
    });
    render(bar());
    fireEvent.click(screen.getByRole("button", { name: /xai\/grok-4\.6/ }));
    // The stale favorite (its endpoint was removed) leaves the dropup; the live ones stay.
    await waitFor(() => expect(screen.queryByRole("menuitemradio", { name: /phdeepinfra/ })).toBeNull());
    expect(screen.getByRole("menuitemradio", { name: /alinerey\/DeepSeek-V4\.1-Flash/ })).toBeTruthy();
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

  it("will not offer a starred model this machine cannot run", async () => {
    mocks.readModelFavorites.mockResolvedValue(["openai/gpt-6.1-sol", "alinerey/GLM-5.3"]);
    // This machine knows the openai provider but is not signed into it, so its star survives the dead-favorite
    // filter and shows as unrunnable here. The star itself was made on the machine that is signed in.
    mocks.providerCatalog.mockResolvedValue({
      providers: [{ id: "openai", name: "OpenAI", authenticated: false, stored: false, apiKey: false, oauth: true, apiKeyName: "", oauthName: "" }],
      models: [{ provider: "alinerey", id: "GLM-5.3" }],
      custom: [],
    });
    const onPickModel = vi.fn();
    render(bar(onPickModel, "openai/gpt-6.1-sol"));
    fireEvent.click(screen.getByRole("button", { name: /openai\/gpt-6\.1-sol/ }));

    const elsewhere = await screen.findByRole("menuitemradio", { name: /openai\/gpt-6\.1-sol.*not signed in here/ });
    expect((elsewhere as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(elsewhere);
    expect(onPickModel).not.toHaveBeenCalled();

    const here = screen.getByRole("menuitemradio", { name: "alinerey/GLM-5.3" });
    expect((here as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(here);
    await waitFor(() => expect(onPickModel).toHaveBeenCalledWith("alinerey/GLM-5.3"));
  });

  it("lists every star when the daemon cannot say which models it runs", async () => {
    mocks.readModelFavorites.mockResolvedValue(["openai/gpt-6.1-sol"]);
    mocks.providerCatalog.mockRejectedValue(new Error("the daemon is not reachable"));
    const onPickModel = vi.fn();
    render(bar(onPickModel, "openai/gpt-6.1-sol"));
    fireEvent.click(screen.getByRole("button", { name: /openai\/gpt-6\.1-sol/ }));
    const row = await screen.findByRole("menuitemradio", { name: "openai/gpt-6.1-sol" });
    expect((row as HTMLButtonElement).disabled).toBe(false);
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
