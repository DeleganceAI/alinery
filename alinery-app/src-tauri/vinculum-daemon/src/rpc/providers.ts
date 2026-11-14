// ProviderService (plan S4.12): provider sign-in, custom providers and the model list. The credential files are the ones beside
// the app config this daemon was started with, so a remote repository's host signs in and lists its own models. The sign-in
// itself (device-code poll, prompts) is `login.ts`; the browser is the shell's. Everything that touches a credential is ADMIN.
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { LoginMethod, type LoginStatus as WireLoginStatus, LoginStatusSchema, type ProviderCatalog as WireCatalog, ProviderCatalogSchema, type ProviderService } from "alinery-proto/alinery/v1/providers_pb";
import { create } from "@bufbuild/protobuf";
import { join } from "node:path";
import { readSettingsFiles, settingsEntity } from "../domain/settings.ts";
import { DomainError } from "../platform/lock.ts";
import type { ProviderCatalog, openProviderRuntime } from "../runtime.ts";
import type { LoginStatus } from "../login.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

export type ProviderDeps = { providers: ReturnType<typeof openProviderRuntime>; repo: string; appConfig: string };

/** The harnesses a session can launch with a model list: the Vinculum agent, whichever of its two names the row carries. */
const MODEL_HARNESSES = new Set(["vinculum"]);

export function catalogToWire(c: ProviderCatalog): WireCatalog {
  return create(ProviderCatalogSchema, { providers: c.providers, models: c.models, custom: c.custom });
}

export function loginStatusToWire(s: LoginStatus): WireLoginStatus {
  return create(LoginStatusSchema, {
    loginId: s.loginId,
    status: s.status,
    failure: s.failure ?? "",
    prompt: s.prompt ? { type: s.prompt.type, message: s.prompt.message, placeholder: s.prompt.placeholder, options: s.prompt.options ?? [] } : undefined,
    events: s.events.map((e) => ({
      event:
        e.type === "info"
          ? { case: "info" as const, value: { message: e.message, links: e.links ?? [] } }
          : e.type === "auth_url"
            ? { case: "authUrl" as const, value: { url: e.url, instructions: e.instructions } }
            : e.type === "device_code"
              ? { case: "deviceCode" as const, value: { userCode: e.userCode, verificationUri: e.verificationUri, intervalSeconds: e.intervalSeconds, expiresInSeconds: e.expiresInSeconds } }
              : { case: "progress" as const, value: { message: e.message } },
    })),
  });
}

/** What the harness picker offers: the harness row's own models, then `provider/id` for every model of a signed-in provider here. */
export async function listModels(d: ProviderDeps, harness: string): Promise<string[]> {
  if (!MODEL_HARNESSES.has(harness)) return [];
  const settings = settingsEntity(readSettingsFiles(join(d.repo, ".alinery"), d.appConfig)).value;
  const rows = settings.case === "settings" ? settings.value.harnesses : [];
  const out = [...(rows.find((r) => r.harness?.key === harness)?.harness?.models ?? [])];
  for (const model of await d.providers.models.getAvailable()) {
    const selector = `${model.provider}/${model.id}`;
    if (!out.includes(selector)) out.push(selector);
  }
  return out;
}

/** A refusal the user can act on (an unknown provider, a bad URL) is INVALID_ARGUMENT, not an Internal error. */
const refuse = <T>(f: () => T | Promise<T>): Promise<T> =>
  domain(async () => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ConnectError || e instanceof DomainError) throw e;
      throw fail(Code.InvalidArgument, "invalid_argument", e instanceof Error ? e.message : String(e));
    }
  });

export function providerService(d: ProviderDeps, dedupe: Dedupe): ServiceImpl<typeof ProviderService> {
  const { providers } = d;
  const catalog = async () => ({ catalog: catalogToWire(await providers.catalog()) });
  return {
    catalog: (_req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return refuse(catalog);
    },
    loginStart: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () =>
        refuse(() => {
          const method = req.method === LoginMethod.OAUTH ? "oauth" : req.method === LoginMethod.API_KEY ? "api_key" : "";
          if (!method) throw new DomainError("invalid_argument", "login method must be api_key or oauth");
          return { status: loginStatusToWire(providers.startLogin(req.provider, method)) };
        }),
      );
    },
    loginPoll: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return refuse(() => ({ status: loginStatusToWire(providers.pollLogin(req.loginId)) }));
    },
    loginReply: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () =>
        refuse(() => {
          if (req.cancel) providers.cancelLogin(req.loginId);
          else providers.replyLogin(req.loginId, req.value);
          return {};
        }),
      );
    },
    logout: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () => refuse(async () => ({ catalog: catalogToWire(await providers.logout(req.provider)) })));
    },
    saveCustom: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () =>
        refuse(async () => {
          const typedKey = req.apiKey.trim();
          const saved = await providers.saveCustom({
            id: req.id,
            name: req.name,
            baseUrl: req.baseUrl,
            apiKey: typedKey || undefined,
            clearKey: !typedKey && !req.keepKey,
            models: req.models,
          });
          return { catalog: catalogToWire(saved) };
        }),
      );
    },
    deleteCustom: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () => refuse(async () => ({ catalog: catalogToWire(await providers.deleteCustom(req.id)) })));
    },
    listModels: (req, ctx) => {
      requireCapability(ctx, Capability.VIEW);
      return refuse(async () => ({ models: await listModels(d, req.harness) }));
    },
  };
}
