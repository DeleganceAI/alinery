import { expect, test } from "bun:test";
import { create, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Capability, HelloResponseSchema, ShutdownOrigin } from "alinery-proto/alinery/v1/admin_pb";

// The daemon reaches the generated code through the `alinery-proto` package `exports` map.
test("alinery-proto resolves in the daemon and round-trips a HelloResponse", () => {
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
  expect(ShutdownOrigin.CONFIRMED_TAKEOVER).toBe(4);
});
