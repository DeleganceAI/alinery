import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmHost } from "./confirm";
import type * as IpcFixtures from "./test/mockIpc";

const requests = vi.hoisted(() => ({ list: [] as { id: string; label: string }[] }));
vi.mock("./ipc", async () => (await vi.importActual<typeof IpcFixtures>("./test/mockIpc")).mockIpc());
vi.mock("./sync/hooks", () => ({
  REPO_SCOPE: {},
  useScope: () => ({}),
  useEntity: () => ({ value: { case: "joinRequests", value: { requests: requests.list } } }),
}));
vi.mock("./sync/members", () => ({ JOIN_REQUESTS_KEY: "daemon/_/join-requests", decideJoin: vi.fn(async () => {}) }));

import { JoinRequestsBanner } from "./DaemonConflictBanner";
import { decideJoin } from "./sync/members";

afterEach(() => {
  cleanup();
  vi.mocked(decideJoin).mockClear();
});

const mount = () =>
  render(
    <>
      <JoinRequestsBanner repo="alinery+ssh://box/srv/app" />
      <ConfirmHost />
    </>,
  );

it("shows nothing while no one asks", () => {
  requests.list = [];
  mount();
  expect(screen.queryByRole("status")).toBeNull();
});

it("lets a requester in only after a confirmation that says what they get, and declines without one", async () => {
  requests.list = [
    { id: "r1", label: "jon on Strix" },
    { id: "r2", label: "pat" },
  ];
  mount();
  expect(screen.getByText("jon on Strix asks to use app's daemon (1 more waiting)")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Let in…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Let jon on Strix use app's daemon?" });
  expect(dialog.textContent).toContain("including terminals and agents");
  expect(decideJoin).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Let them in" }));
  await waitFor(() => expect(decideJoin).toHaveBeenCalledWith("alinery+ssh://box/srv/app", "r1", true));
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  await waitFor(() => expect(decideJoin).toHaveBeenCalledWith("alinery+ssh://box/srv/app", "r1", false));
});
