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

function isDevLaunch(args) {
  return args.find((arg) => TAURI_SUBCOMMANDS.has(arg)) === "dev";
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

async function run(args) {
  let reservation;
  try {
    if (isDevLaunch(args)) {
      reservation = await reserveDevPort(parseDevPort(process.env.ALINERY_DEV_PORT));
    }
    const launch = selectTauriLaunch(args, import.meta.url, reservation?.port);
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
