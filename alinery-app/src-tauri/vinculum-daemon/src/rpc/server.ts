// The RPC socket (T1, plan 2.1.8): grpc-js over HTTP/2 with prior knowledge on `<repo>/.alinery/rpc[-ns].sock`.
// A grpc-js handler can't see its connection's socket, so the peer check runs once per connection,
// at accept, on our own node:net listener, and picks the server built for that peer class.
import { rmSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import * as grpc from "@grpc/grpc-js";
import { AdminService } from "alinery-proto/alinery/v1/admin_pb";
import { BlobService } from "alinery-proto/alinery/v1/blobs_pb";
import { ExecutionService } from "alinery-proto/alinery/v1/executions_pb";
import { JobService } from "alinery-proto/alinery/v1/jobs_pb";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { RepoService, SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { SyncService } from "alinery-proto/alinery/v1/sync_pb";
import { DraftService, TaskService } from "alinery-proto/alinery/v1/tasks_pb";
import { TerminalService } from "alinery-proto/alinery/v1/terminal_pb";
import { adminService, type DaemonInfo, type Lifecycle } from "./admin.ts";
import { credentials, PEER_CLASSES, type PeerClass } from "./auth.ts";
import { addService } from "./grpc.ts";
import type { JobRunner } from "../jobs/runner.ts";
import type { StorageParams } from "../jobs/storage.ts";
import { Dedupe } from "../sync/dedupe.ts";
import type { Store } from "../sync/store.ts";
import { blobService } from "./blobs.ts";
import { executionService } from "./executions.ts";
import { jobService } from "./jobs.ts";
import { sessionService, type Transcripts } from "./sessions.ts";
import { repoService, settingsService, type SettingsDeps } from "./settings.ts";
import { syncService } from "./sync.ts";
import { draftService, type TaskDeps, taskService } from "./tasks.ts";
import { terminalService } from "./terminal.ts";
import { peerExecutable, samePath } from "./peer.ts";

const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

type Hosted = { store: Store; jobs: JobRunner; storageScan: StorageParams; dedupe: Dedupe; transcripts: Transcripts; terminal: ReturnType<typeof terminalService>; settings?: SettingsDeps; tasks?: TaskDeps };

function makeServer(peer: PeerClass, secret: Buffer, info: DaemonInfo, lifecycle: Lifecycle, { store, jobs, storageScan, dedupe, transcripts, terminal, settings, tasks }: Hosted) {
  // A draft carries its pasted images in one message (up to the 100 MB attachment set); grpc-js defaults to 4 MiB.
  const server = new grpc.Server({ "grpc.max_receive_message_length": MAX_MESSAGE_BYTES });
  const values = (header: Headers) => credentials(header, peer, secret);
  addService(server, AdminService, adminService(info, lifecycle, store.epoch), values);
  addService(server, SyncService, syncService(store), values);
  addService(server, JobService, jobService(jobs, dedupe, store, storageScan), values);
  addService(server, SessionService, sessionService(transcripts), values);
  addService(server, TerminalService, terminal, values);
  addService(server, ExecutionService, executionService(dedupe, store), values);
  if (settings) {
    addService(server, SettingsService, settingsService(settings, dedupe, store), values);
    addService(server, RepoService, repoService(settings, dedupe, store), values);
  }
  if (tasks) {
    addService(server, TaskService, taskService(tasks, dedupe, store), values);
    addService(server, DraftService, draftService(tasks, dedupe, store), values);
    addService(server, BlobService, blobService(tasks, dedupe, store), values);
  }
  return server.createConnectionInjector(grpc.ServerCredentials.createInsecure());
}

/** Without a host executable the daemon was started over ssh and every peer is sshd. */
function peerClass(socket: Parameters<typeof peerExecutable>[0], hostExecutable: string | undefined): PeerClass {
  if (!hostExecutable) return "ssh";
  const peer = peerExecutable(socket);
  return peer && samePath(peer, hostExecutable) ? "shell" : "other";
}

export type RpcOptions = { socketPath: string; secret: Buffer; hostExecutable?: string; info: DaemonInfo; lifecycle: Lifecycle; store: Store; jobs: JobRunner; storageScan: StorageParams; transcripts: Transcripts; terminalGapMs?: number; settings?: SettingsDeps; tasks?: TaskDeps };

export function serveRpc(options: RpcOptions): Promise<NetServer> {
  // One dedupe and one attach table for all three peer classes: a client's retry lands on a new connection, not a new class.
  const hosted = { store: options.store, jobs: options.jobs, storageScan: options.storageScan, transcripts: options.transcripts, dedupe: new Dedupe(), terminal: terminalService(options.terminalGapMs), settings: options.settings, tasks: options.tasks };
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
