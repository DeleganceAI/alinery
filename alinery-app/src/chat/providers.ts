import type { ChatModelOption } from "../chatTranscript";
import type { HostedCatalogView } from "../types";

/** Product provider for Alinery-hosted models. Not an OMP login row. */
export const HOSTED_PROVIDER = "alinery";

/** xAI chat models the daemon can launch when a Grok key is saved. Same ids as pi-ai's xAI catalog. */
export const GROK_MODELS = ["grok-4.3", "grok-4.5", "grok-4.6", "grok-4.7"];

/** A provider the Accounts tab can sign in to. `available` is retained from the old login row. */
export type LoginProvider = {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
  /** Present when a credential is stored. An injected or ambient login has no sign-out. */
  stored?: boolean;
  apiKey?: boolean;
  oauth?: boolean;
  apiKeyName?: string;
  oauthName?: string;
};

export type ProviderCatalog = {
  providers: Array<{
    id: string;
    name: string;
    authenticated: boolean;
    stored: boolean;
    apiKey: boolean;
    oauth: boolean;
    apiKeyName: string;
    oauthName: string;
  }>;
  models: Array<{ provider: string; id: string }>;
  custom: Array<{ id: string; name: string; baseUrl: string; hasKey: boolean; models: string[] }>;
};

export type ProviderLoginStatus = {
  loginId: string;
  status: string;
  prompt?: {
    type: string;
    message: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
  };
  events: Array<
    | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
    | { type: "auth_url"; url: string; instructions?: string }
    | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
    | { type: "progress"; message: string }
  >;
  failure: string;
};

export function loginProvidersFromCatalog(catalog: ProviderCatalog | null): LoginProvider[] {
  return (catalog?.providers ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    available: true,
    authenticated: provider.authenticated,
    stored: provider.stored,
    apiKey: provider.apiKey,
    oauth: provider.oauth,
    apiKeyName: provider.apiKeyName,
    oauthName: provider.oauthName,
  }));
}

export const INTERACTIVE_PROMPT_ERROR = /requires interactive prompts which are not supported in RPC mode/i;

export type AdvancedProviderRow = {
  id: string;
  name: string;
  reason: "env" | "live-promote";
  /** Models already listed for this provider → env looks ready. */
  readyViaEnv?: boolean;
};

/**
 * Does this session need the accounts dialog before it can do anything?
 *
 * Login is only one of the two ways OMP gets credentials: a provider configured by env var or
 * `config.yml` never appears in `get_login_providers` at all, it just shows up in the model list.
 * Judging setup on login rows alone therefore nags people who are perfectly well authenticated.
 *
 * The env test is deliberately the same one `partitionProviders` uses — models present *and no
 * login row* — rather than "this provider has models". OMP caches a static model catalogue per
 * provider whether or not it holds a credential (`models.db`), so for a provider that does have a
 * login row, models say nothing about auth and only `authenticated` does.
 */
export function needsProviderSetup(providers: LoginProvider[], currentModel?: string, models: ChatModelOption[] = [], hostedReady = false): boolean {
  if (hostedReady) return false;
  if (providers.length === 0) return false;
  const loginIds = new Set(providers.map((p) => p.id));
  const envReady = models.some((m) => !loginIds.has(m.provider));
  if (!providers.some((p) => p.authenticated) && !envReady) return true;
  if (!currentModel) return false;
  const slash = currentModel.indexOf("/");
  if (slash <= 0) return false;
  const providerId = currentModel.slice(0, slash);
  const row = providers.find((p) => p.id === providerId);
  return row !== undefined && row.authenticated === false;
}

