// Custom OpenAI-compatible providers. The user pastes the provider block of an OMP `models.yml` or a pi `models.json`
// (JSON is YAML, so one parser reads both); `checkCustom` names every problem by field so the settings editor can show
// them as the user types, and `testCustom` sends one short request per model through pi itself.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema } from "@earendil-works/pi-ai/providers/compat-schema";
import { ModelCostSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { Value } from "typebox/value";
import { writeOwnerOnly } from "./platform/fs.ts";

type Models = Pick<MutableModels, "setProvider" | "deleteProvider">;
type Api = "openai-completions" | "openai-responses";
type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type CustomModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  supportsTools?: boolean;
  cost?: Cost;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
};

export type CustomProvider = {
  id: string;
  name?: string;
  baseUrl: string;
  api?: Api;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: CustomModel[];
};

export type CustomProviderPublic = {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: string[];
  /** This provider as YAML for the editor, its key replaced by SAVED_KEY. */
  config: string;
};

export type CustomProblem = { path: string; message: string; error: boolean };
export type CustomModelTest = { provider: string; model: string; ok: boolean; detail: string; millis: number };

/** What the editor shows for a stored key; saving it unchanged keeps that key. */
export const SAVED_KEY = "<saved>";
const DEFAULT_CONTEXT = 128000;
const DEFAULT_MAX_TOKENS = 8192;
const COMPAT: Record<Api, { properties: Record<string, unknown> }> = {
  "openai-completions": OpenAICompletionsCompatSchema as never,
  "openai-responses": OpenAIResponsesCompatSchema as never,
};
const PROVIDER_KEYS = new Set(["name", "baseUrl", "api", "apiKey", "authHeader", "headers", "compat", "models"]);
const MODEL_KEYS = new Set(["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "supportsTools", "cost", "headers", "compat"]);

export function customProviderPath(appConfig: string): string {
  return join(dirname(appConfig), "custom-providers.json");
}

/**
 * Parse and check `text`. Errors stop a save; warnings name a default Alinery fills in or a field it ignores.
 * `stored` supplies the key behind SAVED_KEY, `taken` the ids of built-in providers.
 */
export function checkCustom(text: string, taken: ReadonlySet<string>, stored: readonly CustomProvider[] = []): { providers: CustomProvider[]; problems: CustomProblem[] } {
  const problems: CustomProblem[] = [];
  const error = (path: string, message: string) => problems.push({ path, message, error: true });
  const warn = (path: string, message: string) => problems.push({ path, message, error: false });
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (cause) {
    // Bun's YAML error carries a line and column, but they do not point at the input reliably, so they are left out.
    const reason = String(cause instanceof Error ? cause.message : cause).replace(/^YAML Parse error: /, "");
    error("", `not valid YAML or JSON (${reason}); check the indentation, colons and brackets`);
    return { providers: [], problems };
  }
  if (isObject(doc) && isObject(doc.providers)) doc = doc.providers; // a whole models.yml or models.json
  if (!isObject(doc) || Object.keys(doc).length === 0) {
    error("", "start with the provider's id, then its fields indented under it (see the example)");
    return { providers: [], problems };
  }
  const providers: CustomProvider[] = [];
  for (const [rawId, raw] of Object.entries(doc)) {
    const id = rawId.trim().toLowerCase();
    const at = (field: string) => `${rawId}.${field}`;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) error(rawId, "the provider id must be a short name: letters, digits and dashes, starting with a letter");
    else if (id === "alinery" || taken.has(id)) error(rawId, `${id} is a built-in provider; pick another id`);
    if (!isObject(raw)) {
      error(rawId, "needs its fields indented under it: baseUrl, apiKey, models");
      continue;
    }
    for (const key of Object.keys(raw)) if (!PROVIDER_KEYS.has(key)) warn(at(key), "Alinery does not use this field; it is ignored");

    const name = optionalString(raw.name, at("name"), error);
    let baseUrl = "";
    if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) error(at("baseUrl"), "required: the API root, such as https://api.example.com/v1");
    else {
      try {
        const url = new URL(raw.baseUrl.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") error(at("baseUrl"), "must start with http:// or https://");
        else if (url.username || url.password) error(at("baseUrl"), "put the key in apiKey, not in the URL");
        else baseUrl = url.toString().replace(/\/$/, "");
        if (/\/chat\/completions\/?$|\/responses\/?$/.test(url.pathname)) warn(at("baseUrl"), "this looks like a full request path; baseUrl is usually the root ending in /v1");
      } catch {
        error(at("baseUrl"), "is not a URL");
      }
    }
    const api: Api = raw.api === undefined ? "openai-completions" : (raw.api as Api);
    if (raw.api !== undefined && !(raw.api in COMPAT)) error(at("api"), "must be openai-completions or openai-responses");

    let apiKey: string | undefined;
    if (raw.apiKey === undefined || raw.apiKey === null || raw.apiKey === "") warn(at("apiKey"), "no key: requests go out without one, which only a local server accepts");
    else if (typeof raw.apiKey !== "string") error(at("apiKey"), "must be text");
    else if (raw.apiKey.trim() === SAVED_KEY) {
      apiKey = stored.find((row) => row.id === id)?.apiKey;
      if (!apiKey) error(at("apiKey"), `no key is saved for ${id}; paste the key`);
    } else if (/^<.*>$/.test(raw.apiKey.trim())) error(at("apiKey"), `replace ${raw.apiKey.trim()} with your key`);
    else {
      apiKey = raw.apiKey.trim();
      if (/^[A-Z][A-Z0-9_]*_(KEY|TOKEN)$/.test(apiKey)) warn(at("apiKey"), "this looks like an environment variable name; Alinery sends apiKey as the key itself");
    }
    if (raw.authHeader !== undefined && typeof raw.authHeader !== "boolean") error(at("authHeader"), "must be true or false");
    const headers = stringMap(raw.headers, at("headers"), error);
    const compat = checkCompat(raw.compat, api, at("compat"), error, warn);

    const models: CustomModel[] = [];
    if (!Array.isArray(raw.models) || raw.models.length === 0) error(at("models"), "list at least one model, each starting with - id:");
    else if (raw.models.length > 50) error(at("models"), "at most 50 models per provider");
    else {
      const seen = new Set<string>();
      raw.models.forEach((entry, index) => {
        const m = typeof entry === "string" ? { id: entry } : entry;
        const path = (field?: string) => `${rawId}.models[${index}]${field ? `.${field}` : ""}`;
        if (!isObject(m)) return error(path(), "each model needs at least an id");
        for (const key of Object.keys(m)) if (!MODEL_KEYS.has(key)) warn(path(key), "Alinery does not use this field; it is ignored");
        const modelId = typeof m.id === "string" ? m.id.trim() : "";
        if (!modelId) return error(path("id"), "required: the model name the endpoint expects");
        if (modelId.length > 128 || /\s/.test(modelId)) error(path("id"), "cannot contain spaces");
        if (seen.has(modelId)) error(path("id"), `${modelId} is listed twice`);
        seen.add(modelId);
        const model: CustomModel = { id: modelId };
        const modelName = optionalString(m.name, path("name"), error);
        if (modelName) model.name = modelName;
        // A model without `reasoning` offers no thinking levels, and nothing on the endpoint says otherwise, so say so here.
        if (m.reasoning === undefined) warn(path("reasoning"), "not set, so this model gets no thinking levels: add reasoning: true if it thinks, or reasoning: false");
        else if (typeof m.reasoning !== "boolean") error(path("reasoning"), "must be true or false");
        else model.reasoning = m.reasoning;
        if (m.input !== undefined) {
          const input = Array.isArray(m.input) ? m.input : [m.input];
          if (!input.every((kind) => kind === "text" || kind === "image") || !input.includes("text")) error(path("input"), "must be [text] or [text, image]");
          else model.input = [...new Set(input)] as ("text" | "image")[];
        }
        for (const field of ["contextWindow", "maxTokens"] as const) {
          const value = m[field];
          if (value === undefined) warn(path(field), `not set; Alinery assumes ${(field === "contextWindow" ? DEFAULT_CONTEXT : DEFAULT_MAX_TOKENS).toLocaleString("en-US")}`);
          else if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) error(path(field), "must be a whole number of tokens");
          else model[field] = value;
        }
        if ((model.maxTokens ?? DEFAULT_MAX_TOKENS) > (model.contextWindow ?? DEFAULT_CONTEXT)) error(path("maxTokens"), "is larger than contextWindow");
        if (m.supportsTools === false) error(path("supportsTools"), "Alinery's agent works through tool calls, so this model cannot run it");
        else if (m.supportsTools !== undefined && typeof m.supportsTools !== "boolean") error(path("supportsTools"), "must be true or false");
        else if (m.supportsTools === true) model.supportsTools = true;
        if (m.cost !== undefined) {
          if (!Value.Check(ModelCostSchema, m.cost)) error(path("cost"), "needs input, output, cacheRead and cacheWrite, each a number (dollars per million tokens)");
          else model.cost = m.cost as Cost;
        }
        const modelHeaders = stringMap(m.headers, path("headers"), error);
        if (modelHeaders) model.headers = modelHeaders;
        const modelCompat = checkCompat(m.compat, api, path("compat"), error, warn);
        if (modelCompat) model.compat = modelCompat;
        models.push(model);
      });
    }
    const provider: CustomProvider = { id, baseUrl, models };
    if (name) provider.name = name;
    if (raw.api !== undefined) provider.api = api;
    if (apiKey) provider.apiKey = apiKey;
    if (typeof raw.authHeader === "boolean") provider.authHeader = raw.authHeader;
    if (headers) provider.headers = headers;
    if (compat) provider.compat = compat;
    providers.push(provider);
  }
  return { providers, problems };
}

