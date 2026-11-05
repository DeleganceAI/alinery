// Writes golden/admin.json: the bytes protobuf-es produces for the admin messages the Rust shell
// hand-encodes (src-tauri/src/daemon_rpc.rs). Every field is set to a value that differs from its
// default and from its neighbours, so a renumbered or retyped field changes the bytes. The shell's
// `tests::daemon_rpc` decodes these; check-proto-gen.sh regenerates the file and diffs it.
//
//   bun golden.ts            writes golden/admin.json
import { mkdirSync, writeFileSync } from "node:fs";
import { create, toBinary, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Capability, HelloRequestSchema, HelloResponseSchema, ShutdownOrigin, ShutdownRequestSchema, ShutdownResponseSchema } from "./gen/alinery/v1/admin_pb";

const hex = <D extends DescMessage>(schema: D, init: MessageInitShape<D>) => Buffer.from(toBinary(schema, create(schema, init))).toString("hex");

const golden = {
  ShutdownRequest: hex(ShutdownRequestSchema, { origin: ShutdownOrigin.CONFIRMED_TAKEOVER, confirmationId: "confirm-1" }),
  ShutdownResponse: hex(ShutdownResponseSchema, { sessionsStopped: 300 }),
  HelloRequest: hex(HelloRequestSchema, { clientId: "client-1", clientKind: "desktop", protocol: 25 }),
  HelloResponse: hex(HelloResponseSchema, {
    protocol: 25,
    buildId: "build-abc",
    epoch: "epoch-1",
    capabilities: [Capability.VIEW, Capability.ACT, Capability.ADMIN],
    repoRoot: "/repo",
    appConfigIdentity: "identity-1",
  }),
};

mkdirSync(new URL("./golden", import.meta.url), { recursive: true });
writeFileSync(new URL("./golden/admin.json", import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);
