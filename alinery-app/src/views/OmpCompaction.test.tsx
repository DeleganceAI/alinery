import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { OmpCompactionSnapshot } from "../types";
import { OmpCompaction } from "./OmpCompaction";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../ipc", () => mockIpc({ readOmpCompaction: mocks.read }));
const ready: OmpCompactionSnapshot = {
  binary_path: "/managed/omp",
  installed_version: "18.1.13",
  config_path: "/managed/config.yml",
  status: "ready",
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
});
afterEach(cleanup);
const valueFor = (label: string) => screen.getByText(label).nextElementSibling;

it("shows configured values without editing controls or invented capacity", async () => {
  render(<OmpCompaction />);
  await screen.findByText("65%");
  expect(valueFor("Auto-compaction")?.textContent).toBe("Off");
  expect(valueFor("Mid-turn compaction")?.textContent).toBe("Off");
  expect(valueFor("Async compaction")?.textContent).toBe("On");
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.getByRole("button", { name: /Refresh/ })).toBeTruthy();
  expect(screen.getByText(/10,000 tokens/)).toBeTruthy();
  expect(screen.getByText("Varies by model")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("distinguishes native defaults from explicitly configured values without warning", async () => {
  mocks.read.mockResolvedValue({
    ...ready,
    enabled: { value: true, source: "upstream_default" },
    threshold_percent: { value: -1, source: "upstream_default" },
    threshold_tokens: { value: -1, source: "upstream_default" },
  });
  render(<OmpCompaction />);
  await screen.findByText("On (OMP default)");
  expect(screen.getAllByText("Default (OMP default)")).toHaveLength(2);
  expect(valueFor("Mid-turn compaction")?.textContent).toBe("Off");
  expect(screen.queryByText("Unknown")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["legacy_unresolved", "invalid", "unreadable", "unsupported", "missing_binary"] as const)("keeps %s uncertainty distinct from confirmed defaults", async (status) => {
  const unknown = { value: null, source: "unknown" as const };
  mocks.read.mockResolvedValue({
    ...ready,
    status,
    enabled: unknown,
    threshold_percent: unknown,
    threshold_tokens: unknown,
    mid_turn_enabled: unknown,
    async_enabled: unknown,
  });
  render(<OmpCompaction />);
  await waitFor(() => expect(screen.getAllByText("Unknown")).toHaveLength(5));
  expect(screen.queryByText(/OMP default/)).toBeNull();
  expect(screen.queryByText("65%")).toBeNull();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("refreshes values and clears a failed refresh warning without dropping old values", async () => {
  render(<OmpCompaction />);
  await screen.findByText("65%");
  mocks.read.mockRejectedValueOnce(new Error("Read denied: PRIVATE_IPC_PAYLOAD"));
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await screen.findByRole("alert");
  expect(screen.getByText("65%")).toBeTruthy();
  expect(valueFor("Auto-compaction")?.textContent).toBe("Off");
  expect(screen.queryByText(/PRIVATE_IPC_PAYLOAD/)).toBeNull();

  const refreshed = deferred();
  mocks.read.mockReturnValueOnce(refreshed.promise);
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  expect(screen.getByText("65%")).toBeTruthy();
  await act(async () => refreshed.resolve({ ...ready, enabled: { value: true, source: "configured" }, threshold_percent: { value: 80, source: "configured" } }));
  expect(screen.getByText("80%")).toBeTruthy();
  expect(valueFor("Auto-compaction")?.textContent).toBe("On");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("preserves the six-row loading region through a first-read failure and retry without inventing values", async () => {
  const first = deferred();
  mocks.read.mockReturnValueOnce(first.promise);
  render(<OmpCompaction />);
  expect(screen.getAllByRole("term")).toHaveLength(6);
  expect(screen.getAllByLabelText("Loading")).toHaveLength(6);
  expect(screen.queryByText("65%")).toBeNull();
  expect(screen.queryByText("Unknown")).toBeNull();
  expect(screen.getByRole("button", { name: /Refresh/ }).hasAttribute("disabled")).toBe(true);
  await act(async () => first.reject(new Error("PRIVATE_IPC_PAYLOAD")));
  await screen.findByRole("alert");
  expect(screen.queryByText(/PRIVATE_IPC_PAYLOAD/)).toBeNull();
  expect(screen.queryAllByRole("term")).toHaveLength(0);
  const retry = deferred();
  mocks.read.mockReturnValueOnce(retry.promise);
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  expect(screen.queryByText("65%")).toBeNull();
  expect(screen.getByRole("alert")).toBeTruthy();
  await act(async () => retry.resolve(ready));
  expect(screen.getAllByRole("term")).toHaveLength(6);
  expect(screen.getByText("65%")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Loading")).toBeNull();
});

it("shows safe configuration causes while retaining trustworthy partial values", async () => {
  mocks.read.mockResolvedValue({
    ...ready,
    status: "invalid",
    threshold_percent: { value: null, source: "unknown" },
    errors: ["compaction.thresholdPercent must be a number"],
  });
  render(<OmpCompaction />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("compaction.thresholdPercent must be a number");
  expect(valueFor("Compaction threshold")?.textContent).toBe("Unknown");
  expect(valueFor("Auto-compaction")?.textContent).toBe("Off");
  mocks.read.mockResolvedValue(ready);
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await screen.findByText("65%");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows safe version-probe failures rather than hiding their cause", async () => {
  mocks.read.mockResolvedValue({
    ...ready,
    status: "unsupported",
    installed_version: null,
    errors: ["Couldn't identify the OMP version: the version check timed out."],
  });
  render(<OmpCompaction />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("the version check timed out");
  expect(screen.queryByRole("textbox")).toBeNull();
});

it.each(["resolve", "reject"] as const)("ignores an obsolete read that later %ss", async (outcome) => {
  const old = deferred();
  const latest = deferred();
  mocks.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  render(
    <StrictMode>
      <OmpCompaction />
    </StrictMode>,
  );
  await act(async () => latest.resolve({ ...ready, threshold_percent: { value: 80, source: "configured" } }));
  await act(async () => {
    if (outcome === "resolve") old.resolve(ready);
    else old.reject(new Error("Obsolete failure"));
  });
  expect(screen.getByText("80%")).toBeTruthy();
  expect(screen.queryByText("65%")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("ignores a pending read after unmount without changing a reopened snapshot", async () => {
  const late = deferred();
  mocks.read.mockReturnValueOnce(late.promise);
  const old = render(<OmpCompaction />);
  old.unmount();
  render(<OmpCompaction />);
  await screen.findByText("65%");
  await act(async () => late.resolve({ ...ready, threshold_percent: { value: 80, source: "configured" } }));
  expect(screen.getByText("65%")).toBeTruthy();
  expect(screen.queryByText("80%")).toBeNull();
});

it("keeps configured fallback distinct from an absent upstream token limit", async () => {
  mocks.read.mockResolvedValue({ ...ready, threshold_tokens: { value: -1, source: "configured" } });
  render(<OmpCompaction />);
  expect((await screen.findByText("Default")).title).toBe("configured");
  mocks.read.mockResolvedValue({ ...ready, threshold_tokens: { value: -1, source: "upstream_default" } });
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  expect((await screen.findByText("Default (OMP default)")).title).toBe("upstream_default");
});