/** One short request per model, with one tool declared as the agent would, through the provider pi builds from the config. */
export async function testCustom(providers: readonly CustomProvider[], timeoutMs = 30_000): Promise<CustomModelTest[]> {
  const models = createModels();
  for (const row of providers) models.setProvider(providerFor(row));
  const tool = { name: "ping", description: "Answers pong.", parameters: { type: "object", properties: {} } } as never;
  return Promise.all(
    providers.flatMap((row) =>
      models.getModels(row.id).map(async (model) => {
        const started = Date.now();
        const result = { provider: row.id, model: model.id };
        try {
          const reply = await models.completeSimple(
            model,
            { systemPrompt: "Answer in one word.", messages: [{ role: "user", content: "Say OK.", timestamp: Date.now() }], tools: [tool] },
            { maxTokens: 64, signal: AbortSignal.timeout(timeoutMs) },
          );
          const millis = Date.now() - started;
          if (reply.stopReason === "error" || reply.stopReason === "aborted") return { ...result, ok: false, detail: reply.errorMessage || reply.stopReason, millis };
          return { ...result, ok: true, detail: `answered in ${millis} ms`, millis };
        } catch (cause) {
          return { ...result, ok: false, detail: String(cause instanceof Error ? cause.message : cause), millis: Date.now() - started };
        }
      }),
    ),
  );
}

