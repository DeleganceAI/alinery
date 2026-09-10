// @vitest-environment node
// These exercise the node-side build tooling: they read files off disk relative to
// import.meta.url, which is not a file:// URL under the jsdom default.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

it("bundles the Apache license, copyright notice, and third-party license texts", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
    bundle: { licenseFile: string; resources: Record<string, string> };
  };
  const resourceRoot = new URL("../src-tauri/", import.meta.url);
  const bundled = Object.fromEntries(Object.entries(config.bundle.resources).map(([source, destination]) => [destination, readFileSync(new URL(source, resourceRoot), "utf8")]));

  expect(bundled.LICENSE).toContain("Version 2.0, January 2004");
  expect(bundled.LICENSE).toBe(readFileSync(new URL(config.bundle.licenseFile, resourceRoot), "utf8"));
  expect(bundled.NOTICE).toContain("Copyright 2026 Delegance Inc.");
  expect(bundled["THIRD-PARTY-NOTICES.md"]).toContain("Copyright (c) 2025 Mario Zechner");
  expect(bundled["THIRD-PARTY-NOTICES.md"]).toContain(readFileSync(new URL("playbooks/superdevelop/LICENSE.superpowers", resourceRoot), "utf8"));
});

describe("tauri development config overlay", () => {
  it("uses Alinery for the production product identity", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
      productName: string;
      app: { windows: Array<{ title: string; maximized: boolean }> };
    };
    expect(config.productName).toBe("Alinery");
    expect(config.app.windows[0]?.title).toBe("Alinery");
    expect(config.app.windows[0]?.maximized).toBe(true);
  });

  it("uses the approved development product identity", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(config.productName).toBe("Alinery Dev");
    expect(config.identifier).toBe("ai.delegance.alinery.dev");
  });

  it("is narrow and replaces the complete window array with only its title changed", () => {
    const base = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { windows: Array<Record<string, unknown>> } };
    const development = JSON.parse(readFileSync(new URL("../src-tauri/tauri.dev.conf.json", import.meta.url), "utf8")) as { app: { windows: Array<Record<string, unknown>> } };

    expect(Object.keys(development).sort()).toEqual(["app", "identifier", "productName"]);
    expect(development.app.windows).toEqual(base.app.windows.map((window) => ({ ...window, title: "Alinery Dev" })));
  });
});
