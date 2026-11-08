import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendException, appendInfo, logPath, quoteLogValue } from "./log.ts";
import { tryLockExclusive } from "./lock.ts";

const dirs: string[] = [];
const appConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), "alinery-log-"));
  dirs.push(dir);
  return join(dir, "app.toml");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a line has the timestamp, a 9-wide level, pid and process label", () => {
  const app = appConfig();
  appInfo(app);
  const line = readFileSync(logPath(app), "utf8").trimEnd();
  expect(line).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ info      pid=\d+ proc=alinery-vinculum-daemon hello$/);
  appendException(app, "boom");
  expect(readFileSync(logPath(app), "utf8")).toContain(" exception pid=");
});
const appInfo = (app: string) => appendInfo(app, "hello");

test("values are quoted on one line", () => {
  expect(quoteLogValue('a "b"\n\\c')).toBe('"a \\"b\\"\\n\\\\c"');
  expect(quoteLogValue("\x07")).toBe('"\\x07"');
});

test("a long line is capped at 4096 bytes on a character boundary", () => {
  const app = appConfig();
  appendInfo(app, "é".repeat(5000));
  const line = readFileSync(logPath(app), "utf8").trimEnd();
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096);
  expect(line).toEndWith(" …truncated");
  expect(line).not.toContain("\ufffd");
});

test("the log rotates at 1 MB and keeps five files", () => {
  const app = appConfig();
  mkdirSync(join(app, "..", "logs"), { recursive: true });
  const big = "x".repeat(1_000_000 - 10);
  for (let i = 0; i < 7; i++) {
    writeFileSync(logPath(app), `${big}\n`);
    appendInfo(app, `n${i}`);
  }
  const files = readdirSync(join(app, "..", "logs")).filter((f) => f.startsWith("alinery.log") && !f.endsWith(".lock")).sort();
  expect(files).toEqual(["alinery.log", "alinery.log.1", "alinery.log.2", "alinery.log.3", "alinery.log.4"]);
  expect(readFileSync(logPath(app), "utf8")).toContain("n6");
});

test("a held lock drops the line instead of blocking forever", () => {
  const app = appConfig();
  appendInfo(app, "first");
  const held = tryLockExclusive(join(app, "..", "logs", "alinery.log.lock"));
  try {
    const started = performance.now();
    appendInfo(app, "dropped");
    expect(performance.now() - started).toBeGreaterThan(300);
  } finally {
    held?.release();
  }
  expect(readFileSync(logPath(app), "utf8")).not.toContain("dropped");
  expect(existsSync(logPath(app))).toBe(true);
});
