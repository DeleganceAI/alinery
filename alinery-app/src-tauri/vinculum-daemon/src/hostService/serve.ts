// `alinery-vinculum-daemon --host-service` (plan S5.2, O15 b): the host's work while no daemon runs, spoken over the stdin and
// stdout of one long-lived process (one ssh channel per host). Messages are proto/alinery/v1/host.proto, framed as
// `[u32 big-endian length][message]`. The process holds each claimed repo's GUI lock for as long as the channel lives; the
// kernel lets the locks go when the channel dies, which is exactly the lifetime the local `claim_repo` has.
import { create, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import {
  HostFolderReply_Kind,
  HostInitReply_Kind,
  HostReplySchema,
  type HostRequest,
  HostRequestSchema,
  HostSpawnDaemon_Launch,
} from "alinery-proto/alinery/v1/host_pb";
import { backupRestore, backupVerify, classifyFolder, Claims, initFolder, listDir, removeFile, spawnDaemon, syncCredentials, waitDaemonGone, writeFile } from "./ops.ts";

/** Printed once, before the first frame: the client skips whatever a login shell printed ahead of it. */
export const MARKER = "alinery-host-service/1\n";
/** A frame longer than this is a broken stream, not a message; refuse it instead of allocating for it. */
export const MAX_FRAME = 64 * 1024 * 1024;

export function frame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + message.length);
  new DataView(out.buffer).setUint32(0, message.length, false);
  out.set(message, 4);
  return out;
}

/** Cuts a byte stream into frames. Throws on a length over `MAX_FRAME`, after which the stream is not trustworthy. */
export class FrameReader {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    if (this.buffer.length === 0) this.buffer = chunk;
    else {
      const joined = new Uint8Array(this.buffer.length + chunk.length);
      joined.set(this.buffer);
      joined.set(chunk, this.buffer.length);
      this.buffer = joined;
    }
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getUint32(0, false);
      if (length > MAX_FRAME) throw new Error(`host service frame of ${length} bytes is over the ${MAX_FRAME} byte limit`);
      if (this.buffer.length < 4 + length) break;
      frames.push(this.buffer.slice(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }
}

type Body = MessageInitShape<typeof HostReplySchema>["body"];
const done: Body = { case: "done", value: {} };

/** Run one call. A thrown Error becomes the reply's `error`; a claim held elsewhere is an answer, not an error. */
export async function handle(call: HostRequest["call"], claims: Claims): Promise<Body> {
  switch (call.case) {
    case "ping":
      return done;
    case "claimRepo":
      return { case: "claim", value: { claimed: claims.claim(call.value.repo) } };
    case "releaseRepo":
      claims.release(call.value.repo);
      return done;
    case "classify": {
      const folder = await classifyFolder(call.value.path);
      const kinds = { checkout: HostFolderReply_Kind.CHECKOUT, absent: HostFolderReply_Kind.ABSENT, refused: HostFolderReply_Kind.REFUSED };
      return {
        case: "folder",
        value: { kind: kinds[folder.kind], path: folder.kind === "refused" ? "" : folder.path, message: folder.kind === "refused" ? folder.message : "" },
      };
    }
    case "init": {
      const result = await initFolder(call.value.path);
      return {
        case: "init",
        value: { kind: result.kind === "initialized" ? HostInitReply_Kind.INITIALIZED : HostInitReply_Kind.ALREADY_CHECKOUT, root: result.root },
      };
    }
    case "listDir":
      return { case: "listing", value: listDir(call.value.path, call.value.showHidden) };
    case "writeFile":
      writeFile(call.value.path, call.value.contents);
      return done;
    case "syncCredentials":
      return { case: "erased", value: { providers: await syncCredentials(call.value.path, call.value.set, call.value.remove, call.value.eraseOauth) } };
    case "removeFile":
      removeFile(call.value.path);
      return done;
    case "backupVerify":
      await backupVerify(call.value.repo, call.value.backupPath);
      return done;
    case "backupRestore":
      await backupRestore(call.value.repo, call.value.backupPath);
      return done;
    case "waitDaemonGone":
      await waitDaemonGone(call.value.repo);
      return done;
    case "spawnDaemon": {
      const v = call.value;
      await spawnDaemon({
        repo: v.repo,
        appConfig: v.appConfig,
        binary: v.binary,
        buildId: v.buildId,
        namespace: v.namespace,
        log: v.log,
        launch: v.launch === HostSpawnDaemon_Launch.SYSTEMD_RUN ? "systemd_run" : "direct",
        unit: v.unit,
        uiSecretFile: v.uiSecretFile,
        rpcSecretFile: v.rpcSecretFile,
        appVersion: v.appVersion,
      });
      return done;
    }
    default:
      throw new Error("the host's runtime does not understand this request");
  }
}

/**
 * Serve until `input` ends. Each request is handled on its own, so a slow git call never holds up a ping, and the write of one
 * reply is a single call, so two replies never interleave. Returns when the input has ended and every started request has answered.
 */
export async function serveHost(input: AsyncIterable<Uint8Array>, write: (bytes: Uint8Array) => void, runtime: string, claims = new Claims()): Promise<void> {
  const reply = (id: bigint, body: Body) => write(frame(toBinary(HostReplySchema, create(HostReplySchema, { id, body }))));
  write(new TextEncoder().encode(MARKER));
  reply(0n, { case: "hello", value: { runtime, pid: process.pid } });

  const reader = new FrameReader();
  const inflight = new Set<Promise<void>>();
  for await (const chunk of input) {
    let frames: Uint8Array[];
    try {
      frames = reader.push(chunk);
    } catch (error) {
      console.error(`host-service: ${(error as Error).message}`);
      break;
    }
    for (const bytes of frames) {
      let request: HostRequest;
      try {
        request = fromBinary(HostRequestSchema, bytes);
      } catch (error) {
        // Without a readable request there is no id to answer; the client times that call out.
        console.error(`host-service: unreadable request: ${(error as Error).message}`);
        continue;
      }
      const run = (async () => {
        let body: Body;
        try {
          if (!request.call.case) throw new Error("the host's runtime does not understand this request");
          body = await handle(request.call, claims);
        } catch (error) {
          body = { case: "error", value: error instanceof Error ? error.message : String(error) };
        }
        reply(request.id, body);
      })();
      inflight.add(run);
      void run.finally(() => inflight.delete(run));
    }
  }
  await Promise.all(inflight);
}

/** `--host-service [--app-version <v>]`: the process entry. Ends when the ssh channel closes stdin; the locks go with the process. */
export async function runHostService(args: string[]): Promise<number> {
  const at = args.indexOf("--app-version");
  const runtime = (at >= 0 && args[at + 1]) || "unknown";
  await serveHost(
    process.stdin as unknown as AsyncIterable<Uint8Array>,
    (bytes) => {
      process.stdout.write(bytes);
    },
    runtime,
  );
  return 0;
}
