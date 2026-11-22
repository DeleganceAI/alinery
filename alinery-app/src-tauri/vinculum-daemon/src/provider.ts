import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

type CatalogModel = {
  id: string;
  name: string;
  context_window: number;
  max_tokens: number;
  thinking?: { reasoning?: boolean; levels?: Record<string, string | null> };
  input?: unknown;
};

/** The catalog `input`, as Pi's: text always, image only when the catalog says so. Pi swaps an image for a placeholder on a text-only model. */
export function inputForHosted(input: CatalogModel["input"]): ("text" | "image")[] {
  return Array.isArray(input) && input.includes("image") ? ["text", "image"] : ["text"];
}

const HOSTED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * The catalog `thinking` object, as Pi's `reasoning` and `thinkingLevelMap`.
 * A string is the `reasoning_effort` to send. Null, a blank, or a missing key is not offered.
 * No object, or `reasoning` not exactly true, means this model does not think.
 */
export function thinkingForHosted(thinking: CatalogModel["thinking"]): { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> } {
  if (thinking?.reasoning !== true || !thinking.levels || typeof thinking.levels !== "object") return { reasoning: false };
  const thinkingLevelMap: Record<string, string | null> = {};
  for (const name of HOSTED_THINKING_LEVELS) {
    const value = thinking.levels[name];
    thinkingLevelMap[name] = typeof value === "string" && value.trim() ? value : null;
  }
  return { reasoning: true, thinkingLevelMap };
}
type InferenceFile = {
  token: string;
  expires_at: number;
  catalog: { base_url: string; models: CatalogModel[] };
  pots?: Record<string, { token: string; expires_at: number }>;
};

let installed: { models: Pick<MutableModels, "setProvider">; appConfig: string; registered: Set<string> } | null = null;

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
  const pot = Object.values(inference?.pots ?? {}).some((row) => row.token.startsWith("inf_"));
  return { hosted: Boolean((inference?.token || pot) && inference?.catalog?.models?.length), grok: Boolean(process.env.XAI_API_KEY?.trim()) };
}

export type ResolvedModel = { provider: string; modelId: string };

/**
 * A blank session model is not a model. Chats and auxiliary sessions are created that way when settings have no default.
 * `alinery/grok-*` stays on disk and is read as xAI. The provider prefix is otherwise kept, and only the first slash splits it.
 */
export function resolveModel(appConfig: string, requested: string): ResolvedModel | null {
  refreshHostedProviders();
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

/** A team's key can land after the daemon started; its provider exists only once registered. */
export function refreshHostedProviders() {
  if (!installed) return;
  const { models, appConfig, registered } = installed;
  // A registered provider reads its token and catalog on every call, so only a pot it has not seen needs registering.
  for (const teamId of Object.keys(readInference(appConfig)?.pots ?? {})) {
    if (registered.has(teamId)) continue;
    registered.add(teamId);
    registerHosted(models, appConfig, `alinery:${teamId}`, teamId);
  }
}

export function installAlineryProvider(models: Pick<MutableModels, "setProvider">, appConfig: string) {
  installed = { models, appConfig, registered: new Set() };
  registerHosted(models, appConfig, "alinery", null);
  refreshHostedProviders();
}

function registerHosted(models: Pick<MutableModels, "setProvider">, appConfig: string, id: string, teamId: string | null) {
  // The hosted catalog is openai-completions. /v1/responses is not served and comes back 404.
  const catalog = () => {
    const inference = readInference(appConfig);
    return (inference?.catalog.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      api: "openai-completions",
      provider: id,
      baseUrl: inference?.catalog.base_url,
      ...thinkingForHosted(model.thinking),
      input: inputForHosted(model.input),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
    }));
  };
  const streamWith = (method: "stream" | "streamSimple", model: { id: string; api?: string }, context: unknown, options: Record<string, unknown> | undefined) =>
    streamAlinery(appConfig, teamId, method, model, context, options);
  const provider = createProvider({
    id,
    name: teamId ? `Alinery ${teamId}` : "Alinery",
    auth: {
      apiKey: {
        name: "Alinery hosted",
        resolve: async ({ credential }) => {
          const explicit = credential?.key?.trim();
          if (explicit) return { auth: { apiKey: explicit }, source: "stored credential" };
          const token = hostedToken(readInference(appConfig), teamId);
          if (token) return { auth: { apiKey: token }, source: "alinery hosted" };
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
  provider.getModels = catalog;
  provider.getAllModels = catalog;
  models.setProvider(provider);
}

function hostedToken(inference: InferenceFile | null, teamId: string | null): string | undefined {
  if (!inference) return undefined;
  if (!teamId) return inference.token || undefined;
  const token = inference.pots?.[teamId]?.token;
  return token?.startsWith("inf_") ? token : undefined;
}

type StreamMethod = "stream" | "streamSimple";

function streamAlinery(appConfig: string, teamId: string | null, method: StreamMethod, model: { id: string; api?: string; baseUrl?: string }, context: unknown, options: Record<string, unknown> | undefined) {
  const hostedApi = openAICompletionsApi();
  const inference = readInference(appConfig);
  const token = hostedToken(inference, teamId);
  const hosted = inference?.catalog.models.some((item) => item.id === model.id);
  if (!hosted || !token || !inference) throw new Error(`model ${model.id} is unavailable`);
  const hostedModel = { ...model, api: "openai-completions", baseUrl: inference.catalog.base_url };
  return hostedApi[method](hostedModel, context, { ...options, apiKey: token });
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
