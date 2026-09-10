// @vitest-environment node
// These exercise the node-side build tooling: they read files off disk relative to
// import.meta.url, which is not a file:// URL under the jsdom default.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { childEnvironment, parseDevPort, reserveDevPort, selectTauriLaunch } from "./tauri.mjs";

const DEV_CONFIG_ARGS = ["--config", "src-tauri/tauri.dev.conf.json"];

const SOURCE_ROOT = join("/tmp", "Alinery source with spaces", "日本語");
const PACKAGE_ROOT = join(SOURCE_ROOT, "alinery-app");
const MODULE_URL = pathToFileURL(join(PACKAGE_ROOT, "scripts", "tauri.mjs")).href;

function generatedDevConfig(args: string[]) {
  return JSON.parse(args[args.length - 1] ?? "") as {
    build: { beforeDevCommand: string; devUrl: string };
  };
}

describe("selectTauriLaunch", () => {
  it("derives the package and source roots and gives dev one coordinated launch plan", () => {
    const launch = selectTauriLaunch(["dev"], MODULE_URL, 4317);

    expect(launch.packageRoot).toBe(PACKAGE_ROOT);
    expect(launch.sourceRoot).toBe(SOURCE_ROOT);
    expect(launch.args.slice(0, -2)).toEqual(["dev", ...DEV_CONFIG_ARGS]);
    expect(launch.args[launch.args.length - 2]).toBe("--config");
    expect(generatedDevConfig(launch.args)).toEqual({
      build: {
        beforeDevCommand: "bash src-tauri/scripts/copy-sidecar.sh debug && npm run dev -- --port 4317",
        devUrl: "http://localhost:4317",
      },
    });
    expect(launch.environment).toEqual({
      VITE_ALINERY_DEV_LAUNCH_ROOT: SOURCE_ROOT,
      ALINERY_DEV_LAUNCH_ROOT: SOURCE_ROOT,
    });
  });

  it("preserves dev flags and makes the generated port overlay the final config", () => {
    const launch = selectTauriLaunch(["dev", "--release", "--config", "caller.conf.json", "--features", "fixture"], MODULE_URL, 4318);

    expect(launch.args.slice(0, -2)).toEqual(["dev", "--release", "--config", "caller.conf.json", "--features", "fixture", ...DEV_CONFIG_ARGS]);
    expect(launch.args[launch.args.length - 2]).toBe("--config");
    expect(generatedDevConfig(launch.args).build).toEqual({
      beforeDevCommand: "bash src-tauri/scripts/copy-sidecar.sh debug && npm run dev -- --port 4318",
      devUrl: "http://localhost:4318",
    });
    expect(launch.environment.VITE_ALINERY_DEV_LAUNCH_ROOT).toBe(SOURCE_ROOT);
    expect(launch.environment.ALINERY_DEV_LAUNCH_ROOT).toBe(SOURCE_ROOT);
  });

  it("detects dev after forwarded global options", () => {
    const launch = selectTauriLaunch(["--verbose", "dev", "--release"], MODULE_URL, 4319);
    expect(launch.args.slice(0, -2)).toEqual(["--verbose", "dev", "--release", ...DEV_CONFIG_ARGS]);
  });

  it("leaves production build arguments byte-for-byte unchanged and adds no environment", () => {
    const args = ["build", "--bundles", "app"];
    const launch = selectTauriLaunch(args, MODULE_URL);

    expect(launch.args).toEqual(args);
    expect(launch.environment).toEqual({});
  });

  it("leaves other subcommands and no-subcommand invocations unchanged with no environment", () => {
    expect(selectTauriLaunch(["info"], MODULE_URL)).toMatchObject({ args: ["info"], environment: {} });
    expect(selectTauriLaunch(["--version"], MODULE_URL)).toMatchObject({ args: ["--version"], environment: {} });
    expect(selectTauriLaunch([], MODULE_URL)).toMatchObject({ args: [], environment: {} });
  });

  it("does not mutate the caller argument array", () => {
    const args = ["dev", "--release"];
    const original = [...args];

    selectTauriLaunch(args, MODULE_URL, 4320);

    expect(args).toEqual(original);
  });

  it("scrubs stale launch provenance before creating every child environment", () => {
    const parent = {
      PATH: "/bin",
      VITE_ALINERY_DEV_LAUNCH_ROOT: "/private/stale/frontend",
      ALINERY_DEV_LAUNCH_ROOT: "/private/stale/backend",
    };

    expect(childEnvironment(parent, {})).toEqual({ PATH: "/bin" });
    expect(
      childEnvironment(parent, {
        VITE_ALINERY_DEV_LAUNCH_ROOT: SOURCE_ROOT,
        ALINERY_DEV_LAUNCH_ROOT: SOURCE_ROOT,
      }),
    ).toEqual({
      PATH: "/bin",
      VITE_ALINERY_DEV_LAUNCH_ROOT: SOURCE_ROOT,
      ALINERY_DEV_LAUNCH_ROOT: SOURCE_ROOT,
    });
  });

  it("validates deterministic ALINERY_DEV_PORT overrides", () => {
    expect(parseDevPort(undefined)).toBeUndefined();
    expect(parseDevPort("")).toBeUndefined();
    expect(parseDevPort("4317")).toBe(4317);
    expect(() => parseDevPort("0")).toThrow("ALINERY_DEV_PORT");
    expect(() => parseDevPort("4317x")).toThrow("ALINERY_DEV_PORT");
    expect(() => parseDevPort("65536")).toThrow("ALINERY_DEV_PORT");
  });

  it("reserves distinct ports for two concurrent launch plans", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "alinery-dev-port-test-"));
    const reservations: Array<{ port: number; release: () => Promise<void> }> = [];
    try {
      const first = await reserveDevPort(undefined, lockDirectory);
      reservations.push(first);
      const second = await reserveDevPort(undefined, lockDirectory);
      reservations.push(second);

      expect(second.port).not.toBe(first.port);
      expect(generatedDevConfig(selectTauriLaunch(["dev"], MODULE_URL, first.port).args).build.devUrl).toBe(`http://localhost:${first.port}`);
      expect(generatedDevConfig(selectTauriLaunch(["dev"], MODULE_URL, second.port).args).build.devUrl).toBe(`http://localhost:${second.port}`);
      await expect(reserveDevPort(first.port, lockDirectory)).rejects.toThrow(`ALINERY_DEV_PORT ${first.port} is unavailable`);
    } finally {
      await Promise.all(reservations.map((reservation) => reservation.release()));
      await rm(lockDirectory, { recursive: true, force: true });
    }
  });
});
