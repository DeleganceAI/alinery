import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { SessionService } from "alinery-proto/alinery/v1/sessions_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import * as ipc from "../ipc";
import {
  abortSession,
  archiveSession,
  clearSessionNotifications,
  createDrawerTerminal,
  killSession,
  markSessionNotificationRead,
  openSession,
  promptSession,
  readSessionHistory,
  readSessionOmp,
  renameSession,
  SessionConflict,
  setSessionModel,
  setSessionThinkingLevel,
} from "./sessions";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
vi.mock("../ipc", () => ({ prepareHostedInference: vi.fn(async () => undefined) }));

type Seen = { repo: string; call: string; req: Record<string, unknown> }[];
let seen: Seen;
let impl: Record<string, (req: never) => unknown>;

beforeEach(() => {
  seen = [];
  impl = {};
  vi.mocked(daemonTransport).mockImplementation((repo: string) => {
    const handler = (call: string) => (req: never) => {
      seen.push({ repo, call, req: req as never });
      return (impl[call]?.(req) ?? {}) as never;
    };
    return createRouterTransport((router) => {
      router.service(
        SessionService,
        Object.fromEntries(
          [
            "renameSession",
            "archiveSession",
            "killSession",
            "clearNotifications",
            "readHistory",
            "readOmpWindow",
            "promptSession",
            "abortSession",
            "setSessionModel",
            "setSessionThinkingLevel",
            "resumeSession",
            "createSession",
          ].map((c) => [c, handler(c)]),
        ) as never,
      );
    }) as Transport;
  });
});
afterEach(() => vi.resetAllMocks());

describe("session writes", () => {
  it("rename answers with the name and where it came from", async () => {
    impl.renameSession = () => ({ name: "Fix login", source: "user" });
    expect(await renameSession({ repoPath: "/r", taskSlug: "t", sessionId: "s1", name: "Fix login" })).toEqual({ name: "Fix login", source: "user" });
    expect(seen[0]).toMatchObject({ repo: "/r", call: "renameSession", req: { name: "Fix login", session: { taskSlug: "t", id: "s1" } } });
  });

  it("a rename over a row that moved on is a SessionConflict; any other refusal keeps the daemon's words", async () => {
    impl.renameSession = () => {
      throw new ConnectError("the name changed", Code.Aborted);
    };
    await expect(renameSession({ repoPath: "/r", taskSlug: "", sessionId: "s1", name: "x" })).rejects.toBeInstanceOf(SessionConflict);
    impl.archiveSession = () => {
      throw new ConnectError("session not found", Code.NotFound);
    };
    await expect(archiveSession("/r", "t", "gone")).rejects.toThrow("session not found");
  });

  it("archive and kill go to the repo's own daemon", async () => {
    await archiveSession("/a", "t", "s1");
    await killSession("/b", "s2", "");
    expect(seen.map((s) => [s.repo, s.call])).toEqual([
      ["/a", "archiveSession"],
      ["/b", "killSession"],
    ]);
  });

  it("notifications are cleared per repo, each with the suppression a person chose", async () => {
    await markSessionNotificationRead("/a", "t", "s1");
    await clearSessionNotifications([
      { repo_path: "/a", task_slug: "t", id: "s1" },
      { repo_path: "/b", task_slug: "u", id: "s2", notification_suppression: { notice: "waiting_for_input", occurrence: "corr-1" } },
      { repo_path: "/a", task_slug: "t", id: "s3" },
    ]);
    const clears = seen.filter((s) => s.call === "clearNotifications");
    expect(clears.map((c) => c.repo)).toEqual(["/a", "/a", "/b"]);
    expect((clears[1].req.sessions as unknown[]).length).toBe(2);
    expect(clears[2].req.sessions).toMatchObject([{ session: { taskSlug: "u", id: "s2" }, suppression: { notice: "waiting_for_input", occurrence: "corr-1" } }]);
  });
});

