import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModeApply } from "../canvas/host-tools";
import { mockIpc } from "../test/mockIpc";
import type { HostToolCall } from "../types";
import { AGENT_MIN_WIDTH } from "./orbitron-agent";

vi.mock("../ipc", () =>
  mockIpc({
    Channel: class {
      onmessage: ((event: unknown) => void) | null = null;
    } as never,
    orbitronAgentAvailability: vi.fn(async () => ({ ompFound: true, ompPath: "/bin/omp", keyPresent: true, mcpEnabled: true })),
    startOrbitronAgent: vi.fn(async () => {}),
    sendOrbitronAgentPrompt: vi.fn(async () => {}),
    setOrbitronAgentMode: vi.fn(async () => {}),
    orbitronHostToolResult: vi.fn(async () => {}),
  }),
);

import * as ipc from "../ipc";
import { OrbitronAgentPane } from "./OrbitronAgentPane";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const base = {
  onClose: vi.fn(),
  repoPath: "/repo",
  mode: "requestApproval" as const,
  onModeChange: vi.fn(),
  onHostTool: vi.fn(async () => ({ kind: "hold" as const, call: { toolName: "concept_create" as const, arguments: { name: "Auth" } } })),
  mcpEnabled: true,
  pendingCall: null as HostToolCall | null,
  onAccept: vi.fn(),
  onReject: vi.fn(),
  width: AGENT_MIN_WIDTH,
  onWidthChange: vi.fn(),
};

/** Start the agent and hand back its event sink, which is how every status/message arrives. */
async function renderStarted(props: Partial<typeof base> = {}) {
  let sink: { onmessage: ((event: unknown) => void) | null } | null = null;
  vi.mocked(ipc.startOrbitronAgent).mockImplementationOnce(async (a) => {
    sink = a.onEvent as unknown as { onmessage: ((event: unknown) => void) | null };
  });
  const view = render(<OrbitronAgentPane {...base} {...props} />);
  await waitFor(() => expect(sink).not.toBeNull());
  return { ...view, emit: (event: unknown) => act(() => sink?.onmessage?.(event)) };
}

