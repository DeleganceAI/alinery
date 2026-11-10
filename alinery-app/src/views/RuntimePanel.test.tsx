import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { McpStatusHandle } from "../useMcpStatus";

vi.mock("../ipc", () =>
  mockIpc({
    runtimeStatus: async () => ({
      hosts: [
        { host_id: "h1", label: "aagent", state: "connected", running: "aaaaaaaa1111", bundled: "bbbbbbbb2222" },
        { host_id: "h2", label: "box", state: "connected", running: "cccccccc", bundled: "cccccccc" },
        { host_id: "h3", label: "offline", state: "idle", running: null, bundled: null },
      ],
      repos: [
        { repo: "/Users/me/app", state: "build_drift", issues: [] },
        { repo: "alinery+ssh://h1/home/me/svc", state: "conflict", issues: ["The daemon on the host speaks protocol 40; this app speaks 41."] },
      ],
    }),
  }),
);
vi.mock("../sync/hooks", () => ({ useLiveSessionsByRepo: () => ({ "/Users/me/app": 2 }) }));

import { RuntimePanel } from "./RuntimePanel";

const mcp: McpStatusHandle = {
  enabled: true,
  running: true,
  clients: 0,
  socket_reachable: true,
  binary_found: true,
  binary_path: "/x",
  host_args: [],
  repo: "/Users/me/app",
  socket_path: "/s",
  error: "",
  refresh: () => {},
};

afterEach(cleanup);

it("marks only the host whose bundled runtime differs as stale, and names each daemon's state", async () => {
  render(<RuntimePanel mcp={mcp} />);
  const stale = await screen.findAllByText(/Stale: restarting a daemon/);
  expect(stale).toHaveLength(1);
  expect(screen.getByText("aaaaaaaa → bbbbbbbb")).toBeTruthy();
  expect(screen.getByText("Other build (usable)")).toBeTruthy();
  expect(screen.getByText("2 live")).toBeTruthy();
  expect(screen.getByText("Needs a restart").getAttribute("title")).toContain("protocol 40");
  expect(screen.getByText("daemon · h1")).toBeTruthy();
});
