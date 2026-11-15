import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { McpStatusHandle } from "../useMcpStatus";

const runtime = vi.hoisted(() => ({ extra: [] as never[] }));
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
        ...runtime.extra,
      ],
      local_link: { calls: 0, bytes_up: 0, bytes_down: 0 },
    }),
    stopDaemon: vi.fn(async () => {}),
    remoteConnect: vi.fn(async () => {}),
    machineMcpPeer: vi.fn(async () => "4242:1700000000.000001"),
    forceRestartMachineMcp: vi.fn(async () => {}),
  }),
);
const mcpStatus = (state: number, extra = {}) => ({
  state,
  build: "0.600.0",
  protocol: 49,
  uptimeMs: 10n,
  clients: 3,
  daemons: [
    { repo: "/Users/me/app", protocol: 49, compatible: true },
    { repo: "/old", protocol: 48, compatible: false },
  ],
  socketPath: "/cfg/machine-mcp.sock",
  tokenRequired: false,
  ...extra,
});
const machine = vi.hoisted(() => ({ status: vi.fn(), restart: vi.fn(), token: vi.fn(), http: vi.fn() }));
vi.mock("../sync/mcp", async (original) => ({
  ...(await original<typeof import("../sync/mcp")>()),
  machineMcpStatus: machine.status,
  restartMachineMcp: machine.restart,
  machineMcpToken: machine.token,
  setMachineMcpHttp: machine.http,
}));
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
import { McpState } from "../sync/mcp";
import { mcpHttpUrl, RuntimePanel } from "./RuntimePanel";

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
  runtime.extra = [];
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  machine.status.mockResolvedValue(mcpStatus(McpState.OK));
  machine.restart.mockResolvedValue(mcpStatus(McpState.OK));
  machine.token.mockResolvedValue("");
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

it("shows the machine MCP through a local daemon, and restarts it after a yes that counts its clients", async () => {
  confirms.ask.mockResolvedValue("confirm");
  render(<RuntimePanel mcp={mcp} />);
  expect(await screen.findByText("3 clients · 1 daemon · 1 incompatible")).toBeTruthy();
  expect(machine.status).toHaveBeenCalledWith("/Users/me/app");
  fireEvent.click(screen.getByRole("button", { name: "Restart MCP" }));
  await waitFor(() => expect(machine.restart).toHaveBeenCalledWith("/Users/me/app"));
  expect(text(confirms.ask.mock.calls[0][0].body)).toContain("Its 3 connected clients lose any tool call in flight");
});

it("offers Force restart only when it does not answer, bound to the incarnation the user confirmed", async () => {
  machine.status.mockResolvedValue(mcpStatus(McpState.STUCK));
  confirms.danger.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<RuntimePanel mcp={mcp} />);
  const force = await screen.findByRole("button", { name: "Force restart…" });
  fireEvent.click(force);
  await waitFor(() => expect(confirms.danger).toHaveBeenCalledTimes(1));
  expect(text(confirms.danger.mock.calls[0][1])).toContain("process 4242");
  expect(ipc.forceRestartMachineMcp).not.toHaveBeenCalled();
  await waitFor(() => expect((force as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(force);
  await waitFor(() => expect(ipc.forceRestartMachineMcp).toHaveBeenCalledWith("4242:1700000000.000001"));
});

it("requires a token only after a yes, and shows no Force restart for an MCP that answers", async () => {
  confirms.ask.mockResolvedValue("confirm");
  let held = "";
  machine.token.mockImplementation(async (_repo: string, action: string) => (held = action === "rotate" ? "feedface00112233" : action === "clear" ? "" : held));
  render(<RuntimePanel mcp={mcp} />);
  fireEvent.click(await screen.findByRole("button", { name: "Require token…" }));
  await waitFor(() => expect(machine.token).toHaveBeenCalledWith("/Users/me/app", "rotate"));
  expect(await screen.findByText("feedface…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Force restart…" })).toBeNull();
});

it("asks each connected host's MCP through a daemon on that host, and offers Force restart for this computer's only", async () => {
  const remote = { repo: "alinery+ssh://h2/srv/api", state: "current" as const, issues: [], host: "h2", version: "0.600.0", started_by: "", os_user: "", mine: true };
  runtime.extra = [remote as never];
  machine.status.mockImplementation(async (repo: string) => mcpStatus(repo === remote.repo ? McpState.STUCK : McpState.OK));
  render(<RuntimePanel mcp={mcp} />);
  await waitFor(() => expect(machine.status).toHaveBeenCalledWith(remote.repo));
  expect(await screen.findByText("Not answering")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Force restart…" })).toBeNull();
  expect(screen.getAllByText("No daemon running here to ask")).toHaveLength(1);
});

const httpOf = (extra = {}) => ({ enabled: false, bind: "127.0.0.1", port: 39470, listening: false, error: "", addresses: ["192.168.1.20", "fd00::5"], ...extra });

it("keeps HTTP off until a token is set, then serves on all interfaces only after the cleartext warning, and shows the URL", async () => {
  machine.status.mockResolvedValue(mcpStatus(McpState.OK, { http: httpOf() }));
  const { unmount } = render(<RuntimePanel mcp={mcp} />);
  expect(await screen.findByText(/Require a token first/)).toBeTruthy();
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  unmount();

  machine.token.mockResolvedValue("feedface00112233");
  machine.http.mockResolvedValue(mcpStatus(McpState.OK));
  confirms.ask.mockResolvedValueOnce("cancel").mockResolvedValueOnce("confirm");
  render(<RuntimePanel mcp={mcp} />);
  await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByRole("combobox", { name: "Bind address" }), { target: { value: "0.0.0.0" } });
  expect(screen.getByText(/token is sent unencrypted/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(confirms.ask).toHaveBeenCalledTimes(1));
  expect(machine.http).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(machine.http).toHaveBeenCalledWith("/Users/me/app", { enabled: true, bind: "0.0.0.0", port: 39470 }));
});

it("names the URL a client uses: the bind, the first address for all interfaces, IPv6 in brackets", () => {
  expect(mcpHttpUrl(httpOf({ listening: true }), "box")).toBe("http://127.0.0.1:39470/mcp");
  expect(mcpHttpUrl(httpOf({ bind: "0.0.0.0" }), "box")).toBe("http://192.168.1.20:39470/mcp");
  expect(mcpHttpUrl(httpOf({ bind: "fd00::5", port: 8080 }), "box")).toBe("http://[fd00::5]:8080/mcp");
  expect(mcpHttpUrl(httpOf({ bind: "0.0.0.0", addresses: [] }), "box")).toBe("http://box:39470/mcp");
});
