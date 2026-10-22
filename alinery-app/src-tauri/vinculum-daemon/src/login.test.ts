import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, test } from "bun:test";
import { credentialPath, openCredentialStore } from "./credentials.ts";
import { createLoginBroker } from "./login.ts";

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

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
