import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

type Models = Pick<MutableModels, "setProvider" | "deleteProvider">;

export type CustomProvider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
};

export type CustomProviderPublic = {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: string[];
};

export function customProviderPath(appConfig: string): string {
  return join(dirname(appConfig), "custom-providers.json");
}

export function openCustomProviders(path: string) {
  let rows = readRows(path);

  const persist = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(rows), { mode: 0o600 });
    chmodSync(path, 0o600);
  };

  return {
    list(): CustomProvider[] {
      return rows.map((row) => ({ ...row, models: [...row.models] }));
    },
    publicList(): CustomProviderPublic[] {
      return rows.map((row) => ({ id: row.id, name: row.name, baseUrl: row.baseUrl, hasKey: Boolean(row.apiKey), models: [...row.models] }));
    },
    register(models: Models) {
      for (const row of rows) models.setProvider(providerFor(row));
    },
    save(input: CustomProvider & { clearKey?: boolean }, taken: ReadonlySet<string>): CustomProvider {
      const next = validateCustom(input, taken, rows);
      rows = [...rows.filter((row) => row.id !== next.id), next];
      persist();
      return { ...next, models: [...next.models] };
    },
    remove(id: string, models: Models) {
      rows = rows.filter((row) => row.id !== id);
      models.deleteProvider(id);
      persist();
    },
  };
}

export function validateCustom(input: CustomProvider & { clearKey?: boolean }, taken: ReadonlySet<string>, existing: readonly CustomProvider[] = []): CustomProvider {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("endpoint id must be a short lowercase name");
  if (id === "alinery" || taken.has(id)) throw new Error(`${id} is already a provider`);
  const name = input.name.trim();
  if (!name || name.length > 60 || /[\u0000-\u001f]/.test(name)) throw new Error("endpoint name is missing or too long");
  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl.trim());
  } catch {
    throw new Error("endpoint URL must be http or https");
  }
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") throw new Error("endpoint URL must be http or https");
  if (baseUrl.username || baseUrl.password) throw new Error("put the API key in the key field, not the URL");
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
  if (models.length < 1 || models.length > 20) throw new Error("name between 1 and 20 model ids");
  if (models.some((model) => model.length > 128 || /[\s/]/.test(model))) throw new Error("a model id cannot contain spaces or slashes");
  const previous = existing.find((row) => row.id === id);
  const typed = input.apiKey?.trim();
  const apiKey = input.clearKey ? undefined : typed || previous?.apiKey;
  return { id, name, baseUrl: baseUrl.toString().replace(/\/$/, ""), apiKey: apiKey || undefined, models };
}

function providerFor(row: CustomProvider) {
  const models = () =>
    row.models.map((id) => ({
      id,
      name: id,
      api: "openai-completions",
      provider: row.id,
      baseUrl: row.baseUrl,
      reasoning: false,
      input: ["text"],
      // No discovery. Pi still requires a context cap; the endpoint enforces its own.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }));
  const provider = createProvider({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    auth: {
      apiKey: {
        name: `${row.name} API key`,
        resolve: async () => {
          const key = row.apiKey?.trim();
          if (key) return { auth: { apiKey: key }, source: "custom endpoint" };
          return { auth: {}, source: "no auth" };
        },
      },
    },
    models: [],
    api: openAICompletionsApi(),
  });
  provider.getModels = models;
  provider.getAllModels = models;
  return provider;
}

function readRows(path: string): CustomProvider[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is CustomProvider => Boolean(row && typeof row === "object" && typeof (row as CustomProvider).id === "string"));
  } catch {
    return [];
  }
}
