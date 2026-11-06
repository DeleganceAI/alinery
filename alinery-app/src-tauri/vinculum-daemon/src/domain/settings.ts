// Repository settings (plan S4.1), ported from alinery-core `shared.rs` (`resolve_effective_config`,
// the harness overlay, `clear_repo_override`) and `settings.rs` (the TOML reads, writes and log lines).
// `effectiveSettings` is the one place the precedence lives: an absent repo field inherits the global
// value, and a present blank string is a value (settings.rs `:97-99`). `sessionControls.ts` calls it too.
import { create, equals } from "@bufbuild/protobuf";
import {
  type Entity,
  EntitySchema,
  type EffectiveSettings,
  EffectiveSettingsSchema,
  type RepoOverrides,
  RepoOverridesSchema,
  SettingSource,
  SettingsSchema,
} from "alinery-proto/alinery/v1/entities_pb";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import defaultConfigToml from "../../../config.default.toml" with { type: "text" };
import defaultHarnessesToml from "../../../harnesses.default.toml" with { type: "text" };
import { appendException, appendInfo, quoteLogValue } from "../platform/log.ts";
import { writeAtomic, writeDurable } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import { type Obj, Refuse, bool, obj, present, refuse, req, str, strings, tomlParse, uint } from "../sync/parsers/serde.ts";

// ---- the global tier (`app.toml`, table `[global]`) --------------------------------------------------

export type PlaybookRef = { scope: "bundled" | "global" | "repo"; key: string };
export type Choice = { harness: string; model: string; thinking: string; playbook: PlaybookRef; draftAutosave: boolean };
export type Backup = { destination: string; enabled: boolean; retention: number; triggerPreArchive: boolean; triggerPostArtifactChange: boolean; triggerPostPushCommit: boolean };
export type Telemetry = { enabled: boolean; prompted: boolean; installId: string; endpoint: string };
export type Notifications = {
  enabled: boolean;
  sound: boolean;
  bounce: boolean;
  banner: boolean;
  dockBadge: boolean;
  dockBadgeInputWaits: boolean;
  dockBadgeApprovalWaits: boolean;
  dockBadgeFailures: boolean;
  dockBadgeCompletions: boolean;
};
export type Harness = {
  key: string;
  name: string;
  binary: string;
  args: string[];
  modelArg: string[];
  promptArg: string[];
  env: Record<string, string>;
  promptInjection: string;
  adapter: string;
  messageAdapter: string;
  models: string[];
  modelsCmd: string;
  resume?: { enabled: boolean; idSource: string; launchArgs: string[]; resumeArgs: string[] };
};
export type Global = { notifications: Notifications; githubToken: string; defaults: Choice; backup: Backup; harnesses: Harness[]; telemetry: Telemetry };

// Product constants of alinery-core (types.rs, shared.rs, playbook_library.rs).
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.alinery.ai";
export const MIN_BACKUP_RETENTION = 1;
export const MAX_BACKUP_RETENTION = 100;
const DEFAULT_RETENTION = 10;
const OMP = "omp";
const VINCULUM = "vinculum";
const NO_HARNESS = "no-harness";
/** `BUNDLED_PLAYBOOKS`: a legacy `defaults.playbook = "<key>"` is bundled only for these. A test keeps the list equal to `playbooks/`. */
export const BUNDLED_PLAYBOOK_KEYS = new Set([
  "superdevelop",
  "one-shot",
  "review",
  "bug-hunting",
  "free-form",
  "generic-session",
  "natural-planning-brainstorm",
  "systematic-naming",
  "primed-feature-development",
  "systematic-evidence-review",
  "build-playbook",
  "academic-survey",
  "spec",
  "solution-exploration",
]);
const DEFAULT_PLAYBOOK: PlaybookRef = { scope: "bundled", key: "superdevelop" };

const validPlaybookKey = (key: string) => /^[a-z0-9][a-z0-9-]*$/.test(key);
const SCOPES = ["bundled", "global", "repo"] as const;

