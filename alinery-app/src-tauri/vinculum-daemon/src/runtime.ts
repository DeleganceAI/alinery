import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CreateModelsOptions, MutableModels } from "@earendil-works/pi-ai/models";
import { credentialPath, openCredentialStore } from "./credentials.ts";
import { customProviderPath, openCustomProviders, type CustomProviderPublic } from "./customProviders.ts";
import { createLoginBroker, type LoginStatus } from "./login.ts";
import { installAlineryProvider } from "./provider.ts";

export type LoginProviderRow = {
  id: string;
  name: string;
  authenticated: boolean;
  /** A credential file entry. Env and ambient files can authenticate without one, and those cannot be signed out here. */
  stored: boolean;
  apiKey: boolean;
  oauth: boolean;
  apiKeyName: string;
  oauthName: string;
};

export type ProviderCatalog = {
  providers: LoginProviderRow[];
  models: { provider: string; id: string }[];
  custom: CustomProviderPublic[];
};

type AuthContext = NonNullable<CreateModelsOptions["authContext"]>;

/** Pi reads provider keys through this, not `process.env`. Only the Grok key the app injected is visible. */
export function vinculumAuthContext(): AuthContext {
  return {
    async env(name) {
      if (name !== "XAI_API_KEY") return undefined;
      const value = process.env.XAI_API_KEY?.trim();
      return value || undefined;
    },
    async fileExists(path) {
      const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
      try {
        return existsSync(expanded);
      } catch {
        return false;
      }
    },
  };
}

function deviceId(appConfig: string): string {
  const path = join(dirname(appConfig), "provider-device-id");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first login creates it */
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, id, { mode: 0o600 });
  chmodSync(path, 0o600);
  return id;
}

export function openProviderRuntime(appConfig: string) {
  const credentials = openCredentialStore(credentialPath(appConfig));
  const models = builtinModels({ credentials, authContext: vinculumAuthContext() });
  installAlineryProvider(models, appConfig);
  const custom = openCustomProviders(customProviderPath(appConfig));
  custom.register(models);
  const login = createLoginBroker(models, { agentName: "Alinery", getDeviceId: () => deviceId(appConfig) });

  const catalog = () => providerCatalog(models, credentials, custom.publicList());

  return {
    models,
    catalog,
    startLogin(provider: string, method: "api_key" | "oauth"): LoginStatus {
      return login.start(provider, method);
    },
    pollLogin(loginId: string): LoginStatus {
      return login.poll(loginId);
    },
    replyLogin(loginId: string, value: string) {
      login.reply(loginId, value);
    },
    cancelLogin(loginId: string) {
      login.cancel(loginId);
    },
    async logout(provider: string): Promise<ProviderCatalog> {
      await models.logout(provider);
      return catalog();
    },
    async saveCustom(input: { id: string; name: string; baseUrl: string; apiKey?: string; clearKey?: boolean; models: string[] }): Promise<ProviderCatalog> {
      const own = new Set(custom.list().map((row) => row.id));
      const taken = new Set(models.getProviders().map((provider) => provider.id).filter((id) => !own.has(id)));
      custom.save(input, taken);
      custom.register(models);
      return catalog();
    },
    async deleteCustom(id: string): Promise<ProviderCatalog> {
      custom.remove(id, models);
      return catalog();
    },
  };
}

export async function providerCatalog(
  models: MutableModels,
  credentials: NonNullable<CreateModelsOptions["credentials"]>,
  custom: CustomProviderPublic[],
): Promise<ProviderCatalog> {
  const stored = new Set((await credentials.list()).map((row) => row.providerId));
  const providers: LoginProviderRow[] = [];
  await Promise.all(
    models.getProviders().map(async (provider) => {
      if (provider.id === "alinery") return;
      const apiKey = Boolean(provider.auth.apiKey?.login);
      const oauth = Boolean(provider.auth.oauth?.login);
      if (!apiKey && !oauth) return;
      let authenticated = stored.has(provider.id);
      if (!authenticated) {
        try {
          authenticated = Boolean(await models.checkAuth(provider.id));
        } catch {
          authenticated = false;
        }
      }
      providers.push({
        id: provider.id,
        name: provider.name,
        authenticated,
        stored: stored.has(provider.id),
        apiKey,
        oauth,
        apiKeyName: provider.auth.apiKey?.name ?? "",
        oauthName: provider.auth.oauth?.name ?? "",
      });
    }),
  );
  providers.sort((a, b) => a.name.localeCompare(b.name));
  const available = await models.getAvailable();
  return {
    providers,
    models: available.map((model) => ({ provider: model.provider, id: model.id })),
    custom,
  };
}
