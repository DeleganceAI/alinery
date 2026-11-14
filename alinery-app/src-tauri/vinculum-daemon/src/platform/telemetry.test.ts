import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { consented, eventRecord, ingestUrl, sanitizeHarness, sanitizePhase, sanitizePlaybook, SEND_TIMEOUT_MS, telemetrySender } from "./telemetry.ts";

const CASES = resolve(import.meta.dir, "../../../conformance/telemetry");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function appToml(telemetry: string): string {
  const dir = mkdtempSync(join(tmpdir(), "alinery-telemetry-"));
  dirs.push(dir);
  const path = join(dir, "app.toml");
  writeFileSync(path, `settings_version = 1\n\n[global.telemetry]\n${telemetry}\n`);
  return path;
}

describe("the record", () => {
  for (const name of readdirSync(CASES)) {
    test(`${name} equals Rust's event_record`, () => {
      const event = JSON.parse(readFileSync(join(CASES, name, "event.json"), "utf8"));
      const expected = JSON.parse(readFileSync(join(CASES, name, "expected.json"), "utf8"));
      const actual = { ...eventRecord(event, "11111111-2222-3333-4444-555555555555", "VERSION"), os: "OS" };
      expect(actual).toEqual(expected);
    });
  }
  test("the ingest url and the allowlists", () => {
    expect(ingestUrl("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/api/default/alinery_usage/_json");
    expect([sanitizeHarness("vinculum"), sanitizeHarness("claude")]).toEqual(["vinculum", "custom"]);
    expect([sanitizePlaybook("review"), sanitizePlaybook("mine")]).toEqual(["review", "custom"]);
    expect([sanitizePhase(""), sanitizePhase("tdd"), sanitizePhase("x")]).toEqual(["", "tdd", "custom"]);
  });
  test("consent needs enabled, prompted and an install id", () => {
    const base = { enabled: true, prompted: true, installId: "id", endpoint: "" };
    expect(consented(base)).toBe(true);
    expect(consented({ ...base, enabled: false })).toBe(false);
    expect(consented({ ...base, prompted: false })).toBe(false);
    expect(consented({ ...base, installId: "" })).toBe(false);
  });
});

describe("the sender", () => {
  const event = { event: "settings.change", source: "alineryd", scope: "repo" } as const;
  const listener = () => {
    const bodies: { auth: string | null; body: unknown; url: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push({ auth: req.headers.get("authorization"), body: await req.json(), url: new URL(req.url).pathname });
        return new Response("{}");
      },
    });
    return { bodies, server, endpoint: `http://127.0.0.1:${server.port}` };
  };

  test("with consent one record goes to the endpoint named in app.toml", async () => {
    const l = listener();
    try {
      const path = appToml(`enabled = true\nprompted = true\ninstall_id = "abc"\nendpoint = "${l.endpoint}"`);
      telemetrySender(path, "9.9.9").record(() => event);
      await Bun.sleep(300);
      expect(l.bodies).toHaveLength(1);
      expect(l.bodies[0].url).toBe("/api/default/alinery_usage/_json");
      expect(l.bodies[0].auth).toStartWith("Basic ");
      expect(l.bodies[0].body).toEqual([{ event: "settings.change", app_version: "9.9.9", os: process.platform === "darwin" ? "macos" : process.platform, anon_id: "abc", props: { source: "alineryd", scope: "repo" } }]);
    } finally {
      l.server.stop(true);
    }
  });

  test("a consent change in app.toml applies to the next event with no restart", async () => {
    const l = listener();
    try {
      const path = appToml(`enabled = false\nprompted = true\ninstall_id = "abc"\nendpoint = "${l.endpoint}"`);
      const sender = telemetrySender(path, "1.0.0");
      sender.record(() => event);
      writeFileSync(path, `[global.telemetry]\nenabled = true\nprompted = true\ninstall_id = "abc"\nendpoint = "${l.endpoint}"\n`);
      sender.record(() => event);
      await Bun.sleep(300);
      expect(l.bodies).toHaveLength(1);
    } finally {
      l.server.stop(true);
    }
  });

  test("with consent off nothing is sent, and the event is not even built", async () => {
    const l = listener();
    try {
      let built = 0;
      for (const toml of [`enabled = false\nprompted = true\ninstall_id = "abc"`, `enabled = true\nprompted = false\ninstall_id = "abc"`, `enabled = true\nprompted = true`]) {
        telemetrySender(appToml(`${toml}\nendpoint = "${l.endpoint}"`), "1.0.0").record(() => (built++, event));
      }
      telemetrySender(join(tmpdir(), "no-such-dir", "app.toml"), "1.0.0").record(() => (built++, event));
      await Bun.sleep(3000);
      expect(l.bodies).toHaveLength(0);
      expect(built).toBe(0);
    } finally {
      l.server.stop(true);
    }
  });

  test("an unreachable endpoint neither throws nor delays the caller", async () => {
    const path = appToml(`enabled = true\nprompted = true\ninstall_id = "abc"\nendpoint = "http://127.0.0.1:1"`);
    const started = performance.now();
    expect(() => telemetrySender(path, "1.0.0").record(() => event)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(50);
    await Bun.sleep(100); // the failed send settles without an unhandled rejection
  });

  test("a hung endpoint is given up on after the timeout", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const path = appToml(`enabled = true\nprompted = true\ninstall_id = "abc"\nendpoint = "http://127.0.0.1:${server.port}"`);
      let outcome = "pending";
      const sender = telemetrySender(path, "1.0.0", (url, init) => fetch(url, init).then(() => (outcome = "ok"), () => (outcome = "dropped")));
      sender.record(() => event);
      await Bun.sleep(SEND_TIMEOUT_MS + 500);
      expect(outcome).toBe("dropped");
    } finally {
      server.stop(true);
    }
  });
});
