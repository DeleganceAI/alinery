// A repository's settings from the daemon's `settings/_/repo` entity (plan S4.1): what `read_config_for_repo`,
// `read_scoped_settings_for_repo` and `read_repo_overrides_for_repo` answered, and the two writes that replace
// `write_repo_overrides_for_repo` and `clear_repo_override_for_repo`. Global settings stay in the shell.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import type { Cursor } from "alinery-proto/alinery/v1/common_pb";
import {
  type EffectiveSettings,
  type Entity,
  type HarnessChoice as HarnessChoiceProto,
  type RepoOverrides as RepoOverridesProto,
  RepoOverridesSchema,
  SettingSource,
} from "alinery-proto/alinery/v1/entities_pb";
import { SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { useMemo, useSyncExternalStore } from "react";
import { daemonTransport } from "../daemon/transport";
import type { Config, HarnessChoice, RepoOverrides, SettingSource as Source } from "../types";
import { acquireScope, REPO_SCOPE, useEntity, useScope } from "./hooks";
import { newMutationMeta } from "./mutation";

export const SETTINGS_KEY = "settings/_/repo";

export type RepoSettings = {
  overrides: RepoOverrides;
  /** The global tier with the repository's overrides over it, and where each value came from. */
  effective: Config;
  /** Sent back as `expected_revision`, so a write over a newer row is refused. */
  revision: bigint;
};

const source = (s: SettingSource): Source => (s === SettingSource.REPOSITORY ? "repository" : "global");

const choiceOf = (c: HarnessChoiceProto | undefined): HarnessChoice => ({
  harness: c?.harness ?? "",
  model: c?.model ?? "",
  thinking: c?.thinking ?? "",
  playbook: { scope: (c?.playbook?.scope || "bundled") as HarnessChoice["playbook"]["scope"], key: c?.playbook?.key ?? "" },
  draft_autosave: c?.draftAutosave ?? true,
});

export function configOf(e: EffectiveSettings): Config {
  const n = e.notifications;
  return {
    notifications: {
      enabled: n?.enabled ?? false,
      sound: n?.sound ?? false,
      bounce: n?.bounce ?? false,
      banner: n?.banner ?? false,
      dock_badge: n?.dockBadge ?? false,
      dock_badge_input_waits: n?.dockBadgeInputWaits ?? false,
      dock_badge_approval_waits: n?.dockBadgeApprovalWaits ?? false,
      dock_badge_failures: n?.dockBadgeFailures ?? false,
      dock_badge_completions: n?.dockBadgeCompletions ?? false,
    },
    github: { token: e.githubToken },
    defaults: choiceOf(e.defaults),
    provenance: {
      github_token: source(e.githubTokenSource),
      defaults: {
        harness: source(e.defaultsSource?.harness ?? 0),
        model: source(e.defaultsSource?.model ?? 0),
        thinking: source(e.defaultsSource?.thinking ?? 0),
        playbook: source(e.defaultsSource?.playbook ?? 0),
        draft_autosave: source(e.defaultsSource?.draftAutosave ?? 0),
      },
    },
    backup: {
      destination: e.backup?.destination ?? "",
      enabled: e.backup?.enabled ?? false,
      retention: e.backup?.retention ?? 0,
      trigger_pre_archive: e.backup?.triggerPreArchive ?? false,
      trigger_post_artifact_change: e.backup?.triggerPostArtifactChange ?? false,
      trigger_post_push_commit: e.backup?.triggerPostPushCommit ?? false,
    },
    telemetry: {
      enabled: e.telemetry?.enabled ?? false,
      prompted: e.telemetry?.prompted ?? false,
      install_id: e.telemetry?.installId ?? "",
      endpoint: e.telemetry?.endpoint ?? "",
    },
  };
}

const nul = <T>(v: T | undefined): T | null => v ?? null;

export function overridesOf(o: RepoOverridesProto | undefined): RepoOverrides {
  const d = o?.defaults;
  const b = o?.backup;
  return {
    github: { token: nul(o?.github?.token) },
    defaults: {
      harness: nul(d?.harness),
      model: nul(d?.model),
      thinking: nul(d?.thinking),
      playbook: d?.playbook ? { scope: d.playbook.scope as HarnessChoice["playbook"]["scope"], key: d.playbook.key } : null,
      draft_autosave: nul(d?.draftAutosave),
    },
    backup: {
      destination: nul(b?.destination),
      enabled: nul(b?.enabled),
      retention: nul(b?.retention),
      trigger_pre_archive: nul(b?.triggerPreArchive),
      trigger_post_artifact_change: nul(b?.triggerPostArtifactChange),
      trigger_post_push_commit: nul(b?.triggerPostPushCommit),
    },
  };
}

const undef = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

export function overridesToProto(o: RepoOverrides): RepoOverridesProto {
  const d = o.defaults ?? {};
  const b = o.backup ?? {};
  return create(RepoOverridesSchema, {
    github: { token: undef(o.github?.token) },
    defaults: {
      harness: undef(d.harness),
      model: undef(d.model),
      thinking: undef(d.thinking),
      playbook: d.playbook ? { scope: d.playbook.scope, key: d.playbook.key } : undefined,
      draftAutosave: undef(d.draft_autosave),
    },
    backup: {
      destination: undef(b.destination),
      enabled: undef(b.enabled),
      retention: undef(b.retention),
      triggerPreArchive: undef(b.trigger_pre_archive),
      triggerPostArtifactChange: undef(b.trigger_post_artifact_change),
      triggerPostPushCommit: undef(b.trigger_post_push_commit),
    },
  });
}

/** The settings a row holds, or the daemon's reason it has none (a `config.toml` or `app.toml` it refuses to read). */
export function settingsOf(e: Entity | undefined): { settings: RepoSettings } | { error: string } | undefined {
  if (e?.value.case !== "settings") return undefined;
  const s = e.value.value;
  if (s.error) return { error: s.error };
  return { settings: { overrides: overridesOf(s.overrides), effective: configOf(s.effective ?? ({} as EffectiveSettings)), revision: e.revision } };
}

export type RepoSettingsRead = { settings?: RepoSettings; error?: string; ready: boolean; cursor?: Cursor };

const NOTHING = () => () => {};

/** The repository's settings while this component is mounted, with the replica's cursor (for `Overlay.read`). */
export function useRepoSettings(repo: string): RepoSettingsRead {
  const replica = useScope(repo, REPO_SCOPE);
  const entity = useEntity(replica, SETTINGS_KEY);
  const subscribe = useMemo(() => (replica ? replica.listen : NOTHING), [replica]);
  const cursor = useSyncExternalStore(subscribe, () => replica?.cursor);
  const ready = useSyncExternalStore(subscribe, () => replica?.ready ?? false);
  const parsed = useMemo(() => settingsOf(entity), [entity]);
  return { settings: parsed && "settings" in parsed ? parsed.settings : undefined, error: parsed && "error" in parsed ? parsed.error : undefined, ready, cursor };
}

/** One read for a command that needs the settings once: the stream's first snapshot, or an error if the daemon does not answer within `timeoutMs`. */
export function readRepoSettings(repo: string, timeoutMs = 3000): Promise<RepoSettings> {
  const { replica, release } = acquireScope(repo, REPO_SCOPE);
  return new Promise<RepoSettings>((resolve, reject) => {
    let off = () => {};
    const done = (finish: () => void) => {
      clearTimeout(timer);
      off();
      release();
      finish();
    };
    const read = () => {
      if (!replica.ready) return;
      const parsed = settingsOf(replica.get(SETTINGS_KEY));
      if (parsed && "settings" in parsed) done(() => resolve(parsed.settings));
      else done(() => reject(new Error(parsed ? parsed.error : "the daemon has no settings for this repository")));
    };
    const timer = setTimeout(() => done(() => reject(new Error(`the daemon for ${repo} did not answer`))), timeoutMs);
    off = replica.listen(read);
    read();
  });
}

/** The effective config only (`read_config_for_repo`). */
export const readEffectiveConfig = (repo: string, timeoutMs?: number) => readRepoSettings(repo, timeoutMs).then((s) => s.effective);

/** A write over a row that moved on: the view should show the newer values and say so. */
export class SettingsConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsConflict";
  }
}

async function mutate<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const err = ConnectError.from(e);
    if (err.code === Code.Aborted) throw new SettingsConflict(err.rawMessage);
    throw new Error(err.rawMessage);
  }
}

const client = (repo: string) => createClient(SettingsService, daemonTransport(repo));

/** Replaces the repository's whole `config.toml`; resolves with the cursor the write was applied at. */
export function writeRepoOverrides(repo: string, overrides: RepoOverrides, expectedRevision?: bigint): Promise<Cursor | undefined> {
  return mutate(() => client(repo).writeOverrides({ meta: newMutationMeta(), overrides: overridesToProto(overrides), expectedRevision: expectedRevision ?? 0n })).then(
    (r) => r.applied?.cursor,
  );
}

/** Clears one dotted override key (`defaults.model`) so the global value applies again. */
export function clearRepoOverride(repo: string, field: string, expectedRevision?: bigint): Promise<Cursor | undefined> {
  return mutate(() => client(repo).clearOverride({ meta: newMutationMeta(), field, expectedRevision: expectedRevision ?? 0n })).then((r) => r.applied?.cursor);
}
