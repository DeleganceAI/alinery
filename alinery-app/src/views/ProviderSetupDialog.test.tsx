import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

const mocks = vi.hoisted(() => ({
  ompSetupSession: vi.fn(),
  rpcAttachSession: vi.fn(),
  rpcWriteSession: vi.fn(),
  readOmpModelRoles: vi.fn(),
  detachSession: vi.fn(),
  openUrl: vi.fn(),
}));
vi.mock("../ipc", () => mockIpc(mocks));

/** One `get_login_providers` response line, as the daemon forwards it. */
const providersLine = (rows: { id: string; authenticated: boolean }[]) =>
  JSON.stringify({
    type: "response",
    id: "p1",
    command: "get_login_providers",
    success: true,
    data: { providers: rows.map((row) => ({ id: row.id, name: row.id, available: true, authenticated: row.authenticated })) },
  });

function mountWith(lines: string[], mode: "auto" | "manual" = "auto") {
  const onClose = vi.fn();
  mocks.ompSetupSession.mockResolvedValue("__omp-setup__");
  mocks.readOmpModelRoles.mockResolvedValue({});
  mocks.rpcWriteSession.mockResolvedValue(undefined);
  mocks.detachSession.mockResolvedValue(undefined);
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.rpcAttachSession.mockImplementation(async ({ onLine }: { onLine: (line: string) => void }) => {
    await Promise.resolve();
    for (const line of lines) onLine(line);
  });

  render(<ProviderSetupDialog mode={mode} onClose={onClose} />);
  return onClose;
}

async function emit(value: unknown) {
  const calls = mocks.rpcAttachSession.mock.calls;
  const attach = calls[calls.length - 1]?.[0] as { onLine: (line: string) => void };
  await act(async () => attach.onLine(JSON.stringify(value)));
}

function uiResponses(requestId: string) {
  return mocks.rpcWriteSession.mock.calls
    .map(([, payload]) => payload as { type?: string; id?: string; confirmed?: boolean; value?: string })
    .filter((payload) => payload.type === "extension_ui_response" && payload.id === requestId);
}

