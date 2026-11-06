import { expect, test } from "bun:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { Capability } from "alinery-proto/alinery/v1/admin_pb";
import { TOOL_RPCS, TOOLS } from "../mcpServer/tools.ts";
import { AGENT_RPCS, capabilitiesOf, credentials, TokenRegistry } from "./auth.ts";

const SECRET = Buffer.from("ab".repeat(32));
const headers = (token?: string) => new Headers(token === undefined ? {} : { authorization: `Bearer ${token}` });
const caps = (token: string | undefined, method: string, tokens: TokenRegistry, peer: "shell" | "other" | "ssh" = "shell") =>
  [...capabilitiesOf({ values: credentials(headers(token), peer, SECRET, tokens, method) } as never)].map((c) => Capability[c]).sort();

test("an AGENT credential may call exactly the RPCs behind the 26 MCP tools (O18 b)", () => {
  expect(TOOLS.length).toBe(26);
  expect([...AGENT_RPCS.keys()].sort()).toEqual([...TOOL_RPCS].sort());
});

test("no AGENT RPC is Shutdown, an approval or a token mint", () => {
  for (const method of AGENT_RPCS.keys()) expect(method).not.toMatch(/Shutdown|Approv|MintToken|Takeover|Restore/i);
});

test("a minted token holds AGENT plus the capability of an allowed call, and AGENT alone for any other", () => {
  const tokens = new TokenRegistry();
  const token = tokens.mint("test");
  expect(caps(token, "alinery.v1.SyncService/Subscribe", tokens)).toEqual(["AGENT", "VIEW"]);
  expect(caps(token, "alinery.v1.TaskService/CreateTask", tokens)).toEqual(["ACT", "AGENT"]);
  expect(caps(token, "alinery.v1.AdminService/Shutdown", tokens)).toEqual(["AGENT"]);
  expect(caps(token, "alinery.v1.AdminService/MintToken", tokens)).toEqual(["AGENT"]);
  expect(caps(token, "alinery.v1.AdminService/Hello", tokens)).toEqual(["AGENT"]);
});

test("the daemon's own secret keeps its full set, and no token or a wrong one is UNAUTHENTICATED", () => {
  const tokens = new TokenRegistry();
  expect(caps(SECRET.toString(), "alinery.v1.AdminService/Shutdown", tokens)).toEqual(["ACT", "ADMIN", "APPROVE", "VIEW"]);
  for (const given of [undefined, "wrong", ""]) {
    try {
      credentials(headers(given), "shell", SECRET, tokens, "alinery.v1.AdminService/Hello");
      throw new Error("accepted");
    } catch (e) {
      expect((e as ConnectError).code).toBe(Code.Unauthenticated);
    }
  }
});

test("a second mint under one label keeps the first valid until the third (a call mid-flight survives a refresh)", () => {
  const tokens = new TokenRegistry();
  const first = tokens.mint("shell");
  const second = tokens.mint("shell");
  expect(tokens.has(first)).toBe(true);
  expect(tokens.has(second)).toBe(true);
  const third = tokens.mint("shell");
  expect(tokens.has(first)).toBe(false);
  expect(tokens.has(second)).toBe(true);
  expect(tokens.has(third)).toBe(true);
  expect(tokens.has(tokens.mint("other"))).toBe(true);
  expect(tokens.has(third)).toBe(true);
});
