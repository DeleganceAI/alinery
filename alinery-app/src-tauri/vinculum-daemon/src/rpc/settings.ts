// SettingsService and RepoService (plan S4.1): the repository's `config.toml` writes and the repository's
// first-use setup. The read side is the `settings/_/repo` entity, so these return only `Applied`.
import { Code, type ServiceImpl } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import type { RepoOverrides } from "alinery-proto/alinery/v1/entities_pb";
import type { RepoService, SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { clearOverride, emptyOverrides, ensureRepoReady, overridesOf, settingsKey, writeOverridesFile } from "../domain/settings.ts";
import { withTaskMutation } from "../platform/lock.ts";
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
