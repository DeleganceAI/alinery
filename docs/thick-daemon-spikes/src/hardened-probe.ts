// S0.5 hardened-runtime probe: does bun:ffi dlopen libSystem.B.dylib, and do flock, errno and
// F_FULLFSYNC work, in a binary signed like the shipped daemon? Prints one JSON line, exits 0 when
// every check passes. Standalone on purpose: compile this file alone.
//
//   bun build --compile src/hardened-probe.ts --outfile /tmp/hardened-probe
//   codesign --force --timestamp --options runtime --entitlements <release daemon entitlements.plist> \
//     --sign "Developer ID Application: <team>" /tmp/hardened-probe
//   codesign -dv --entitlements - /tmp/hardened-probe   # expect flags=0x10000(runtime)
//   /tmp/hardened-probe
import { dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const EWOULDBLOCK = 35;
const F_FULLFSYNC = 51;
const result: Record<string, unknown> = { execPath: process.execPath, bun: Bun.version };
let ok = false;
const dir = mkdtempSync(join(tmpdir(), "hardened-probe-"));
try {
  const libc = dlopen("libSystem.B.dylib", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __error: { args: [], returns: FFIType.ptr },
  });
  result.dlopen = "ok";
  const path = join(dir, "probe.lock");
  const a = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  const b = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  result.flock_first = libc.symbols.flock(a, LOCK_EX | LOCK_NB);
  result.flock_second = libc.symbols.flock(b, LOCK_EX | LOCK_NB);
  result.errno_second = read.i32(libc.symbols.__error() as Pointer, 0);
  result.f_fullfsync = libc.symbols.fcntl(a, F_FULLFSYNC);
  closeSync(a);
  closeSync(b);
  ok = result.flock_first === 0 && result.flock_second === -1 && result.errno_second === EWOULDBLOCK && result.f_fullfsync === 0;
} catch (error) {
  result.error = String(error);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok, ...result }));
process.exit(ok ? 0 : 1);
