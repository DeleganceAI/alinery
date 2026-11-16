// The machine MCP's HTTP listener (M4): the Host and Origin checks against DNS rebinding and cross-site pages, the token on every
// request with its rotation overlap, and that it never listens without the token.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearToken, rotateToken, writeHttp } from "../domain/machineMcp.ts";
import { refusal } from "./http.ts";
import { answers, ask, machinePaths } from "./machine.ts";

const SERVE = join(import.meta.dir, "machineServe.testutil.ts");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:39470/mcp", { method: "POST", headers });

test("on a loopback bind a rebinding Host or a cross-site Origin is forbidden, and the token is required either way", () => {
  const ok = ["t1"];
  expect(refusal(req({ host: "127.0.0.1:39470", authorization: "Bearer t1" }), "127.0.0.1", ok)).toBe(0);
  expect(refusal(req({ host: "localhost:39470", authorization: "Bearer t1" }), "127.0.0.1", ok)).toBe(0);
  expect(refusal(req({ host: "evil.example:39470", authorization: "Bearer t1" }), "127.0.0.1", ok)).toBe(403);
  expect(refusal(req({ host: "127.0.0.1:39470", origin: "https://evil.example", authorization: "Bearer t1" }), "127.0.0.1", ok)).toBe(403);
  expect(refusal(req({ host: "127.0.0.1:39470", origin: "http://127.0.0.1:39470", authorization: "Bearer t1" }), "127.0.0.1", ok)).toBe(0);
  expect(refusal(req({ host: "127.0.0.1:39470" }), "127.0.0.1", ok)).toBe(401);
  expect(refusal(req({ host: "127.0.0.1:39470", authorization: "Bearer t2" }), "127.0.0.1", ok)).toBe(401);
  // No key file: nothing is accepted over HTTP, unlike the owner-only socket.
  expect(refusal(req({ host: "127.0.0.1:39470", authorization: "Bearer t1" }), "127.0.0.1", null)).toBe(401);
  // On all interfaces any Host is fine (the token guards it), but an Origin must still match.
  expect(refusal(req({ host: "box.lan:39470", authorization: "Bearer t1" }), "0.0.0.0", ok)).toBe(0);
  expect(refusal(req({ host: "box.lan:39470", origin: "https://evil.example", authorization: "Bearer t1" }), "0.0.0.0", ok)).toBe(403);
});

test("turning HTTP on needs the token, a bind of this machine and a real port; the token cannot be cleared while it is on", () => {
  const dir = mkdtempSync(join(tmpdir(), "mhttp-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const paths = machinePaths(dir);
  expect(() => writeHttp(paths, { enabled: true, bind: "127.0.0.1", port: 39470 })).toThrow(/token/);
  rotateToken(paths.key);
  expect(() => writeHttp(paths, { enabled: true, bind: "203.0.113.9", port: 39470 })).toThrow(/address of this machine/);
  expect(() => writeHttp(paths, { enabled: true, bind: "127.0.0.1", port: 0 })).toThrow(/port/);
  writeHttp(paths, { enabled: true, bind: "127.0.0.1", port: 39470 });
  expect(() => clearToken(paths)).toThrow(/HTTP off/);
  writeHttp(paths, { enabled: false, bind: "127.0.0.1", port: 39470 });
  clearToken(paths);
});

async function serving(withToken: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "mhttp-"));
  const paths = machinePaths(dir);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const token = withToken ? rotateToken(paths.key) : "";
  writeFileSync(paths.http, JSON.stringify({ enabled: true, bind: "127.0.0.1", port }));
  const proc = Bun.spawn([process.execPath, SERVE, dir, "1"], { stdout: "ignore", stderr: "ignore" });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => proc.kill("SIGKILL"));
  const end = Date.now() + 10_000;
  while (!(await answers(paths.socket))) {
    if (Date.now() > end) throw new Error("the machine MCP did not start");
    await Bun.sleep(50);
  }
  return { paths, url: `http://127.0.0.1:${port}/mcp`, token };
}

const post = (url: string, token: string, body: unknown) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("a real listener serves MCP over POST with the token, refuses without it, offers no GET stream, and spans a rotation", async () => {
  const { paths, url, token } = await serving(true);
  expect((await ask(paths.socket, { op: "status" }, token)).http).toEqual({ listening: true, error: "" });

  const list = await post(url, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(list.status).toBe(200);
  expect(JSON.stringify(await list.json())).toContain("alinery_list_repos");
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
  expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  expect((await post(url, token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

  // A client holding the old token keeps working through the overlap; the new one works at once, with no restart.
  const next = rotateToken(paths.key);
  expect((await post(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(200);
  expect((await post(url, next, { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(200);
});

test("enabled with no token set, it does not listen and says why", async () => {
  const { paths, url } = await serving(false);
  expect((await ask(paths.socket, { op: "status" })).http).toEqual({ listening: false, error: "HTTP needs the token set first" });
  expect(await fetch(url).then(() => "answered", () => "refused")).toBe("refused");
});