/** types.rs `SettingsPlaybookRef`: a scoped table, or the legacy bare key that earlier installs wrote. */
function playbookRef(v: unknown): PlaybookRef {
  if (typeof v === "string") {
    if (!validPlaybookKey(v)) return refuse();
    return { scope: BUNDLED_PLAYBOOK_KEYS.has(v) ? "bundled" : "repo", key: v };
  }
  const o = obj(v);
  if (Object.keys(o).some((k) => k !== "scope" && k !== "key")) return refuse();
  const scope = req(o, "scope");
  if (!(SCOPES as readonly string[]).includes(scope)) return refuse();
  return { scope: scope as PlaybookRef["scope"], key: req(o, "key") };
}

const optStr = (o: Obj, k: string): string | undefined => (present(o, k) ? str(o, k) : undefined);
const optBool = (o: Obj, k: string): boolean | undefined => (present(o, k) ? bool(o, k) : undefined);
const optU8 = (o: Obj, k: string): number | undefined => (present(o, k) ? uint(o[k], 255) : undefined);
const table = (o: Obj, k: string): Obj => (present(o, k) ? obj(o[k]) : {});

function oneOf(o: Obj, k: string, allowed: string[], fallback: string): string {
  const value = str(o, k, fallback);
  return allowed.includes(value) ? value : refuse();
}

function harnessOf(v: unknown): Harness {
  const o = obj(v);
  const list = (k: string) => (present(o, k) ? strings(o[k]) : []);
  const env = table(o, "env");
  const resume = present(o, "resume") ? obj(o.resume) : undefined;
  return {
    key: req(o, "key"),
    name: req(o, "name"),
    binary: req(o, "binary"),
    args: list("args"),
    modelArg: list("model_arg"),
    promptArg: list("prompt_arg"),
    // Sorted: Rust holds a HashMap, so two files are equal whatever order the keys came in.
    env: Object.fromEntries(Object.keys(env).sort().map((k) => [k, typeof env[k] === "string" ? (env[k] as string) : refuse()])),
    promptInjection: str(o, "prompt_injection"),
    adapter: oneOf(o, "adapter", ["omp", "unsupported"], "unsupported"),
    messageAdapter: oneOf(o, "message_adapter", ["omp_bracketed_paste", "unsupported"], "unsupported"),
    models: list("models"),
    modelsCmd: str(o, "models_cmd"),
    resume: resume
      ? {
          enabled: bool(resume, "enabled"),
          idSource: str(resume, "id_source"),
          launchArgs: present(resume, "launch_args") ? strings(resume.launch_args) : [],
          resumeArgs: present(resume, "resume_args") ? strings(resume.resume_args) : [],
        }
      : undefined,
  };
}

/** A `HarnessFile`: `[[harness]]` rows. Refuses as serde does. */
function harnessFile(o: Obj): Harness[] {
  if (!present(o, "harness")) return [];
  return Array.isArray(o.harness) ? o.harness.map(harnessOf) : refuse();
}

const bundledHarnesses = (): Harness[] => harnessFile(tomlParse(defaultHarnessesToml) as Obj);

function choiceOf(o: Obj): Choice {
  return {
    harness: str(o, "harness"),
    model: str(o, "model"),
    thinking: str(o, "thinking"),
    playbook: present(o, "playbook") ? playbookRef(o.playbook) : DEFAULT_PLAYBOOK,
    draftAutosave: bool(o, "draft_autosave", true),
  };
}

export function defaultGlobal(): Global {
  return globalOf({});
}

function globalOf(g: Obj): Global {
  const n = table(g, "notifications");
  const b = table(g, "backup");
  const t = table(g, "telemetry");
  const harnesses = present(g, "harnesses") ? harnessFile(obj(g.harnesses)) : [];
  return {
    notifications: {
      enabled: bool(n, "enabled", true),
      sound: bool(n, "sound", true),
      bounce: bool(n, "bounce", false),
      banner: bool(n, "banner", true),
      dockBadge: bool(n, "dock_badge", true),
      dockBadgeInputWaits: bool(n, "dock_badge_input_waits", true),
      dockBadgeApprovalWaits: bool(n, "dock_badge_approval_waits", true),
      dockBadgeFailures: bool(n, "dock_badge_failures", true),
      dockBadgeCompletions: bool(n, "dock_badge_completions", true),
    },
    githubToken: str(table(g, "github"), "token"),
    defaults: choiceOf(table(g, "defaults")),
    backup: {
      destination: str(b, "destination"),
      enabled: bool(b, "enabled"),
      retention: present(b, "retention") ? uint(b.retention, 255) : DEFAULT_RETENTION,
      triggerPreArchive: bool(b, "trigger_pre_archive"),
      triggerPostArtifactChange: bool(b, "trigger_post_artifact_change"),
      triggerPostPushCommit: bool(b, "trigger_post_push_commit"),
    },
    // settings.rs `normalize_global_settings`: an empty registry is the bundled one.
    harnesses: harnesses.length ? harnesses : bundledHarnesses(),
    telemetry: { enabled: bool(t, "enabled", true), prompted: bool(t, "prompted", false), installId: str(t, "install_id"), endpoint: str(t, "endpoint", DEFAULT_TELEMETRY_ENDPOINT) },
  };
}