describe("session reads", () => {
  it("history sends the window it is given, and none when it is not", async () => {
    impl.readHistory = () => ({ data: new Uint8Array([1, 2, 3]) });
    const out = await readSessionHistory("/r", { id: "s1", offset: 4, limit: 3 });
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3]);
    expect(seen[0].req).toMatchObject({ offset: 4n, limit: 3n });
    await readSessionHistory("/r", { id: "s1" });
    expect(seen[1].req.offset).toBeUndefined();
  });

  it("an OMP window comes back in the framing the decoder reads: a JSON header line, then the rows", async () => {
    impl.readOmpWindow = () => ({ start: 5n, end: 12n, length: 40n, data: new TextEncoder().encode("a\nb\n") });
    const out = new Uint8Array(await readSessionOmp("/r", { id: "s1", taskSlug: "t", want: 100 }));
    const text = new TextDecoder().decode(out);
    expect(text).toBe('{"start":5,"end":12,"length":40}\na\nb\n');
    expect(seen[0].req).toMatchObject({ want: 100n, session: { taskSlug: "t", id: "s1" } });
  });
});

describe("the turn controls and the process (S5.3)", () => {
  it("a prompt and an abort name the session; a prompt carries a mutation id and an abort does not", async () => {
    await promptSession("/r", "s1", "hello");
    await abortSession("/r", "s1");
    expect(seen.map((s) => [s.repo, s.call])).toEqual([
      ["/r", "promptSession"],
      ["/r", "abortSession"],
    ]);
    expect(seen[0].req).toMatchObject({ sessionId: "s1", text: "hello" });
    expect((seen[0].req.meta as { mutationId: string }).mutationId).not.toBe("");
    expect(seen[1].req).toMatchObject({ sessionId: "s1" });
  });

  it("a model or thinking change answers with the controls in the shape the views read", async () => {
    impl.setSessionModel = () => ({ controls: { model: "anthropic/claude", thinking: "off", thinkingLevels: [] } });
    impl.setSessionThinkingLevel = () => ({ controls: { model: "xai/grok", thinking: "low", thinkingLevels: ["off", "low", "high"] } });
    expect(await setSessionModel("/r", "s1", "anthropic/claude")).toEqual({
      model: "anthropic/claude",
      thinking: "off",
      thinking_levels: [],
      context_tokens: 0,
      context_window: 0,
    });
    expect(await setSessionThinkingLevel("/r", "s1", "low")).toEqual({
      model: "xai/grok",
      thinking: "low",
      thinking_levels: ["off", "low", "high"],
      context_tokens: 0,
      context_window: 0,
    });
    expect(seen[0].req).toMatchObject({ sessionId: "s1", model: "anthropic/claude" });
    expect(seen[1].req).toMatchObject({ sessionId: "s1", level: "low" });
  });

  it("opening to spawn refreshes the hosted credentials first and asks ResumeSession with the geometry", async () => {
    const order: string[] = [];
    vi.mocked(ipc.prepareHostedInference).mockImplementation(async () => {
      order.push("prepare");
    });
    impl.resumeSession = () => {
      order.push("resume");
      return {};
    };
    await openSession("/r", { id: "s1", cwd: "/w", taskSlug: " t ", phase: "plan", model: "p/m", harness: "omp", intent: "spawn", cols: 80, rows: 24 });
    expect(order).toEqual(["prepare", "resume"]);
    expect(ipc.prepareHostedInference).toHaveBeenCalledWith("p/m", "omp");
    expect(seen[0].req).toMatchObject({ session: { taskSlug: "t", id: "s1" }, intent: "spawn", cwd: "/w", phase: "plan", model: "p/m", cols: 80, rows: 24 });
  });

  it("an attach starts nothing, so it refreshes nothing; an unknown intent never reaches the daemon", async () => {
    await openSession("/r", { id: "s1", cwd: "/w", intent: "attach" });
    expect(ipc.prepareHostedInference).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ call: "resumeSession", req: { intent: "attach", session: { taskSlug: "", id: "s1" } } });
    await expect(openSession("/r", { id: "s1", cwd: "/w", intent: "teleport" })).rejects.toThrow("unknown session intent 'teleport'");
    expect(seen).toHaveLength(1);
  });

  it("the drawer shell is a taskless no-harness session that is created and not started", async () => {
    impl.createSession = () => ({ started: { session: { id: "d1", harness: "no-harness" }, start: "not_requested", errors: [] } });
    expect(await createDrawerTerminal("/r")).toMatchObject({ id: "d1" });
    expect(seen[0]).toMatchObject({
      repo: "/r",
      call: "createSession",
      req: { taskSlug: "", start: false, target: { case: "auxiliary", value: { harness: "no-harness" } } },
    });
  });
});
