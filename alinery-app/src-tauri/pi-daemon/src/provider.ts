import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProvider } from "@earendil-works/pi-ai/models";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

type CatalogModel = { id: string; name: string; context_window: number; max_tokens: number };
type InferenceFile = { token: string; expires_at: number; catalog: { base_url: string; models: CatalogModel[] } };

export function pairingConfigDir(appConfig: string): string {
  const dir = dirname(appConfig);
  const parent = dirname(dir);
  return parent.endsWith("/instances") || parent.endsWith("\\instances") ? dirname(parent) : dir;
}

export function readInference(appConfig: string): InferenceFile | null {
  try {
    return JSON.parse(readFileSync(join(pairingConfigDir(appConfig), "inference.json"), "utf8")) as InferenceFile;
  } catch {
    return null;
  }
}

export function modelSources(appConfig: string): { hosted: boolean; grok: boolean } {
  const inference = readInference(appConfig);
  return { hosted: Boolean(inference?.token && inference.catalog?.models?.length), grok: Boolean(process.env.XAI_API_KEY?.trim()) };
}

let compatRetry = false;

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export function installAlineryProvider(models: { setProvider: (provider: unknown) => void; refresh?: (options?: { providers?: string[] }) => Promise<unknown> }, appConfig: string) {
  const grok = xaiProvider();
  const hostedApi = openAIResponsesApi();
  const catalog = () => {
    const inference = readInference(appConfig);
    const hosted = (inference?.catalog.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      api: "openai-responses",
      provider: "alinery",
      baseUrl: inference?.catalog.base_url,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
    }));
    const grokModels = grok.getModels().map((model) => ({ ...model, provider: "alinery" }));
    return [...hosted, ...grokModels];
  };
  const streamWith = (method: "stream" | "streamSimple", model: { id: string; api?: string }, context: unknown, options: Record<string, unknown> | undefined) => {
    const inference = readInference(appConfig);
    const hosted = inference?.catalog.models.some((item) => item.id === model.id);
    if (!hosted) {
      if (!process.env.XAI_API_KEY?.trim()) throw new Error(`model ${model.id} is unavailable`);
      return grok[method]({ ...model, provider: "xai" }, context, options);
    }
    if (!inference?.token) throw new Error(`model ${model.id} is unavailable`);
    const hostedModel = { ...model, baseUrl: inference.catalog.base_url };
    const stream = hostedApi[method](hostedModel, context, { ...options, apiKey: inference.token, compat: compatRetry });
    return {
      ...stream,
      async *[Symbol.asyncIterator]() {
        try {
          yield* stream;
        } catch (error) {
          const status = httpStatus(error);
          if (status === 400 && !compatRetry) {
            compatRetry = true;
            yield* hostedApi[method](hostedModel, context, {
              ...options,
              apiKey: inference.token,
              store: false,
              developerRole: true,
              maxCompletionTokens: true,
            });
            return;
          }
          throw error;
        }
      },
    };
  };
  // pi-ai 1.3.0 ignores a top-level stream and requires api.stream (or an api map).
  const provider = createProvider({
    id: "alinery",
    name: "Alinery",
    auth: {
      apiKey: {
        name: "Alinery hosted",
        resolve: () => {
          const inference = readInference(appConfig);
          const grokReady = Boolean(process.env.XAI_API_KEY?.trim());
          if (!inference?.token && !grokReady) return undefined;
          return { type: "apiKey", key: inference?.token ?? "xai" };
        },
      },
    },
    models: [],
    fetchModels: async () => catalog(),
    api: {
      stream: (model, context, options) => streamWith("stream", model, context, options),
      streamSimple: (model, context, options) => streamWith("streamSimple", model, context, options),
    },
  });
  // createProvider's getModels is the baseline snapshot. Re-read inference.json on each lookup.
  provider.getModels = catalog;
  provider.getAllModels = catalog;
  models.setProvider(provider);
}