/** Partition login-list vs Advanced (env-only / documented incompatible / live-promoted). */
export function partitionProviders(input: { loginProviders: LoginProvider[]; models: ChatModelOption[]; livePromotedIds?: Iterable<string>; configuredIds?: Iterable<string> }): {
  chatLogin: LoginProvider[];
  advanced: AdvancedProviderRow[];
} {
  const loginIds = new Set(input.loginProviders.map((p) => p.id));
  const configured = new Set(input.configuredIds ?? []);
  const modelProviders = new Map<string, number>();
  for (const m of input.models) {
    modelProviders.set(m.provider, (modelProviders.get(m.provider) ?? 0) + 1);
  }

  const advanced = new Map<string, AdvancedProviderRow>();

  for (const [id, count] of modelProviders) {
    if (id === HOSTED_PROVIDER) continue;
    if (loginIds.has(id) || configured.has(id)) continue;
    advanced.set(id, {
      id,
      name: id,
      reason: "env",
      readyViaEnv: count > 0,
    });
  }

  for (const id of input.livePromotedIds ?? []) {
    if (!id) continue;
    const fromLogin = input.loginProviders.find((p) => p.id === id);
    advanced.set(id, {
      id,
      name: fromLogin?.name || id,
      reason: "live-promote",
    });
  }

  const chatLogin = input.loginProviders.filter((p) => p.id !== HOSTED_PROVIDER && !advanced.has(p.id));
  const advancedList = [...advanced.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { chatLogin, advanced: advancedList };
}

/** Append xAI rows when Settings has a Grok key. Absent from the hosted catalog and from OMP's model list. */
export function mergeGrokModels(models: ChatModelOption[], enabled: boolean): ChatModelOption[] {
  if (!enabled) return models;
  const seen = new Set(models.map((model) => `${model.provider}/${model.id}`));
  const extra = GROK_MODELS.filter((id) => !seen.has(`xai/${id}`)).map((id) => ({ provider: "xai", id }));
  return extra.length > 0 ? [...models, ...extra] : models;
}

/** Catalog rows first; drop OMP duplicates of the same `alinery/<id>`. */
export function mergeHostedModels(models: ChatModelOption[], hosted: HostedCatalogView | null | undefined): ChatModelOption[] {
  if (!hosted) return models;
  const hostedRows = hosted.models.map((m) => ({ provider: HOSTED_PROVIDER, id: m.id }));
  const seen = new Set(hostedRows.map((m) => `${m.provider}/${m.id}`));
  return [...hostedRows, ...models.filter((m) => !seen.has(`${m.provider}/${m.id}`))];
}

export function hostedPrice(hosted: HostedCatalogView | null | undefined, provider: string, id: string): number | undefined {
  if (provider !== HOSTED_PROVIDER || !hosted) return undefined;
  const row = hosted.models.find((m) => m.id === id);
  return row?.price ?? undefined;
}

export function isInteractivePromptLoginError(error: string | undefined | null): boolean {
  return typeof error === "string" && INTERACTIVE_PROMPT_ERROR.test(error);
}

export type SetupOfferInput = {
  /** RPC is attached and answering — without it `providers` is stale or absent. */
  connected: boolean;
  /** A dialog is already up, or setup was already offered on this mount. */
  suppressed: boolean;
  /** A turn is open in the transcript, or the daemon reports the agent busy. */
  busy: boolean;
  providers: LoginProvider[];
  models: ChatModelOption[];
  currentModel?: string;
  /** Paid + minted hosted models count as set up. Do not nag Anthropic. */
  hostedReady?: boolean;
};

/**
 * Should we raise the accounts dialog unprompted?
 *
 * Split out from the effect that used to own it so both callers agree: the in-session offer and
 * the repo-open check answer the same question from the same inputs, and neither can drift into
 * nagging a session the other would leave alone. `busy` defers rather than cancels — the caller
 * re-runs this when the turn closes.
 */
export function shouldOfferProviderSetup(input: SetupOfferInput): boolean {
  if (!input.connected || input.suppressed || input.busy) return false;
  if (input.providers.length === 0) return false;
  return needsProviderSetup(input.providers, input.currentModel, input.models, input.hostedReady === true);
}
