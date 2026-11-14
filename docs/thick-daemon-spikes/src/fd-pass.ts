// S7.1 research: can one Bun process hand a PTY master fd to another (SCM_RIGHTS), so a keeper
// could give a session's PTY to a restarted brain? Everything through bun:ffi to libc; Bun has no
// API for ancillary data, and Bun.Terminal does not expose its master fd (see the end).
//
//   bun src/fd-pass.ts            # sender: prints one JSON line, exits 0 when every check passes
//   bun src/fd-pass.ts bun-terminal   # same, but the master is the one inside a Bun.Terminal
//
// Sender: posix_openpt + grantpt + unlockpt + ptsname, opens the slave, spawns `sh` on the slave,
// makes a socketpair, spawns the receiver (this file, `receive`) with one end as its fd 3,
// sendmsg(SCM_RIGHTS) the master, then CLOSES its own master. Receiver: recvmsg, writes a line to
// the master, reads the PTY back (the line discipline's echo, then the shell's reply), and prints it.
// The shell also writes what it read to a file the sender checks: a third party saw the bytes.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const darwin = process.platform === "darwin";
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOL_SOCKET = darwin ? 0xffff : 1;
const SCM_RIGHTS = 1;
const O_NOCTTY = darwin ? 0x20000 : 0x100;
// struct msghdr: macOS has int msg_iovlen and socklen_t msg_controllen; glibc has size_t for both.
const MSG = darwin ? { size: 48, iov: 16, iovlen: 24, control: 32, controllen: 40, wide: false } : { size: 56, iov: 16, iovlen: 24, control: 32, controllen: 40, wide: true };
// struct cmsghdr: macOS {u32 len; int level; int type} aligned to 4; glibc {size_t len; int; int} aligned to 8.
const CMSG = darwin ? { hdr: 12, space: 16, len: 16 } : { hdr: 16, space: 24, len: 20 };

const libc = dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
  socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
  grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
  unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
  ptsname: { args: [FFIType.i32], returns: FFIType.cstring },
  isatty: { args: [FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
});
const c = libc.symbols;

/** One byte of payload plus one SCM_RIGHTS fd (send), or room for one (receive). */
function message(fd: number | null) {
  const payload = new Uint8Array([0x46]); // "F"
  const iov = new DataView(new ArrayBuffer(16));
  iov.setBigUint64(0, BigInt(ptr(payload)), true);
  iov.setBigUint64(8, 1n, true);
  const control = new DataView(new ArrayBuffer(CMSG.space));
  if (fd !== null) {
    if (darwin) control.setUint32(0, CMSG.len, true);
    else control.setBigUint64(0, BigInt(CMSG.len), true);
    control.setInt32(CMSG.hdr - 8, SOL_SOCKET, true);
    control.setInt32(CMSG.hdr - 4, SCM_RIGHTS, true);
    control.setInt32(CMSG.hdr, fd, true);
  }
  const msg = new DataView(new ArrayBuffer(MSG.size));
  msg.setBigUint64(MSG.iov, BigInt(ptr(iov)), true);
  msg.setBigUint64(MSG.control, BigInt(ptr(control)), true);
  if (MSG.wide) {
    msg.setBigUint64(MSG.iovlen, 1n, true);
    msg.setBigUint64(MSG.controllen, BigInt(CMSG.space), true);
  } else {
    msg.setInt32(MSG.iovlen, 1, true);
    msg.setUint32(MSG.controllen, CMSG.space, true);
  }
  // Keep the buffers alive with the msghdr that points into them.
  return { msg, keep: [payload, iov, control], control };
}

function sendFd(sock: number, fd: number): number {
  const m = message(fd);
  return Number(c.sendmsg(sock, ptr(m.msg), 0));
}

async function recvFd(sock: number): Promise<number> {
  const m = message(null);
  for (let i = 0; i < 500; i++) {
    const n = Number(c.recvmsg(sock, ptr(m.msg), 0));
    if (n > 0) {
      const level = m.control.getInt32(CMSG.hdr - 8, true);
      const type = m.control.getInt32(CMSG.hdr - 4, true);
      if (level !== SOL_SOCKET || type !== SCM_RIGHTS) throw new Error(`no SCM_RIGHTS: level ${level} type ${type}`);
      return m.control.getInt32(CMSG.hdr, true);
    }
    await Bun.sleep(10); // fd 3 may be inherited non-blocking
  }
  throw new Error("recvmsg: nothing arrived");
}

function openMaster(): { master: number; slavePath: string } {
  const master = c.posix_openpt(constants.O_RDWR | O_NOCTTY);
  if (master < 0 || c.grantpt(master) !== 0 || c.unlockpt(master) !== 0) throw new Error("posix_openpt failed");
  return { master, slavePath: String(c.ptsname(master)) };
}

