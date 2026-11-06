// SettingsService and RepoService (plan S4.1): the repository's `config.toml` writes and the repository's
// first-use setup. The read side is the `settings/_/repo` entity, so these return only `Applied`.
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { join } from "node:path";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { RepoOverrides } from "alinery-proto/alinery/v1/entities_pb";
import type { RepoService, SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { clearOverride, emptyOverrides, ensureRepoReady, overridesOf, settingsKey, writeOverridesFile } from "../domain/settings.ts";
import { writeOwnerOnly } from "../platform/fs.ts";
import { withTaskMutation } from "../platform/lock.ts";
import { pairingConfigDir } from "../provider.ts";
import type { Sender } from "../platform/telemetry.ts";
import type { Dedupe } from "../sync/dedupe.ts";
import { SETTINGS_PATHS } from "../sync/parsers/settings.ts";
import type { Store } from "../sync/store.ts";
import { requireCapability } from "./auth.ts";
import { domain, fail, metaOf } from "./errors.ts";

export type SettingsDeps = {
  repo: string;
  appConfig: string;
  /** Feed.refresh: re-reads one path into the store, so a reply's cursor already covers the write. */
  refresh: (rel: string) => Promise<void>;
  telemetry: Sender;
};

const CONFIG = "config.toml";

/** The hosted-inference file as the daemon's own provider reads it (`provider.ts` `InferenceFile`): refuse anything it could not use, before it replaces a good file. */
function hostedInferenceBody(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail(Code.InvalidArgument, "invalid_argument", "inference_json is not JSON");
  }
  const file = value as { token?: unknown; expires_at?: unknown; catalog?: { base_url?: unknown; models?: unknown } } | null;
  const ok =
    typeof file?.token === "string" &&
    file.token !== "" &&
    typeof file.expires_at === "number" &&
    typeof file.catalog?.base_url === "string" &&
    Array.isArray(file.catalog.models);
  if (!ok) throw fail(Code.InvalidArgument, "invalid_argument", "inference_json needs a token, an expires_at and a catalog with base_url and models");
  return text;
}

// A write is serialized with every other writer of this repository (the task-mutation lock), and the file is re-read
// into the store under that lock, so `expected_revision` is checked against the file as it is now, not as the
// watcher last saw it. A mismatch changes nothing (ABORTED); 0 means no check.
export function settingsService(d: SettingsDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof SettingsService> {
  const applied = () => ({ cursor: store.cursor() });
  const mutate = (op: string, expected: bigint, change: (current: RepoOverrides | undefined) => RepoOverrides) =>
    domain(() =>
      withTaskMutation(d.repo, op, async () => {
        await d.refresh(CONFIG);
        const row = store.get(settingsKey);
        if (expected !== 0n && row?.revision !== expected) throw fail(Code.Aborted, "aborted", `settings changed since revision ${expected} (now ${row?.revision ?? 0n})`);
        writeOverridesFile(d.repo, d.appConfig, change(overridesOf(row)));
        await d.refresh(CONFIG);
        d.telemetry.record(() => ({ event: "settings.change", source: "alineryd", scope: "repo" }));
        return { applied: applied() };
      }),
    );
  return {
    // The hosted token is a credential: ADMIN, owner-only, and the daemon's own host is the only place it is written.
    // It is not repo state, so it takes no repository lock and no store refresh; the provider re-reads the file on each lookup.
    writeHostedInference: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () =>
        domain(() => {
          writeOwnerOnly(join(pairingConfigDir(d.appConfig), "inference.json"), hostedInferenceBody(req.inferenceJson));
          return {};
        }),
      );
    },
    writeOverrides: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () => mutate("write_overrides", req.expectedRevision, () => req.overrides ?? emptyOverrides()));
    },
    clearOverride: (req, ctx) => {
      requireCapability(ctx, Capability.ACT);
      return dedupe.once(metaOf(req.meta), () =>
        mutate("clear_override", req.expectedRevision, (current) => {
          // A refused `config.toml` cannot be edited field by field: there is no value to clear a field from.
          if (!current) throw fail(Code.FailedPrecondition, "failed_precondition", "config.toml cannot be read; replace the whole file instead");
          return clearOverride(current, req.field);
        }),
      );
    },
  };
}

export function repoService(d: SettingsDeps, dedupe: Dedupe, store: Store): ServiceImpl<typeof RepoService> {
  return {
    ensureReady: (req, ctx) => {
      requireCapability(ctx, Capability.ADMIN);
      return dedupe.once(metaOf(req.meta), () =>
        domain(async () => {
          await ensureRepoReady(d.repo);
          for (const rel of SETTINGS_PATHS) await d.refresh(rel);
          return { applied: { cursor: store.cursor() } };
        }),
      );
    },
  };
}
