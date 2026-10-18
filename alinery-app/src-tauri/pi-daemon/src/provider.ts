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

export function installAlineryProvider(models: { setProvider: (provider: unknown) => void }, appConfig: string) {
  const grok = xaiProvider();
  const hostedApi = openAIResponsesApi();
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
    getModels: () => {
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
    },
    stream: (model, context, options) => {
      const inference = readInference(appConfig);
      const hosted = inference?.catalog.models.some((item) => item.id === model.id);
      if (!hosted) {
        if (!process.env.XAI_API_KEY?.trim()) throw new Error(`model ${model.id} is unavailable`);
        return grok.stream({ ...model, provider: "xai" }, context, options);
      }
      if (!inference?.token) throw new Error(`model ${model.id} is unavailable`);
      const stream = hostedApi.stream({ ...model, baseUrl: inference.catalog.base_url }, context, { ...options, apiKey: inference.token, compat: compatRetry });
      return {
        ...stream,
        async *[Symbol.asyncIterator]() {
          try {
            yield* stream;
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 400 && !compatRetry) {
              compatRetry = true;
              yield* hostedApi.stream({ ...model, baseUrl: inference.catalog.base_url }, context, {
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
    },
  });
  models.setProvider(provider);
}
