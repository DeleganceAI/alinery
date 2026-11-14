import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { DaemonStatusSchema } from "alinery-proto/alinery/v1/entities_pb";
import { afterEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { daemonHarness, entity, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { acquireScope, liveSessionsNow, REPO_SCOPE, useEntities, useScope } from "./hooks";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const status = (n: number) => entity("daemon/_/status", { case: "daemonStatus", value: create(DaemonStatusSchema, { liveSessions: n }) });
function daemon(opened: { n: number; closed: number }, rows = [status(2)]) {
  const h = scriptedSync(async function* (_req, _call, signal) {
    opened.n += 1;
    signal.addEventListener("abort", () => (opened.closed += 1), { once: true }); // the client cancelled the call
    yield snapshot(rows, 1);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync }).transport as Transport);
}

it("two views share one stream, and the stream closes when the last one unmounts", async () => {
  const opened = { n: 0, closed: 0 };
  daemon(opened);
  const a = renderHook(() => useScope("/r", REPO_SCOPE));
  const b = renderHook(() => useScope("/r", REPO_SCOPE));
  await waitFor(() => expect(a.result.current).not.toBeNull());
  expect(b.result.current).toBe(a.result.current);
  const rows = renderHook(() => useEntities(a.result.current));
  await waitFor(() => expect(rows.result.current.map((e) => e.key)).toEqual(["daemon/_/status"]));
  a.unmount();
  await new Promise((r) => setTimeout(r, 30));
  expect(opened.closed).toBe(0);
  b.unmount();
  await waitFor(() => expect(opened.closed).toBe(1));
  expect(opened.n).toBe(1);
});

it("liveSessionsNow reads the count once the snapshot lands, then lets go of the stream", async () => {
  const opened = { n: 0, closed: 0 };
  daemon(opened);
  expect(await liveSessionsNow("/r")).toBe(2);
  await waitFor(() => expect(opened.closed).toBe(1));
});

it("liveSessionsNow answers 0 when the daemon never answers", async () => {
  vi.mocked(daemonTransport).mockReturnValue(
    daemonHarness({
      sync: scriptedSync(async function* () {
        await new Promise(() => {});
      }).sync,
    }).transport as Transport,
  );
  expect(await liveSessionsNow("/r", 50)).toBe(0);
});

it("release is idempotent", async () => {
  const opened = { n: 0, closed: 0 };
  daemon(opened);
  const one = acquireScope("/r", REPO_SCOPE);
  const two = acquireScope("/r", REPO_SCOPE);
  one.release();
  one.release();
  await new Promise((r) => setTimeout(r, 30));
  expect(opened.closed).toBe(0);
  two.release();
  await waitFor(() => expect(opened.closed).toBe(1));
});
