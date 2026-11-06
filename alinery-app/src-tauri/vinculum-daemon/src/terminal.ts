// no-harness shells. One Bun.Terminal per session, inside this process.
// Reattach replays the scrollback file from an offset (rpc/terminal.ts). There is no vt100 frame.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { signalChild, spawnDetached } from "./platform/process.ts";

export const REPLAY_BYTES = 8 * 1024 * 1024;
/** A replay frame stays well under a client's default 4 MiB message limit. */
const REPLAY_FRAME_BYTES = 256 * 1024;

/** One frame of output: `offset` is the position of `data[0]` in the scrollback file. */
export type OutputFrame = { offset: number; data: Buffer } | { exit: { code: number; signal: string } };
type Sink = (frame: OutputFrame) => void;

type Shell = {
  terminal: Bun.Terminal;
  proc: Bun.Subprocess;
  scrollback: string;
  /** Bytes in the scrollback file: the offset the next live byte gets. */
  size: number;
  sinks: Set<Sink>;
  exited: boolean;
};

const shells = new Map<string, Shell>();

/**
 * The runs of `input` to keep when replaying: terminal queries (CSI ... c / n, OSC with `?`) are left
 * out so a replayed screen does not make the new terminal answer them into the shell again. A
 * sequence cut off at the end of the input stays.
 */
export function replayRanges(input: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let keep = 0;
  const drop = (from: number, to: number) => {
    if (from > keep) out.push([keep, from]);
    keep = to;
  };
  let i = 0;
  while (i < input.length) {
    if (input[i] === 0x1b && i + 1 < input.length && input[i + 1] === 0x5b) {
      let j = i + 2;
      while (j < input.length && !(input[j] >= 0x40 && input[j] <= 0x7e)) j += 1;
      const final = input[j];
      if (final === undefined) break;
      if (final === 0x63 || final === 0x6e) drop(i, j + 1);
      i = j + 1;
      continue;
    }
    if (input[i] === 0x1b && i + 1 < input.length && input[i + 1] === 0x5d) {
      let j = i + 2;
      let isQuery = false;
      for (;;) {
        const byte = input[j];
        if (byte === undefined) {
          out.push([keep, input.length]);
          return out.filter(([a, b]) => b > a);
        }
        if (byte === 0x07) break;
        if (byte === 0x1b && input[j + 1] === 0x5c) {
          j += 1;
          break;
        }
        if (byte === 0x3f) isQuery = true;
        j += 1;
      }
      if (isQuery) drop(i, j + 1);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  if (input.length > keep) out.push([keep, input.length]);
  return out;
}

export class OffsetAhead extends Error {}

/** The replay for an attach at `from` (0: the kept tail), cut into frames, and whether the tail started above 0. */
function replay(path: string, from: number, size: number): { frames: OutputFrame[]; truncated: boolean } {
  const start = from > 0 ? from : Math.max(0, size - REPLAY_BYTES);
  const frames: OutputFrame[] = [];
  if (size > start) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(size - start);
      const read = readSync(fd, buf, 0, buf.length, start);
      for (const [a, b] of replayRanges(buf.subarray(0, read))) {
        for (let at = a; at < b; at += REPLAY_FRAME_BYTES) frames.push({ offset: start + at, data: buf.subarray(at, Math.min(b, at + REPLAY_FRAME_BYTES)) });
      }
    } catch {
      /* no file yet: nothing to replay */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { frames, truncated: from === 0 && start > 0 };
}

function fanout(shell: Shell, data: Buffer) {
  const offset = shell.size;
  appendFileSync(shell.scrollback, data);
  shell.size += data.length;
  for (const sink of shell.sinks) sink({ offset, data });
}

export function hasPty(id: string): boolean {
  const shell = shells.get(id);
  return Boolean(shell && !shell.exited);
}

export function isPty(id: string): boolean {
  return shells.has(id);
}

export function startShell(id: string, cwd: string, scrollback: string, cols: number, rows: number, onExit: (code: number | null) => void, shellPath = process.env.SHELL || "/bin/sh"): Shell {
  const previous = shells.get(id);
  if (previous && !previous.exited) return previous;
  mkdirSync(dirname(scrollback), { recursive: true });
  const sinks = new Set<Sink>();
  let size = 0;
  try {
    size = statSync(scrollback).size;
  } catch {
    /* a new session */
  }
  const shell: Shell = {
    terminal: undefined as unknown as Bun.Terminal,
    proc: undefined as unknown as Bun.Subprocess,
    scrollback,
    size,
    sinks,
    exited: false,
  };
  const terminal = new Bun.Terminal({
    cols: cols || 80,
    rows: rows || 24,
    data(_terminal, data) {
      fanout(shell, Buffer.from(data));
    },
  });
  const proc = spawnDetached([shellPath, "-i"], {
    cwd,
    env: process.env,
    terminal,
  });
  shell.terminal = terminal;
  shell.proc = proc;
  shells.set(id, shell);
  void proc.exited.then((code) => {
    shell.exited = true;
    const exit = { code: code ?? -1, signal: proc.signalCode ?? "" };
    for (const sink of sinks) sink({ exit });
    sinks.clear();
    try {
      terminal.close();
    } catch {
      /* already closed */
    }
    onExit(code);
  });
  return shell;
}

/**
 * Start sending a live shell's output to `sink` from `from` (0: the kept tail). The replay is returned and the
 * sink registered in the same tick, so live frames start exactly where the replay ends. Undefined when the
 * shell is not running; throws OffsetAhead when `from` is past the end of the file (a client from another file).
 */
export function subscribeOutput(id: string, from: number, sink: Sink): { frames: OutputFrame[]; truncated: boolean; unsubscribe: () => void } | undefined {
  const shell = shells.get(id);
  if (!shell || shell.exited) return undefined;
  if (from > shell.size) throw new OffsetAhead(`offset ${from} is past the end of the scrollback (${shell.size})`);
  const { frames, truncated } = replay(shell.scrollback, from, shell.size);
  shell.sinks.add(sink);
  return { frames, truncated, unsubscribe: () => shell.sinks.delete(sink) };
}

export function writePty(id: string, data: string | Uint8Array): boolean {
  const shell = shells.get(id);
  if (!shell || shell.exited) return false;
  shell.terminal.write(data);
  return true;
}

export function resizePty(id: string, cols: number, rows: number): boolean {
  const shell = shells.get(id);
  if (!shell || shell.exited || cols <= 0 || rows <= 0) return false;
  shell.terminal.resize(cols, rows);
  return true;
}

export function killPty(id: string) {
  const shell = shells.get(id);
  if (!shell) return;
  shell.exited = true;
  signalChild(shell.proc, "SIGTERM", "session-kill");
  try {
    shell.terminal.close();
  } catch {
    /* already closed */
  }
  shells.delete(id);
}
