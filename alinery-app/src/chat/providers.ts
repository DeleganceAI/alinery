import type { ChatModelOption } from "../chatTranscript";

/** OMP `get_login_providers` row. */
export type LoginProvider = {
  id: string;
  name: string;
  available: boolean;
  authenticated: boolean;
};

/**
 * Login providers that need `onPrompt` before `open_url` — RPC rejects them.
 * Best-effort snapshot from OMP `docs/providers.md`; drift is expected.
 */
export const RPC_INCOMPATIBLE_LOGIN_IDS = new Set(["baseten", "coreweave", "sakana", "cloudflare-ai-gateway"]);

export const INTERACTIVE_PROMPT_ERROR = /requires interactive prompts which are not supported in RPC mode/i;

export type AdvancedProviderRow = {
  id: string;
  name: string;
  reason: "env" | "rpc-incompatible" | "live-promote";
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
export function needsProviderSetup(providers: LoginProvider[], currentModel?: string, models: ChatModelOption[] = []): boolean {
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
export function partitionProviders(input: { loginProviders: LoginProvider[]; models: ChatModelOption[]; livePromotedIds?: Iterable<string> }): {
  chatLogin: LoginProvider[];
  advanced: AdvancedProviderRow[];
} {
  const loginIds = new Set(input.loginProviders.map((p) => p.id));
  const modelProviders = new Map<string, number>();
  for (const m of input.models) {
    modelProviders.set(m.provider, (modelProviders.get(m.provider) ?? 0) + 1);
  }

  const advanced = new Map<string, AdvancedProviderRow>();

  for (const [id, count] of modelProviders) {
    if (loginIds.has(id)) continue;
    advanced.set(id, {
      id,
      name: id,
      reason: "env",
      readyViaEnv: count > 0,
    });
  }

  for (const p of input.loginProviders) {
    if (!RPC_INCOMPATIBLE_LOGIN_IDS.has(p.id)) continue;
    advanced.set(p.id, {
      id: p.id,
      name: p.name || p.id,
      reason: "rpc-incompatible",
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

  const chatLogin = input.loginProviders.filter((p) => !advanced.has(p.id));
  const advancedList = [...advanced.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { chatLogin, advanced: advancedList };
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
  return needsProviderSetup(input.providers, input.currentModel, input.models);
}
