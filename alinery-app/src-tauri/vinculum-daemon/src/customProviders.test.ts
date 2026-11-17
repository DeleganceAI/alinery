import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUSTOM_ENDPOINT_REFERENCE, CUSTOM_ENDPOINT_STARTER } from "../../../src/customEndpointExample.ts";
import { checkCustom, openCustomProviders, testCustom } from "./customProviders.ts";

const noop = { setProvider() {}, deleteProvider() {} };

// The block from an OMP models.yml, pasted as is.
const OMP = `phdeepinfra:
    baseUrl: "https://api.deepinfra.com/v1/openai"
    api: openai-completions
    apiKey: sk-test
    authHeader: true
    compat:
      maxTokensField: max_tokens
    models:
      - id: deepseek-ai/DeepSeek-V4-Pro-0813
        contextWindow: 1000000
        maxTokens: 32000
        supportsTools: true
      - id: deepseek-ai/DeepSeek-V4.1-Flash-1017
        contextWindow: 1000000
        maxTokens: 32000
        supportsTools: true
        input: [text, image]
`;

test("an OMP provider block reads with no problem, slashes in model ids included", () => {
  const { providers, problems } = checkCustom(OMP, new Set());
  expect(problems).toEqual([]);
  expect(providers).toEqual([
    {
      id: "phdeepinfra",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      api: "openai-completions",
      apiKey: "sk-test",
      authHeader: true,
      compat: { maxTokensField: "max_tokens" },
      models: [
        { id: "deepseek-ai/DeepSeek-V4-Pro-0813", contextWindow: 1000000, maxTokens: 32000, supportsTools: true },
        { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", contextWindow: 1000000, maxTokens: 32000, supportsTools: true, input: ["text", "image"] },
      ],
    },
  ]);
  // A whole pi models.json, JSON included, reads the same way.
  expect(checkCustom(JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:11434/v1", models: [{ id: "llama", contextWindow: 8000, maxTokens: 2000 }] } } }), new Set()).problems).toEqual([
    { path: "local.apiKey", message: "no key: requests go out without one, which only a local server accepts", error: false },
  ]);
});

test("the editor's reference reads with no problem once its key is filled in, and the starter's only problem is the key", () => {
  expect(checkCustom(CUSTOM_ENDPOINT_REFERENCE.replace("<your key>", "sk-x"), new Set()).problems).toEqual([]);
  expect(checkCustom(CUSTOM_ENDPOINT_STARTER, new Set()).problems).toEqual([{ path: "my-endpoint.apiKey", message: "replace <your key> with your key", error: true }]);
});

test("each problem names its field, errors apart from warnings", () => {
  const text = `openai:
  baseUrl: ftp://x
  apiKey: <key>
  colour: blue
  compat:
    maxTokensField: max_tok
    madeUp: true
  models:
    - id: a b
      maxTokens: 9000
      contextWindow: 4000
      supportsTools: false
`;
  const { problems } = checkCustom(text, new Set(["openai"]));
  const byPath = Object.fromEntries(problems.map((p) => [p.path, [p.error, p.message]]));
  expect(byPath.openai).toEqual([true, "openai is a built-in provider; pick another id"]);
  expect(byPath["openai.baseUrl"]?.[0]).toBe(true);
  expect(byPath["openai.apiKey"]).toEqual([true, "replace <key> with your key"]);
  expect(byPath["openai.colour"]?.[0]).toBe(false);
  expect(byPath["openai.compat.maxTokensField"]).toEqual([true, "must be one of max_completion_tokens, max_tokens"]);
  expect(byPath["openai.compat.madeUp"]?.[0]).toBe(false);
  expect(byPath["openai.models[0].id"]).toEqual([true, "cannot contain spaces"]);
  expect(byPath["openai.models[0].maxTokens"]).toEqual([true, "is larger than contextWindow"]);
  expect(byPath["openai.models[0].supportsTools"]?.[0]).toBe(true);
  expect(checkCustom("a:\n  b: [1, 2\n", new Set()).problems[0]).toMatchObject({ path: "", error: true });
});

test("<saved> keeps the stored key, renaming drops the old id, and two daemons saving different providers keep both", () => {
  const path = join(mkdtempSync(join(tmpdir(), "alinery-custom-")), "custom-providers.json");
  const first = openCustomProviders(path);
  const second = openCustomProviders(path);
  first.save("a:\n  baseUrl: http://127.0.0.1:1/v1\n  apiKey: k-a\n  models: [m]\n", new Set(), noop);
  second.save("b:\n  baseUrl: http://127.0.0.1:2/v1\n  models: [m]\n", new Set(), noop);
  expect(openCustomProviders(path).list().map((row) => row.id).sort()).toEqual(["a", "b"]);
  const shown = openCustomProviders(path).publicList().find((row) => row.id === "a")!;
  expect(shown.config).not.toContain("k-a");
  first.save(shown.config.replace("a:", "c:").replace("<saved>", "k-c"), new Set(), noop, "a");
  first.save(first.publicList().find((row) => row.id === "c")!.config, new Set(), noop);
  expect(openCustomProviders(path).list().map((row) => [row.id, row.apiKey]).sort()).toEqual([["b", undefined], ["c", "k-c"]]);
  expect(() => first.save("d:\n  baseUrl: http://x/v1\n  apiKey: <saved>\n  models: [m]\n", new Set(), noop)).toThrow("no key is saved for d");
});

test("a file of older rows, model ids as plain strings, still loads", () => {
  const path = join(mkdtempSync(join(tmpdir(), "alinery-custom-")), "custom-providers.json");
  writeFileSync(path, JSON.stringify([{ id: "local", name: "Local", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "k", models: ["llama"] }]));
  expect(openCustomProviders(path).publicList()).toMatchObject([{ id: "local", name: "Local", hasKey: true, models: ["llama"] }]);
});

test("the live test sends a request through pi with the key, the max-tokens field and a tool, and reports a refusal", async () => {
  const seen: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      seen.push({ auth: request.headers.get("authorization"), body });
      if (body.model === "missing") return Response.json({ error: { message: "model not found" } }, { status: 404 });
      const chunk = { id: "x", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const text = `local:\n  baseUrl: http://127.0.0.1:${server.port}/v1\n  apiKey: k-live\n  compat:\n    maxTokensField: max_tokens\n  models: [org/good, missing]\n`;
    const results = await testCustom(checkCustom(text, new Set()).providers, 10_000);
    expect(results.map((r) => [r.model, r.ok])).toEqual([["org/good", true], ["missing", false]]);
    expect(results[1]?.detail).toContain("model not found");
    expect(seen[0]?.auth).toBe("Bearer k-live");
    expect(seen[0]?.body.max_tokens).toBe(64);
    expect((seen[0]?.body.tools as unknown[]).length).toBe(1);
  } finally {
    server.stop(true);
  }
});
