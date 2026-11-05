import { create, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Capability, HelloResponseSchema, ShutdownOrigin } from "alinery-proto/alinery/v1/admin_pb";
import { describe, expect, it } from "vitest";

// The app reaches the generated code through the `alinery-proto` package `exports` map.
// A resolution break (a missing proto/node_modules, a changed exports map) fails here.
describe("alinery-proto", () => {
  it("resolves and round-trips a HelloResponse", () => {
    const sent = create(HelloResponseSchema, {
      protocol: 25,
      buildId: "b",
      epoch: "e",
      capabilities: [Capability.VIEW, Capability.ADMIN],
      repoRoot: "/r",
      appConfigIdentity: "i",
    });
    const back = fromBinary(HelloResponseSchema, toBinary(HelloResponseSchema, sent));
    expect(equals(HelloResponseSchema, sent, back)).toBe(true);
    expect(back.appConfigIdentity).toBe("i");
    expect(back.capabilities).toEqual([Capability.VIEW, Capability.ADMIN]);
  });

  it("exposes the shutdown origins of invariant 1", () => {
    expect(ShutdownOrigin.CONFIRMED_TAKEOVER).toBe(4);
  });
});
