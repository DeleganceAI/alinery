// ProviderService (plan S4.12) through the real RPC socket, on the real provider runtime in a temp config directory: sign in with
// an API key (groq asks for the key and stores it, offline), poll, reply, sign out; a custom provider; the model list. The
// capability rows are the point of the second half: every credential call is ADMIN, so a peer that is not the shell is refused.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { LoginMethod, ProviderService } from "alinery-proto/alinery/v1/providers_pb";
import { credentialPath } from "../credentials.ts";
import { JobRunner } from "../jobs/runner.ts";
import { openProviderRuntime } from "../runtime.ts";
import { Store } from "../sync/store.ts";
import { serveRpc } from "./server.ts";

const SECRET = "cd".repeat(32);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function start(hostExecutable: string | undefined) {
  const dir = mkdtempSync("/tmp/rpc-prov-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".alinery"), { recursive: true });
  const appConfig = join(dir, "config", "app.toml");
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(appConfig, "");
  const providers = openProviderRuntime(appConfig);
  const socketPath = join(dir, "rpc.sock");
  const net = await serveRpc({
    socketPath,
    secret: Buffer.from(SECRET),
    hostExecutable,
    info: { protocol: 37, buildId: "b", repoRoot: repo, appConfigIdentity: "i" },
    lifecycle: { stop: () => 0, exit: () => {} },
    store: new Store({ coalesceMs: 1 }),
    jobs: new JobRunner(new Store({ coalesceMs: 1 })),
    storageScan: { mode: "error" } as never,
    transcripts: async () => undefined,
    providers: { providers, repo, appConfig },
  });
  cleanup.push(() => {
    net.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const svc = (token: string | null) =>
    createClient(
      ProviderService,
      createGrpcTransport({
        baseUrl: "http://daemon",
        nodeOptions: { createConnection: () => connect(socketPath) } as never,
        interceptors: token ? [(next) => (req) => (req.header.set("authorization", `Bearer ${token}`), next(req))] : [],
      }),
    );
  let n = 0;
  const meta = () => ({ clientId: "c1", mutationId: `m${++n}` });
  return { dir, repo, svc, meta };
}

async function code(p: Promise<unknown>): Promise<Code | undefined> {
  try {
    await p;
  } catch (e) {
    return ConnectError.from(e).code;
  }
  return undefined;
}

async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const v = await read();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

test("an API-key sign-in: start, poll to the key prompt, reply, poll to done, then the catalog and the model list show it, and logout removes it", async () => {
  const { svc, meta, dir } = await start(process.execPath);
  const c = svc(SECRET);
  expect((await c.catalog({})).catalog?.providers.find((p) => p.id === "groq")?.authenticated).toBe(false);
  expect(await c.listModels({ harness: "omp" })).toMatchObject({ models: [] });

  const started = (await c.loginStart({ meta: meta(), provider: "groq", method: LoginMethod.API_KEY })).status!;
  expect(started.loginId).not.toBe("");
  const prompted = await until(async () => {
    const s = (await c.loginPoll({ loginId: started.loginId })).status!;
    return s.prompt ? s : undefined;
  });
  expect(prompted.status).toBe("prompt");
  expect(prompted.prompt?.type).toBe("secret");
  await c.loginReply({ meta: meta(), loginId: started.loginId, value: "groq-secret", cancel: false });
  const done = await until(async () => {
    const s = (await c.loginPoll({ loginId: started.loginId })).status!;
    return s.status === "done" || s.status === "error" ? s : undefined;
  });
  expect(done.status).toBe("done");

  const row = (await c.catalog({})).catalog!.providers.find((p) => p.id === "groq")!;
  expect(row).toMatchObject({ authenticated: true, stored: true, apiKey: true });
  expect(readFileSync(credentialPath(join(dir, "config", "app.toml")), "utf8")).toContain("groq-secret");
  const listed = (await c.listModels({ harness: "omp" })).models;
  expect(listed.length).toBeGreaterThan(0);
  expect(listed.every((m) => m.includes("/"))).toBe(true);
  expect(listed.some((m) => m.startsWith("groq/"))).toBe(true);
  expect(new Set(listed).size).toBe(listed.length);
  // Terminal and a harness the app cannot launch have no list.
  expect((await c.listModels({ harness: "no-harness" })).models).toEqual([]);
  expect((await c.listModels({ harness: "claude" })).models).toEqual([]);

  const out = (await c.logout({ meta: meta(), provider: "groq" })).catalog!;
  expect(out.providers.find((p) => p.id === "groq")?.authenticated).toBe(false);
  expect((await c.listModels({ harness: "omp" })).models.some((m) => m.startsWith("groq/"))).toBe(false);
});

test("a cancel reply ends the sign-in, and a method that is not api_key or oauth is INVALID_ARGUMENT", async () => {
  const { svc, meta } = await start(process.execPath);
  const c = svc(SECRET);
  expect(await code(c.loginStart({ meta: meta(), provider: "groq", method: LoginMethod.UNSPECIFIED }))).toBe(Code.InvalidArgument);
  const started = (await c.loginStart({ meta: meta(), provider: "groq", method: LoginMethod.API_KEY })).status!;
  await until(async () => ((await c.loginPoll({ loginId: started.loginId })).status!.prompt ? true : undefined));
  await c.loginReply({ meta: meta(), loginId: started.loginId, value: "", cancel: true });
  const ended = await until(async () => {
    const s = (await c.loginPoll({ loginId: started.loginId })).status!;
    return s.status === "cancelled" || s.status === "error" ? s : undefined;
  });
  expect(ended.status).toBe("cancelled");
  expect((await c.catalog({})).catalog?.providers.find((p) => p.id === "groq")?.authenticated).toBe(false);
});

test("a repeated mutation id starts one sign-in, not two", async () => {
  const { svc } = await start(process.execPath);
  const c = svc(SECRET);
  const same = { clientId: "c9", mutationId: "once" };
  const a = await c.loginStart({ meta: same, provider: "groq", method: LoginMethod.API_KEY });
  const b = await c.loginStart({ meta: same, provider: "groq", method: LoginMethod.API_KEY });
  expect(b.status?.loginId).toBe(a.status?.loginId);
  expect(await code(c.loginStart({ provider: "groq", method: LoginMethod.API_KEY }))).toBe(Code.InvalidArgument);
});

test("a custom provider is saved, listed with has_key and never its key, keeps the key on a blank save, and is deleted", async () => {
  const { svc, meta, dir } = await start(process.execPath);
  const c = svc(SECRET);
  const saved = (await c.saveCustom({ meta: meta(), id: "mine", name: "Mine", baseUrl: "https://llm.example.com/v1", apiKey: "k-1", keepKey: false, models: ["m1", "m2"] })).catalog!;
  expect(saved.custom).toMatchObject([{ id: "mine", name: "Mine", hasKey: true, models: ["m1", "m2"] }]);
  expect(JSON.stringify(saved)).not.toContain("k-1");
  const kept = (await c.saveCustom({ meta: meta(), id: "mine", name: "Mine", baseUrl: "https://llm.example.com/v1", apiKey: "", keepKey: true, models: ["m1"] })).catalog!;
  expect(kept.custom[0]).toMatchObject({ hasKey: true, models: ["m1"] });
  const cleared = (await c.saveCustom({ meta: meta(), id: "mine", name: "Mine", baseUrl: "https://llm.example.com/v1", apiKey: "", keepKey: false, models: ["m1"] })).catalog!;
  expect(cleared.custom[0]?.hasKey).toBe(false);
  expect(readFileSync(join(dir, "config", "custom-providers.json"), "utf8")).toContain("mine");
  expect(await code(c.saveCustom({ meta: meta(), id: "bad", name: "Bad", baseUrl: "not a url", apiKey: "", keepKey: false, models: ["m"] }))).toBe(Code.InvalidArgument);
  expect((await c.deleteCustom({ meta: meta(), id: "mine" })).catalog?.custom).toEqual([]);
});

test("every credential call is ADMIN: a peer that is not the shell (VIEW and ACT), and no token, are refused; VIEW reads still work", async () => {
  const { svc, meta } = await start("/bin/sh");
  const other = svc(SECRET);
  const calls: Array<() => Promise<unknown>> = [
    () => other.loginStart({ meta: meta(), provider: "groq", method: LoginMethod.API_KEY }),
    () => other.loginPoll({ loginId: "x" }),
    () => other.loginReply({ meta: meta(), loginId: "x", value: "v", cancel: false }),
    () => other.logout({ meta: meta(), provider: "groq" }),
    () => other.saveCustom({ meta: meta(), id: "a", name: "A", baseUrl: "https://a.example.com", apiKey: "", keepKey: false, models: [] }),
    () => other.deleteCustom({ meta: meta(), id: "a" }),
  ];
  for (const call of calls) expect(await code(call())).toBe(Code.PermissionDenied);
  await other.catalog({});
  await other.listModels({ harness: "omp" });
  const none = svc(null);
  expect(await code(none.catalog({}))).toBe(Code.PermissionDenied);
  expect(await code(none.loginStart({ meta: meta(), provider: "groq", method: LoginMethod.API_KEY }))).toBe(Code.PermissionDenied);
});

test("a host's own harness row models come first, then the signed-in providers' models", async () => {
  const { svc, repo } = await start(process.execPath);
  writeFileSync(join(repo, ".alinery", "harnesses.toml"), '[[harness]]\nkey = "omp"\nname = "OMP"\nbinary = "omp"\nmodels = ["house/model-a"]\n');
  const listed = (await svc(SECRET).listModels({ harness: "omp" })).models;
  expect(listed[0]).toBe("house/model-a");
});
