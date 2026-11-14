import { expect, test } from "bun:test";
import { create, equals, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { Capability, HelloResponseSchema } from "./gen/alinery/v1/admin_pb";

// Every field set to a non-default value, so a dropped or renumbered field changes the result.
const full = () =>
  create(HelloResponseSchema, {
    protocol: 25,
    buildId: "build-abc",
    epoch: "epoch-1",
    capabilities: [Capability.VIEW, Capability.ACT, Capability.AGENT],
    repoRoot: "/repo",
    appConfigIdentity: "identity-1",
  });

test("HelloResponse survives toBinary/fromBinary with every field set", () => {
  const sent = full();
  const back = fromBinary(HelloResponseSchema, toBinary(HelloResponseSchema, sent));
  expect(equals(HelloResponseSchema, sent, back)).toBe(true);
  expect(back.capabilities).toEqual([Capability.VIEW, Capability.ACT, Capability.AGENT]);
  expect(back.appConfigIdentity).toBe("identity-1");
});

test("HelloResponse survives toJson/fromJson with every field set", () => {
  const sent = full();
  const back = fromJson(HelloResponseSchema, toJson(HelloResponseSchema, sent));
  expect(equals(HelloResponseSchema, sent, back)).toBe(true);
});

test("equals() notices a changed field", () => {
  const other = full();
  other.epoch = "epoch-2";
  expect(equals(HelloResponseSchema, full(), other)).toBe(false);
});
