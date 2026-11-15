// The machine MCP's optional HTTP listener (docs/machine-mcp-plan.md M4, M10): Streamable HTTP, JSON answers only (no SSE stream),
// off by default, and refused unless the token is set, because other OS users and any page doing DNS rebinding can reach even
// loopback. No TLS: the listener speaks plain HTTP, and wrapping it is the user's job.
import { readFileSync } from "node:fs";
import type { Context } from "./handlers.ts";
import { handleRequest } from "./server.ts";

type Json = Record<string, unknown>;

export type HttpSettings = { enabled: boolean; bind: string; port: number };
export const HTTP_DEFAULTS: HttpSettings = { enabled: false, bind: "127.0.0.1", port: 39470 };

/** The settings file beside the key; absent or unreadable is the defaults, which keep HTTP off. */
export function readHttpSettings(path: string): HttpSettings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HttpSettings>;
    return {
      enabled: raw.enabled === true,
      bind: typeof raw.bind === "string" && raw.bind ? raw.bind : HTTP_DEFAULTS.bind,
      port: Number.isInteger(raw.port) && (raw.port as number) > 0 && (raw.port as number) < 65536 ? (raw.port as number) : HTTP_DEFAULTS.port,
    };
  } catch {
    return { ...HTTP_DEFAULTS };
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopback = (bind: string) => LOOPBACK.has(bind);

/** The host part of a Host or Origin value: `[::1]:39470` → `::1`, `localhost:39470` → `localhost`. */
function hostOf(value: string): string {
  const bare = value.replace(/^[a-z]+:\/\//i, "").split("/")[0];
  if (bare.startsWith("[")) return bare.slice(1, bare.indexOf("]"));
  return bare.split(":")[0].toLowerCase();
}

/**
 * Whether a request may be served, as an HTTP status (0 when it may). On a loopback bind the Host must name loopback, which defeats
 * DNS rebinding; on any bind an Origin must name the same host as Host, so a page on another site cannot call it from a browser.
 * The token is required on every request either way.
 */
export function refusal(req: Request, bind: string, accepted: string[] | null): number {
  const host = req.headers.get("host") ?? "";
  if (isLoopback(bind) && !LOOPBACK.has(hostOf(host))) return 403;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null" && hostOf(origin) !== hostOf(host)) return 403;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!accepted?.length || !given || !accepted.includes(given)) return 401;
  return 0;
}

export type HttpListener = { listening: boolean; error: string; stop: () => void };

/** Starts the listener when the settings say so and a token is set; reports why not otherwise. */
export function serveHttp(settings: HttpSettings, ctx: Context, accepted: () => string[] | null): HttpListener {
  if (!settings.enabled) return { listening: false, error: "", stop: () => {} };
  if (!accepted()?.length) return { listening: false, error: "HTTP needs the token set first", stop: () => {} };
  try {
    const server = Bun.serve({
      hostname: settings.bind,
      port: settings.port,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path !== "/mcp") return new Response("not found", { status: 404 });
        const refused = refusal(req, settings.bind, accepted());
        if (refused) return new Response(refused === 401 ? "a valid Authorization: Bearer token is required" : "forbidden", { status: refused, headers: refused === 401 ? { "WWW-Authenticate": "Bearer" } : {} });
        // No server-initiated stream: a GET for one is not offered (Streamable HTTP lets a server say so with 405).
        if (req.method !== "POST") return new Response("only POST", { status: 405, headers: { Allow: "POST" } });
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
        }
        const one = async (message: unknown) => (message && typeof message === "object" ? handleRequest(ctx, message as Json) : null);
        if (Array.isArray(body)) {
          const answers = (await Promise.all(body.map(one))).filter(Boolean);
          return answers.length ? Response.json(answers) : new Response(null, { status: 202 });
        }
        const answer = await one(body);
        // A notification or a response gets no body.
        return answer ? Response.json(answer) : new Response(null, { status: 202 });
      },
    });
    return { listening: true, error: "", stop: () => server.stop(true) };
  } catch (e) {
    return { listening: false, error: `could not listen on ${settings.bind}:${settings.port}: ${(e as Error).message}`, stop: () => {} };
  }
}
