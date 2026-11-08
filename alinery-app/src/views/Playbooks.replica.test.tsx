// The Explore library read through the real sync path: the daemon's `playbook/*` rows reach the page through
// src/sync/playbooks and a replica, and a star goes back as PlaybookService.SavePicker. Playbooks.test.tsx covers
// the page's behaviour with the library stubbed; this one proves the view reads the replica, not a stub.
import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type Entity, PlaybookPickerSchema, PlaybookSchema } from "alinery-proto/alinery/v1/entities_pb";
import type { SavePickerRequest } from "alinery-proto/alinery/v1/playbooks_pb";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmHost } from "../confirm";
import { daemonTransport } from "../daemon/transport";
import { cursor, daemonHarness, entity, scriptedSync, snapshot, untilAborted } from "../test/daemonHarness";
import { Playbooks } from "./Playbooks";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
vi.mock("../ipc", async () => (await import("../test/mockIpc")).mockIpc());
vi.mock("../sync/community", () => ({
  listCommunityImports: vi.fn(async () => ({ imports: [] })),
  communityDownloadStatus: vi.fn(async () => ({ rows: [] })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ref = (scope: string, key: string) => ({ scope, key });
const playbookRow = (scope: string, key: string, title: string): Entity =>
  entity(`playbook/${scope}/${key}`, { case: "playbook", value: create(PlaybookSchema, { reference: ref(scope, key), title, description: `${title} steps` }) });

it("lists the daemon's playbook rows and saves a star through the picker service", async () => {
  const saved: SavePickerRequest[] = [];
  const rows = [
    playbookRow("bundled", "superdevelop", "SuperDevelop"),
    playbookRow("repo", "review", "Review Loop"),
    entity("playbook/_/picker", { case: "playbookPicker", value: create(PlaybookPickerSchema, { order: [], entries: [] }) }),
  ];
  const { sync } = scriptedSync(async function* (_req, _call, signal) {
    yield snapshot(rows, 1);
    await untilAborted(signal);
  });
  vi.mocked(daemonTransport).mockReturnValue(
    daemonHarness({
      sync,
      playbooks: {
        savePicker: (request) => {
          saved.push(request);
          return { applied: { cursor: cursor(1) } } as never;
        },
      },
    }).transport as Transport,
  );

  render(
    <>
      <ConfirmHost />
      <Playbooks repoPath="/a" onCreateTask={() => {}} />
    </>,
  );

  const library = await screen.findByRole("list", { name: "Playbook library" });
  await within(library).findByText("Review Loop");
  expect(within(library).getByText("SuperDevelop")).toBeTruthy();

  const star = within(library).getByRole("button", { name: "Star playbook: repo/review" });
  expect(star.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(star);
  await waitFor(() => expect(saved).toHaveLength(1));
  expect(saved[0].global).toBe(false);
  expect(saved[0].entries.filter((e) => e.preferred).map((e) => `${e.reference?.scope}/${e.reference?.key}`)).toEqual(["bundled/superdevelop", "repo/review"]);
});
