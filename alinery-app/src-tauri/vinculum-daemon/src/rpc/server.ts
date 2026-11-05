// The RPC socket (T1, plan 2.1.8): grpc-js over HTTP/2 with prior knowledge on `<repo>/.alinery/rpc[-ns].sock`.
// A grpc-js handler can't see its connection's socket, so the peer check runs once per connection,
// at accept, on our own node:net listener, and picks the server built for that peer class.
import { rmSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import * as grpc from "@grpc/grpc-js";
import { AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { adminService, type DaemonInfo, type Lifecycle } from "./admin.ts";
import { credentials, PEER_CLASSES, type PeerClass } from "./auth.ts";
import { addService } from "./grpc.ts";
import type { JobRunner } from "../jobs/runner.ts";
import type { StorageParams } from "../jobs/storage.ts";
import { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { jobService } from "./jobs.ts";
import { syncService } from "./sync.ts";
import { peerExecutable, samePath } from "./peer.ts";

type Hosted = { store: Store; jobs: JobRunner; storageScan: StorageParams; dedupe: Dedupe };

function makeServer(peer: PeerClass, secret: Buffer, info: DaemonInfo, lifecycle: Lifecycle, { store, jobs, storageScan, dedupe }: Hosted) {
  const server = new grpc.Server();
  const values = (header: Headers) => credentials(header, peer, secret);
  addService(server, AdminService, adminService(info, lifecycle, store.epoch), values);
  addService(server, SyncService, syncService(store), values);
  addService(server, JobService, jobService(jobs, dedupe, store, storageScan), values);
  return server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
}

/** Without a host executable the daemon was started over ssh and every peer is sshd. */
function peerClass(socket: Parameters<typeof peerExecutable>[0], hostExecutable: string | undefined): PeerClass {
  if (!hostExecutable) return "ssh";
  const peer = peerExecutable(socket);
  return peer && samePath(peer, hostExecutable) ? "shell" : "other";
}

export type RpcOptions = { socketPath: string; secret: Buffer; hostExecutable?: string; info: DaemonInfo; lifecycle: Lifecycle; store: Store; jobs: JobRunner; storageScan: StorageParams };

export function serveRpc(options: RpcOptions): Promise<NetServer> {
  // One dedupe for all three peer classes: a client's retry lands on a new connection, not a new class.
  const hosted = { store: options.store, jobs: options.jobs, storageScan: options.storageScan, dedupe: new Dedupe() };
  const servers = new Map(PEER_CLASSES.map((p) => [p, makeServer(p, options.secret, options.info, options.lifecycle, hosted)]));
  const net = createNetServer((sock) => {
    sock.on("error", () => {});
    servers.get(peerClass(sock, options.hostExecutable))!.injectConnection(sock);
  });
  rmSync(options.socketPath, { force: true });
  // bind(2) gives a socket 0777 minus the umask, and a chmod after listen would leave a window, so
  // the umask is 0177 (mode 0600) around listen. Bun binds synchronously inside listen(); the umask
  // is process-wide, so it is put back before anything else runs.
  const previous = process.umask(0o177);
  try {
    net.listen(options.socketPath);
  } finally {
    process.umask(previous);
  }
  return new Promise((resolve, reject) => {
    net.once("error", reject);
    net.once("listening", () => resolve(net));
  });
}
