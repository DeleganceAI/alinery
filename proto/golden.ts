// Writes golden/admin.json and golden/host.json: the bytes protobuf-es produces for the admin and settings messages the Rust shell
// hand-encodes (src-tauri/src/daemon_rpc.rs). Every field is set to a value that differs from its
// default and from its neighbours, so a renumbered or retyped field changes the bytes. The shell's
// `tests::daemon_rpc` decodes these; check-proto-gen.sh regenerates the file and diffs it. host.json holds the host service's
// messages (host.proto), which the shell hand-encodes too (src-tauri/src/host_wire.rs, tested by `tests::host_wire`).
//
//   bun golden.ts            writes golden/admin.json
import { mkdirSync, writeFileSync } from "node:fs";
import { create, toBinary, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { EnsureReadyRequestSchema, WriteHostedInferenceRequestSchema, WriteHostedInferenceResponseSchema } from "./gen/alinery/v1/settings_pb";
import {
  HostBackupRestoreSchema,
  HostBackupVerifySchema,
  HostClaimReplySchema,
  HostClaimRepoSchema,
  HostClassifySchema,
  HostDoneSchema,
  HostErasedSchema,
  HostFolderReply_Kind,
  HostFolderReplySchema,
  HostHelloSchema,
  HostInitReply_Kind,
  HostInitReplySchema,
  HostInitSchema,
  HostListDirSchema,
  HostListingSchema,
  HostPingSchema,
  HostReleaseRepoSchema,
  HostRemoveFileSchema,
  HostReplySchema,
  HostRequestSchema,
  HostSpawnDaemon_Launch,
  HostSpawnDaemonSchema,
  HostSyncCredentialsSchema,
  HostWaitDaemonGoneSchema,
  HostWriteFileSchema,
} from "./gen/alinery/v1/host_pb";
import { Capability, HelloRequestSchema, HelloResponseSchema, MintTokenRequestSchema, MintTokenResponseSchema, ShutdownOrigin, ShutdownRequestSchema, ShutdownResponseSchema } from "./gen/alinery/v1/admin_pb";

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
  MintTokenRequest: hex(MintTokenRequestSchema, { capability: Capability.AGENT, label: "managed-mcp" }),
  MintTokenResponse: hex(MintTokenResponseSchema, { token: "ab12cd34" }),
  EnsureReadyRequest: hex(EnsureReadyRequestSchema, { meta: { clientId: "client-1", mutationId: "mutation-1" } }),
  WriteHostedInferenceRequest: hex(WriteHostedInferenceRequestSchema, { meta: { clientId: "client-1", mutationId: "mutation-2" }, inferenceJson: '{"token":"inf_x"}' }),
  WriteHostedInferenceResponse: hex(WriteHostedInferenceResponseSchema, {}),
};

mkdirSync(new URL("./golden", import.meta.url), { recursive: true });
writeFileSync(new URL("./golden/admin.json", import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);

const request = (id: number, call: MessageInitShape<typeof HostRequestSchema>["call"]) => hex(HostRequestSchema, { id: BigInt(id), call });
const reply = (id: number, body: MessageInitShape<typeof HostReplySchema>["body"]) => hex(HostReplySchema, { id: BigInt(id), body });

const host = {
  "request.ping": request(1, { case: "ping", value: create(HostPingSchema) }),
  "request.claim_repo": request(2, { case: "claimRepo", value: create(HostClaimRepoSchema, { repo: "/srv/claim" }) }),
  "request.release_repo": request(3, { case: "releaseRepo", value: create(HostReleaseRepoSchema, { repo: "/srv/release" }) }),
  "request.classify": request(4, { case: "classify", value: create(HostClassifySchema, { path: "/srv/classify" }) }),
  "request.init": request(5, { case: "init", value: create(HostInitSchema, { path: "/srv/init" }) }),
  "request.list_dir": request(6, { case: "listDir", value: create(HostListDirSchema, { path: "/srv/list", showHidden: true }) }),
  "request.write_file": request(7, { case: "writeFile", value: create(HostWriteFileSchema, { path: "/srv/c/app.toml", contents: "x = 1\n" }) }),
  "request.sync_credentials": request(8, {
    case: "syncCredentials",
    value: create(HostSyncCredentialsSchema, { path: "/srv/c/creds.json", set: { anthropic: '{"type":"api_key"}' }, remove: ["old"], eraseOauth: true }),
  }),
  "request.remove_file": request(9, { case: "removeFile", value: create(HostRemoveFileSchema, { path: "/srv/c/inference.json" }) }),
  "request.backup_verify": request(10, { case: "backupVerify", value: create(HostBackupVerifySchema, { repo: "/srv/verify", backupPath: "/srv/b/verify.zip" }) }),
  "request.backup_restore": request(11, { case: "backupRestore", value: create(HostBackupRestoreSchema, { repo: "/srv/restore", backupPath: "/srv/b/restore.zip" }) }),
  "request.wait_daemon_gone": request(12, { case: "waitDaemonGone", value: create(HostWaitDaemonGoneSchema, { repo: "/srv/gone" }) }),
  "request.spawn_daemon": request(13, {
    case: "spawnDaemon",
    value: create(HostSpawnDaemonSchema, {
      repo: "/srv/spawn",
      appConfig: "/srv/c/app.toml",
      binary: "/srv/rt/alinery-vinculum-daemon",
      buildId: "abc123",
      namespace: "dev",
      log: "/srv/c/logs/d.log",
      launch: HostSpawnDaemon_Launch.SYSTEMD_RUN,
      unit: "alinery-daemon-abc",
      rpcSecretFile: "/srv/c/rpc-secrets/a.rpc",
      appVersion: "0.26.0",
    }),
  }),
  "reply.error": reply(21, { case: "error", value: "no such folder" }),
  "reply.hello": reply(0, { case: "hello", value: create(HostHelloSchema, { runtime: "0.26.0", pid: 4242 }) }),
  "reply.done": reply(22, { case: "done", value: create(HostDoneSchema) }),
  "reply.claim": reply(23, { case: "claim", value: create(HostClaimReplySchema, { claimed: true }) }),
  "reply.folder": reply(24, { case: "folder", value: create(HostFolderReplySchema, { kind: HostFolderReply_Kind.REFUSED, path: "/srv/folder", message: "not a work tree" }) }),
  "reply.init": reply(25, { case: "init", value: create(HostInitReplySchema, { kind: HostInitReply_Kind.ALREADY_CHECKOUT, root: "/srv/root" }) }),
  "reply.listing": reply(26, {
    case: "listing",
    value: create(HostListingSchema, {
      path: "/srv/home",
      entries: [
        { name: "alpha", git: true, symlink: false },
        { name: "beta", git: false, symlink: true },
      ],
      truncated: true,
    }),
  }),
  "reply.erased": reply(27, { case: "erased", value: create(HostErasedSchema, { providers: ["codex", "openai"] }) }),
};

writeFileSync(new URL("./golden/host.json", import.meta.url), `${JSON.stringify(host, null, 2)}\n`);