async function startLogin() {
  mountWith([providersLine([{ id: "openai-codex", authenticated: false }])], "manual");
  fireEvent.click(await screen.findByRole("button", { name: /openai-codex/ }));
  await waitFor(() => expect(mocks.rpcWriteSession).toHaveBeenCalledWith("__omp-setup__", expect.objectContaining({ type: "login", providerId: "openai-codex" })));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ProviderSetupDialog", () => {
  it("opens the requested sign-in link once, acknowledges it, and requires approval for another link", async () => {
    await startLogin();
    const request = { type: "extension_ui_request", id: "login-url", method: "open_url", url: "https://display.example", launchUrl: "https://auth.example/callback" };
    await emit(request);
    await emit(request);

    await waitFor(() => expect(uiResponses("login-url")).toEqual([{ type: "extension_ui_response", id: "login-url", confirmed: true }]));
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith("https://auth.example/callback");

    await emit({ type: "extension_ui_request", id: "second-url", method: "open_url", launchUrl: "https://second.example" });
    expect(await screen.findByRole("button", { name: "Allow" })).toBeTruthy();
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
    expect(uiResponses("second-url")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(uiResponses("second-url")).toEqual([{ type: "extension_ui_response", id: "second-url", confirmed: false }]));
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
  });

  it("declines an unsafe sign-in URL without launching it", async () => {
    await startLogin();
    await emit({ type: "extension_ui_request", id: "blocked-url", method: "open_url", launchUrl: "file:///etc/passwd" });

    await waitFor(() => expect(uiResponses("blocked-url")).toEqual([{ type: "extension_ui_response", id: "blocked-url", confirmed: false }]));
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(screen.getByText(/only http and https/i)).toBeTruthy();
  });

  it("shows an opener failure and tells OMP the browser did not open", async () => {
    await startLogin();
    mocks.openUrl.mockRejectedValue(new Error("browser could not open"));
    await emit({ type: "extension_ui_request", id: "failed-url", method: "open_url", launchUrl: "https://auth.example" });

    await waitFor(() => expect(uiResponses("failed-url")).toEqual([{ type: "extension_ui_response", id: "failed-url", confirmed: false }]));
    expect(screen.getByText(/browser could not open/)).toBeTruthy();
  });

  it("lets the user submit a login code inside the provider dialog", async () => {
    await startLogin();
    await emit({ type: "extension_ui_request", id: "login-code", method: "input", title: "Paste your login code" });

    fireEvent.change(await screen.findByRole("textbox", { name: "Paste your login code" }), { target: { value: "test-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(uiResponses("login-code")).toEqual([{ type: "extension_ui_response", id: "login-code", value: "test-code" }]));
    expect(screen.queryByRole("textbox", { name: "Paste your login code" })).toBeNull();
  });

  it("brings up the reserved setup session rather than needing a real one", async () => {
    mountWith([providersLine([{ id: "anthropic", authenticated: false }])]);
    await waitFor(() => expect(mocks.ompSetupSession).toHaveBeenCalled());
    expect(mocks.rpcAttachSession).toHaveBeenCalledWith(expect.objectContaining({ id: "__omp-setup__" }));
  });

  it("shows the dialog on repo open when nothing is authenticated", async () => {
    const onClose = mountWith([providersLine([{ id: "anthropic", authenticated: false }])]);
    await waitFor(() => expect(screen.getByText(/anthropic/i)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stays invisible and reports not-needed when the install is already set up", async () => {
    const onClose = mountWith([providersLine([{ id: "anthropic", authenticated: true }])]);
    await waitFor(() => expect(onClose).toHaveBeenCalledWith("not-needed"));
    // "not-needed" is what keeps a self-close from being remembered as a dismissal, so an install
    // that later loses its credentials is offered setup again.
    expect(screen.queryByText(/Advanced/)).toBeNull();
  });

  it("opens regardless of provider state when the user asked for it", async () => {
    const onClose = mountWith([providersLine([{ id: "anthropic", authenticated: true }])], "manual");
    await waitFor(() => expect(screen.getByText(/anthropic/i)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("releases the setup session when it goes away", async () => {
    mountWith([providersLine([{ id: "anthropic", authenticated: false }])]);
    await waitFor(() => expect(mocks.rpcAttachSession).toHaveBeenCalled());
    const { attachId } = mocks.rpcAttachSession.mock.calls[0][0];
    cleanup();
    expect(mocks.detachSession).toHaveBeenCalledWith("__omp-setup__", attachId);
  });

  it("releases a setup session that only arrives after it goes away", async () => {
    let resolveSession: (id: string) => void = () => undefined;
    mocks.ompSetupSession.mockReturnValue(new Promise<string>((resolve) => (resolveSession = resolve)));
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.rpcAttachSession.mockResolvedValue(undefined);
    mocks.detachSession.mockResolvedValue(undefined);
    render(<ProviderSetupDialog mode="auto" onClose={vi.fn()} />);
    cleanup();
    resolveSession("__omp-setup__");
    // The attach still has to happen: the daemon only arms its idle reaper once it has seen a
    // client, so skipping it would strand the session instead of releasing it.
    await waitFor(() => expect(mocks.detachSession).toHaveBeenCalledWith("__omp-setup__", expect.any(Number)));
    expect(mocks.rpcAttachSession).toHaveBeenCalledTimes(1);
  });

  it("shows Connecting… in manual mode before providers arrive", async () => {
    mocks.ompSetupSession.mockResolvedValue("__omp-setup__");
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.rpcWriteSession.mockResolvedValue(undefined);
    mocks.detachSession.mockResolvedValue(undefined);
    mocks.rpcAttachSession.mockImplementation(async () => undefined);
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    expect(screen.queryByText("No models match.")).toBeNull();
    expect(screen.queryByText("No Chat-capable providers yet.")).toBeNull();
  });

  it("retries ompSetupSession when the daemon is not connected then shows providers", async () => {
    vi.useFakeTimers();
    mocks.ompSetupSession.mockRejectedValueOnce(new Error("daemon not connected")).mockResolvedValue("__omp-setup__");
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.rpcWriteSession.mockResolvedValue(undefined);
    mocks.detachSession.mockResolvedValue(undefined);
    mocks.rpcAttachSession.mockImplementation(async ({ onLine }: { onLine: (line: string) => void }) => {
      await Promise.resolve();
      onLine(providersLine([{ id: "anthropic", authenticated: false }]));
    });
    render(<ProviderSetupDialog mode="manual" onClose={vi.fn()} />);
    expect(mocks.ompSetupSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.ompSetupSession.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText(/anthropic/i)).toBeTruthy());
  });

  it("surfaces a failed catalogue after persistent daemon not connected, without ready-empty copy", async () => {
    vi.useFakeTimers();
    mocks.ompSetupSession.mockRejectedValue(new Error("daemon not connected"));
    mocks.readOmpModelRoles.mockResolvedValue({});
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    vi.useRealTimers();
    expect(screen.getByText(/daemon not connected/i)).toBeTruthy();
    expect(screen.queryByText("No models match.")).toBeNull();
    expect(screen.queryByText("No Chat-capable providers yet.")).toBeNull();
  });

  it("retries daemon not connected in auto mode without closing or painting empty lists", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    mocks.ompSetupSession.mockRejectedValue(new Error("daemon not connected"));
    mocks.readOmpModelRoles.mockResolvedValue({});
    render(<ProviderSetupDialog mode="auto" onClose={onClose} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.ompSetupSession.mock.calls.length).toBeGreaterThan(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("No Chat-capable providers yet.")).toBeNull();
    vi.useRealTimers();
  });

  it("detaches a setup session when attach fails with daemon not connected, then retries", async () => {
    vi.useFakeTimers();
    mocks.ompSetupSession.mockResolvedValueOnce("__omp-setup-1__").mockResolvedValueOnce("__omp-setup-2__");
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.rpcWriteSession.mockResolvedValue(undefined);
    mocks.detachSession.mockResolvedValue(undefined);
    mocks.rpcAttachSession.mockRejectedValueOnce(new Error("daemon not connected")).mockImplementation(async ({ onLine }: { onLine: (line: string) => void }) => {
      await Promise.resolve();
      onLine(providersLine([{ id: "anthropic", authenticated: false }]));
    });
    render(<ProviderSetupDialog mode="auto" onClose={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.detachSession).toHaveBeenCalledWith("__omp-setup-1__", expect.any(Number));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.ompSetupSession.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText(/anthropic/i)).toBeTruthy());
    expect(mocks.rpcAttachSession).toHaveBeenCalledWith(expect.objectContaining({ id: "__omp-setup-2__" }));
  });

  it("opens Accounts when unsignedOpensAccounts and providers need setup", async () => {
    const extras = { unsignedOpensAccounts: true };
    mocks.ompSetupSession.mockResolvedValue("__omp-setup__");
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.rpcWriteSession.mockResolvedValue(undefined);
    mocks.detachSession.mockResolvedValue(undefined);
    mocks.rpcAttachSession.mockImplementation(async ({ onLine }: { onLine: (line: string) => void }) => {
      await Promise.resolve();
      onLine(providersLine([{ id: "anthropic", authenticated: false }]));
    });
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} {...extras} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Accounts" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("stays on Models without unsignedOpensAccounts", async () => {
    mocks.ompSetupSession.mockResolvedValue("__omp-setup__");
    mocks.readOmpModelRoles.mockResolvedValue({});
    mocks.rpcWriteSession.mockResolvedValue(undefined);
    mocks.detachSession.mockResolvedValue(undefined);
    mocks.rpcAttachSession.mockImplementation(async ({ onLine }: { onLine: (line: string) => void }) => {
      await Promise.resolve();
      onLine(providersLine([{ id: "anthropic", authenticated: false }]));
    });
    render(<ProviderSetupDialog mode="manual" initialTab="models" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Models" }).getAttribute("aria-selected")).toBe("true"));
  });
});