/** `app.toml`'s text as `parse_global_settings` reads it; undefined when serde would refuse it. Sections the daemon never reads
 * (updates, power, experiments, grid_views, model_favorites) are not checked. */
export function parseGlobal(text: string): Global | undefined {
  try {
    const root = obj(tomlParse(text));
    return globalOf(table(root, "global"));
  } catch (e) {
    if (e instanceof Refuse) return undefined;
    throw e;
  }
}

// ---- the repository tier (`config.toml`) ---------------------------------------------------------

export const emptyOverrides = (): RepoOverrides => create(RepoOverridesSchema, {});

/** `config.toml`'s text as `toml::from_str::<RepoOverrides>` reads it; undefined when serde would refuse it. */
export function parseOverrides(text: string): RepoOverrides | undefined {
  try {
    const root = obj(tomlParse(text));
    const github = table(root, "github");
    const defaults = table(root, "defaults");
    const backup = table(root, "backup");
    return create(RepoOverridesSchema, {
      github: { token: optStr(github, "token") },
      defaults: {
        harness: optStr(defaults, "harness"),
        model: optStr(defaults, "model"),
        thinking: optStr(defaults, "thinking"),
        playbook: present(defaults, "playbook") ? playbookRef(defaults.playbook) : undefined,
        draftAutosave: optBool(defaults, "draft_autosave"),
      },
      backup: {
        destination: optStr(backup, "destination"),
        enabled: optBool(backup, "enabled"),
        retention: optU8(backup, "retention"),
        triggerPreArchive: optBool(backup, "trigger_pre_archive"),
        triggerPostArtifactChange: optBool(backup, "trigger_post_artifact_change"),
        triggerPostPushCommit: optBool(backup, "trigger_post_push_commit"),
      },
    });
  } catch (e) {
    if (e instanceof Refuse) return undefined;
    throw e;
  }
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * The bytes of `config.toml` for `o`. `Bun.TOML.stringify` follows key order, so every table lists its keys
 * in the Rust struct's field order (types.rs `RepoOverrides`), and the three tables are always written,
 * empty or not, as `toml::to_string` does. A golden case written by Rust pins the result.
 */
export function overridesToml(o: RepoOverrides): string {
  const d = o.defaults;
  const b = o.backup;
  return Bun.TOML.stringify({
    github: defined({ token: o.github?.token }),
    defaults: defined({ harness: d?.harness, model: d?.model, thinking: d?.thinking, playbook: d?.playbook && { scope: d.playbook.scope, key: d.playbook.key }, draft_autosave: d?.draftAutosave }),
    backup: defined({
      destination: b?.destination,
      enabled: b?.enabled,
      retention: b?.retention,
      trigger_pre_archive: b?.triggerPreArchive,
      trigger_post_artifact_change: b?.triggerPostArtifactChange,
      trigger_post_push_commit: b?.triggerPostPushCommit,
    }),
  });
}

/** shared.rs `clear_repo_override`. The `defaults.model` case clears the harness beside it (Settings stamps `omp` next to every model write). */
export function clearOverride(o: RepoOverrides, field: string): RepoOverrides {
  const out = create(RepoOverridesSchema, { github: { ...o.github }, defaults: { ...o.defaults }, backup: { ...o.backup } });
  const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const [section, key] = field.split(".");
  const known: Record<string, string[]> = {
    github: ["token"],
    defaults: ["harness", "model", "thinking", "playbook", "draft_autosave"],
    backup: ["destination", "enabled", "retention", "trigger_pre_archive", "trigger_post_artifact_change", "trigger_post_push_commit"],
  };
  if (!known[section]?.includes(key)) throw new DomainError("invalid_argument", `unknown repository override field: ${field}`);
  const target = out[section as "github" | "defaults" | "backup"] as unknown as Record<string, unknown>;
  target[camel(key)] = undefined;
  if (field === "defaults.model") target.harness = undefined;
  return out;
}

// ---- the effective values --------------------------------------------------------------------------

export type Scoped<T> = { value: T; source: SettingSource };

/** The precedence of settings.rs `:97-99`: an absent repo field inherits; `""` is a value, a repo that blanks a field means blank. */
export function pick<T>(repo: T | undefined, global: T): Scoped<T> {
  return repo === undefined ? { value: global, source: SettingSource.GLOBAL } : { value: repo, source: SettingSource.REPOSITORY };
}

/** shared.rs `resolve_effective_config`. */
export function effectiveSettings(global: Global, o: RepoOverrides): EffectiveSettings {
  const d = o.defaults;
  const b = o.backup;
  const harness = pick(d?.harness, global.defaults.harness);
  const model = pick(d?.model, global.defaults.model);
  const thinking = pick(d?.thinking, global.defaults.thinking);
  const playbook = pick(d?.playbook && { scope: d.playbook.scope as PlaybookRef["scope"], key: d.playbook.key }, global.defaults.playbook);
  const autosave = pick(d?.draftAutosave, global.defaults.draftAutosave);
  const token = pick(o.github?.token, global.githubToken);
  const g = global.backup;
  return create(EffectiveSettingsSchema, {
    notifications: global.notifications,
    githubToken: token.value,
    githubTokenSource: token.source,
    defaults: { harness: harness.value, model: model.value, thinking: thinking.value, playbook: playbook.value, draftAutosave: autosave.value },
    defaultsSource: { harness: harness.source, model: model.source, thinking: thinking.source, playbook: playbook.source, draftAutosave: autosave.source },
    // shared.rs `resolve_backup`: retention is clamped to the slider's 1..100, since 0 would delete every backup on the next create.
    backup: {
      destination: b?.destination ?? g.destination,
      enabled: b?.enabled ?? g.enabled,
      retention: Math.min(MAX_BACKUP_RETENTION, Math.max(MIN_BACKUP_RETENTION, b?.retention ?? g.retention)),
      triggerPreArchive: b?.triggerPreArchive ?? g.triggerPreArchive,
      triggerPostArtifactChange: b?.triggerPostArtifactChange ?? g.triggerPostArtifactChange,
      triggerPostPushCommit: b?.triggerPostPushCommit ?? g.triggerPostPushCommit,
    },
    telemetry: global.telemetry,
  });
}

// ---- harnesses -----------------------------------------------------------------------------------------

const allowedLaunch = (key: string) => key === OMP || key === VINCULUM || key === NO_HARNESS;
const noHarnessEntry = (): Harness => ({
  key: NO_HARNESS,
  name: "Terminal",
  binary: "",
  args: [],
  modelArg: [],
  promptArg: [],
  env: {},
  promptInjection: "",
  adapter: "unsupported",
  messageAdapter: "unsupported",
  models: [],
  modelsCmd: "",
});

/** shared.rs `resolve_harness_overlay` and `product_launch_list`: the repo's `harnesses.toml` over the global registry, Terminal first.
 * A repo may overlay every field but `models_cmd`, which runs under a shell and so only ever comes from the global row. */
export function effectiveHarnesses(global: Harness[], local: Harness[]): { harness: Harness; source: SettingSource }[] {
  const byKey = new Map(local.filter((h) => allowedLaunch(h.key) && h.key !== NO_HARNESS).map((h) => [h.key, h]));
  const out: { harness: Harness; source: SettingSource }[] = [];
  for (const g of global) {
    if (!allowedLaunch(g.key) || g.key === NO_HARNESS) continue;
    const l = byKey.get(g.key);
    byKey.delete(g.key);
    out.push(l ? { harness: { ...l, modelsCmd: g.modelsCmd }, source: SettingSource.REPOSITORY } : { harness: g, source: SettingSource.GLOBAL });
  }
  for (const l of byKey.values()) out.push({ harness: { ...l, modelsCmd: "" }, source: SettingSource.REPOSITORY });
  if (!out.some((e) => e.harness.key === OMP)) {
    const omp = bundledHarnesses().find((h) => h.key === OMP);
    if (omp) out.push({ harness: omp, source: SettingSource.GLOBAL });
  }
  out.unshift({ harness: noHarnessEntry(), source: SettingSource.GLOBAL });
  return out;
}

/** settings.rs `read_local_harness_overrides`: a file that does not parse, or that equals the bundled one, is no overlay. */
function localHarnesses(text: string | undefined): Harness[] {
  if (text === undefined) return [];
  try {
    const rows = harnessFile(obj(tomlParse(text)));
    return JSON.stringify(rows) === JSON.stringify(bundledHarnesses()) ? [] : rows;
  } catch (e) {
    if (e instanceof Refuse) return [];
    throw e;
  }
}

// ---- the entity ------------------------------------------------------------------------------------------

export const settingsKey = "settings/_/repo";

/** The texts of the three files; undefined is a file that does not exist. */
export type SettingsFiles = { app?: string; config?: string; harnesses?: string };

/** `settings/_/repo`. A file serde would refuse leaves only `error`, which the Settings view shows. */
export function settingsEntity(files: SettingsFiles): Entity {
  const row = (value: Parameters<typeof create<typeof SettingsSchema>>[1]): Entity => create(EntitySchema, { key: settingsKey, value: { case: "settings", value: create(SettingsSchema, value) } });
  const global = files.app === undefined ? defaultGlobal() : parseGlobal(files.app);
  if (!global) return row({ error: "invalid global settings (playbook defaults require a scope-qualified v2 reference)" });
  const overrides = files.config === undefined ? emptyOverrides() : parseOverrides(files.config);
  if (!overrides) return row({ error: "invalid repository settings (playbook defaults require a scope-qualified v2 reference)" });
  return row({ overrides, effective: effectiveSettings(global, overrides), harnesses: effectiveHarnesses(global.harnesses, localHarnesses(files.harnesses)) });
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The three files of a repo as text, `undefined` where one is missing. Synchronous, so a write between two reads cannot split a row. */
export function readSettingsFiles(alinery: string, appConfig: string): SettingsFiles {
  return { app: readText(appConfig), config: readText(join(alinery, "config.toml")), harnesses: readText(join(alinery, "harnesses.toml")) };
}

/** The global tier as the daemon reads it from `app.toml` now; the defaults when the file is missing or refused. */
export function currentGlobal(appConfig: string): Global {
  const text = readText(appConfig);
  return (text === undefined ? undefined : parseGlobal(text)) ?? defaultGlobal();
}

export const overridesOf = (e: Entity | undefined): RepoOverrides | undefined => (e?.value.case === "settings" && !e.value.value.error ? e.value.value.overrides ?? emptyOverrides() : undefined);

// ---- writes ------------------------------------------------------------------------------------------------

type Prior = { kind: "missing" } | { kind: "parsed"; value: RepoOverrides } | { kind: "unreadable" };

const quotedChange = (key: string, prev: string | undefined, next: string | undefined) => (prev === next ? [] : prev !== undefined && next === undefined ? [`${key}=cleared`] : next !== undefined ? [`${key}=${quoteLogValue(next)}`] : []);
const plainChange = (key: string, prev: boolean | number | undefined, next: boolean | number | undefined) => (prev === next ? [] : prev !== undefined && next === undefined ? [`${key}=cleared`] : next !== undefined ? [`${key}=${next}`] : []);
const secretChange = (key: string, prev: string | undefined, next: string | undefined) => (prev === next ? [] : prev !== undefined && next === undefined ? [`${key}=cleared`] : [`${key}=changed`]);

/** settings.rs `log_repo_settings_event`: which fields a write changed, never a secret's value. */
export function repoSettingsLogLine(repo: string, prev: RepoOverrides, next: RepoOverrides): string | undefined {
  const fields = [
    ...secretChange("github.token", prev.github?.token, next.github?.token),
    ...quotedChange("defaults.harness", prev.defaults?.harness, next.defaults?.harness),
    ...quotedChange("defaults.model", prev.defaults?.model, next.defaults?.model),
    ...quotedChange("defaults.thinking", prev.defaults?.thinking, next.defaults?.thinking),
    ...(equals(RepoOverridesSchema, create(RepoOverridesSchema, { defaults: { playbook: prev.defaults?.playbook } }), create(RepoOverridesSchema, { defaults: { playbook: next.defaults?.playbook } })) ? [] : ["defaults.playbook=changed"]),
    ...plainChange("defaults.draft_autosave", prev.defaults?.draftAutosave, next.defaults?.draftAutosave),
    ...quotedChange("backup.destination", prev.backup?.destination, next.backup?.destination),
    ...plainChange("backup.enabled", prev.backup?.enabled, next.backup?.enabled),
    ...plainChange("backup.retention", prev.backup?.retention, next.backup?.retention),
    ...plainChange("backup.trigger_pre_archive", prev.backup?.triggerPreArchive, next.backup?.triggerPreArchive),
    ...plainChange("backup.trigger_post_artifact_change", prev.backup?.triggerPostArtifactChange, next.backup?.triggerPostArtifactChange),
    ...plainChange("backup.trigger_post_push_commit", prev.backup?.triggerPostPushCommit, next.backup?.triggerPostPushCommit),
  ];
  return fields.length ? `settings.repo repo=${quoteLogValue(repo)} ${fields.join(" ")}` : undefined;
}

const configPath = (repo: string) => join(repo, ".alinery", "config.toml");

function readPrior(repo: string): Prior {
  const text = readText(configPath(repo));
  if (text === undefined) return { kind: "missing" };
  const value = parseOverrides(text);
  return value ? { kind: "parsed", value } : { kind: "unreadable" };
}

/**
 * Writes `config.toml`. The caller holds the task-mutation lock. A repository whose file is refused
 * cannot be edited field by field (`clear`), but a whole-file write replaces it, as Rust's does.
 * Returns the previous overrides for the caller's telemetry decision.
 */
export function writeOverridesFile(repo: string, appConfig: string, next: RepoOverrides): void {
  const prior = readPrior(repo);
  try {
    mkdirSync(join(repo, ".alinery"), { recursive: true });
    writeAtomic(configPath(repo), overridesToml(next));
  } catch (e) {
    appendException(appConfig, `settings.repo write-failed repo=${quoteLogValue(repo)} reason=io err=${quoteLogValue((e as Error).message)}`);
    throw new DomainError("internal", `write ${configPath(repo)}: ${(e as Error).message}`);
  }
  if (prior.kind === "unreadable") appendException(appConfig, `settings.repo unreadable repo=${quoteLogValue(repo)} kind=parse`);
  else {
    const line = repoSettingsLogLine(repo, prior.kind === "parsed" ? prior.value : emptyOverrides(), next);
    if (line) appendInfo(appConfig, line);
  }
}

// ---- EnsureReady -------------------------------------------------------------------------------------------

/** core `ensure_task_data_ignored`. */
export async function ensureIgnored(repo: string): Promise<void> {
  const path = join(repo, ".gitignore");
  const file = Bun.file(path);
  let contents = (await file.exists()) ? await file.text() : "";
  if (contents.split("\n").some((line) => line.trim() === "/.alinery/")) return;
  if (contents !== "" && !contents.endsWith("\n")) contents += "\n";
  await writeDurable(path, `${contents}/.alinery/\n`);
}

/**
 * The repository half of `set_active_repo` (`ensure_repo_ready`): `.alinery/`, the ignore entry, `harnesses.toml` and
 * `config.toml`, each created only when missing, so a second call touches nothing. `harnesses.toml` is new
 * (Rust's `ensure_harnesses_toml` only made the directory); it holds the bundled rows, which read as no overlay.
 */
export async function ensureRepoReady(repo: string): Promise<void> {
  const alinery = join(repo, ".alinery");
  mkdirSync(alinery, { recursive: true });
  await ensureIgnored(repo);
  for (const [name, text] of [["harnesses.toml", defaultHarnessesToml], ["config.toml", defaultConfigToml]] as const) {
    const path = join(alinery, name);
    if (!(await Bun.file(path).exists())) await writeDurable(path, text);
  }
}

