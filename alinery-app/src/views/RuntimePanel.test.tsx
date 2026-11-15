import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
        { repo: "alinery+ssh://h2/srv/shared", state: "joined", issues: [], host: "h2", version: "0.25.0", started_by: "sam", os_user: "sam", mine: false },
        { repo: "/Users/me/idle", state: "not_attached", issues: [], host: "local", version: null, started_by: "", os_user: "", mine: true },
      ],
      local_link: { calls: 0, bytes_up: 0, bytes_down: 0 },
    }),
    stopDaemon: vi.fn(async () => {}),
    remoteConnect: vi.fn(async () => {}),
  }),
);
const confirms = vi.hoisted(() => ({ danger: vi.fn(), ask: vi.fn() }));
vi.mock("../confirm", () => ({ confirmDanger: confirms.danger, askConfirm: confirms.ask }));
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

import * as ipc from "../ipc";
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const text = (node: ReactNode) => render(<>{node}</>).container.textContent;

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

it("restarts exactly the row's daemon after a confirmation that counts its live sessions", async () => {
  confirms.danger.mockResolvedValue(true);
  render(<RuntimePanel mcp={mcp} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restart the daemon for app" }));
  await waitFor(() => expect(ipc.stopDaemon).toHaveBeenCalledWith("/Users/me/app"));
  const [title, body, accept] = confirms.danger.mock.calls[0];
  expect(title).toBe("Restart the daemon for app?");
  expect(text(body)).toContain("Its 2 live sessions are stopped");
  expect(accept).toBe("Stop 2 sessions and restart");
  expect(confirms.danger).toHaveBeenCalledTimes(1);
});

it("asks a second time, naming them, before restarting a daemon someone else started", async () => {
  confirms.danger.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  render(<RuntimePanel mcp={mcp} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restart the daemon for shared" }));
  await waitFor(() => expect(confirms.danger).toHaveBeenCalledTimes(2));
  expect(text(confirms.danger.mock.calls[0][1])).toContain("Any live sessions in this repository are stopped");
  expect(confirms.danger.mock.calls[1][0]).toBe("Restart the daemon sam started?");
  expect(ipc.stopDaemon).not.toHaveBeenCalled();
});

it("does nothing on cancel, and offers no restart for a daemon that is not running", async () => {
  confirms.danger.mockResolvedValue(false);
  render(<RuntimePanel mcp={mcp} />);
  fireEvent.click(await screen.findByRole("button", { name: "Restart the daemon for svc" }));
  await waitFor(() => expect(confirms.danger).toHaveBeenCalled());
  expect(ipc.stopDaemon).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Restart the daemon for idle" })).toBeNull();
});

it("updates only a stale connected host, by reconnecting it after a yes", async () => {
  confirms.ask.mockResolvedValue("confirm");
  render(<RuntimePanel mcp={mcp} />);
  const buttons = await screen.findAllByRole("button", { name: "Update host…" });
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  await waitFor(() => expect(ipc.remoteConnect).toHaveBeenCalledWith("h1", false));
  expect(text(confirms.ask.mock.calls[0][0].body)).toContain("keep going on the old runtime");
});
