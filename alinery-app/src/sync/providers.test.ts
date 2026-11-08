import { Code, ConnectError, type ServiceImpl, type Transport } from "@connectrpc/connect";
import { LoginMethod, type ProviderService } from "alinery-proto/alinery/v1/providers_pb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { daemonHarness } from "../test/daemonHarness";
import { customProviderDelete, customProviderSave, listModels, providerCatalog, providerLoginPoll, providerLoginReply, providerLoginStart, providerLogout } from "./providers";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
const ipcMocks = vi.hoisted(() => ({ readAppConfig: vi.fn() }));
vi.mock("../ipc", () => ipcMocks);

beforeEach(() => {
  ipcMocks.readAppConfig.mockResolvedValue({ active_repo: "alinery+ssh://box/srv/r", known_repos: ["alinery+ssh://box/srv/r", "/b"] });
});
afterEach(() => vi.resetAllMocks());

function serve(providers: Partial<ServiceImpl<typeof ProviderService>>) {
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ providers }).transport as Transport);
}

const wireCatalog = {
  providers: [{ id: "groq", name: "Groq", authenticated: true, stored: true, apiKey: true, oauth: false, apiKeyName: "API key", oauthName: "" }],
  models: [{ provider: "groq", id: "llama" }],
  custom: [{ id: "mine", name: "Mine", baseUrl: "https://x.example/v1", hasKey: true, models: ["m1"] }],
};

it("reads the catalog from the active repository's daemon in the shape the sign-in UI uses", async () => {
  serve({ catalog: () => ({ catalog: wireCatalog }) as never });
  expect(await providerCatalog()).toEqual(wireCatalog);
  expect(vi.mocked(daemonTransport)).toHaveBeenCalledWith("alinery+ssh://box/srv/r");
  expect(await providerCatalog("/named")).toEqual(wireCatalog);
  expect(vi.mocked(daemonTransport)).toHaveBeenLastCalledWith("/named");
});

it("starts a sign-in with the method, returns the host that holds it, and maps events and the prompt, leaving unset fields unset", async () => {
  const seen: unknown[] = [];
  serve({
    loginStart: (request) => {
      seen.push([request.provider, request.method, Boolean(request.meta?.mutationId)]);
      return { status: { loginId: "l1", status: "pending", failure: "", events: [] } } as never;
    },
    loginPoll: (request) =>
      ({
        status: {
          loginId: request.loginId,
          status: "prompt",
          failure: "",
          prompt: {
            type: "select",
            message: "Pick",
            options: [
              { id: "a", label: "A", description: "first" },
              { id: "b", label: "B" },
            ],
          },
          events: [
            { event: { case: "authUrl", value: { url: "https://auth.example/x" } } },
            { event: { case: "deviceCode", value: { userCode: "AB-12", verificationUri: "https://d.example", intervalSeconds: 5 } } },
            { event: { case: "info", value: { message: "hi", links: [{ url: "https://l.example", label: "L" }, { url: "https://m.example" }] } } },
            { event: { case: "progress", value: { message: "waiting" } } },
          ],
        },
      }) as never,
  });
  const started = await providerLoginStart("anthropic", "oauth");
  expect(started).toEqual({ host: "alinery+ssh://box/srv/r", status: { loginId: "l1", status: "pending", failure: "", events: [] } });
  expect(seen).toEqual([["anthropic", LoginMethod.OAUTH, true]]);
  const polled = await providerLoginPoll("l1", started.host);
  expect(polled.prompt).toEqual({
    type: "select",
    message: "Pick",
    options: [
      { id: "a", label: "A", description: "first" },
      { id: "b", label: "B" },
    ],
  });
  expect(polled.events).toEqual([
    { type: "auth_url", url: "https://auth.example/x" },
    { type: "device_code", userCode: "AB-12", verificationUri: "https://d.example", intervalSeconds: 5 },
    { type: "info", message: "hi", links: [{ url: "https://l.example", label: "L" }, { url: "https://m.example" }] },
    { type: "progress", message: "waiting" },
  ]);
  expect(vi.mocked(daemonTransport)).toHaveBeenLastCalledWith("alinery+ssh://box/srv/r");
});

it("sends a reply, a cancel, a logout and the custom provider calls with a fresh mutation id each", async () => {
  const calls: Array<[string, unknown, string]> = [];
  const meta = (m?: { mutationId: string }) => m?.mutationId ?? "";
  serve({
    loginReply: (r) => (calls.push(["reply", { value: r.value, cancel: r.cancel }, meta(r.meta)]), {} as never),
    logout: (r) => (calls.push(["logout", r.provider, meta(r.meta)]), { catalog: wireCatalog } as never),
    saveCustom: (r) => (calls.push(["save", { id: r.id, apiKey: r.apiKey, keepKey: r.keepKey, models: [...r.models] }, meta(r.meta)]), { catalog: wireCatalog } as never),
    deleteCustom: (r) => (calls.push(["delete", r.id, meta(r.meta)]), { catalog: { providers: [], models: [], custom: [] } } as never),
  });
  await providerLoginReply("l1", "secret", false, "/b");
  await providerLoginReply("l1", "", true, "/b");
  await providerLogout("groq", "/b");
  await customProviderSave({ id: "mine", name: "Mine", baseUrl: "https://x.example/v1", apiKey: "", keepKey: true, models: ["m1"] }, "/b");
  expect(await customProviderDelete("mine", "/b")).toEqual({ providers: [], models: [], custom: [] });
  expect(calls.map(([name, body]) => [name, body])).toEqual([
    ["reply", { value: "secret", cancel: false }],
    ["reply", { value: "", cancel: true }],
    ["logout", "groq"],
    ["save", { id: "mine", apiKey: "", keepKey: true, models: ["m1"] }],
    ["delete", "mine"],
  ]);
  expect(new Set(calls.map(([, , id]) => id)).size).toBe(5);
});

it("lists models from the daemon of the repository named, else the active one, and says why a call failed", async () => {
  const asked: string[] = [];
  serve({ listModels: (r) => (asked.push(r.harness), { models: ["house/a", "groq/llama"] }) });
  expect(await listModels("omp", "/b")).toEqual(["house/a", "groq/llama"]);
  expect(vi.mocked(daemonTransport)).toHaveBeenLastCalledWith("/b");
  await listModels("omp");
  expect(vi.mocked(daemonTransport)).toHaveBeenLastCalledWith("alinery+ssh://box/srv/r");
  expect(asked).toEqual(["omp", "omp"]);
  serve({
    catalog: () => {
      throw new ConnectError("needs ADMIN", Code.PermissionDenied);
    },
  });
  await expect(providerCatalog()).rejects.toThrow("needs ADMIN");
});
