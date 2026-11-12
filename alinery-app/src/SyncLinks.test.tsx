import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockIpc } from "./test/mockIpc";

const status = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./ipc", () =>
  mockIpc({
    runtimeStatus: async () => {
      status.calls += 1;
      const n = status.calls;
      return {
        hosts: [
          { host_id: "h1", label: "devbox", state: "connected", running: "a", bundled: "b", link: { calls: n * 4, bytes_up: n * 2048, bytes_down: n * 4096 } },
          { host_id: "h2", label: "laptop", state: "reconnecting", running: null, bundled: null, link: { calls: 0, bytes_up: 0, bytes_down: 0 } },
        ],
        repos: [
          { repo: "/me/app", state: "current", issues: [], host: "local", version: "0.600.0" },
          { repo: "alinery+ssh://h1/srv/api", state: "current", issues: [], host: "h1", version: "0.25.0" },
          { repo: "/me/idle", state: "not_attached", issues: [], host: "local", version: null },
        ],
        local_link: { calls: n, bytes_up: n * 100, bytes_down: n * 200 },
      };
    },
  }),
);

import { daemonIsOld, formatRate, linkRate, SyncLinks } from "./SyncLinks";

afterEach(cleanup);

it("computes rates between samples and formats them", () => {
  expect(linkRate(undefined, { calls: 1, bytes_up: 1, bytes_down: 1 }, 1)).toBeNull();
  expect(linkRate({ calls: 2, bytes_up: 0, bytes_down: 0 }, { calls: 6, bytes_up: 2048, bytes_down: 512 }, 2)).toEqual({ ops: 2, up: 1024, down: 256 });
  expect([formatRate(12.4), formatRate(1536), formatRate(3 * 1024 * 1024)]).toEqual(["12 B/s", "1.5 KB/s", "3.0 MB/s"]);
});

it("offers an update only for a daemon from another release, a drifted build, or one too old to say", () => {
  const repo = { repo: "/r", state: "current" as const, issues: [], host: "local" };
  expect(daemonIsOld({ ...repo, version: "0.600.0" }, "0.600.0")).toBe(false);
  expect(daemonIsOld({ ...repo, version: null }, "0.600.0")).toBe(false);
  expect(daemonIsOld({ ...repo, version: "0.25.0" }, "0.600.0")).toBe(true);
  expect(daemonIsOld({ ...repo, version: "" }, "0.600.0")).toBe(true);
  expect(daemonIsOld({ ...repo, state: "build_drift", version: "0.600.0" }, "0.600.0")).toBe(true);
});

it("lists each host's link, its traffic, and each attached daemon's version with an update button when old", async () => {
  render(<SyncLinks appVersion="0.600.0" />);
  expect(await screen.findByText("This computer")).toBeDefined();
  expect(screen.getByText("devbox")).toBeDefined();
  expect(screen.getByText("reconnecting")).toBeDefined();
  expect(screen.getByText("v0.600.0")).toBeDefined();
  expect(screen.getByText("v0.25.0")).toBeDefined();
  expect(screen.queryByText("idle")).toBeNull();
  expect(screen.getByRole("button", { name: "Update the daemon for api" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Update the daemon for app" })).toBeNull();
  expect(screen.getByText(/reconnect to install the new one/)).toBeDefined();
  await waitFor(() => expect(screen.getAllByText(/ops\/s/)[0].textContent).not.toBe("– ops/s"), { timeout: 2500 });
});
