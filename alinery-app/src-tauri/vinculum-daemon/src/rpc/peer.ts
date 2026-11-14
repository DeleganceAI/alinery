// Who is on the other end of a unix-socket connection: the peer's executable, read with
// getpeereid + LOCAL_PEERPID on macOS and SO_PEERCRED on Linux (moved from main.ts, S1.1).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readlinkSync, realpathSync } from "node:fs";
import type { Socket } from "node:net";

function socketFd(socket: Socket): number | null {
  const record: unknown = socket;
  if (!record || typeof record !== "object" || !("_handle" in record)) return null;
  const handle = record._handle;
  if (!handle || typeof handle !== "object" || !("fd" in handle) || typeof handle.fd !== "number") return null;
  return handle.fd;
}

// libSystem has no getpeerid. Match alinery-core peer_process_id: getpeereid, then LOCAL_PEERPID.
const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

export function peerExecutable(socket: Socket): string | null {
  const fd = socketFd(socket);
  if (fd == null) return null;
  try {
    if (process.platform === "darwin") return darwinPeerExecutable(fd);
    if (process.platform === "linux") return linuxPeerExecutable(fd);
    return null;
  } catch {
    return null;
  }
}

function darwinPeerExecutable(fd: number): string | null {
  const libc = dlopen("libSystem.B.dylib", {
    getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    geteuid: { args: [], returns: FFIType.u32 },
    proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const uid = Buffer.alloc(4);
  const gid = Buffer.alloc(4);
  if (libc.symbols.getpeereid(fd, ptr(uid), ptr(gid)) !== 0) return null;
  if (uid.readUInt32LE(0) !== libc.symbols.geteuid()) return null;
  const pid = Buffer.alloc(4);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4, 0);
  if (libc.symbols.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, ptr(pid), ptr(size)) !== 0) return null;
  if (size.readUInt32LE(0) !== 4) return null;
  const pidNum = pid.readInt32LE(0);
  if (pidNum <= 0) return null;
  const path = Buffer.alloc(4096);
  const length = libc.symbols.proc_pidpath(pidNum, ptr(path), path.length);
  if (length <= 0) return null;
  return path.subarray(0, length).toString().replace(/\0+$/, "");
}

function linuxPeerExecutable(fd: number): string | null {
  const libc = dlopen("libc.so.6", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    geteuid: { args: [], returns: FFIType.u32 },
  });
  const cred = Buffer.alloc(12);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(12, 0);
  if (libc.symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(cred), ptr(size)) !== 0) return null;
  if (size.readUInt32LE(0) < 12) return null;
  const pidNum = cred.readInt32LE(0);
  const peerUid = cred.readUInt32LE(4);
  if (pidNum <= 0 || peerUid !== libc.symbols.geteuid()) return null;
  return readlinkSync(`/proc/${pidNum}/exe`);
}
export function samePath(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}
