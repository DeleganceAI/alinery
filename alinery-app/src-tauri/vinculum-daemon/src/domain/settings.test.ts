// Settings (plan S4.1). The conformance cases are the ones Rust's `cargo test -p alinery-core --test conformance`
// also runs: same `input/`, same `expected.json`, and for a write the same bytes under `after/`.
import { create, fromJson, type JsonObject, toJson } from "@bufbuild/protobuf";
import { type Entity, RepoOverridesSchema, SettingSource, SettingsSchema } from "alinery-proto/alinery/v1/entities_pb";
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalize } from "../sync/testkit.ts";
import { BUNDLED_PLAYBOOKS } from "./bundledPlaybooks.ts";
import {
  BUNDLED_PLAYBOOK_KEYS,
  clearOverride,
  defaultGlobal,
  effectiveSettings,
  ensureRepoReady,
  overridesToml,
  parseGlobal,
  parseOverrides,
  pick,
  readSettingsFiles,
  repoSettingsLogLine,
  settingsEntity,
  writeOverridesFile,
} from "./settings.ts";

const CONFORMANCE = resolve(import.meta.dir, "../../../conformance");

/** The shape Rust's serde writes for the same row (conformance.rs `settings`). */
function serdeShape(e: Entity): unknown {
  if (e.value.case !== "settings") throw new Error("not a settings row");
  const s = e.value.value;
  if (s.error) return { error: true };
  const source = (v: unknown): unknown => (typeof v === "string" ? v.replace("SETTING_SOURCE_", "").toLowerCase() : v);
  const json = toJson(SettingsSchema, s, { useProtoFieldName: true }) as { overrides?: unknown; effective?: Record<string, any>; harnesses?: any[] };
  const f = json.effective ?? {};
  return {
    overrides: json.overrides ?? {},
    effective: {
      notifications: f.notifications,
      github: { token: f.github_token ?? "" },
      defaults: f.defaults,
      provenance: { github_token: source(f.github_token_source), defaults: Object.fromEntries(Object.entries(f.defaults_source ?? {}).map(([k, v]) => [k, source(v)])) },
      backup: f.backup,
      telemetry: f.telemetry,
    },
    harnesses: (json.harnesses ?? []).map((h) => ({ ...h.harness, source: source(h.source) })),
  };
}

// Provenance reads "global" for an unspecified (0) enum, the zero value normalize() drops; make the missing side explicit.
const explicitGlobal = (v: any): any => {
  if (Array.isArray(v)) return v.map(explicitGlobal);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === "unspecified" ? "global" : explicitGlobal(x)]));
  return v;
};

describe("settings conformance (read)", () => {
  for (const name of readdirSync(join(CONFORMANCE, "settings"))) {
    test(name, () => {
      const input = join(CONFORMANCE, "settings", name, "input");
      const files = readSettingsFiles(join(input, ".alinery"), join(input, "app.toml"));
      const actual = { "settings/_/repo": serdeShape(settingsEntity(files)) };
      const expected = JSON.parse(readFileSync(join(CONFORMANCE, "settings", name, "expected.json"), "utf8"));
      expect(normalize(explicitGlobal(actual))).toEqual(normalize(expected));
    });
  }
});

