import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { McpStatusHandle } from "../useMcpStatus";

vi.mock("../ipc", () =>
  mockIpc({
    runtimeStatus: async () => ({
      hosts: [
        { host_id: "h1", label: "aagent", state: "connected", running: "aaaaaaaa1111", bundled: "bbbbbbbb2222", link: { calls: 0, bytes_up: 0, bytes_down: 0 }, daemons: [] },
        { host_id: "h2", label: "box", state: "connected", running: "cccccccc", bundled: "cccccccc", link: { calls: 0, bytes_up: 0, bytes_down: 0 }, daemons: [] },
        { host_id: "h3", label: "offline", state: "idle", running: null, bundled: null, link: { calls: 0, bytes_up: 0, bytes_down: 0 }, daemons: [] },
      ],
      repos: [
        { repo: "/Users/me/app", state: "build_drift", issues: [], host: "local", version: "0.25.0", started_by: "", os_user: "", mine: true },
        {
          repo: "alinery+ssh://h1/home/me/svc",
          state: "conflict",
          issues: ["The daemon on the host speaks protocol 40; this app speaks 41."],
          host: "h1",
          version: null,
          started_by: "",
          os_user: "",
          mine: false,
        },
      ],
      local_link: { calls: 0, bytes_up: 0, bytes_down: 0 },
    }),
  }),
);
vi.mock("../sync/hooks", () => ({ useLiveSessionsByRepo: () => ({ "/Users/me/app": 2 }) }));
vi.mock("../sync/agent", () => ({
  readOfficeTools: async () => ({
    bundledPython: true,
    tools: [
      { name: "python3", path: "/rt/python/bin/python3" },
      { name: "bun", path: "/v/bin/bun" },
      { name: "soffice", path: "" },
      { name: "pdftoppm", path: "" },
      { name: "qpdf", path: "/opt/homebrew/bin/qpdf" },
    ],
  }),
}));

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

it("says what the office skills will find on each running daemon, and links LibreOffice when it is missing", async () => {
  render(<RuntimePanel mcp={mcp} />);
  expect(await screen.findByText(/Python bundled · missing LibreOffice, pdftoppm/)).toBeTruthy();
  expect(screen.getAllByText("office tools")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Get LibreOffice" })).toBeTruthy();
});
