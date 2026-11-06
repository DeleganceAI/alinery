import { createRouterTransport } from "@connectrpc/connect";
import { cleanup, render, waitFor } from "@testing-library/react";
import { type AttachRequest, type AttachResponse, TerminalService, type WriteRequest } from "alinery-proto/alinery/v1/terminal_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "./daemon/transport";
import { SessionTerminal, type SessionTerminalIo } from "./SessionTerminal";
import type { SessionObservation } from "./types";

type FakeTerm = { written: string[]; cleared: number; reset: number; typed: (data: string) => void };
const terms = vi.hoisted(() => [] as FakeTerm[]);

vi.mock("./daemon/transport", () => ({ daemonTransport: vi.fn() }));
vi.mock("./ipc", () => ({ onRemoteHostConnected: () => () => {}, readAppConfig: vi.fn(), readSessionHistory: vi.fn(), openSession: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    handlers: Array<(d: string) => void> = [];
    me: FakeTerm = {
      written: [],
      cleared: 0,
      reset: 0,
      typed: (d) => {
        for (const h of this.handlers) h(d);
      },
    };
    constructor() {
      terms.push(this.me);
    }
    loadAddon() {}
    open() {}
    onData(h: (d: string) => void) {
      this.handlers.push(h);
      return { dispose: () => {} };
    }
    write(bytes: Uint8Array, done?: () => void) {
      this.me.written.push(new TextDecoder().decode(bytes));
      done?.();
    }
    writeln() {}
    clear() {
      this.me.cleared += 1;
    }
    reset() {
      this.me.reset += 1;
    }
    resize() {}
    refresh() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("./terminalRenderer", () => ({ attachGpuRenderer: () => {} }));

const data = (text: string, offset: number, attachId = ""): AttachResponse =>
  ({ body: { case: "data", value: new TextEncoder().encode(text) }, offset: BigInt(offset), attachId, truncated: false }) as AttachResponse;

/** A daemon whose Attach calls each play a script, then end the stream (a drop). */
function fakeDaemon(scripts: AttachResponse[][]) {
  const attaches: AttachRequest[] = [];
  const writes: WriteRequest[] = [];
  const transport = createRouterTransport((router) =>
    router.service(TerminalService, {
      async *attach(req, ctx) {
        attaches.push(req);
        const script = scripts[attaches.length - 1] ?? [];
        for (const f of script) yield f;
        if (attaches.length >= scripts.length) await new Promise<void>((r) => ctx.signal.addEventListener("abort", () => r()));
      },
      async write(req) {
        writes.push(req);
        return {};
      },
      async resize() {
        return {};
      },
      async detach() {
        return {};
      },
    }),
  );
  return { transport, attaches, writes };
}

const live = { lifecycle: { state: "live" } } as unknown as SessionObservation;
const io: SessionTerminalIo = { open: vi.fn(async () => {}), repo: async () => "/repo", status: async () => live };

function mount(intent: "attach" | "spawn" = "attach") {
  return render(<SessionTerminal sessionId="s1" cwd="/repo" taskSlug="t" phase="" harness="no-harness" model="" intent={intent} terminalFontSize={13} io={io} />);
}

beforeEach(() => {
  terms.length = 0;
  vi.mocked(io.open).mockClear();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});
afterEach(cleanup);

describe("SessionTerminal", () => {
  it("reattaches from the last offset it rendered, without clearing the screen, and restarts input numbering", async () => {
    const daemon = fakeDaemon([[data("hello", 0, "a1"), data("world", 5)], [data("!", 10, "a2")]]);
    vi.mocked(daemonTransport).mockReturnValue(daemon.transport);
    mount();
    await waitFor(() => expect(daemon.attaches).toHaveLength(2), { timeout: 4000 });
    expect(daemon.attaches[0]?.fromOffset).toBe(0n);
    expect(daemon.attaches[1]?.fromOffset).toBe(10n);
    expect(daemon.attaches[1]).toMatchObject({ cols: 80, rows: 24, session: { taskSlug: "t", id: "s1" } });
    await waitFor(() => expect(terms[0]?.written.join("")).toBe("helloworld!"));
    expect(terms[0]?.cleared).toBe(0);
    expect(io.open).not.toHaveBeenCalled();

    terms[0]?.typed("ls");
    terms[0]?.typed("\r");
    await waitFor(() => expect(daemon.writes).toHaveLength(2));
    expect(daemon.writes.map((w) => [w.attachId, w.inputSeq, new TextDecoder().decode(w.data)])).toEqual([
      ["a2", 0n, "ls"],
      ["a2", 1n, "\r"],
    ]);
  });

  it("starts the shell before it attaches when the pane spawns one", async () => {
    const daemon = fakeDaemon([[data("$ ", 0, "a1")]]);
    vi.mocked(daemonTransport).mockReturnValue(daemon.transport);
    mount("spawn");
    await waitFor(() => expect(terms[0]?.written.join("")).toBe("$ "));
    expect(io.open).toHaveBeenCalledTimes(1);
    expect(vi.mocked(io.open).mock.calls[0]?.[0]).toMatchObject({ id: "s1", intent: "spawn", taskSlug: "t" });
  });
});