describe("settings conformance (write)", () => {
  for (const name of readdirSync(join(CONFORMANCE, "settings_write"))) {
    test(name, () => {
      const dir = join(CONFORMANCE, "settings_write", name);
      const repo = mkdtempSync(join(tmpdir(), "alinery-settings-"));
      try {
        // A case that only writes ships no `input/`: the repo starts empty.
        if (existsSync(join(dir, "input"))) cpSync(join(dir, "input"), repo, { recursive: true });
        const command = JSON.parse(readFileSync(join(dir, "command.json"), "utf8"));
        let ok = true;
        try {
          if (command.op === "write") writeOverridesFile(repo, join(repo, "app.toml"), fromJson(RepoOverridesSchema, command.overrides as JsonObject));
          else {
            const text = readSettingsFiles(join(repo, ".alinery"), join(repo, "app.toml")).config;
            const current = text === undefined ? create(RepoOverridesSchema, {}) : parseOverrides(text);
            if (!current) throw new Error("refused");
            writeOverridesFile(repo, join(repo, "app.toml"), clearOverride(current, command.field));
          }
        } catch {
          ok = false;
        }
        expect({ ok }).toEqual(JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")));
        const after = join(dir, "after/.alinery/config.toml");
        const written = join(repo, ".alinery/config.toml");
        expect(existsSync(written) ? readFileSync(written) : null).toEqual(existsSync(after) ? readFileSync(after) : null);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  }
});

describe("precedence", () => {
  const global = { ...defaultGlobal(), defaults: { ...defaultGlobal().defaults, model: "gpt-5", draftAutosave: true } };
  const of = (init: object) => effectiveSettings(global, create(RepoOverridesSchema, init));
  test("absent inherits", () => {
    const e = of({});
    expect(e.defaults?.model).toBe("gpt-5");
    expect(e.defaultsSource?.model).toBe(SettingSource.GLOBAL);
  });
  test("a blank string is a value", () => {
    const e = of({ defaults: { model: "" } });
    expect(e.defaults?.model).toBe("");
    expect(e.defaultsSource?.model).toBe(SettingSource.REPOSITORY);
  });
  test("false beats a true global", () => {
    const e = of({ defaults: { draftAutosave: false } });
    expect(e.defaults?.draftAutosave).toBe(false);
  });
  test("a clear restores the global value", () => {
    const set = create(RepoOverridesSchema, { defaults: { model: "", harness: "vinculum" } });
    const cleared = clearOverride(set, "defaults.model");
    expect(cleared.defaults?.model).toBeUndefined();
    expect(cleared.defaults?.harness).toBeUndefined(); // the harness stamped beside a model goes too
    expect(effectiveSettings(global, cleared).defaults?.model).toBe("gpt-5");
    expect(set.defaults?.model).toBe(""); // the input is not changed
  });
  test("retention is clamped", () => {
    expect(of({ backup: { retention: 0 } }).backup?.retention).toBe(1);
    expect(of({ backup: { retention: 250 } }).backup?.retention).toBe(100);
  });
  test("pick", () => {
    expect(pick("", "g")).toEqual({ value: "", source: SettingSource.REPOSITORY });
    expect(pick(undefined, "g")).toEqual({ value: "g", source: SettingSource.GLOBAL });
  });
  test("an unknown field is refused", () => {
    expect(() => clearOverride(create(RepoOverridesSchema, {}), "defaults.nonsense")).toThrow("unknown repository override field");
    expect(() => clearOverride(create(RepoOverridesSchema, {}), "nonsense")).toThrow();
  });
});

describe("parsing", () => {
  test("a legacy bare playbook key is scoped by the bundled list", () => {
    expect(parseGlobal('[global.defaults]\nplaybook = "review"\n')?.defaults.playbook).toEqual({ scope: "bundled", key: "review" });
    expect(parseGlobal('[global.defaults]\nplaybook = "mine"\n')?.defaults.playbook).toEqual({ scope: "repo", key: "mine" });
  });
  test("what serde refuses is refused, and unknown keys are not", () => {
    expect(parseOverrides("[defaults]\nmodel = 1\n")).toBeUndefined();
    expect(parseOverrides("[backup]\nretention = 256\n")).toBeUndefined();
    expect(parseOverrides('[defaults.playbook]\nscope = "repo"\nkey = "k"\nextra = 1\n')).toBeUndefined();
    expect(parseOverrides('[mystery]\nx = 1\n[defaults]\nmodel = "m"\n')?.defaults?.model).toBe("m");
    expect(parseGlobal("[global.defaults]\ndraft_autosave = 1\n")).toBeUndefined();
  });
  test("the bundled playbook list is bundledPlaybooks.ts, and the shell's copy in alinery-core types.rs is the same list", () => {
    const keys = BUNDLED_PLAYBOOKS.map(([key]) => key);
    expect(keys.length).toBeGreaterThan(5);
    expect([...BUNDLED_PLAYBOOK_KEYS].sort()).toEqual([...keys].sort());
    const source = readFileSync(resolve(import.meta.dir, "../../../alinery-core/src/types.rs"), "utf8");
    const start = source.indexOf("const LEGACY_BUNDLED_PLAYBOOK_KEYS");
    const rust = [...source.slice(start, source.indexOf("];", start)).matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(rust.sort()).toEqual([...keys].sort());
  });
  test("a missing config.toml is the defaults, an app.toml with a bad value is an error row", () => {
    expect(serdeShape(settingsEntity({}))).toMatchObject({ effective: { defaults: { playbook: { scope: "bundled", key: "superdevelop" } } } });
    expect(serdeShape(settingsEntity({ app: "[global.defaults]\ndraft_autosave = 1\n" }))).toEqual({ error: true });
  });
});

describe("overridesToml", () => {
  test("keys follow the Rust struct's field order whatever order they were set in", () => {
    const o = create(RepoOverridesSchema, { backup: { retention: 3, destination: "/d" }, defaults: { draftAutosave: false, harness: "vinculum" } });
    expect(overridesToml(o)).toBe('[github]\n\n[defaults]\nharness = "vinculum"\ndraft_autosave = false\n\n[backup]\ndestination = "/d"\nretention = 3\n');
  });
  test("what is written parses back to the same overrides", () => {
    const o = create(RepoOverridesSchema, { github: { token: "t" }, defaults: { model: "", playbook: { scope: "global", key: "k" } }, backup: { enabled: false, retention: 0 } });
    const back = parseOverrides(overridesToml(o));
    expect(toJson(RepoOverridesSchema, back!)).toEqual(toJson(RepoOverridesSchema, o));
  });
});

describe("log line", () => {
  const o = (init: object) => create(RepoOverridesSchema, init);
  test("names the changed fields and never a secret", () => {
    const line = repoSettingsLogLine("/r", o({}), o({ github: { token: "ghp-secret" }, defaults: { model: "m" }, backup: { retention: 4 } }));
    expect(line).toBe('settings.repo repo="/r" github.token=changed defaults.model="m" backup.retention=4');
    expect(line).not.toContain("ghp-secret");
  });
  test("a clear is 'cleared'; no change is no line", () => {
    expect(repoSettingsLogLine("/r", o({ defaults: { model: "m" } }), o({}))).toBe('settings.repo repo="/r" defaults.model=cleared');
    expect(repoSettingsLogLine("/r", o({}), o({}))).toBeUndefined();
  });
});

describe("EnsureReady", () => {
  const snapshot = (dir: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        out[p] = Bun.file(p).lastModified;
      }
    };
    walk(dir);
    return out;
  };
  test("creates what is missing once, and a second call touches nothing", async () => {
    const repo = mkdtempSync(join(tmpdir(), "alinery-ready-"));
    try {
      await ensureRepoReady(repo);
      expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("/.alinery/\n");
      for (const f of ["config.toml", "harnesses.toml"]) expect(existsSync(join(repo, ".alinery", f))).toBe(true);
      // The bundled harnesses read as no overlay.
      const files = readSettingsFiles(join(repo, ".alinery"), join(repo, "app.toml"));
      expect((serdeShape(settingsEntity(files)) as any).harnesses.map((h: any) => h.source)).toEqual(["global", "global"]);
      const before = snapshot(repo);
      await Bun.sleep(20);
      await ensureRepoReady(repo);
      expect(snapshot(repo)).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  test("keeps an existing .gitignore and a config the user wrote", async () => {
    const repo = mkdtempSync(join(tmpdir(), "alinery-ready-"));
    try {
      mkdirSync(join(repo, ".alinery"));
      await Bun.write(join(repo, ".gitignore"), "node_modules");
      await Bun.write(join(repo, ".alinery/config.toml"), '[defaults]\nmodel = "mine"\n');
      await ensureRepoReady(repo);
      expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n/.alinery/\n");
      expect(readFileSync(join(repo, ".alinery/config.toml"), "utf8")).toBe('[defaults]\nmodel = "mine"\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
