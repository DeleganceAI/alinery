import type { Transport } from "@connectrpc/connect";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { StatusDot } from "../shared";
import { daemonHarness, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { sessionDaemon, sessionEntity } from "../test/sessionDaemon";
import type { SessionObservation, SessionState } from "../types";
import { observationNow, observationOf, useSessionObservation } from "./sessionObservation";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../ipc", async () => (await import("../test/mockIpc")).mockIpc({ notifySessionAttention: notify }));

const running = (agent: "busy" | "idle" | "waiting_for_input" = "busy", correlation = "c1"): SessionObservation => ({
  lifecycle: { state: "live" },
  state: {
    process: { state: "alive" },
    agent: agent === "waiting_for_input" ? { state: agent, correlation_id: correlation } : { state: agent },
    playbook: { state: "in_progress" },
    adapter: "omp",
    message_adapter: "omp_bracketed_paste",
  },
  checkpoint: { phase_completed_at: null, omp_session_id: null, omp_turn_id: null },
  transport: "rpc",
});
const exited: SessionObservation = {
  lifecycle: { state: "exited", code: 3 },
  state: null,
  checkpoint: { phase_completed_at: 20, omp_session_id: "o1", omp_turn_id: 4 },
  transport: null,
};

beforeEach(() => vi.mocked(notify).mockClear());
afterEach(() => {
  cleanup();
  vi.mocked(daemonTransport).mockReset();
});

describe("observationOf", () => {
  it("reads back what the daemon stored, for every lifecycle", () => {
    const idleState = running("idle").state as SessionState;
    const shapes: SessionObservation[] = [
      running("busy"),
      running("waiting_for_input", "ask-1"),
      exited,
      { lifecycle: { state: "never_started" }, state: null, checkpoint: { phase_completed_at: null, omp_session_id: null, omp_turn_id: null }, transport: null },
      { lifecycle: { state: "orphaned" }, state: null, checkpoint: { phase_completed_at: null, omp_session_id: null, omp_turn_id: null }, transport: null },
      { lifecycle: { state: "interrupted" }, state: null, checkpoint: { phase_completed_at: null, omp_session_id: null, omp_turn_id: null }, transport: null },
      { ...running("idle"), lifecycle: { state: "live_exited" }, state: { ...idleState, process: { state: "exited", code: null } } },
      { ...running("idle"), state: { ...idleState, playbook: { state: "failed", reason: "StaleSource" } } },
    ];
    for (const o of shapes) {
      const wait = o.state?.agent.state === "waiting_for_input" ? { kind: "input", correlationId: "ask-1" } : undefined;
      expect(observationOf(sessionEntity("t", "s", o, wait))).toEqual(o);
    }
  });

  it("calls a session with no entity never started", () => {
    expect(observationOf(undefined).lifecycle).toEqual({ state: "never_started" });
  });
});

function Probe({ repo = "/r", notify = true }: { repo?: string; notify?: boolean }) {
  const observation = useSessionObservation(repo, "task", "s1");
  return <StatusDot id="s1" slug="task" repoPath={repo} observation={observation} notifyTransitions={notify} />;
}

describe("a session's badge follows its subscription", () => {
  it("goes from running to waiting to exited (no status command or timer exists to ask), and asks for attention once", async () => {
    const daemon = sessionDaemon();
    vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
    daemon.show("/r", "task", "s1", running("busy"));
    render(<Probe />);
    await screen.findByText("Running");
    expect(notify).not.toHaveBeenCalled();

    daemon.show("/r", "task", "s1", running("waiting_for_input"), { kind: "input", correlationId: "c1" });
    await screen.findByText("Needs input");
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith("/r", "task", "waiting_for_input");

    daemon.show("/r", "task", "s1", exited);
    await waitFor(() => expect(screen.queryByText("Needs input")).toBeNull());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("raises nothing when a reconnect snapshot shows the same wait", async () => {
    const waiting = running("waiting_for_input");
    const entity = (o: SessionObservation) => sessionEntity("task", "s1", o, o.state?.agent.state === "waiting_for_input" ? { kind: "input", correlationId: "c1" } : undefined);
    const h = scriptedSync(async function* (_req, call, signal) {
      if (call === 0) {
        yield snapshot([entity(running("busy"))], 1);
        await new Promise((r) => setTimeout(r, 40)); // let the view render busy first
        yield { frame: { case: "delta", value: { changes: [{ op: { case: "put", value: entity(waiting) } }], cursor: { epoch: "e1", seq: 2n } } } } as never;
        throw new Error("link dropped");
      }
      yield snapshot([entity(waiting)], 5); // the same wait, seen again after the reconnect
      await untilAborted(signal);
    });
    vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync }).transport as Transport);
    render(<Probe />);
    await screen.findByText("Needs input");
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.requests.length).toBe(2), { timeout: 3000 }); // the run loop resubscribed
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText("Needs input")).toBeDefined();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("resubscribes with the last cursor and keeps the last status while down", async () => {
    const h = scriptedSync(async function* (_req, call, signal) {
      if (call === 0) {
        yield snapshot([sessionEntity("task", "s1", running("busy"))], 1);
        throw new Error("link dropped");
      }
      await untilAborted(signal);
    });
    vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync }).transport as Transport);
    render(<Probe notify={false} />);
    await screen.findByText("Running");
    await waitFor(() => expect(h.requests.length).toBe(2), { timeout: 3000 });
    expect(h.requests[1].cursor?.seq).toBe(1n);
    expect(screen.getByText("Running")).toBeDefined();
  });
});

describe("observationNow", () => {
  it("answers from the snapshot and rejects when the daemon is silent", async () => {
    const daemon = sessionDaemon();
    vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
    daemon.show("/r", "task", "s1", exited);
    expect((await observationNow("/r", "task", "s1")).lifecycle).toEqual({ state: "exited", code: 3 });

    const silent = scriptedSync(async function* (_req, _call, signal) {
      yield* [];
      await untilAborted(signal);
    });
    vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: silent.sync }).transport as Transport);
    await expect(observationNow("/r", "task", "s1", 50)).rejects.toThrow("did not answer");
  });
});
