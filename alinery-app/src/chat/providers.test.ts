import { describe, expect, it } from "vitest";
import { isInteractivePromptLoginError, type LoginProvider, needsProviderSetup, partitionProviders, shouldOfferProviderSetup } from "./providers";

const providers = (rows: Partial<LoginProvider>[]): LoginProvider[] =>
  rows.map((r, i) => ({
    id: r.id ?? `p${i}`,
    name: r.name ?? r.id ?? `P${i}`,
    available: r.available ?? true,
    authenticated: r.authenticated ?? false,
  }));

const models = (...ids: string[]) => ids.map((provider) => ({ provider, id: `${provider}-model` }));

describe("needsProviderSetup", () => {
  it("is false with an empty provider list (still loading)", () => {
    expect(needsProviderSetup([])).toBe(false);
  });

  it("is true when nothing is authenticated", () => {
    expect(needsProviderSetup(providers([{ id: "anthropic", authenticated: false }]))).toBe(true);
  });

  it("is true when the current model provider is listed and unauthenticated", () => {
    expect(
      needsProviderSetup(
        providers([
          { id: "anthropic", authenticated: true },
          { id: "openai", authenticated: false },
        ]),
        "openai/gpt-4",
      ),
    ).toBe(true);
  });

  it("is false when some provider is authenticated and the current one is ok or unknown", () => {
    expect(needsProviderSetup(providers([{ id: "anthropic", authenticated: true }]), "anthropic/claude")).toBe(false);
    expect(needsProviderSetup(providers([{ id: "anthropic", authenticated: true }]), "mystery/x")).toBe(false);
  });

  it("is false when auth comes from env rather than login", () => {
    // `openai-compatible` has models but no login row: env- or config-backed, and usable.
    expect(needsProviderSetup(providers([{ id: "anthropic", authenticated: false }]), undefined, models("openai-compatible"))).toBe(false);
  });

  it("still asks for setup when the only models belong to an unauthenticated login provider", () => {
    // OMP caches a model catalogue per provider whether or not it holds a credential, so models
    // on a provider that *does* have a login row prove nothing.
    expect(needsProviderSetup(providers([{ id: "anthropic", authenticated: false }]), undefined, models("anthropic"))).toBe(true);
  });
});

describe("shouldOfferProviderSetup", () => {
  const base = {
    connected: true,
    suppressed: false,
    busy: false,
    providers: providers([{ id: "anthropic", authenticated: false }]),
    models: [],
    currentModel: undefined,
  };

  it("offers setup on an idle connected session with nothing authenticated", () => {
    expect(shouldOfferProviderSetup(base)).toBe(true);
  });

  it("defers while a turn is in flight", () => {
    expect(shouldOfferProviderSetup({ ...base, busy: true })).toBe(false);
  });

  it("stays quiet when not connected, already suppressed, or still loading providers", () => {
    expect(shouldOfferProviderSetup({ ...base, connected: false })).toBe(false);
    expect(shouldOfferProviderSetup({ ...base, suppressed: true })).toBe(false);
    expect(shouldOfferProviderSetup({ ...base, providers: [] })).toBe(false);
  });
});

describe("partitionProviders", () => {
  it("puts env-only model providers in Advanced", () => {
    const { chatLogin, advanced } = partitionProviders({
      loginProviders: providers([{ id: "anthropic", authenticated: true }]),
      models: [
        { provider: "anthropic", id: "claude" },
        { provider: "openrouter", id: "auto" },
      ],
    });
    expect(chatLogin.map((p) => p.id)).toEqual(["anthropic"]);
    expect(advanced).toEqual([expect.objectContaining({ id: "openrouter", reason: "env", readyViaEnv: true })]);
  });

  it("moves documented RPC-incompatible login rows to Advanced", () => {
    const { chatLogin, advanced } = partitionProviders({
      loginProviders: providers([
        { id: "anthropic", name: "Anthropic" },
        { id: "baseten", name: "Baseten" },
      ]),
      models: [],
    });
    expect(chatLogin.map((p) => p.id)).toEqual(["anthropic"]);
    expect(advanced).toEqual([expect.objectContaining({ id: "baseten", reason: "rpc-incompatible" })]);
  });

  it("promotes live interactive-prompt failures into Advanced", () => {
    const { advanced } = partitionProviders({
      loginProviders: providers([{ id: "weird", name: "Weird" }]),
      models: [],
      livePromotedIds: ["weird"],
    });
    expect(advanced).toEqual([expect.objectContaining({ id: "weird", reason: "live-promote" })]);
  });
});

describe("isInteractivePromptLoginError", () => {
  it("matches the OMP RPC rejection sentence", () => {
    expect(isInteractivePromptLoginError("Provider requires interactive prompts which are not supported in RPC mode. Use the terminal UI to log in.")).toBe(true);
    expect(isInteractivePromptLoginError("nope")).toBe(false);
  });
});
