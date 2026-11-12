import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
          {
            host_id: "h1",
            label: "devbox",
            state: "connected",
            running: "a",
            bundled: "b",
            link: { calls: n * 4, bytes_up: n * 2048, bytes_down: n * 4096 },
            daemons: [
              { repo: "/srv/shared", lane: "", pid: 1, os_user: "dev", started_by: "jon on Strix", started_at_ms: 0, version: "0.600.0", protocol: 42 },
              { repo: "/srv/other", lane: "", pid: 2, os_user: "pat", started_by: "", started_at_ms: 0, version: "0.600.0", protocol: 42 },
            ],
          },
          { host_id: "h2", label: "laptop", state: "reconnecting", running: null, bundled: null, link: { calls: 0, bytes_up: 0, bytes_down: 0 }, daemons: [] },
        ],
        repos: [
          { repo: "/me/app", state: "current", issues: [], host: "local", version: "0.600.0", started_by: "", os_user: "", mine: true },
          { repo: "alinery+ssh://h1/srv/api", state: "current", issues: [], host: "h1", version: "0.25.0", started_by: "", os_user: "", mine: true },
          { repo: "/me/idle", state: "not_attached", issues: [], host: "local", version: null, started_by: "", os_user: "", mine: true },
          { repo: "alinery+ssh://h1/srv/shared", state: "joined", issues: [], host: "h1", version: "0.600.0", started_by: "jon on Strix", os_user: "dev", mine: false },
          { repo: "/me/clash", state: "conflict", issues: ["another lane owns it"], host: "local", version: null, started_by: "", os_user: "", mine: true },
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
  const repo = { repo: "/r", state: "current" as const, issues: [], host: "local", started_by: "", os_user: "", mine: true };
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
  expect(screen.getAllByText("v0.600.0").length).toBeGreaterThan(0);
  expect(screen.getByText("v0.25.0")).toBeDefined();
  expect(screen.queryByText("idle")).toBeNull();
  expect(screen.getByRole("button", { name: "Update the daemon for api" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Update the daemon for app" })).toBeNull();
  expect(screen.getByText(/reconnect to install the new one/)).toBeDefined();
  await waitFor(() => expect(screen.getAllByText(/ops\/s/)[0].textContent).not.toBe("– ops/s"), { timeout: 2500 });
});

it("sends a conflicted daemon to its repository's takeover banner, with the reason on hover", async () => {
  const onOpenRepo = vi.fn();
  render(<SyncLinks appVersion="0.600.0" onOpenRepo={onOpenRepo} />);
  const open = await screen.findByRole("button", { name: "Open clash to resolve its daemon conflict" });
  expect(screen.queryByRole("button", { name: "Update the daemon for clash" })).toBeNull();
  expect(screen.getByTitle("another lane owns it")).toBeDefined();
  fireEvent.click(open);
  expect(onOpenRepo).toHaveBeenCalledWith("/me/clash");
});

it("names who started a daemon someone else runs, and lists the host's daemons this app has not opened", async () => {
  render(<SyncLinks appVersion="0.600.0" />);
  const shared = (await screen.findByText("shared")).closest(".sync-link-repo") as HTMLElement;
  expect(shared.textContent).toContain(" · jon on Strix");
  expect(shared.textContent).toContain("v0.600.0 · joined");
  expect(shared.getAttribute("title")).toContain("Started by jon on Strix (as dev)");
  const other = screen.getByText("other").closest(".sync-link-repo") as HTMLElement;
  expect(other.textContent).toContain(" · pat");
  expect(screen.getAllByText("shared")).toHaveLength(1); // the opened repo is not listed twice
});
