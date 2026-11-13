// What an agent's shell gets beyond the daemon's own environment, so the office skills run on any machine: the bundled
// Python first on PATH, extra Python packages kept per repository, and `bun` (with `node`, `npm` and `npx` as
// fallbacks) when the machine has no such command.
//
// The Python is the runtime's `python/` (scripts/python-runtime/stage.sh), found by `runtimePart`. The shims run this
// executable as the Bun CLI (BUN_BE_BUN=1).
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { writeAtomic } from "./platform/fs.ts";

/** A directory of the runtime (`python` or `skills`): beside this executable on an ssh host, or in the runtime the app
 * unpacked for its local daemon (ALINERY_RUNTIME_HOME, `pi_durable::local_runtime_home`). */
export function runtimePart(part: "python" | "skills", execPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const probe = part === "python" ? join("bin", "python3") : "included.json";
  for (const home of [dirname(execPath), env.ALINERY_RUNTIME_HOME]) {
    if (home && existsSync(join(home, part, probe))) return join(home, part);
  }
  return undefined;
}

// ponytail: npm and npx map onto bun's nearest commands; flags bun lacks fail loudly, which beats having no npm at all.
const SHIMS: Record<string, string> = { bun: "", node: "", npm: "", npx: "x" };

/** Writes the shims for this executable once, in a directory named by its path, so daemons of two builds never share one. */
export function writeShims(vinculumDir: string, execPath: string): string {
  const dir = join(vinculumDir, "bin", createHash("sha256").update(execPath).digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });
  for (const [name, sub] of Object.entries(SHIMS)) {
    const script = `#!/bin/sh\nBUN_BE_BUN=1 exec '${execPath.replaceAll("'", "'\\''")}' ${sub}${sub ? " " : ""}"$@"\n`;
    writeAtomic(join(dir, name), script, 0o755);
  }
  return dir;
}

/** macOS keeps LibreOffice's `soffice` inside its app, off PATH; the skills call it by name. */
export function libreOfficeDir(platform = process.platform, home = homedir()): string | undefined {
  if (platform !== "darwin") return undefined;
  return ["/Applications", join(home, "Applications")].map((apps) => join(apps, "LibreOffice.app", "Contents", "MacOS")).find((dir) => existsSync(join(dir, "soffice")));
}

/** LibreOffice's `soffice`, looked up now (it may be installed while the daemon runs): on PATH, or in its macOS app. */
export function findSoffice(path = process.env.PATH ?? ""): string | undefined {
  const app = libreOfficeDir();
  return whichOn("soffice", path) ?? (app ? join(app, "soffice") : undefined);
}

export function agentShellEnv(o: { python?: string; shims?: string; repo: string; path?: string; libreOffice?: string }): Record<string, string> {
  const userBase = join(o.repo, ".alinery", "python-packages");
  const front = o.python ? [join(o.python, "bin"), join(userBase, "bin")] : [];
  // The shims go last: a real node or bun on the machine wins.
  const parts = [...front, ...(o.path ?? "").split(delimiter).filter(Boolean), ...(o.libreOffice ? [o.libreOffice] : []), ...(o.shims ? [o.shims] : [])];
  return { PATH: parts.join(delimiter), ...(o.python ? { PYTHONUSERBASE: userBase, PIP_DISABLE_PIP_VERSION_CHECK: "1" } : {}) };
}

/** The programs the office skills reach for, found as the agent's shell would find them. */
export const OFFICE_TOOLS = ["python3", "bun", "soffice", "pdftoppm", "qpdf"] as const;

export function whichOn(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {}
  }
  return undefined;
}
