// Peer process of a unix-socket connection, as vinculum-daemon/src/main.ts does it today
// (getpeereid + LOCAL_PEERPID on macOS, SO_PEERCRED on Linux), reached from a node:http request.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readlinkSync } from "node:fs";
import type { Socket } from "node:net";

export function socketFd(socket: Socket): number | null {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  return handle && typeof handle.fd === "number" ? handle.fd : null;
}

const darwin =
  process.platform === "darwin"
    ? dlopen("libSystem.B.dylib", {
        getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      })
    : null;
const linux =
  process.platform === "linux"
    ? dlopen("libc.so.6", {
        getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      })
    : null;

export function peerPid(fd: number): number | null {
  const size = Buffer.alloc(4);
  if (darwin) {
    const pid = Buffer.alloc(4);
    size.writeUInt32LE(4, 0);
    if (darwin.symbols.getsockopt(fd, 0 /* SOL_LOCAL */, 2 /* LOCAL_PEERPID */, ptr(pid), ptr(size)) !== 0) return null;
    return pid.readInt32LE(0);
  }
  if (linux) {
    const cred = Buffer.alloc(12);
    size.writeUInt32LE(12, 0);
    if (linux.symbols.getsockopt(fd, 1 /* SOL_SOCKET */, 17 /* SO_PEERCRED */, ptr(cred), ptr(size)) !== 0) return null;
    return cred.readInt32LE(0);
  }
  return null;
}

export function peerExecutable(socket: Socket): string | null {
  const fd = socketFd(socket);
  if (fd == null) return null;
  const pid = peerPid(fd);
  if (!pid || pid <= 0) return null;
  if (linux) return readlinkSync(`/proc/${pid}/exe`);
  const path = Buffer.alloc(4096);
  const n = darwin!.symbols.proc_pidpath(pid, ptr(path), path.length);
  return n > 0 ? path.subarray(0, n).toString() : null;
}
