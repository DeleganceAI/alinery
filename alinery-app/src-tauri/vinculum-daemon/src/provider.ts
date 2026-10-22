import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
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

export type ResolvedModel = { provider: string; modelId: string };

/**
 * A blank session model is not a model. Chats and auxiliary sessions are created that way when settings have no default.
 * `alinery/grok-*` stays on disk and is read as xAI. The provider prefix is otherwise kept, and only the first slash splits it.
 */
export function resolveModel(appConfig: string, requested: string): ResolvedModel | null {
  const trimmed = requested.trim();
  const slash = trimmed.indexOf("/");
  const prefix = slash > 0 ? trimmed.slice(0, slash) : "";
  const id = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
  const grok = new Set(xaiProvider().getModels().map((model) => model.id));
  if (id && grok.has(id) && (prefix === "" || prefix === "alinery" || prefix === "xai")) return { provider: "xai", modelId: id };
  if (prefix && id) return { provider: prefix, modelId: id };
  if (id) return { provider: "alinery", modelId: id };
  const hosted = readInference(appConfig)?.catalog.models ?? [];
  const preferred = hosted.find((model) => model.id === "DeepSeek-V4.1-Flash") ?? hosted[0];
  if (preferred?.id) return { provider: "alinery", modelId: preferred.id };
  const fallback = xaiProvider().getModels()[0]?.id;
  return fallback ? { provider: "xai", modelId: fallback } : null;
}

export function installAlineryProvider(models: Pick<MutableModels, "setProvider">, appConfig: string) {
  // The hosted catalog is openai-completions. /v1/responses is not served and comes back 404.
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
    return hosted;
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
  const hostedApi = openAICompletionsApi();
  const inference = readInference(appConfig);
  const hosted = inference?.catalog.models.some((item) => item.id === model.id);
  if (!hosted || !inference?.token) throw new Error(`model ${model.id} is unavailable`);
  const hostedModel = { ...model, api: "openai-completions", baseUrl: inference.catalog.base_url };
  return hostedApi[method](hostedModel, context, { ...options, apiKey: inference.token });
}

/** One tools-off reply through whichever provider owns the model. The caller does not write it into a conversation. */
export async function completeConfiguredText(models: Pick<MutableModels, "getModel" | "completeSimple">, appConfig: string, requested: string, messages: Context["messages"]): Promise<string> {
  const resolved = resolveModel(appConfig, requested);
  if (!resolved) throw new Error("no model is configured");
  const model = models.getModel(resolved.provider, resolved.modelId);
  if (!model) throw new Error(`model ${resolved.provider}/${resolved.modelId} is unavailable`);
  const result = await models.completeSimple(model, normalizeContext({ messages }));
  if (result.stopReason === "error" || result.errorMessage) throw new Error(result.errorMessage || "title request failed");
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
