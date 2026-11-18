import { describe, expect, it } from "vitest";
import { loopbackTarget } from "./providerAccess";

// The address comes from the daemon's own prompt, never from a port this app assumes: it is the
// redirect URI of whichever agent runtime the daemon runs.
describe("loopbackTarget", () => {
  it("reads the daemon's redirect address out of its prompt", () => {
    expect(loopbackTarget("http://127.0.0.1:1455/auth/callback")).toEqual({ port: 1455, path: "/auth/callback" });
  });

  it("follows the runtime when the port or path changes", () => {
    expect(loopbackTarget("http://127.0.0.1:8080/oauth/done")).toEqual({ port: 8080, path: "/oauth/done" });
  });

  it("takes a bare origin as the root path", () => {
    expect(loopbackTarget("http://127.0.0.1:1455")).toEqual({ port: 1455, path: "/" });
  });

  it("refuses anything that is not a loopback http address this app can bind", () => {
    for (const value of [
      undefined,
      "",
      "https://127.0.0.1:1455/auth/callback",
      "http://localhost:1455/auth/callback",
      "http://example.com:1455/auth/callback",
      "http://127.0.0.1:0/auth/callback",
      "http://127.0.0.1:99999/auth/callback",
      "http://127.0.0.1:1455/auth/callback?code=ac_2",
      "http://127.0.0.1:1455/auth/callback#frag",
    ]) {
      expect(loopbackTarget(value), String(value)).toBeNull();
    }
  });
});
