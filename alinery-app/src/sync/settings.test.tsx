import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl, type Transport } from "@connectrpc/connect";
import { renderHook, waitFor } from "@testing-library/react";
import { CursorSchema } from "alinery-proto/alinery/v1/common_pb";
import { type Entity, EntitySchema, SettingSource, SettingsSchema } from "alinery-proto/alinery/v1/entities_pb";
import type { SettingsService } from "alinery-proto/alinery/v1/settings_pb";
import { afterEach, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { daemonHarness, entity, put, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { clearRepoOverride, readEffectiveConfig, readRepoSettings, SettingsConflict, useRepoSettings, writeRepoOverrides } from "./settings";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const row = (init: Parameters<typeof create<typeof SettingsSchema>>[1], revision = 7n): Entity =>
  create(EntitySchema, { ...entity("settings/_/repo", { case: "settings", value: create(SettingsSchema, init) }), revision });

const full = row({
  overrides: { defaults: { model: "gpt-5", playbook: { scope: "repo", key: "mine" } }, backup: { retention: 3, enabled: false } },
  effective: {
    githubToken: "tok",
    defaults: { harness: "omp", model: "gpt-5", thinking: "high", playbook: { scope: "repo", key: "mine" }, draftAutosave: false },
    defaultsSource: { harness: SettingSource.GLOBAL, model: SettingSource.REPOSITORY, playbook: SettingSource.REPOSITORY },
    githubTokenSource: SettingSource.GLOBAL,
    backup: { destination: "/b", enabled: false, retention: 3, triggerPreArchive: true },
    notifications: { enabled: true, dockBadgeFailures: true },
    telemetry: { enabled: false, prompted: true, installId: "i", endpoint: "https://t" },
  },
});

function serve(rows: Entity[], settings: Partial<ServiceImpl<typeof SettingsService>> = {}) {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot(rows, 1);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync, settings: settings as ServiceImpl<typeof SettingsService> }).transport as Transport);
}

it("reads the effective config and the overrides in the shapes the views already use", async () => {
  serve([full]);
  const s = await readRepoSettings("/a");
  expect(s.revision).toBe(7n);
  expect(s.overrides.defaults).toMatchObject({ model: "gpt-5", harness: null, playbook: { scope: "repo", key: "mine" } });
  expect(s.overrides.backup).toMatchObject({ retention: 3, enabled: false, destination: null });
  expect(s.effective.defaults).toEqual({ harness: "omp", model: "gpt-5", thinking: "high", playbook: { scope: "repo", key: "mine" }, draft_autosave: false });
  expect(s.effective.provenance.defaults).toMatchObject({ harness: "global", model: "repository", playbook: "repository" });
  expect(s.effective.backup).toMatchObject({ destination: "/b", retention: 3, trigger_pre_archive: true });
  expect(s.effective.notifications).toMatchObject({ enabled: true, dock_badge_failures: true, sound: false });
  expect((await readEffectiveConfig("/a")).github.token).toBe("tok");
});

it("a refused file is an error carrying the daemon's reason, and a silent daemon is an error", async () => {
  serve([row({ error: "invalid repo config: bad" })]);
  await expect(readRepoSettings("/b")).rejects.toThrow("invalid repo config: bad");
  vi.mocked(daemonTransport).mockReturnValue(
    daemonHarness({
      sync: scriptedSync(async function* () {
        await new Promise(() => {});
      }).sync,
    }).transport as Transport,
  );
  await expect(readRepoSettings("/c", 40)).rejects.toThrow("did not answer");
});

it("useRepoSettings follows the row, and carries the replica's cursor", async () => {
  const h = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot([full], 1);
    await new Promise((r) => setTimeout(r, 250));
    yield put(row({ overrides: { defaults: { model: "other" } }, effective: { defaults: { model: "other" } } }, 9n), 2);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(daemonHarness({ sync: h.sync }).transport as Transport);
  const { result } = renderHook(() => useRepoSettings("/d"));
  await waitFor(() => expect(result.current.settings?.revision).toBe(7n));
  expect(result.current.cursor?.seq).toBe(1n);
  await waitFor(() => expect(result.current.settings?.overrides.defaults.model).toBe("other"));
  expect(result.current.cursor?.seq).toBe(2n);
});

it("a write carries the overrides, the expected revision and a mutation id, and resolves with the cursor", async () => {
  const calls: { model?: string; retention?: number; expected: bigint; client: string; mutation: string }[] = [];
  serve([full], {
    writeOverrides: (req: {
      overrides?: { defaults?: { model?: string }; backup?: { retention?: number } };
      expectedRevision: bigint;
      meta?: { clientId: string; mutationId: string };
    }) => {
      calls.push({
        model: req.overrides?.defaults?.model,
        retention: req.overrides?.backup?.retention,
        expected: req.expectedRevision,
        client: req.meta?.clientId ?? "",
        mutation: req.meta?.mutationId ?? "",
      });
      return { applied: { cursor: create(CursorSchema, { epoch: "e1", seq: 4n }) } };
    },
  });
  const s = await readRepoSettings("/e");
  const cursor = await writeRepoOverrides("/e", { ...s.overrides, defaults: { ...s.overrides.defaults, model: "x" } }, s.revision);
  await writeRepoOverrides("/e", s.overrides);
  expect(cursor?.seq).toBe(4n);
  expect(calls[0]).toMatchObject({ model: "x", retention: 3, expected: 7n });
  expect(calls[0].client).not.toBe("");
  expect(calls[0].mutation).not.toBe(calls[1].mutation);
  expect(calls[1].expected).toBe(0n);
});

it("a stale revision is a SettingsConflict; any other failure is an Error with the daemon's words", async () => {
  serve([full], {
    writeOverrides: () => {
      throw new ConnectError("settings changed since revision 7 (now 9)", Code.Aborted);
    },
    clearOverride: () => {
      throw new ConnectError("unknown repository override field: x", Code.InvalidArgument);
    },
  });
  await expect(writeRepoOverrides("/f", { github: {}, defaults: {}, backup: {} }, 7n)).rejects.toBeInstanceOf(SettingsConflict);
  await expect(clearRepoOverride("/f", "x")).rejects.toThrow("unknown repository override field: x");
});