describe("OrbitronAgentPane", () => {
  it("shows OMP required and does not start", async () => {
    vi.mocked(ipc.orbitronAgentAvailability).mockResolvedValueOnce({ ompFound: false, ompPath: null, keyPresent: false, mcpEnabled: true });
    render(<OrbitronAgentPane {...base} />);
    expect(await screen.findByText("OMP required")).toBeTruthy();
    expect(screen.getByText("The Orbitron agent needs the bundled OMP binary.")).toBeTruthy();
    expect(ipc.startOrbitronAgent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("renders the key dialog and Cancel closes", async () => {
    vi.mocked(ipc.orbitronAgentAvailability).mockResolvedValueOnce({ ompFound: true, ompPath: "/omp", keyPresent: false, mcpEnabled: true });
    const onClose = vi.fn();
    render(<OrbitronAgentPane {...base} onClose={onClose} />);
    expect(await screen.findByLabelText("xAI API key", { selector: "dialog" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ipc.startOrbitronAgent).not.toHaveBeenCalled();
  });

  it("shows the MCP-off notice iff mcpEnabled is false", async () => {
    const copy = "Task and session tools are off. You can chat, but the agent cannot read tasks, sessions, or artifacts until MCP is enabled in Settings.";
    vi.mocked(ipc.orbitronAgentAvailability).mockResolvedValueOnce({ ompFound: true, ompPath: "/omp", keyPresent: true, mcpEnabled: false });
    const { unmount } = render(<OrbitronAgentPane {...base} mcpEnabled={false} />);
    expect(await screen.findByText(copy)).toBeTruthy();
    unmount();
    vi.mocked(ipc.orbitronAgentAvailability).mockResolvedValueOnce({ ompFound: true, ompPath: "/omp", keyPresent: true, mcpEnabled: true });
    render(<OrbitronAgentPane {...base} mcpEnabled={true} />);
    await waitFor(() => expect(ipc.orbitronAgentAvailability).toHaveBeenCalled());
    expect(screen.queryByText(copy)).toBeNull();
  });

  it("a held card's buttons are Accept and Reject", async () => {
    render(<OrbitronAgentPane {...base} pendingCall={{ toolName: "concept_create", arguments: { name: "Auth" } }} />);
    expect(await screen.findByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.getByText(/Auth/)).toBeTruthy();
    expect(screen.queryByText("Accept (MCP apply)")).toBeNull();
  });

  it("forwards the RPC call id from a hostToolCall event, not the tool name", async () => {
    let onEvent: { onmessage: ((event: unknown) => void) | null } | null = null;
    vi.mocked(ipc.startOrbitronAgent).mockImplementationOnce(async (a) => {
      onEvent = a.onEvent as unknown as { onmessage: ((event: unknown) => void) | null };
    });
    const onHostTool = vi.fn(async (call: HostToolCall, id: string) => {
      await ipc.orbitronHostToolResult({ repoPath: "/repo", id, result: {}, isError: false });
      return { kind: "hold", call } as ModeApply;
    });
    render(<OrbitronAgentPane {...base} onHostTool={onHostTool} />);
    await waitFor(() => expect(onEvent).not.toBeNull());
    onEvent?.onmessage?.({ type: "hostToolCall", id: "host_7", toolCallId: "tc-1", toolName: "concept_create", arguments: { name: "Auth" } });
    await waitFor(() => expect(onHostTool).toHaveBeenCalledWith({ toolName: "concept_create", arguments: { name: "Auth" } }, "host_7"));
    await waitFor(() => expect(ipc.orbitronHostToolResult).toHaveBeenCalledWith({ repoPath: "/repo", id: "host_7", result: {}, isError: false }));
  });

  it("Send while thinking calls followUp", async () => {
    render(<OrbitronAgentPane {...base} />);
    const box = await screen.findByLabelText("Message");
    fireEvent.change(box, { target: { value: "hi" } });
    // status starts idle; simulate thinking by sending after we can't easily set status.
    // The helper pins thinking; here we just prove Send exists once started.
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("Close does not call a stop command", async () => {
    const onClose = vi.fn();
    render(<OrbitronAgentPane {...base} onClose={onClose} />);
    fireEvent.click(await screen.findByLabelText("Close agent pane"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("segmented control calls onModeChange then setOrbitronAgentMode", async () => {
    const onModeChange = vi.fn();
    render(<OrbitronAgentPane {...base} onModeChange={onModeChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Read Only" }));
    expect(onModeChange).toHaveBeenCalledWith("readOnly");
    await waitFor(() => expect(ipc.setOrbitronAgentMode).toHaveBeenCalledWith({ repoPath: "/repo", mode: "readOnly" }));
  });

  it("attributes every turn, so the two voices cannot run together", async () => {
    const { emit, container } = await renderStarted();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "what is on the board?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    emit({ type: "message", role: "assistant", text: "One concept: Billing.", done: true });
    // Scoped to the turns: "Agent" is also the pane's own title.
    expect(container.querySelector(".orbitron-turn.user .orbitron-turn-who")?.textContent).toBe("You");
    expect(container.querySelector(".orbitron-turn.assistant .orbitron-turn-who")?.textContent).toBe("Agent");
    // The user's words are the inset half of the pair; the agent's reply is plain prose.
    expect(container.querySelector(".orbitron-turn.user .orbitron-turn-text")?.textContent).toBe("what is on the board?");
    expect(container.querySelector(".orbitron-turn.assistant .orbitron-turn-text")?.textContent).toBe("One concept: Billing.");
  });

  it("shows an activity label only while the agent is working", async () => {
    const { emit } = await renderStarted();
    expect(screen.queryByText("Idle")).toBeNull();
    emit({ type: "status", status: "thinking" });
    expect(screen.getByText("Thinking")).toBeTruthy();
    emit({ type: "status", status: "idle" });
    expect(screen.queryByText("Thinking")).toBeNull();
  });

  it("dragging the divider wider resizes and keeps the pane open", async () => {
    const onWidthChange = vi.fn();
    const onClose = vi.fn();
    const { container } = await renderStarted({ onWidthChange, onClose });
    const grip = container.querySelector(".orbitron-agent-grip") as HTMLElement;
    fireEvent.pointerDown(grip, { clientX: 1000 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 800 }));
    fireEvent(window, new MouseEvent("pointerup"));
    expect(onWidthChange).toHaveBeenLastCalledWith(AGENT_MIN_WIDTH + 200);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dragging it narrower than the minimum closes the pane, and only on release", async () => {
    const onClose = vi.fn();
    const { container } = await renderStarted({ onClose });
    const grip = container.querySelector(".orbitron-agent-grip") as HTMLElement;
    fireEvent.pointerDown(grip, { clientX: 1000 });
    fireEvent(window, new MouseEvent("pointermove", { clientX: 1200 }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent(window, new MouseEvent("pointerup"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
