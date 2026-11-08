#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DEV_PORT = 1420;
const DEV_CONFIG_ARGS = ["--config", "src-tauri/tauri.dev.conf.json"];
const LAUNCH_ROOT_KEYS = ["VITE_ALINERY_DEV_LAUNCH_ROOT", "ALINERY_DEV_LAUNCH_ROOT"];
const TAURI_SUBCOMMANDS = new Set([
  "add",
  "android",
  "build",
  "bundle",
  "completions",
  "dev",
  "icon",
  "info",
  "init",
  "inspect",
  "ios",
  "migrate",
  "permission",
  "plugin",
  "remove",
  "signer",
]);

const PI_DAEMON_SUBCOMMANDS = new Set(["dev", "build"]);

function isDevLaunch(args) {
  return args.find((arg) => TAURI_SUBCOMMANDS.has(arg)) === "dev";
}

// The Vinculum daemon is deliberately not an externalBin, so no
// cargo or tauri step compiles it. These two launches compile it beside the app
// executable they are about to run; every other subcommand leaves it alone.
export function piDaemonCompile(args) {
  const subcommand = args.find((arg) => TAURI_SUBCOMMANDS.has(arg));
  if (!PI_DAEMON_SUBCOMMANDS.has(subcommand)) {
    return undefined;
  }
  return { release: args.includes("--release") || (subcommand === "build" && !args.includes("--debug")) };
}

// Remote (SSH) repos install the Linux runtimes bundled by scripts/build-remote-runtimes.sh.
// A build without them still serves local repos, so a missing set only warns; release sets
// ALINERY_REQUIRE_REMOTE_RUNTIMES=1 to make it fatal.
export function remoteRuntimesProblem(manifestText) {
  let targets = {};
  try {
    targets = JSON.parse(manifestText ?? "").targets ?? {};
  } catch {
    // Absent or unreadable manifest counts as no runtimes.
  }
  return Object.keys(targets).length > 0 ? undefined : "no bundled remote runtimes (run scripts/build-remote-runtimes.sh); remote repositories will be unavailable in this build";
}

function devServerConfig(port) {
  return JSON.stringify({
    build: {
      beforeDevCommand: `bash src-tauri/scripts/copy-sidecar.sh debug && npm run dev -- --port ${port}`,
      devUrl: `http://localhost:${port}`,
    },
  });
}

export function selectTauriLaunch(args, moduleUrl, devPort = DEFAULT_DEV_PORT) {
  const packageRoot = dirname(dirname(fileURLToPath(moduleUrl)));
  const sourceRoot = dirname(packageRoot);
  const isDev = isDevLaunch(args);

  return {
    packageRoot,
    sourceRoot,
    args: isDev ? [...args, ...DEV_CONFIG_ARGS, "--config", devServerConfig(devPort)] : [...args],
    environment: isDev
      ? {
          VITE_ALINERY_DEV_LAUNCH_ROOT: sourceRoot,
          ALINERY_DEV_LAUNCH_ROOT: sourceRoot,
        }
      : {},
  };
}

export function childEnvironment(parentEnvironment, launchEnvironment) {
  const environment = { ...parentEnvironment };
  for (const key of LAUNCH_ROOT_KEYS) {
    delete environment[key];
  }
  return { ...environment, ...launchEnvironment };
}

export function parseDevPort(value) {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`ALINERY_DEV_PORT must be an integer from 1 to 65535, received ${JSON.stringify(value)}`);
  }
  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(`ALINERY_DEV_PORT must be an integer from 1 to 65535, received ${JSON.stringify(value)}`);
  }
  return port;
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "localhost", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function lockOwner(lockPath) {
  try {
    const [owner] = (await readFile(lockPath, "utf8")).split("\n");
    const pid = Number(owner);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function claimPortLock(port, lockDirectory) {
  const lockPath = join(lockDirectory, `alinery-dev-port-${port}.lock`);
  const token = `${process.pid}\n${randomUUID()}\n`;
  const candidatePath = join(lockDirectory, `.alinery-dev-port-${port}-${randomUUID()}`);
  await writeFile(candidatePath, token, { flag: "wx", mode: 0o600 });

  try {
    for (;;) {
      try {
        await link(candidatePath, lockPath);
        let released = false;
        return async () => {
          if (released) {
            return;
          }
          released = true;
          try {
            if ((await readFile(lockPath, "utf8")) === token) {
              await rm(lockPath);
            }
          } catch (error) {
            if (error?.code !== "ENOENT") {
              throw error;
            }
          }
        };
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
      }

      const owner = await lockOwner(lockPath);
      if (owner && processIsAlive(owner)) {
        return undefined;
      }

      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, stalePath);
        await rm(stalePath, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
}

export async function reserveDevPort(requestedPort, lockDirectory = tmpdir()) {
  const firstPort = requestedPort ?? DEFAULT_DEV_PORT;
  const lastPort = requestedPort ?? 65535;

  for (let port = firstPort; port <= lastPort; port += 1) {
    if (!(await portIsAvailable(port))) {
      continue;
    }
    const release = await claimPortLock(port, lockDirectory);
    if (!release) {
      continue;
    }
    if (await portIsAvailable(port)) {
      return { port, release };
    }
    await release();
  }

  if (requestedPort !== undefined) {
    throw new Error(`ALINERY_DEV_PORT ${requestedPort} is unavailable`);
  }
  throw new Error(`no available development port found at or above ${DEFAULT_DEV_PORT}`);
}

// --no-download keeps a launch from reaching the network for a toolchain: an
// absent Bun only skips the optional daemon, and never fails the launch.
async function compilePiDaemon(sourceRoot, release) {
  const args = [join(sourceRoot, "scripts", "dev-fetch-bun.sh"), "--no-download", ...(release ? ["--release"] : [])];
  const code = await new Promise((resolve) => {
    const child = spawn("bash", args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("exit", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    console.error(`alinery-vinculum-daemon: compile failed (exit ${code}); Vinculum stays unavailable`);
  }
}

async function run(args) {
  let reservation;
  try {
    if (isDevLaunch(args)) {
      reservation = await reserveDevPort(parseDevPort(process.env.ALINERY_DEV_PORT));
    }
    const launch = selectTauriLaunch(args, import.meta.url, reservation?.port);
    const compile = piDaemonCompile(args);
    if (args.find((arg) => TAURI_SUBCOMMANDS.has(arg)) === "build") {
      const manifest = await readFile(join(launch.packageRoot, "src-tauri", "resources", "remote", "manifest.json"), "utf8").catch(() => undefined);
      const problem = remoteRuntimesProblem(manifest);
      if (problem && process.env.ALINERY_REQUIRE_REMOTE_RUNTIMES === "1") {
        throw new Error(problem);
      }
      if (problem) {
        console.warn(problem);
      }
    }
    if (compile) {
      await compilePiDaemon(launch.sourceRoot, compile.release);
    }
    const executable = join(launch.packageRoot, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
    const child = spawn(executable, launch.args, {
      env: childEnvironment(process.env, launch.environment),
      stdio: "inherit",
    });

    child.on("error", async (error) => {
      await reservation?.release();
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", async (code, signal) => {
      await reservation?.release();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
    });
  } catch (error) {
    await reservation?.release();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void run(process.argv.slice(2));
}