/** Bun.Terminal's master is private. Diff /dev/fd around the constructor and keep the new tty fds. */
function bunTerminalMaster() {
  const before = new Set(readdirSync("/dev/fd"));
  const terminal = new Bun.Terminal({ cols: 80, rows: 24, data() {} });
  const added = readdirSync("/dev/fd")
    .filter((f) => !before.has(f))
    .map(Number)
    .filter((fd) => c.isatty(fd) === 1);
  // ptsname only succeeds on a master (TIOCPTYGNAME / TIOCGPTN), so it tells master from slave.
  // Bun 1.4.3 holds the master twice (a dup, same device and inode), so keep distinct ones.
  const masters = added.filter((fd) => c.ptsname(fd) !== null);
  const ids = new Set(masters.map((fd) => { const s = fstatSync(fd); return `${s.dev}:${s.ino}:${s.rdev}`; }));
  return { terminal, added, masters, distinct: ids.size };
}

async function sender(mode: string) {
  const result: Record<string, unknown> = { bun: Bun.version, platform: `${process.platform}/${process.arch}`, mode };
  const dir = mkdtempSync(join(tmpdir(), "s71-fdpass-"));
  const seen = join(dir, "shell-saw");
  let ok = false;
  try {
    let master: number;
    let shell: Bun.Subprocess;
    let terminal: Bun.Terminal | undefined;
    if (mode === "bun-terminal") {
      const t = bunTerminalMaster();
      terminal = t.terminal;
      result.bunTerminalNewTtyFds = t.added;
      result.bunTerminalMasters = t.masters;
      if (t.distinct !== 1) throw new Error(`expected one master among ${t.added}`);
      // Bun's data() callback reads the same master, so it would race the receiver for output.
      // Only the receiver's write is checked here: the shell's file proves the bytes arrived.
      master = t.masters[0];
      shell = Bun.spawn(["sh", "-c", `read line; printf '%s' "$line" > '${seen}'; echo "shell got: $line"; sleep 1`], { terminal });
    } else {
      const pty = openMaster();
      master = pty.master;
      result.slave = pty.slavePath;
      const slave = openSync(pty.slavePath, constants.O_RDWR | O_NOCTTY);
      shell = Bun.spawn(["sh", "-c", `read line; printf '%s' "$line" > '${seen}'; echo "shell got: $line"; sleep 1`], {
        stdio: [slave, slave, slave],
      });
      closeSync(slave);
    }
    result.masterFd = master;
    result.masterIsTty = c.isatty(master) === 1;

    const pair = new Int32Array(2);
    if (c.socketpair(AF_UNIX, SOCK_STREAM, 0, ptr(pair)) !== 0) throw new Error("socketpair failed");
    const receiver = Bun.spawn([process.execPath, import.meta.path, "receive", mode], {
      stdio: ["ignore", "pipe", "inherit", pair[1]],
    });
    c.close(pair[1]);
    result.sendmsgBytes = sendFd(pair[0], master);
    // The sender gives the master up: from here only the receiver's copy keeps it open.
    if (mode !== "bun-terminal") result.senderClosedMaster = c.close(master) === 0;
    const out = await new Response(receiver.stdout).text();
    result.receiverExit = await receiver.exited;
    result.receiver = JSON.parse(out.trim().split("\n").pop() ?? "{}");
    await Promise.race([shell.exited, Bun.sleep(3000)]);
    result.shellSaw = readFileSync(seen, "utf8");
    terminal?.close();
    const r = result.receiver as { readBack?: string };
    ok =
      result.receiverExit === 0 &&
      result.masterIsTty === true &&
      result.shellSaw === "ping-from-receiver" &&
      (mode === "bun-terminal" || (r.readBack ?? "").includes("shell got: ping-from-receiver"));
  } catch (error) {
    result.error = String(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  result.ok = ok;
  console.log(JSON.stringify(result));
  process.exit(ok ? 0 : 1);
}

async function receive(mode: string) {
  const result: Record<string, unknown> = { pid: process.pid };
  const fd = await recvFd(3);
  result.receivedFd = fd;
  result.isTty = c.isatty(fd) === 1;
  result.wrote = writeSync(fd, "ping-from-receiver\n");
  if (mode !== "bun-terminal") {
    // Blocking reads on the master: the echo arrives first, then the shell's reply.
    let readBack = "";
    const buf = Buffer.alloc(4096);
    const until = Date.now() + 3000;
    while (!readBack.includes("shell got:") && Date.now() < until) {
      const n = readSync(fd, buf, 0, buf.length, null);
      readBack += buf.subarray(0, n).toString();
    }
    result.readBack = readBack.replace(/\r/g, "");
  }
  console.log(JSON.stringify(result));
}

if (process.argv[2] === "receive") await receive(process.argv[3] ?? "posix");
else await sender(process.argv[2] ?? "posix");