export function openCustomProviders(path: string) {
  let rows = readRows(path);

  const persist = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeOwnerOnly(path, JSON.stringify(rows));
  };

  return {
    list(): CustomProvider[] {
      return structuredClone(rows);
    },
    publicList(): CustomProviderPublic[] {
      return rows.map((row) => ({
        id: row.id,
        name: row.name || row.id,
        baseUrl: row.baseUrl,
        hasKey: Boolean(row.apiKey),
        models: row.models.map((model) => model.id),
        config: configText(row),
      }));
    },
    register(models: Models) {
      for (const row of rows) models.setProvider(providerFor(row));
    },
    /** Check `text` against the latest file and upsert its providers; `replaces` is the id being edited, dropped if renamed. */
    save(text: string, taken: ReadonlySet<string>, models: Models, replaces?: string): CustomProvider[] {
      rows = readRows(path); // another repository's daemon may have saved since this one started
      const { providers, problems } = checkCustom(text, taken, rows);
      const errors = problems.filter((problem) => problem.error);
      if (errors.length > 0) throw new Error(errors.map((problem) => (problem.path ? `${problem.path}: ${problem.message}` : problem.message)).join("; "));
      const ids = new Set(providers.map((row) => row.id));
      if (replaces && !ids.has(replaces)) {
        ids.add(replaces);
        models.deleteProvider(replaces);
      }
      rows = [...rows.filter((row) => !ids.has(row.id)), ...providers];
      persist();
      for (const row of providers) models.setProvider(providerFor(row));
      return structuredClone(providers);
    },
    remove(id: string, models: Models) {
      rows = readRows(path).filter((row) => row.id !== id);
      models.deleteProvider(id);
      persist();
    },
  };
}

