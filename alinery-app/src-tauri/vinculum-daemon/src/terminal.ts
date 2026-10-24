// no-harness shells. One Bun.Terminal per session, inside this process.
// Reattach sends the scrollback tail. There is no vt100 frame.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "node:net";

const REPLAY_BYTES = 8 * 1024 * 1024;
const CLIENT_BACKLOG = 2 * 1024 * 1024;

type Shell = {
  terminal: Bun.Terminal;
  proc: Bun.Subprocess;
  scrollback: string;
  clients: Map<number, Socket>;
  exited: boolean;
};

const shells = new Map<string, Shell>();

function stripTerminalQueries(input: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === 0x1b && i + 1 < input.length && input[i + 1] === 0x5b) {
      let j = i + 2;
      while (j < input.length && !(input[j] >= 0x40 && input[j] <= 0x7e)) j += 1;
      const final = input[j];
      if (final === 0x63 || final === 0x6e) {
        i = j + 1;
        continue;
      }
      if (final === undefined) {
        out.push(...input.subarray(i));
        break;
      }
      out.push(...input.subarray(i, j + 1));
      i = j + 1;
      continue;
    }
    if (input[i] === 0x1b && i + 1 < input.length && input[i + 1] === 0x5d) {
      let j = i + 2;
      let isQuery = false;
      let done = false;
      while (!done) {
        const byte = input[j];
        if (byte === undefined) {
          out.push(...input.subarray(i));
          return Buffer.from(out);
        }
        if (byte === 0x07) break;
        if (byte === 0x1b && input[j + 1] === 0x5c) {
          j += 1;
          break;
        }
        if (byte === 0x3f) isQuery = true;
        j += 1;
      }
      if (!isQuery) out.push(...input.subarray(i, j + 1));
      i = j + 1;
      continue;
    }
    out.push(input[i]);
    i += 1;
  }
  return Buffer.from(out);
}

function tail(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - REPLAY_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return stripTerminalQueries(buf);
  } finally {
    closeSync(fd);
  }
}

function fanout(shell: Shell, data: Buffer) {
  appendFileSync(shell.scrollback, data);
  for (const [attachId, client] of shell.clients) {
    if (client.writableLength > CLIENT_BACKLOG) {
      client.destroy();
      shell.clients.delete(attachId);
      continue;
    }
    client.write(data);
  }
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
  const clients = new Map<number, Socket>();
  const shell: Shell = {
    terminal: undefined as unknown as Bun.Terminal,
    proc: undefined as unknown as Bun.Subprocess,
    scrollback,
    clients,
    exited: false,
  };
  const terminal = new Bun.Terminal({
    cols: cols || 80,
    rows: rows || 24,
    data(_terminal, data) {
      fanout(shell, Buffer.from(data));
    },
  });
  const proc = Bun.spawn([shellPath, "-i"], {
    cwd,
    env: process.env,
    terminal,
  });
  shell.terminal = terminal;
  shell.proc = proc;
  shells.set(id, shell);
  void proc.exited.then((code) => {
    shell.exited = true;
    for (const client of clients.values()) client.end();
    clients.clear();
    try {
      terminal.close();
    } catch {
      /* already closed */
    }
    onExit(code);
  });
  return shell;
}

export function attachShell(id: string, socket: Socket, attachId: number, cols: number, rows: number): boolean {
  const shell = shells.get(id);
  if (!shell || shell.exited) return false;
  if (cols > 0 && rows > 0) {
    try {
      shell.terminal.resize(cols, rows);
    } catch {
      /* shell already gone */
    }
  }
  const previous = shell.clients.get(attachId);
  if (previous && previous !== socket) previous.destroy();
  socket.write(`${JSON.stringify({ ok: true })}\n`);
  const replay = tail(shell.scrollback);
  if (replay.length) socket.write(replay);
  shell.clients.set(attachId, socket);
  socket.on("close", () => {
    if (shell.clients.get(attachId) === socket) shell.clients.delete(attachId);
  });
  return true;
}

export function writePty(id: string, data: string): boolean {
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

export function detachPty(id: string, attachId: number) {
  const shell = shells.get(id);
  const client = shell?.clients.get(attachId);
  if (!shell || !client) return;
  shell.clients.delete(attachId);
  client.end();
}

export function killPty(id: string) {
  const shell = shells.get(id);
  if (!shell) return;
  shell.exited = true;
  try {
    shell.proc.kill();
  } catch {
    /* already dead */
  }
  try {
    shell.terminal.close();
  } catch {
    /* already closed */
  }
  for (const client of shell.clients.values()) client.end();
  shell.clients.clear();
  shells.delete(id);
}
