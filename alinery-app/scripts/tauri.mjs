#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
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

// The Vinculum daemon is the externalBin, but no cargo or tauri step compiles it (copy-sidecar.sh only places it). These
// two launches compile it beside the app executable they are about to run; every other subcommand leaves it alone.
export function piDaemonCompile(args) {
  const subcommand = args.find((arg) => TAURI_SUBCOMMANDS.has(arg));
  if (!PI_DAEMON_SUBCOMMANDS.has(subcommand)) {
    return undefined;
  }
  return { release: args.includes("--release") || (subcommand === "build" && !args.includes("--debug")) };
}

// Remote (SSH) repos install the Linux and macOS runtimes bundled by scripts/build-remote-runtimes.sh,
// which dev and build run first. A build without them still serves local repos, so a missing one only warns; release sets
// ALINERY_REQUIRE_REMOTE_RUNTIMES=1 to make it fatal. Every target counts: a Linux builder skips the darwin ones (no vtool or
// codesign), and that build could not open a macOS host.
export const REMOTE_RUNTIME_TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-apple-darwin", "aarch64-apple-darwin"];

export function remoteRuntimesProblem(manifestText) {
  let targets = {};
  try {
    targets = JSON.parse(manifestText ?? "").targets ?? {};
  } catch {
    // Absent or unreadable manifest counts as no runtimes.
  }
  const missing = REMOTE_RUNTIME_TARGETS.filter((triple) => !(triple in targets));
  if (missing.length === 0) return undefined;
  return `no bundled remote runtime for ${missing.join(", ")} (run scripts/build-remote-runtimes.sh on a Mac, or copy a full resources/remote/ and set ALINERY_REMOTE_RUNTIMES_PREBUILT=1); remote repositories on those systems will be unavailable in this build`;
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

/** What the daemon is compiled from, as `dev-fetch-bun.sh` judges its output stale. */
export function piDaemonInputs(sourceRoot) {
  const pkg = join(sourceRoot, "alinery-app", "src-tauri", "vinculum-daemon");
  return [join(pkg, "src"), join(pkg, "package.json"), join(sourceRoot, "playbook-engine", "src"), join(sourceRoot, "proto", "gen")];
}

/** `task` once `ms` after the last trigger, and never two at once: a trigger during a run runs it once more after. */
export function settledRunner(task, ms) {
  let timer;
  let running = false;
  let again = false;
  const fire = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
      if (again) {
        again = false;
        trigger();
      }
    }
  };
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(fire, ms);
  };
  return trigger;
}

// `tauri dev` rebuilds and restarts the app when its Rust changes, but compiles the daemon only at launch. After a pull
// that changes the protocol, the restarted app took over the old daemon and started the same stale binary, which it
// then had to take over again. Recompiling on a source change keeps the binary current; a daemon already running keeps
// its old build until a takeover or a stop restarts it.
function watchPiDaemon(sourceRoot, release) {
  const recompile = settledRunner(() => {
    console.log("alinery-vinculum-daemon: sources changed, recompiling");
    return compilePiDaemon(sourceRoot, release);
  }, 1000);
  const watchers = piDaemonInputs(sourceRoot).map((path) => {
    try {
      return watch(path, { recursive: true }, recompile);
    } catch {
      return undefined; // a missing input is the compile's to report
    }
  });
  return () => {
    for (const watcher of watchers) watcher?.close();
  };
}

// Remote (SSH) repos need the bundled Linux and macOS runtimes, so dev and build refresh them
// first. A failure (no Bun, offline before Bun's cross targets are cached) only warns here; build
// then checks the manifest, which ALINERY_REQUIRE_REMOTE_RUNTIMES=1 makes fatal.
async function buildRemoteRuntimes(sourceRoot) {
  const code = await new Promise((resolve) => {
    const child = spawn("bash", [join(sourceRoot, "scripts", "build-remote-runtimes.sh")], { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on("exit", (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    console.warn(`build-remote-runtimes.sh failed (exit ${code}); remote repositories may be unavailable in this build`);
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
    const subcommand = args.find((arg) => TAURI_SUBCOMMANDS.has(arg));
    // A release whose runtimes were built on another machine (a Linux job given the macOS job's) keeps them: the build
    // script starts by deleting the old archives.
    if ((subcommand === "dev" || subcommand === "build") && process.env.ALINERY_REMOTE_RUNTIMES_PREBUILT !== "1") {
      await buildRemoteRuntimes(launch.sourceRoot);
    }
    if (subcommand === "build") {
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
    const stopWatching = compile && subcommand === "dev" ? watchPiDaemon(launch.sourceRoot, compile.release) : undefined;

    child.on("error", async (error) => {
      stopWatching?.();
      await reservation?.release();
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", async (code, signal) => {
      stopWatching?.();
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
