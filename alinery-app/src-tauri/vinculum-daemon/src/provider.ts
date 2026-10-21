import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

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

/** A blank session model is not a model. Chats and auxiliary sessions are created that way when settings have no default. */
export function resolveModelId(appConfig: string, requested: string): string {
  const explicit = requested.trim().replace(/^(?:alinery|xai)\//, "");
  if (explicit) return explicit;
  const hosted = readInference(appConfig)?.catalog.models ?? [];
  const preferred = hosted.find((model) => model.id === "DeepSeek-V4.1-Flash") ?? hosted[0];
  if (preferred?.id) return preferred.id;
  return xaiProvider().getModels()[0]?.id ?? "";
}

export function installAlineryProvider(models: { setProvider: (provider: unknown) => void; refresh?: (options?: { providers?: string[] }) => Promise<unknown> }, appConfig: string) {
  const grok = xaiProvider();
  // The hosted catalog is openai-completions. /v1/responses is not served and comes back 404.
  const hostedApi = openAICompletionsApi();
  const catalog = () => {
    const inference = readInference(appConfig);
    const hosted = (inference?.catalog.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      api: "openai-completions",
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
  const streamWith = (method: "stream" | "streamSimple", model: { id: string; api?: string }, context: unknown, options: Record<string, unknown> | undefined) =>
    streamAlinery(appConfig, method, model, context, options);
  // pi-ai 1.3.0 ignores a top-level stream and requires api.stream (or an api map).
  const provider = createProvider({
    id: "alinery",
    name: "Alinery",
    auth: {
      apiKey: {
        name: "Alinery hosted",
        // Models.applyAuth reads resolution.auth. A credential-shaped return leaves auth undefined and throws on auth.apiKey before any request.
        resolve: async ({ credential }) => {
          const explicit = credential?.key?.trim();
          if (explicit) return { auth: { apiKey: explicit }, source: "stored credential" };
          const inference = readInference(appConfig);
          if (inference?.token) return { auth: { apiKey: inference.token }, source: "alinery hosted" };
          const grokKey = process.env.XAI_API_KEY?.trim();
          if (grokKey) return { auth: { apiKey: grokKey }, source: "XAI_API_KEY" };
          return undefined;
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

type StreamMethod = "stream" | "streamSimple";

function streamAlinery(appConfig: string, method: StreamMethod, model: { id: string; api?: string; baseUrl?: string }, context: unknown, options: Record<string, unknown> | undefined) {
  const grok = xaiProvider();
  const hostedApi = openAICompletionsApi();
  const inference = readInference(appConfig);
  const hosted = inference?.catalog.models.some((item) => item.id === model.id);
  if (!hosted) {
    const key = process.env.XAI_API_KEY?.trim();
    if (!key) throw new Error(`model ${model.id} is unavailable`);
    return grok[method]({ ...model, provider: "xai" }, context, { ...options, apiKey: key });
  }
  if (!inference?.token) throw new Error(`model ${model.id} is unavailable`);
  const hostedModel = { ...model, api: "openai-completions", baseUrl: inference.catalog.base_url };
  return hostedApi[method](hostedModel, context, { ...options, apiKey: inference.token });
}

/** One tools-off reply. The caller does not write it into a conversation. */
export async function completeAlineryText(appConfig: string, requested: string, messages: Context["messages"]): Promise<string> {
  const modelId = resolveModelId(appConfig, requested);
  if (!modelId) throw new Error("no model is configured");
  const inference = readInference(appConfig);
  const hosted = inference?.catalog.models.find((model) => model.id === modelId);
  const model = hosted
    ? { id: hosted.id, api: "openai-completions", baseUrl: inference?.catalog.base_url }
    : { id: modelId, api: xaiProvider().getModels().find((item) => item.id === modelId)?.api };
  const stream = streamAlinery(appConfig, "streamSimple", model, normalizeContext({ messages }), undefined);
  const result = await stream.result();
  if (result.stopReason === "error" || result.errorMessage) throw new Error(result.errorMessage || "title request failed");
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
