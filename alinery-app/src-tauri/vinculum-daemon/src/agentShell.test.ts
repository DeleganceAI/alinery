import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentShellEnv, libreOfficeDir, pythonHome, whichOn, writeShims } from "./agentShell.ts";

const temp = () => mkdtempSync(join(tmpdir(), "agent-shell-"));
function fakePython(home: string) {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "python3"), "");
}

test("the Python beside the executable wins over the one the app passed", () => {
  const dir = temp();
  fakePython(join(dir, "python"));
  fakePython(join(dir, "elsewhere"));
  expect(pythonHome(join(dir, "daemon"), { ALINERY_PYTHON_HOME: join(dir, "elsewhere") })).toBe(join(dir, "python"));
  expect(pythonHome(join(dir, "nowhere", "daemon"), { ALINERY_PYTHON_HOME: join(dir, "elsewhere") })).toBe(join(dir, "elsewhere"));
  expect(pythonHome(join(dir, "nowhere", "daemon"), {})).toBeUndefined();
});

test("Python goes first on PATH, the shims last, and extra packages stay in the repository", () => {
  const env = agentShellEnv({ python: "/rt/python", shims: "/v/bin/abc", repo: "/repo", path: "/usr/bin:/bin" });
  expect(env.PATH).toBe("/rt/python/bin:/repo/.alinery/python-packages/bin:/usr/bin:/bin:/v/bin/abc");
  expect(env.PYTHONUSERBASE).toBe("/repo/.alinery/python-packages");
  expect(agentShellEnv({ repo: "/repo", path: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
});

test("the shims run this executable as bun", () => {
  const dir = temp();
  const shims = writeShims(dir, process.execPath);
  expect(execFileSync(join(shims, "bun"), ["--version"], { encoding: "utf8" }).trim()).toBe(Bun.version);
  expect(execFileSync(join(shims, "node"), ["-e", "console.log(6 * 7)"], { encoding: "utf8" }).trim()).toBe("42");
});

test("tools are found as the shell would, and LibreOffice's app folder only on macOS", () => {
  const dir = temp();
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "a", "qpdf"), "", { mode: 0o644 });
  writeFileSync(join(dir, "b", "qpdf"), "#!/bin/sh\n", { mode: 0o755 });
  expect(whichOn("qpdf", `${join(dir, "a")}:${join(dir, "b")}`)).toBe(join(dir, "b", "qpdf"));
  expect(whichOn("soffice", join(dir, "a"))).toBeUndefined();
  const app = join(dir, "Applications", "LibreOffice.app", "Contents", "MacOS");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "soffice"), "");
  expect(libreOfficeDir("darwin", dir)).toBe(app);
  expect(libreOfficeDir("linux", dir)).toBeUndefined();
});
