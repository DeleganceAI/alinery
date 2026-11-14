import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, test } from "bun:test";
import { credentialPath, openCredentialStore } from "./credentials.ts";
import { createLoginBroker } from "./login.ts";
import { openProviderRuntime } from "./runtime.ts";

test("an API-key login stores the secret and does not keep asking", async () => {
  const dir = join(tmpdir(), `alinery-login-${crypto.randomUUID()}`, "config");
  mkdirSync(dir, { recursive: true });
  const appConfig = join(dir, "config.toml");
  const credentials = openCredentialStore(credentialPath(appConfig));
  const models = builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const broker = createLoginBroker(models, { agentName: "Alinery" });
  const started = broker.start("groq", "api_key");
  const prompted = await waitFor(() => {
    const status = broker.poll(started.loginId);
    return status.prompt ? status : undefined;
  });
  expect(prompted.prompt?.type).toBe("secret");
  broker.reply(started.loginId, "groq-secret");
  const done = await waitFor(() => {
    const status = broker.poll(started.loginId);
    return status.status === "done" || status.status === "error" ? status : undefined;
  });
  expect(done.status).toBe("done");
  expect(await credentials.read("groq")).toEqual({ type: "api_key", key: "groq-secret" });
});

test("azure sign-in stores a resource name with the key", async () => {
  const { runtime, credentials } = runtimeFixture();
  const started = runtime.startLogin("azure", "api_key");
  await answer(runtime, started.loginId, "secret", "azure-secret");
  await answer(runtime, started.loginId, "text", "contoso");
  const done = await waitFor(() => {
    const status = runtime.pollLogin(started.loginId);
    return status.status === "done" || status.status === "error" ? status : undefined;
  });
  expect(done.status).toBe("done");
  expect(await credentials.read("azure")).toEqual({
    type: "api_key",
    key: "azure-secret",
    env: { AZURE_OPENAI_RESOURCE_NAME: "contoso" },
  });
});

test("azure sign-in stores an endpoint URL with the key", async () => {
  const { runtime, credentials } = runtimeFixture();
  const started = runtime.startLogin("azure", "api_key");
  await answer(runtime, started.loginId, "secret", "azure-secret");
  await answer(runtime, started.loginId, "text", "contoso.openai.azure.com/openai/v1");
  const done = await waitFor(() => {
    const status = runtime.pollLogin(started.loginId);
    return status.status === "done" || status.status === "error" ? status : undefined;
  });
  expect(done.status).toBe("done");
  expect(await credentials.read("azure")).toEqual({
    type: "api_key",
    key: "azure-secret",
    env: { AZURE_OPENAI_BASE_URL: "https://contoso.openai.azure.com/openai/v1" },
  });
});

test("azure sign-in rejects an endpoint Pi cannot use and stores nothing", async () => {
  const { runtime, credentials } = runtimeFixture();
  const started = runtime.startLogin("azure", "api_key");
  await answer(runtime, started.loginId, "secret", "azure-secret");
  await answer(runtime, started.loginId, "text", "https://");
  const done = await waitFor(() => {
    const status = runtime.pollLogin(started.loginId);
    return status.status === "done" || status.status === "error" ? status : undefined;
  });
  expect(done.status).toBe("error");
  expect(done.failure).toContain("Invalid Azure OpenAI base URL");
  expect(await credentials.read("azure")).toBeUndefined();
});

function runtimeFixture() {
  const dir = join(tmpdir(), `alinery-login-${crypto.randomUUID()}`, "config");
  mkdirSync(dir, { recursive: true });
  const appConfig = join(dir, "config.toml");
  return { runtime: openProviderRuntime(appConfig), credentials: openCredentialStore(credentialPath(appConfig)) };
}

async function answer(runtime: ReturnType<typeof openProviderRuntime>, loginId: string, type: "secret" | "text", value: string) {
  const prompted = await waitFor(() => {
    const status = runtime.pollLogin(loginId);
    return status.prompt?.type === type ? status : undefined;
  });
  expect(prompted.prompt?.type).toBe(type);
  runtime.replyLogin(loginId, value);
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
