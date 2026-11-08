// Provider sign-in, custom providers and the model list through ProviderService (plan S4.12). The daemon owns the credential
// files, so a repository on another machine signs in on that machine and lists its models. Which daemon: the repository a call
// names; with none, the active repository, else the first local one the app knows (the agent directory's rule). The browser
// stays here: the page opens an `auth_url` event with the shell's `open_url`, the daemon holds the poll.
import { createClient } from "@connectrpc/connect";
import { type LoginEvent, LoginMethod, type LoginStatus, ProviderService, type ProviderCatalog as WireCatalog } from "alinery-proto/alinery/v1/providers_pb";
import type { ProviderCatalog, ProviderLoginStatus } from "../chat/providers";
import { daemonTransport } from "../daemon/transport";
import { agentHost, call } from "./hostCall";
import { newMutationMeta } from "./mutation";

const provider = (host: string) => createClient(ProviderService, daemonTransport(host));

function catalogOf(c: WireCatalog | undefined): ProviderCatalog {
  return {
    providers: (c?.providers ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      authenticated: p.authenticated,
      stored: p.stored,
      apiKey: p.apiKey,
      oauth: p.oauth,
      apiKeyName: p.apiKeyName,
      oauthName: p.oauthName,
    })),
    models: (c?.models ?? []).map((m) => ({ provider: m.provider, id: m.id })),
    custom: (c?.custom ?? []).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, hasKey: p.hasKey, models: [...p.models] })),
  };
}

function eventOf(e: LoginEvent): ProviderLoginStatus["events"][number] | null {
  switch (e.event.case) {
    case "info":
      return { type: "info", message: e.event.value.message, links: e.event.value.links.map((l) => ({ url: l.url, ...(l.label === undefined ? {} : { label: l.label }) })) };
    case "authUrl":
      return { type: "auth_url", url: e.event.value.url, ...(e.event.value.instructions === undefined ? {} : { instructions: e.event.value.instructions }) };
    case "deviceCode": {
      const d = e.event.value;
      return {
        type: "device_code",
        userCode: d.userCode,
        verificationUri: d.verificationUri,
        ...(d.intervalSeconds === undefined ? {} : { intervalSeconds: d.intervalSeconds }),
        ...(d.expiresInSeconds === undefined ? {} : { expiresInSeconds: d.expiresInSeconds }),
      };
    }
    case "progress":
      return { type: "progress", message: e.event.value.message };
    default:
      return null;
  }
}

function statusOf(s: LoginStatus | undefined): ProviderLoginStatus {
  if (!s) throw new Error("the daemon sent no sign-in status");
  return {
    loginId: s.loginId,
    status: s.status,
    failure: s.failure,
    events: s.events.map(eventOf).filter((e): e is NonNullable<typeof e> => e !== null),
    ...(s.prompt
      ? {
          prompt: {
            type: s.prompt.type,
            message: s.prompt.message,
            ...(s.prompt.placeholder === undefined ? {} : { placeholder: s.prompt.placeholder }),
            ...(s.prompt.options.length === 0
              ? {}
              : { options: s.prompt.options.map((o) => ({ id: o.id, label: o.label, ...(o.description === undefined ? {} : { description: o.description }) })) }),
          },
        }
      : {}),
  };
}

export async function providerCatalog(repo?: string): Promise<ProviderCatalog> {
  const host = await agentHost(repo);
  return catalogOf((await call(() => provider(host).catalog({}))).catalog);
}

export async function providerLogout(providerId: string, repo?: string): Promise<ProviderCatalog> {
  const host = await agentHost(repo);
  return catalogOf((await call(() => provider(host).logout({ meta: newMutationMeta(), provider: providerId }))).catalog);
}

/** `host` is the repository whose daemon holds the sign-in: poll and answer that one, even if the active repository changes meanwhile. */
export async function providerLoginStart(providerId: string, method: "api_key" | "oauth", repo?: string): Promise<{ status: ProviderLoginStatus; host: string }> {
  const host = await agentHost(repo);
  const wire = method === "oauth" ? LoginMethod.OAUTH : LoginMethod.API_KEY;
  return { host, status: statusOf((await call(() => provider(host).loginStart({ meta: newMutationMeta(), provider: providerId, method: wire }))).status) };
}

export async function providerLoginPoll(loginId: string, repo?: string): Promise<ProviderLoginStatus> {
  const host = await agentHost(repo);
  return statusOf((await call(() => provider(host).loginPoll({ loginId }))).status);
}

export async function providerLoginReply(loginId: string, value: string, cancel: boolean, repo?: string): Promise<void> {
  const host = await agentHost(repo);
  await call(() => provider(host).loginReply({ meta: newMutationMeta(), loginId, value, cancel }));
}

export async function customProviderSave(
  input: { id: string; name: string; baseUrl: string; apiKey: string; keepKey: boolean; models: string[] },
  repo?: string,
): Promise<ProviderCatalog> {
  const host = await agentHost(repo);
  return catalogOf((await call(() => provider(host).saveCustom({ meta: newMutationMeta(), ...input }))).catalog);
}

export async function customProviderDelete(id: string, repo?: string): Promise<ProviderCatalog> {
  const host = await agentHost(repo);
  return catalogOf((await call(() => provider(host).deleteCustom({ meta: newMutationMeta(), id }))).catalog);
}

/** The model suggestions for a harness's picker, from the host of `repo` (else the active repository's host). */
export async function listModels(harness: string, repo?: string): Promise<string[]> {
  const host = await agentHost(repo);
  return [...(await call(() => provider(host).listModels({ harness }))).models];
}
