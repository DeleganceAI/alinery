import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// An undefined custom property in `var(--x)` is invalid at computed-value
// time, so `outline: 2px solid var(--x)` silently becomes `outline: none`.
describe("CSS custom properties", () => {
  let css = "";
  let runtime = "";
  for (const file of readdirSync("src", { recursive: true, encoding: "utf8" })) {
    if (file.includes(".test.")) continue;
    if (file.endsWith(".css")) css += readFileSync(join("src", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    else if (/\.tsx?$/.test(file)) runtime += readFileSync(join("src", file), "utf8");
  }

  it("defines every var() used without a fallback", () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g), ...runtime.matchAll(/["'`](--[\w-]+)["'`]/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
