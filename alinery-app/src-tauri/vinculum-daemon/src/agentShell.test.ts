import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentShellEnv, libreOfficeDir, runtimePart, whichOn, writeShims } from "./agentShell.ts";

const temp = () => mkdtempSync(join(tmpdir(), "agent-shell-"));
function fakePython(home: string) {
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "python3"), "");
}

test("the runtime beside the executable wins over the one the app unpacked", () => {
  const dir = temp();
  fakePython(join(dir, "python"));
  fakePython(join(dir, "unpacked", "python"));
  mkdirSync(join(dir, "unpacked", "skills"));
  writeFileSync(join(dir, "unpacked", "skills", "included.json"), "{}");
  const env = { ALINERY_RUNTIME_HOME: join(dir, "unpacked") };
  expect(runtimePart("python", join(dir, "daemon"), env)).toBe(join(dir, "python"));
  expect(runtimePart("skills", join(dir, "daemon"), env)).toBe(join(dir, "unpacked", "skills"));
  expect(runtimePart("python", join(dir, "nowhere", "daemon"), env)).toBe(join(dir, "unpacked", "python"));
  expect(runtimePart("python", join(dir, "nowhere", "daemon"), {})).toBeUndefined();
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

// Needs the runtime's Python (pypdfium2): beside this executable or at ALINERY_RUNTIME_HOME, which the app sets.
const runtimePython = runtimePart("python", process.execPath, process.env);
test.skipIf(!runtimePython)("the pdftoppm shim draws pages under poppler's names, and refuses an option it lacks", () => {
  const dir = temp();
  const shims = writeShims(dir, process.execPath);
  const env = { ...process.env, ...agentShellEnv({ python: runtimePython, shims, repo: dir, path: "/usr/bin:/bin" }) };
  const run = (...args: string[]) => execFileSync("pdftoppm", args, { cwd: dir, env, encoding: "utf8", stdio: "pipe" });
  execFileSync("python3", ["-I", "-c", "import pypdfium2 as p, sys\nd = p.PdfDocument.new()\nfor _ in range(12): d.new_page(200, 100)\nd.save(sys.argv[1])", "deck.pdf"], { cwd: dir, env });
  run("-jpeg", "-r", "36", "-f", "9", "-l", "10", "deck.pdf", "slide");
  run("-png", "-scale-to", "400", "-f", "2", "-singlefile", "deck.pdf", "one");
  expect(readdirSync(dir).filter((n) => /\.(jpg|png)$/.test(n)).sort()).toEqual(["one.png", "slide-09.jpg", "slide-10.jpg"]);
  expect(() => run("-cropbox", "deck.pdf", "x")).toThrow("-cropbox is not supported");
});