function configText(row: CustomProvider): string {
  const { id, ...rest } = row;
  return Bun.YAML.stringify({ [id]: { ...rest, ...(rest.apiKey ? { apiKey: SAVED_KEY } : {}) } }, null, 2);
}

function providerFor(row: CustomProvider) {
  const api = row.api ?? "openai-completions";
  const models = () =>
    row.models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      api,
      provider: row.id,
      baseUrl: row.baseUrl,
      reasoning: model.reasoning ?? false,
      input: model.input ?? ["text"],
      cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(row.headers || model.headers ? { headers: { ...row.headers, ...model.headers } } : {}),
      ...(row.compat || model.compat ? { compat: { ...row.compat, ...model.compat } } : {}),
    }));
  const provider = createProvider({
    id: row.id,
    name: row.name || row.id,
    baseUrl: row.baseUrl,
    auth: {
      apiKey: {
        name: `${row.name || row.id} API key`,
        resolve: async () => {
          const key = row.apiKey?.trim();
          if (key) return { auth: { apiKey: key }, source: "custom endpoint" };
          return { auth: {}, source: "no auth" };
        },
      },
    },
    models: [],
    api: api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
  });
  provider.getModels = models as never;
  provider.getAllModels = models as never;
  return provider;
}

function checkCompat(
  value: unknown,
  api: Api,
  path: string,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    error(path, "must be a set of options, such as maxTokensField: max_tokens");
    return undefined;
  }
  const schema = (COMPAT[api] ?? COMPAT["openai-completions"]).properties;
  const kept: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(value)) {
    const rule = schema[key] as { anyOf?: { const?: unknown }[]; type?: string } | undefined;
    if (!rule) warn(`${path}.${key}`, `pi has no ${api} option by this name; it is ignored`);
    else if (!Value.Check(rule as never, option)) {
      const allowed = rule.anyOf?.map((choice) => choice.const).filter((choice) => choice !== undefined);
      error(`${path}.${key}`, allowed?.length ? `must be one of ${allowed.join(", ")}` : `must be a ${rule.type ?? "valid value"}`);
    } else kept[key] = option;
  }
  return Object.keys(kept).length ? kept : undefined;
}

function optionalString(value: unknown, path: string, error: (path: string, message: string) => void): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > 80 || /[\u0000-\u001f]/.test(value)) {
    error(path, "must be a short line of text");
    return undefined;
  }
  return value.trim() || undefined;
}

function stringMap(value: unknown, path: string, error: (path: string, message: string) => void): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    error(path, "must be header names with text values");
    return undefined;
  }
  return value as Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRows(path: string): CustomProvider[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is CustomProvider => isObject(row) && typeof row.id === "string" && typeof row.baseUrl === "string" && Array.isArray(row.models))
      .map((row) => ({ ...row, models: row.models.map((model) => (typeof model === "string" ? { id: model } : model)) })); // older rows list bare ids
  } catch {
    return [];
  }
}
