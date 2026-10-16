import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { OmpCompactionSnapshot } from "../types";
import { OmpCompaction } from "./OmpCompaction";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../ipc", () => mockIpc({ readOmpCompaction: mocks.read, setOmpAutoCompaction: mocks.write }));
const ready: OmpCompactionSnapshot = {
  binary_path: "/managed/omp",
  installed_version: "18.1.13",
  config_path: "/managed/config.yml",
  status: "ready",
  revision: "first",
  write_allowed: true,
  write_blocked_reason: null,
  pending_defaults: false,
  enabled: { value: false, source: "configured" },
  threshold_percent: { value: 65, source: "configured" },
  threshold_tokens: { value: 10000, source: "configured" },
  mid_turn_enabled: { value: false, source: "configured" },
  async_enabled: { value: true, source: "configured" },
  errors: [],
};
function deferred() {
  let resolve!: (value: OmpCompactionSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<OmpCompactionSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(ready);
  mocks.write.mockReset();
});
afterEach(cleanup);
const checkbox = () => screen.getByRole("checkbox", { name: "Auto-compaction" }) as HTMLInputElement;

it("shows configured false and threshold without inventing capacity", async () => {
  render(<OmpCompaction />);
  await screen.findByText(/65%/);
  expect(checkbox().checked).toBe(false);
  expect(checkbox().disabled).toBe(false);
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.getByText(/10,000 tokens/)).toBeTruthy();
  expect(screen.getByText(/Varies by model/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows native defaults from an existing database even when editing is unavailable", async () => {
  mocks.read.mockResolvedValue({
    ...ready,
    status: "pending_initialization",
    pending_defaults: true,
    write_allowed: false,
    write_blocked_reason: "Save settings in OMP before editing them here.",
    enabled: { value: true, source: "upstream_default" },
    threshold_percent: { value: -1, source: "upstream_default" },
    threshold_tokens: { value: -1, source: "upstream_default" },
    mid_turn_enabled: { value: true, source: "upstream_default" },
    async_enabled: { value: true, source: "upstream_default" },
  });
  render(<OmpCompaction />);
  await screen.findByRole("alert");
  expect(screen.getAllByText("Default (OMP default)")).toHaveLength(2);
  expect(screen.queryByText("Unknown")).toBeNull();
  expect(screen.queryByText("40%")).toBeNull();
  expect(checkbox().disabled).toBe(true);
  expect(checkbox().checked).toBe(true);
});

it.each(["legacy_unresolved", "invalid", "unreadable", "unsupported", "missing_binary"] as const)("keeps %s uncertainty distinct from confirmed defaults", async (status) => {
  const unknown = { value: null, source: "unknown" as const };
  mocks.read.mockResolvedValue({
    ...ready,
    status,
    write_allowed: false,
    enabled: unknown,
    threshold_percent: unknown,
    threshold_tokens: unknown,
    mid_turn_enabled: unknown,
    async_enabled: unknown,
    pending_defaults: status === "legacy_unresolved",
    errors: status === "legacy_unresolved" ? ["Legacy configuration unresolved"] : [],
  });
  render(<OmpCompaction />);
  await waitFor(() => expect(screen.getAllByText("Unknown")).toHaveLength(5));
  expect(checkbox().disabled).toBe(true);
  expect(checkbox().checked).toBe(false);
  expect(screen.queryByText(/65%/)).toBeNull();
  expect(screen.queryByText(/40%/)).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("confirms checkbox only after persisted result", async () => {
  const write = deferred();
  mocks.write.mockReturnValue(write.promise);
  render(<OmpCompaction />);
  await screen.findByText(/65%/);
  fireEvent.click(checkbox());
  expect(mocks.write).toHaveBeenCalledWith(true, "first");
  expect(checkbox().checked).toBe(false);
  expect(checkbox().disabled).toBe(true);
  await act(async () => write.resolve({ ...ready, revision: "second", enabled: { value: true, source: "configured" } }));
  expect(checkbox().checked).toBe(true);
  expect(checkbox().disabled).toBe(false);
});

it.each(["Installation busy", "Stale revision", "Persistence failed"])("keeps confirmed value stale after %s until refresh", async (message) => {
  mocks.write.mockRejectedValue(new Error(message));
  render(<OmpCompaction />);
  await screen.findByText(/65%/);
  fireEvent.click(checkbox());
  await screen.findByRole("alert");
  expect(checkbox().checked).toBe(false);
  expect(checkbox().disabled).toBe(true);
  expect(mocks.write).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await waitFor(() => expect(checkbox().disabled).toBe(false));
  expect(mocks.write).toHaveBeenCalledTimes(1);
});

it("retains stale values after refresh failure and reports initial read failure as unavailable", async () => {
  const view = render(<OmpCompaction />);
  await screen.findByText(/65%/);
  mocks.read.mockRejectedValue(new Error("Read denied"));
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await screen.findByRole("alert");
  expect(screen.getByText(/65%/)).toBeTruthy();
  expect(checkbox().disabled).toBe(true);
  view.unmount();
  render(<OmpCompaction />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("refresh and unmount discard obsolete responses", async () => {
  const old = deferred();
  const latest = deferred();
  mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const view = render(
    <StrictMode>
      <OmpCompaction />
    </StrictMode>,
  );
  await act(async () => latest.resolve(ready));
  const write = deferred();
  mocks.write.mockReturnValue(write.promise);
  fireEvent.click(checkbox());
  await act(async () => write.resolve({ ...ready, enabled: { value: true, source: "configured" } }));
  await act(async () => old.resolve(ready));
  expect(checkbox().checked).toBe(true);
  const late = deferred();
  mocks.read.mockReturnValue(late.promise);
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  view.unmount();
  await act(async () => late.resolve(ready));
  expect(screen.queryByRole("checkbox")).toBeNull();
});

it("ignores a pending write after unmount without changing a reopened snapshot", async () => {
  const write = deferred();
  mocks.write.mockReturnValue(write.promise);
  const old = render(<OmpCompaction />);
  await screen.findByText(/65%/);
  fireEvent.click(checkbox());
  old.unmount();
  render(<OmpCompaction />);
  await screen.findByText(/65%/);
  await act(async () => write.resolve({ ...ready, enabled: { value: true, source: "configured" } }));
  expect(checkbox().checked).toBe(false);
  expect(checkbox().disabled).toBe(false);
});

it("keeps configured fallback distinct from an absent upstream token limit", async () => {
  mocks.read.mockResolvedValue({ ...ready, threshold_tokens: { value: -1, source: "configured" } });
  render(<OmpCompaction />);
  expect((await screen.findByText("Default")).title).toBe("configured");
  mocks.read.mockResolvedValue({ ...ready, threshold_tokens: { value: -1, source: "upstream_default" } });
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  expect((await screen.findByText("Default (OMP default)")).title).toBe("upstream_default");
});
