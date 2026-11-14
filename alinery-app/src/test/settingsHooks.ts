// The settings row of src/sync/settings.ts, served by a fake daemon a test states. For view tests whose subject
// is the view, not the stream: a repo's row arrives with the same shapes and the same stable identities the real
// hook hands over, and a write behaves as the daemon does: it replaces the overrides, derives the effective
// values, moves the revision and the cursor, and answers with that cursor. Tests of the stream itself use daemonHarness.
//
//     vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));
//     fakeSettings.serve("/r", (overrides) => effectiveFor(overrides));
import { create } from "@bufbuild/protobuf";
import { fireEvent, screen } from "@testing-library/react";
import { type Cursor, CursorSchema } from "alinery-proto/alinery/v1/common_pb";
import { useSyncExternalStore } from "react";
import type * as Settings from "../sync/settings";
import type { Config, GlobalSettings, RepoOverrides } from "../types";

const EMPTY: RepoOverrides = { github: {}, defaults: {}, backup: {} };
const cursorAt = (seq: number): Cursor => create(CursorSchema, { epoch: "test", seq: BigInt(seq) });

/** The daemon's precedence for the fields a view test touches: `global` under what the repo file overrides, with provenance. */
export function effectiveOf(global: GlobalSettings, overrides: RepoOverrides = EMPTY): Config {
  const { thinking } = overrides.defaults;
  return {
    notifications: global.notifications,
    github: global.github,
    defaults: { ...global.defaults, thinking: thinking ?? global.defaults.thinking },
    provenance: {
      github_token: "global",
      defaults: { harness: "global", model: "global", thinking: thinking == null ? "global" : "repository", playbook: "global", draft_autosave: "global" },
    },
    backup: { ...global.backup, destination: overrides.backup.destination ?? global.backup.destination },
    telemetry: global.telemetry,
  } as Config;
}

type Served = { derive: (overrides: RepoOverrides) => Config; read: Settings.RepoSettingsRead };
const served = new Map<string, Served>();
const listeners = new Set<() => void>();
let seq = 1;
let failure: unknown;
const notify = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function row(repo: string): Served {
  const s = served.get(repo);
  if (!s) throw new Error(`fakeSettings: ${repo} is not served`);
  return s;
}

function replace(repo: string, overrides: RepoOverrides): Cursor {
  const s = row(repo);
  seq += 1;
  const cursor = cursorAt(seq);
  served.set(repo, { ...s, read: { settings: { overrides, effective: s.derive(overrides), revision: BigInt(seq) }, ready: true, cursor } });
  notify();
  return cursor;
}

function take(): void {
  if (failure === undefined) return;
  const e = failure;
  failure = undefined;
  throw e;
}

export const fakeSettings = {
  /** Serve `repo`: `derive` is the daemon's precedence for this test (the global tier under the overrides). */
  serve(repo: string, derive: (overrides: RepoOverrides) => Config, overrides: RepoOverrides = EMPTY) {
    seq += 1;
    served.set(repo, { derive, read: { settings: { overrides, effective: derive(overrides), revision: BigInt(seq) }, ready: true, cursor: cursorAt(seq) } });
    notify();
  },
  /** Every `writeRepoOverrides` call, in order. */
  writes: [] as { repo: string; overrides: RepoOverrides; expected: bigint | undefined }[],
  clears: [] as { repo: string; field: string; expected: bigint | undefined }[],
  /** The next write or clear rejects with this. */
  failNext(error: unknown) {
    failure = error;
  },
  /** What the daemon holds for `repo` now. */
  current: (repo: string) => row(repo).read.settings,
  reset() {
    served.clear();
    this.writes.length = 0;
    this.clears.length = 0;
    failure = undefined;
    notify();
  },
};

const NOT_SERVED: Settings.RepoSettingsRead = { ready: false };

export function settingsHooks(actual: typeof Settings): typeof Settings {
  const readSettings = async (repo: string) => {
    const settings = served.get(repo)?.read.settings;
    if (!settings) throw new Error(`fakeSettings: ${repo} is not served`);
    return settings;
  };
  return {
    ...actual,
    useRepoSettings: (repo: string) => useSyncExternalStore(subscribe, () => served.get(repo)?.read ?? NOT_SERVED),
    readRepoSettings: readSettings,
    readEffectiveConfig: async (repo: string) => (await readSettings(repo)).effective,
    writeRepoOverrides: async (repo: string, overrides: RepoOverrides, expected?: bigint) => {
      fakeSettings.writes.push({ repo, overrides, expected });
      take();
      return replace(repo, overrides);
    },
    clearRepoOverride: async (repo: string, field: string, expected?: bigint) => {
      fakeSettings.clears.push({ repo, field, expected });
      take();
      const [section, key] = field.split(".") as ["github" | "defaults" | "backup", string];
      const current = row(repo).read.settings?.overrides ?? EMPTY;
      const next = { ...current, [section]: { ...current[section], [key]: null, ...(field === "defaults.model" ? { harness: null } : {}) } } as RepoOverrides;
      return replace(repo, next);
    },
  };
}

/** Picks the Settings scope from the header's Editing select: a repo path, or "" for All repositories. */
export async function pickScope(repo: string) {
  fireEvent.change(await screen.findByRole("combobox", { name: "Editing" }), { target: { value: repo } });
}
