import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import uiConfirm from "../chat/fixtures/live-extension_ui_confirm.json";
import uiWidget from "../chat/fixtures/live-extension_ui_request.json";
import subagentLifecycle from "../chat/fixtures/live-subagent_lifecycle.json";
import { type ChatPrefs, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import { askConfirm, confirmDanger } from "../confirm";
import { mockIpc } from "../test/mockIpc";
import { journalPage } from "../test/ompJournal";
import { stubScrollSize } from "../test/scroll";
import type { ChatThread, SessionMeta } from "../types";
import { ChatView, repoLabel } from "./ChatView";

vi.mock("../confirm", () => ({
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "cancel"),
}));
vi.mock("../SessionTerminal", () => ({ SessionTerminal: () => <div data-testid="terminal" /> }));
vi.mock("./ProviderSetupDialog", () => ({
  ProviderSetupDialog: ({ initialTab, preselect }: { initialTab?: string; preselect?: string }) => <div data-testid="providers" data-tab={initialTab} data-preselect={preselect} />,
}));

const mocks = vi.hoisted(() => ({
  listChatThreads: vi.fn(),
  listChatRepos: vi.fn(),
  archiveChatThread: vi.fn(),
  setChatPinned: vi.fn(),
  resumeChatThread: vi.fn(),
  createChatThread: vi.fn(),
  chatSessionStatus: vi.fn(),
  chatRpcAttach: vi.fn(),
  onStreamClosed: vi.fn(),
  chatDetach: vi.fn(),
  chatRpcWrite: vi.fn(),
  chatRestate: vi.fn(),
  readChatOmp: vi.fn(),
  openUrl: vi.fn(),
  sessionListStatuses: vi.fn(),
  chatThreadName: vi.fn(),
  startChatThread: vi.fn(),
}));

vi.mock("../ipc", () =>
  mockIpc({
    listChatThreads: mocks.listChatThreads,
    listChatRepos: mocks.listChatRepos,
    archiveChatThread: mocks.archiveChatThread,
    setChatPinned: mocks.setChatPinned,
    resumeChatThread: mocks.resumeChatThread,
    createChatThread: mocks.createChatThread,
    chatSessionStatus: mocks.chatSessionStatus,
    chatRpcAttach: mocks.chatRpcAttach,
    onStreamClosed: mocks.onStreamClosed,
    chatDetach: mocks.chatDetach,
    chatRpcWrite: mocks.chatRpcWrite,
    chatRestate: mocks.chatRestate,
    readChatOmp: mocks.readChatOmp,
    openUrl: mocks.openUrl,
    sessionListStatuses: mocks.sessionListStatuses,
    chatThreadName: mocks.chatThreadName,
    startChatThread: mocks.startChatThread,
  }),
);
function chat(visibility: ChatPrefs = DEFAULT_CHAT_VISIBILITY) {
  return <ChatView terminalFontSize={13} visibility={visibility} />;
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    worktree: "/repo",
    created: 1,
    archived: false,
    phase: "",
    harness: "omp",
    model: "grok",
    playbook: "",
    generic: true,
    harness_resume_token: "tok",
    ended_at: 2,
    ...extra,
  };
}

function thread(id: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    repo_path: "/repo",
    session: meta(id),
    name: null,
    branch_label: "main",
    checkout: true,
    ...extra,
  };
}

/** A live OMP chat as the daemon reports it; `unknown` is a process that has not printed `ready` yet. */
function observed(agent: "unknown" | "idle" | "busy" | "waiting_for_input", process: "alive" | "exited" = "alive", transport?: "pty" | "rpc") {
  return {
    transport,
    lifecycle: { state: process === "alive" ? "live" : "live_exited" },
    checkpoint: {},
    state: {
      process: { state: process },
      agent: { state: agent },
      playbook: { state: "in_progress" },
      adapter: "omp",
      message_adapter: "omp_bracketed_paste",
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

beforeEach(() => {
  mocks.chatSessionStatus.mockResolvedValue(null);
  mocks.chatRpcAttach.mockResolvedValue(undefined);
  mocks.onStreamClosed.mockReset().mockReturnValue(() => {});
  mocks.chatDetach.mockResolvedValue(undefined);
  mocks.chatRpcWrite.mockResolvedValue(undefined);
  mocks.chatRestate.mockResolvedValue(undefined);
  mocks.readChatOmp.mockRejectedValue(new Error("no journal"));
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.sessionListStatuses.mockResolvedValue({});
  mocks.archiveChatThread.mockResolvedValue(undefined);
  mocks.setChatPinned.mockReset().mockResolvedValue(undefined);
  mocks.listChatThreads.mockResolvedValue([]);
  mocks.listChatRepos.mockResolvedValue(["/repo"]);
  mocks.chatThreadName.mockResolvedValue(null);
});

/** A rail row's name is the thread label, then its status: "Chat s-live, Idle". */
const threadRow = (id: string) => new RegExp(`^Chat ${id}(,|$)`);
const link = () => screen.getByTestId("chat-view").dataset.link;
/** The open thread's status, in the title bar (the rail row repeats it). */
const titleBar = () => within(document.querySelector(".chat-titlebar") as HTMLElement);
const rail = () => screen.getByTestId("chat-rail");
const NONE_OPEN = "No repositories are currently available to Chat in this window. Open or check one in the repo switcher.";

describe("ChatView", () => {
  it("asks for a repo and leaves the worktree checkbox off", async () => {
    mocks.listChatThreads.mockResolvedValue([]);
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const box = screen.getByRole("checkbox", { name: "New worktree and branch" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ava" })).toBeTruthy();
  });

  it("archives a checkout thread without deleting the repo", async () => {
    const row = thread("s-checkout");
    mocks.listChatThreads.mockResolvedValue([row]);
    vi.mocked(confirmDanger).mockResolvedValue(true);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-checko") }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalledWith("Archive chat", expect.stringContaining("checkout is not touched"), "Archive"));
    expect(String(vi.mocked(confirmDanger).mock.calls[0]?.[1])).toContain("Archive “Chat s-checko” in repo.");
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-checkout", false));
    expect(String(vi.mocked(confirmDanger).mock.calls[0]?.[1])).not.toContain("delete the repo");
  });

  it("keeps a worktree unless the remove choice is taken", async () => {
    const row = thread("s-wt", { checkout: false, session: meta("s-wt", { worktree: "/repo/.alinery/chat-worktrees/s-wt" }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    vi.mocked(askConfirm).mockResolvedValueOnce("archive");
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-wt") }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    // Enter on the opened dialog is Cancel: no default on a choice that removes or stops work.
    expect(vi.mocked(askConfirm).mock.calls[0]?.[0].defaultKey).toBeUndefined();
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-wt", false));

    vi.mocked(askConfirm).mockResolvedValueOnce("remove");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-wt", true));

    vi.mocked(askConfirm).mockResolvedValueOnce("cancel");
    mocks.archiveChatThread.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(askConfirm).toHaveBeenCalled());
    expect(mocks.archiveChatThread).not.toHaveBeenCalled();
  });

  it("starts the rail collapsed at 900 and still offers a new chat", () => {
    mocks.listChatThreads.mockResolvedValue([]);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    render(chat());
    expect(screen.queryByTestId("chat-rail")).toBeNull();
    expect(screen.getByRole("button", { name: "Start a new chat" })).toBeTruthy();
  });

  it("hides the composer until a thread is picked and starts a new chat in the first repo", async () => {
    mocks.listChatThreads.mockResolvedValue([]);
    mocks.listChatRepos.mockResolvedValue(["/first", "/second"]);
    render(<ChatView terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} />);
    expect(screen.queryByLabelText("Message or /command")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    const dialog = await screen.findByRole("dialog", { name: "New thread" });
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("/first");
  });

  it("lists archived threads and resumes immediately", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    mocks.listChatThreads.mockImplementation(async (includeArchived: boolean) => (includeArchived ? [row] : []));
    mocks.resumeChatThread.mockResolvedValue(meta("s-next"));
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    await waitFor(() => expect(mocks.listChatThreads).toHaveBeenCalledWith(true));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", "s-arch"));
  });

  it("pins and unpins a thread from its own row without selecting it", async () => {
    const plain = thread("s-plain");
    const pinned = thread("s-pinned", { session: meta("s-pinned", { pinned: true }) });
    mocks.listChatThreads.mockResolvedValue([plain, pinned]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Pin Chat s-plain" }));
    await waitFor(() => expect(mocks.setChatPinned).toHaveBeenCalledWith("/repo", "s-plain", true));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Chat s-pinned" }));
    await waitFor(() => expect(mocks.setChatPinned).toHaveBeenCalledWith("/repo", "s-pinned", false));
    // The thread list is re-read so the row's icon and order follow, and nothing was opened.
    await waitFor(() => expect(mocks.listChatThreads.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByRole("heading", { name: "Ava" })).toBeTruthy();
  });

  it("archives the hovered thread, not the open one", async () => {
    const open = thread("s-open");
    const other = thread("s-other");
    mocks.listChatThreads.mockResolvedValue([open, other]);
    vi.mocked(confirmDanger).mockResolvedValue(true);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-open") }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Chat s-other" }));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-other", false));
    expect(mocks.archiveChatThread).not.toHaveBeenCalledWith("/repo", "s-open", expect.anything());
  });

  it("offers Resume instead of row actions on an archived thread", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    mocks.listChatThreads.mockImplementation(async (includeArchived: boolean) => (includeArchived ? [row] : []));
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive Chat s-arch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin Chat s-arch" })).toBeNull();
  });

  it("opens a booting thread idle and sends its first message as a prompt", async () => {
    // A new thread is started at create, so started_at is set before any turn and OMP has not printed `ready` yet.
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("unknown"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await waitFor(() => expect(mocks.chatSessionStatus).toHaveBeenCalled());
    expect(await titleBar().findByText("Idle")).toBeTruthy();
    await waitFor(() => expect(link()).toBe("ready"));
    expect(screen.queryByText("Working…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello" } });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-new", expect.objectContaining({ type: "prompt", message: "hello" })));
    expect(mocks.chatRpcWrite).not.toHaveBeenCalledWith("/repo", "s-new", expect.objectContaining({ type: "follow_up" }));
  });

  it("refreshes the thread status while it stays selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
      mocks.listChatThreads.mockResolvedValue([row]);
      mocks.chatSessionStatus.mockResolvedValueOnce(observed("busy")).mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      expect(await screen.findByRole("button", { name: "Abort turn" })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      expect(titleBar().getByText("Idle")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues while a turn runs and Send now interrupts it", async () => {
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("busy"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    await screen.findByRole("button", { name: "Abort turn" });
    const field = screen.getByLabelText("Send after this turn…");

    fireEvent.change(field, { target: { value: "later" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "follow_up", message: "later" })));

    fireEvent.change(field, { target: { value: "now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort_and_prompt", message: "now" })));
  });

  it("writes abort while the thread is running", async () => {
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    mocks.chatSessionStatus.mockResolvedValue(observed("busy"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    fireEvent.click(await screen.findByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort" })));
  });
  async function openLive(status: ReturnType<typeof observed>, others: ChatThread[] = []) {
    let onLine: (line: string) => void = () => {};
    mocks.chatRpcAttach.mockImplementation(async (args: { onLine: (line: string) => void }) => {
      onLine = args.onLine;
    });
    const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row, ...others]);
    mocks.chatSessionStatus.mockResolvedValue(status);
    const { rerender } = render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    // The seven handshake writes land, and the link is ready, before any send in these tests.
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(7));
    await waitFor(() => expect(link()).toBe("ready"));
    return { rerender, emit: (event: object) => act(() => onLine(JSON.stringify(event))) };
  }

  function sendIdle(text: string) {
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  }

  /** Closes the newest attach's live stream, as the daemon dropping its client does. */
  function dropStream() {
    const calls = mocks.onStreamClosed.mock.calls;
    const [, , onClosed] = calls[calls.length - 1] as [string, number, () => void];
    act(() => onClosed());
  }

  /** Drops the live stream of an RPC thread and waits until the reattach's handshake is done. */
  async function reattach() {
    const attaches = mocks.chatRpcAttach.mock.calls.length;
    dropStream();
    await waitFor(() => expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(attaches + 1));
    await waitFor(() => expect(link()).toBe("ready"));
  }

  it("reattaches when the daemon drops the live stream, and leaves a thread moved to Terminal alone", async () => {
    await openLive(observed("busy", "alive", "rpc"));
    expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(1);
    dropStream();
    await waitFor(() => expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(2));
    mocks.chatSessionStatus.mockResolvedValue(observed("idle", "alive", "pty"));
    dropStream();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(2);
  });

  it("keeps the rename editor and its typed name through a reattach, and closes it on a thread switch", async () => {
    await openLive(observed("idle", "alive", "rpc"), [thread("s-other")]);
    fireEvent.click(titleBar().getByRole("button", { name: "Rename thread" }));
    fireEvent.change(screen.getByLabelText("Thread name"), { target: { value: "Half typed" } });
    await reattach();
    expect((screen.getByLabelText("Thread name") as HTMLInputElement).value).toBe("Half typed");
    fireEvent.click(screen.getByRole("button", { name: threadRow("s-other") }));
    await waitFor(() => expect(screen.queryByLabelText("Thread name")).toBeNull());
  });

  it("keeps an open providers dialog through a reattach", async () => {
    await openLive(observed("idle", "alive", "rpc"));
    sendIdle("/login");
    const dialog = await screen.findByTestId("providers");
    await reattach();
    expect(screen.getByTestId("providers")).toBe(dialog);
  });

  it("opens the MCP dialog from /mcp list output that lands after a reattach", async () => {
    const { emit } = await openLive(observed("idle", "alive", "rpc"));
    sendIdle("/mcp");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "/mcp list" })));
    await reattach();
    emit({ type: "command_output", text: "gh | http | enabled | project" });
    const dialog = await screen.findByRole("dialog", { name: "MCP servers" });
    expect(within(dialog).getByText(/gh/)).toBeTruthy();
  });

  it("stops reattaching once the stream keeps closing, says only that it closed, and reconnects on request", async () => {
    await openLive(observed("busy", "alive", "rpc"));
    const [, , , onGiveUp] = mocks.onStreamClosed.mock.calls[0] as [string, number, () => void, () => void];
    act(() => onGiveUp());
    expect(await screen.findByText("The live connection closed repeatedly, so automatic reconnection stopped. Reconnect to try again.")).toBeTruthy();
    expect(screen.queryByText(/falling behind/i)).toBeNull();
    expect(titleBar().getByText("Disconnected")).toBeTruthy();
    expect(link()).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(link()).toBe("ready"));
    expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
  });

  it("takes back a send OMP refuses: the bubble goes and the text returns to the composer", async () => {
    const { emit } = await openLive(observed("idle", "alive", "rpc"));
    sendIdle("add an HNSW index");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(8));
    const sent = mocks.chatRpcWrite.mock.calls[7]?.[2] as { id: string; type: string };
    expect(sent.type).toBe("prompt");
    await screen.findByText("add an HNSW index");
    emit({ type: "response", id: sent.id, command: "prompt", success: false, error: "model busy" });
    await waitFor(() => expect((screen.getByLabelText("Message or /command") as HTMLTextAreaElement).value).toBe("add an HNSW index"));
    expect(screen.getByText(/Not sent: model busy/)).toBeTruthy();
    expect(screen.queryAllByText("add an HNSW index").filter((element) => element.tagName !== "TEXTAREA")).toHaveLength(0);
  });

  it("goes offline and reloads the list once OMP has exited", async () => {
    await openLive(observed("idle", "alive", "rpc"));
    const reloads = mocks.listChatThreads.mock.calls.length;
    mocks.chatSessionStatus.mockResolvedValue(observed("idle", "exited", "rpc"));
    await waitFor(() => expect(link()).toBe("offline"), { timeout: 3000 });
    expect(mocks.listChatThreads.mock.calls.length).toBe(reloads + 1);
  });

  it("opens the providers dialog on the tab a slash command names, with its model preselected", async () => {
    await openLive(observed("idle"));
    sendIdle("/login");
    expect((await screen.findByTestId("providers")).dataset.tab).toBe("accounts");
    expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(7);
    cleanup();
    await openLive(observed("idle"));
    sendIdle("/model alinery/fast");
    const dialog = await screen.findByTestId("providers");
    expect(dialog.dataset.tab).toBe("models");
    expect(dialog.dataset.preselect).toBe("alinery/fast");
  });

  it("compacts with typed RPC instead of prompting /compact", async () => {
    await openLive(observed("idle"));
    sendIdle("/compact keep the API");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "compact", customInstructions: "keep the API" })));
    expect(mocks.chatRpcWrite).not.toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt" }));
  });

  it("opens the tools dialog from a fresh get_state", async () => {
    await openLive(observed("idle"));
    sendIdle("/tools");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(8));
    expect(mocks.chatRpcWrite).toHaveBeenLastCalledWith("/repo", "s-live", expect.objectContaining({ type: "get_state" }));
    expect(await screen.findByRole("dialog", { name: "Tools this turn" })).toBeTruthy();
  });

  it("opens the MCP dialog from /mcp list output", async () => {
    const { emit } = await openLive(observed("idle"));
    sendIdle("/mcp");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "/mcp list" })));
    emit({ type: "command_output", text: "gh | http | enabled | project" });
    const dialog = await screen.findByRole("dialog", { name: "MCP servers" });
    expect(within(dialog).getByText(/gh/)).toBeTruthy();
  });

  it("prompts again on an idle thread once the previous turn ends", async () => {
    const { emit } = await openLive(observed("idle"));
    sendIdle("one");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "one" })));
    emit({ type: "turn_start" });
    emit({ type: "turn_end" });
    sendIdle("two");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "two" })));
  });

  it("queues a second send made before OMP reports the first turn", async () => {
    await openLive(observed("idle"));
    sendIdle("one");
    fireEvent.change(await screen.findByLabelText("Send after this turn…"), { target: { value: "two" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "follow_up", message: "two" })));
  });

  it("releases the turn claim when the write fails", async () => {
    await openLive(observed("idle"));
    mocks.chatRpcWrite.mockRejectedValueOnce(new Error("boom"));
    sendIdle("one");
    expect(await screen.findByText("boom")).toBeTruthy();
    expect((screen.getByLabelText("Message or /command") as HTMLTextAreaElement).value).toBe("one");
    expect(screen.queryByText("one", { selector: ".chat-journal *" })).toBeNull();
    sendIdle("two");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "prompt", message: "two" })));
  });

  it("does not show a turn as running once OMP has exited", async () => {
    await openLive(observed("busy", "exited"));
    expect(await titleBar().findByText("Exited")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello" } });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("keeps the draft when Send now fails", async () => {
    await openLive(observed("busy"));
    const field = (await screen.findByLabelText("Send after this turn…")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "now" } });
    mocks.chatRpcWrite.mockRejectedValueOnce(new Error("session-exited"));
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("session-exited")).toBeTruthy();
    expect(field.value).toBe("now");
  });

  it("drops a delivered follow-up's queued row instead of showing it twice", async () => {
    const { emit } = await openLive(observed("busy"));
    const field = await screen.findByLabelText("Send after this turn…");
    fireEvent.change(field, { target: { value: "later" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "follow_up", message: "later" })));
    fireEvent.change(field, { target: { value: "now" } });
    fireEvent.click(await screen.findByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "abort_and_prompt", message: "now" })));
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "now" }] } });
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "later" }] } });
    emit({ type: "turn_end" });
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "get_state" })));
    emit({ type: "response", command: "get_state", success: true, data: { queuedMessageCount: 0 } });
    expect(screen.getAllByText("later")).toHaveLength(1);
    expect(screen.queryByText("queued · after this turn")).toBeNull();
  });

  it("pushes a toggled auto-compaction setting to a live thread", async () => {
    const { rerender } = await openLive(observed("idle"));
    mocks.chatRpcWrite.mockClear();
    rerender(chat({ ...DEFAULT_CHAT_VISIBILITY, autoCompaction: false }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", expect.objectContaining({ type: "set_auto_compaction", enabled: false })));
    expect(mocks.chatRpcWrite).toHaveBeenCalledTimes(1);
  });

  it("does not push the auto-compaction setting to a thread whose OMP has exited", async () => {
    const { rerender } = await openLive(observed("idle", "exited"));
    mocks.chatRpcWrite.mockClear();
    rerender(chat({ ...DEFAULT_CHAT_VISIBILITY, autoCompaction: false }));
    expect(mocks.chatRpcWrite).not.toHaveBeenCalled();
  });

  it("restates an idle live thread to the terminal and back to chat", async () => {
    mocks.chatRestate.mockImplementation(async (_repo: string, _id: string, target: "pty" | "rpc") => {
      mocks.chatSessionStatus.mockResolvedValue(observed("idle", "alive", target));
    });
    await openLive(observed("idle", "alive", "rpc"));
    expect(screen.queryByTestId("terminal")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in Terminal" }));
    await waitFor(() => expect(mocks.chatRestate).toHaveBeenCalledWith("/repo", "s-live", "pty"));
    expect(await screen.findByTestId("terminal")).toBeTruthy();
    expect(screen.queryByLabelText("Message or /command")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await waitFor(() => expect(mocks.chatRestate).toHaveBeenLastCalledWith("/repo", "s-live", "rpc"));
    await waitFor(() => expect(screen.queryByTestId("terminal")).toBeNull());
    expect(screen.getByLabelText("Message or /command")).toBeTruthy();
  });

  it("hides the terminal hatch once OMP has exited", async () => {
    await openLive(observed("idle", "exited"));
    expect(screen.queryByRole("button", { name: "Open in Terminal" })).toBeNull();
  });

  const compact = [{ name: "compact", description: "Compact the context" }];
  it.each([
    ["the get_available_commands reply", { type: "response", command: "get_available_commands", success: true, data: { commands: compact } }],
    ["an available_commands_update", { type: "available_commands_update", commands: compact }],
  ])("lists the command catalog from %s when the draft is a lone slash", async (_label, event) => {
    const { emit } = await openLive(observed("idle"));
    emit(event);
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/" } });
    const menu = await screen.findByRole("listbox", { name: "Available commands" });
    expect(within(menu).getByRole("option", { name: /\/compact/ })).toBeTruthy();
  });

  it("marks rail threads with the shared status treatments for what was observed", async () => {
    const live = (id: string) => thread(id, { session: meta(id, { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([live("s-run"), live("s-idle"), live("s-ask"), thread("s-done")]);
    mocks.sessionListStatuses.mockResolvedValue({
      "/repo::s-run": observed("busy"),
      "/repo::s-idle": observed("idle"),
      "/repo::s-ask": observed("waiting_for_input"),
    });
    render(chat());
    const running = await screen.findByRole("button", { name: "Chat s-run, Running" });
    expect(running.querySelector(".ind-orb")).not.toBeNull();
    expect(within(running).getByText("Running")).toBeTruthy();
    const idle = screen.getByRole("button", { name: "Chat s-idle, Idle" });
    expect(idle.querySelector(".ind-orb")).toBeNull();
    // Blocked on a person is a chip, never the moving orb.
    const asking = screen.getByRole("button", { name: "Chat s-ask, Needs input" });
    expect(asking.querySelector(".statusdot-waiting_for_input")).not.toBeNull();
    expect(asking.querySelector(".ind-orb")).toBeNull();
    // An ended thread keeps a marker.
    expect(within(screen.getByRole("button", { name: "Chat s-done, Exited" })).getByText("Exited")).toBeTruthy();
  });

  it("renders a subagent row when a subagent lifecycle event arrives", async () => {
    const { emit } = await openLive(observed("busy"));
    emit(subagentLifecycle);
    expect(await screen.findByText("Explore running")).toBeTruthy();
  });

  const liveMeta = { started_at: 1, ended_at: null, archived: false };

  it("re-reads the open thread's name 3s after a turn ends and re-lists once it changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads
        .mockResolvedValueOnce([thread("s-live", { session: meta("s-live", liveMeta) })])
        .mockResolvedValue([thread("s-live", { name: "Fix the build", session: meta("s-live", liveMeta) })]);
      mocks.chatSessionStatus.mockResolvedValueOnce(observed("busy")).mockResolvedValue(observed("idle"));
      mocks.chatThreadName.mockResolvedValue("Fix the build");
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      await screen.findByRole("button", { name: "Abort turn" });
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      expect(mocks.chatThreadName).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(mocks.chatThreadName).toHaveBeenCalledWith("/repo", "s-live");
      await waitFor(() => expect(mocks.listChatThreads).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole("heading", { name: "Fix the build" })).toBeTruthy();
      // The name changed, so the polling stops.
      await vi.advanceTimersByTimeAsync(12000);
      expect(mocks.chatThreadName).toHaveBeenCalledTimes(1);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps reading the name every 3s for up to a minute when the title lands late, without re-listing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads.mockResolvedValue([thread("s-live", { session: meta("s-live", liveMeta) })]);
      mocks.chatSessionStatus.mockResolvedValueOnce(observed("busy")).mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      await screen.findByRole("button", { name: "Abort turn" });
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      await vi.advanceTimersByTimeAsync(9000);
      expect(mocks.chatThreadName).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(51000);
      expect(mocks.chatThreadName).toHaveBeenCalledTimes(20);
      await vi.advanceTimersByTimeAsync(30000);
      expect(mocks.chatThreadName).toHaveBeenCalledTimes(20);
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read the name when no turn ran", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads.mockResolvedValue([thread("s-live", { session: meta("s-live", liveMeta) })]);
      mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      await titleBar().findByText("Idle");
      await vi.advanceTimersByTimeAsync(12000);
      expect(mocks.chatThreadName).not.toHaveBeenCalled();
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still re-reads the name after a turn that spanned a reattach", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openLive(observed("busy", "alive", "rpc"));
      await reattach();
      mocks.chatSessionStatus.mockResolvedValue(observed("idle", "alive", "rpc"));
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      await vi.advanceTimersByTimeAsync(3000);
      expect(mocks.chatThreadName).toHaveBeenCalledWith("/repo", "s-live");
    } finally {
      vi.useRealTimers();
    }
  });

  /** The extension UI answers the app wrote, in order. */
  function uiResponses() {
    return mocks.chatRpcWrite.mock.calls.map((call) => call[2] as { type?: string }).filter((payload) => payload.type === "extension_ui_response");
  }

  it("answers an Allow click with confirmed:true and clears the row", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiConfirm);
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-confirm-1", confirmed: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
  });

  it("answers a Deny click with confirmed:false", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiConfirm);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-confirm-1", confirmed: false }));
  });

  it("sends one answer for a double click while the first is in flight", async () => {
    const { emit } = await openLive(observed("idle"));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.chatRpcWrite.mockImplementation((_repo: string, _id: string, payload: { type?: string }) => (payload.type === "extension_ui_response" ? gate : Promise.resolve()));
    emit(uiConfirm);
    const allow = await screen.findByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    fireEvent.click(allow);
    expect(uiResponses()).toHaveLength(1);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
    expect(uiResponses()).toHaveLength(1);
  });

  it("shows a failed answer's error and lets the same request be answered again", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiConfirm);
    mocks.chatRpcWrite.mockRejectedValueOnce(new Error("socket closed"));
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("Error: socket closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(uiResponses()).toHaveLength(2));
    expect(uiResponses()[1]).toEqual({ type: "extension_ui_response", id: "ui-confirm-1", confirmed: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
  });

  it("opens an approved link in the browser before confirming it", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-url", method: "open_url", url: "https://example.com/doc" });
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-url", confirmed: true }));
    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/doc");
  });

  it("renders a select prompt above the composer and answers with the chosen option", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-sel", method: "select", title: "Pick a branch", options: ["main", "dev"] });
    const heading = await screen.findByText("Pick a branch");
    const composer = screen.getByLabelText("Message or /command");
    expect(heading.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dev" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-sel", value: "dev" }));
    await waitFor(() => expect(screen.queryByText("Pick a branch")).toBeNull());
  });

  it("cancels a select prompt", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-sel", method: "select", title: "Pick a branch", options: ["main", "dev"] });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-sel", cancelled: true }));
  });

  it("answers an input prompt with the typed value", async () => {
    const { emit } = await openLive(observed("idle"));
    emit({ type: "extension_ui_request", id: "ui-in", method: "input", title: "Your name" });
    const field = await screen.findByLabelText("Your name");
    fireEvent.change(field, { target: { value: "Ada" } });
    fireEvent.click(within(field.closest("form") as HTMLElement).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-live", { type: "extension_ui_response", id: "ui-in", value: "Ada" }));
  });

  it("cancels each presentation-only request once, without showing any UI", async () => {
    const { emit } = await openLive(observed("idle"));
    emit(uiWidget);
    await waitFor(() => expect(uiResponses()).toHaveLength(1));
    // A later request re-runs the cancel pass over everything still pending; the first must not be answered twice.
    emit({ type: "extension_ui_request", id: "ui-status", method: "setStatus" });
    await waitFor(() => expect(uiResponses()).toHaveLength(2));
    expect(uiResponses()).toEqual([
      { type: "extension_ui_response", id: uiWidget.id, cancelled: true },
      { type: "extension_ui_response", id: "ui-status", cancelled: true },
    ]);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("withholds Send now while an approval is pending, and offers it again once answered", async () => {
    const { emit } = await openLive(observed("busy"));
    fireEvent.change(await screen.findByLabelText("Send after this turn…"), { target: { value: "now" } });
    expect(screen.getByRole("button", { name: "Send now" })).toBeTruthy();
    emit(uiConfirm);
    const allow = await screen.findByRole("button", { name: "Allow" });
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    fireEvent.click(allow);
    expect(await screen.findByRole("button", { name: "Send now" })).toBeTruthy();
  });

  it("pages the journal back from the first page's start and prepends the older rows", async () => {
    mocks.readChatOmp.mockImplementation(async (args: { end?: number }) =>
      args.end == null ? journalPage(500, [["m2", "newer question"]]) : journalPage(0, [["m1", "older question"]]),
    );
    await openLive(observed("idle"));
    await waitFor(() => expect(mocks.readChatOmp).toHaveBeenCalledWith({ repoPath: "/repo", id: "s-live", end: 500 }));
    const older = await screen.findByText("older question");
    expect(older.compareDocumentPosition(screen.getByText("newer question")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText("Start of conversation")).toBeTruthy();
    expect(mocks.readChatOmp.mock.calls.filter(([args]) => args.end != null)).toHaveLength(1);
  });

  it("does not page when the first page already starts the conversation", async () => {
    mocks.readChatOmp.mockResolvedValue(journalPage(0, [["m1", "only question"]]));
    await openLive(observed("idle"));
    expect(await screen.findByText("only question")).toBeTruthy();
    expect(screen.getByText("Start of conversation")).toBeTruthy();
    expect(mocks.readChatOmp.mock.calls.filter(([args]) => args.end != null)).toHaveLength(0);
  });

  it("drops an older page that lands after switching threads", async () => {
    const live = (id: string) => thread(id, { session: meta(id, liveMeta) });
    mocks.listChatThreads.mockResolvedValue([live("s-a"), live("s-b")]);
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    let landStale: (buffer: ArrayBuffer) => void = () => {};
    const stale = new Promise<ArrayBuffer>((resolve) => {
      landStale = resolve;
    });
    mocks.readChatOmp.mockImplementation(async (args: { id: string; end?: number }) => {
      if (args.id === "s-a") return args.end == null ? journalPage(500, [["a2", "a newer"]]) : stale;
      return journalPage(0, [["b1", "b only"]]);
    });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-a") }));
    await waitFor(() => expect(mocks.readChatOmp).toHaveBeenCalledWith({ repoPath: "/repo", id: "s-a", end: 500 }));
    fireEvent.click(screen.getByRole("button", { name: threadRow("s-b") }));
    await screen.findByText("b only");
    await act(async () => {
      landStale(journalPage(0, [["a1", "a stale older"]]));
      await stale;
    });
    expect(screen.queryByText("a stale older")).toBeNull();
    expect(screen.getByText("b only")).toBeTruthy();
  });

  // A reattach re-reads the journal, and by then it may have grown past the rows the reader has loaded.
  // The rebuild reads back to the oldest row it replaces (a window sized to the gap, one byte wider
  // so the row at the boundary is found) and keeps what the reader paged in meanwhile.
  describe("a reattach after the journal moved on", () => {
    let stub: ReturnType<typeof stubScrollSize>;
    beforeEach(() => {
      stub = stubScrollSize();
    });
    afterEach(() => stub.restore());

    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-entry-id^="f:"]')].map((node) => node.dataset.entryId);
    const readerAt = (top: number) => {
      const list = document.querySelector(".chat-list") as HTMLElement;
      list.scrollTop = top;
      fireEvent.scroll(list);
    };
    const pending = () => {
      let land: (buffer: ArrayBuffer) => void = () => {};
      const promise = new Promise<ArrayBuffer>((resolve) => {
        land = resolve;
      });
      return { promise, land: (buffer: ArrayBuffer) => act(async () => land(buffer)) };
    };

    it.each([true, false])("keeps the loaded rows and the reader's place across several windows of growth, auto-scroll %s", async (autoScroll) => {
      let grown = false;
      mocks.readChatOmp.mockImplementation(async (args: { end?: number }) => {
        if (!grown) return journalPage(500, [["m2", "second"]]);
        return args.end == null
          ? journalPage(2000, [["m4", "fourth"]])
          : journalPage(500, [
              ["m2", "second"],
              ["m3", "third"],
            ]);
      });
      const { rerender } = await openLive(observed("idle", "alive", "rpc"));
      rerender(chat({ ...DEFAULT_CHAT_VISIBILITY, autoScroll }));
      await screen.findByText("second");
      const second = document.querySelector('[data-entry-id="f:m2"]');
      readerAt(900);
      stub.writes.length = 0;
      grown = true;
      mocks.readChatOmp.mockClear();

      await reattach();
      await screen.findByText("fourth");
      // The tail, then one window sized to the gap: no other read.
      expect(mocks.readChatOmp.mock.calls).toEqual([[{ repoPath: "/repo", id: "s-live" }], [{ repoPath: "/repo", id: "s-live", end: 2000, want: 1501 }]]);
      expect(rows()).toEqual(["f:m2", "f:m3", "f:m4"]);
      expect(document.querySelector('[data-entry-id="f:m2"]')).toBe(second);
      expect(stub.writes).toEqual([]);
    });

    // Order A: the older page was asked for before the reattach and lands after the rebuild.
    it("takes an older page that lands after the rebuild, each row once and in order", async () => {
      const older = pending();
      let grown = false;
      mocks.readChatOmp.mockImplementation((args: { end?: number; want?: number }) => {
        if (args.end === 1000 && args.want == null) return older.promise;
        if (args.end == null) return Promise.resolve(grown ? journalPage(2000, [["m4", "fourth"]]) : journalPage(1000, [["m3", "third"]]));
        return Promise.resolve(journalPage(1000, [["m3", "third"]]));
      });
      await openLive(observed("idle", "alive", "rpc"));
      await screen.findByText("third");
      readerAt(100);
      await waitFor(() => expect(mocks.readChatOmp).toHaveBeenCalledWith({ repoPath: "/repo", id: "s-live", end: 1000 }));
      grown = true;
      await reattach();
      await screen.findByText("fourth");

      await older.land(
        journalPage(0, [
          ["m1", "first"],
          ["m2", "second"],
        ]),
      );
      expect(rows()).toEqual(["f:m1", "f:m2", "f:m3", "f:m4"]);
      expect(await screen.findByText("Start of conversation")).toBeTruthy();
    });

    // Order B: the older page lands while the rebuild is still reading, so the rebuild never saw it.
    it("keeps an older page that lands while the rebuild is still reading", async () => {
      const gap = pending();
      let grown = false;
      mocks.readChatOmp.mockImplementation((args: { end?: number; want?: number }) => {
        if (args.end === 2000) return gap.promise;
        if (args.end === 1000) {
          return Promise.resolve(
            journalPage(0, [
              ["m1", "first"],
              ["m2", "second"],
            ]),
          );
        }
        return Promise.resolve(grown ? journalPage(2000, [["m4", "fourth"]]) : journalPage(1000, [["m3", "third"]]));
      });
      await openLive(observed("idle", "alive", "rpc"));
      await screen.findByText("third");
      grown = true;
      dropStream();
      await waitFor(() => expect(mocks.readChatOmp).toHaveBeenCalledWith({ repoPath: "/repo", id: "s-live", end: 2000, want: 1001 }));
      readerAt(100);
      await screen.findByText("first");

      await gap.land(journalPage(1000, [["m3", "third"]]));
      await waitFor(() => expect(link()).toBe("ready"));
      await screen.findByText("fourth");
      expect(rows()).toEqual(["f:m1", "f:m2", "f:m3", "f:m4"]);
      expect(screen.getByText("Start of conversation")).toBeTruthy();
    });

    it("keeps the rows it has when the gap cannot be read, and still reattaches", async () => {
      let grown = false;
      mocks.readChatOmp.mockImplementation(async (args: { end?: number }) => {
        if (!grown) return journalPage(500, [["m2", "second"]]);
        if (args.end == null) return journalPage(2000, [["m4", "fourth"]]);
        throw new Error("journal busy");
      });
      await openLive(observed("idle", "alive", "rpc"));
      await screen.findByText("second");
      grown = true;
      await reattach();
      expect(rows()).toEqual(["f:m2"]);
      expect(screen.queryByText("fourth")).toBeNull();
    });
  });

  const live = (id: string, extra: Partial<ChatThread> = {}) => thread(id, { session: meta(id, liveMeta), ...extra });
  const payloads = () => mocks.chatRpcWrite.mock.calls.map(([repo, id, payload]) => ({ ...(payload as { type?: string; message?: string }), repo, thread: id }));

  it("hides one thread's rows and approvals while the next loads, and never routes a send on the old thread's turn", async () => {
    mocks.listChatThreads.mockResolvedValue([live("s-a"), live("s-b")]);
    mocks.chatSessionStatus.mockImplementation(async (_repo: string, id: string) => observed(id === "s-a" ? "busy" : "idle"));
    const lines: Record<string, (line: string) => void> = {};
    mocks.chatRpcAttach.mockImplementation(async (args: { id: string; onLine: (line: string) => void }) => {
      lines[args.id] = args.onLine;
    });
    let landB: (buffer: ArrayBuffer) => void = () => {};
    mocks.readChatOmp.mockImplementation((args: { id: string }) =>
      args.id === "s-b"
        ? new Promise<ArrayBuffer>((resolve) => {
            landB = resolve;
          })
        : Promise.resolve(journalPage(0, [["a1", "a question"]])),
    );
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-a") }));
    await waitFor(() => expect(lines["s-a"]).toBeDefined());
    act(() => lines["s-a"]?.(JSON.stringify(uiConfirm)));
    expect(await screen.findByRole("button", { name: "Allow" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: threadRow("s-b") }));
    // B's history has not landed: nothing of A's is left on screen to act on.
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByText("a question")).toBeNull();
    sendIdle("hello");
    expect(await screen.findByText(/Still connecting/)).toBeTruthy();
    expect(payloads().filter((write) => write.message === "hello")).toHaveLength(0);

    await act(async () => landB(journalPage(0, [["b1", "b question"]])));
    await waitFor(() => expect(link()).toBe("ready"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-b", expect.objectContaining({ type: "prompt", message: "hello" })));
    expect(payloads().filter((write) => write.message === "hello")).toEqual([expect.objectContaining({ thread: "s-b", type: "prompt" })]);
  });

  it("sends a resumed thread's message to the successor once its handshake is done", async () => {
    mocks.listChatThreads.mockResolvedValueOnce([thread("s-old")]).mockResolvedValue([live("s-next")]);
    mocks.resumeChatThread.mockResolvedValue(meta("s-next", liveMeta));
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-old") }));
    await waitFor(() => expect(link()).toBe("offline"));
    sendIdle("hello");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-next", expect.objectContaining({ type: "prompt", message: "hello" })));
    const types = payloads().map((write) => write.type);
    expect(types.indexOf("prompt")).toBeGreaterThan(types.indexOf("get_available_models"));
    expect(await screen.findByText("hello", { selector: ".chat-journal *" })).toBeTruthy();
    // The turn it started is running now, so the composer offers to queue.
    expect((screen.getByLabelText("Send after this turn…") as HTMLTextAreaElement).value).toBe("");
  });

  it("never delivers a resumed thread's message to the thread picked while the successor connects", async () => {
    const other = live("s-other", { repo_path: "/other", session: meta("s-other", liveMeta) });
    mocks.listChatThreads.mockResolvedValueOnce([thread("s-old"), other]).mockResolvedValue([live("s-next"), other]);
    mocks.resumeChatThread.mockResolvedValue(meta("s-next", liveMeta));
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    let attachNext: () => void = () => {};
    mocks.chatRpcAttach.mockImplementation((args: { id: string }) =>
      args.id === "s-next"
        ? new Promise<void>((resolve) => {
            attachNext = resolve;
          })
        : Promise.resolve(),
    );
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-old") }));
    sendIdle("hello");
    await waitFor(() => expect(mocks.chatRpcAttach).toHaveBeenCalledWith(expect.objectContaining({ id: "s-next" })));
    fireEvent.click(screen.getByRole("button", { name: threadRow("s-other") }));
    await act(async () => attachNext());
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/other", "s-other", expect.objectContaining({ type: "get_available_models" })));
    expect(payloads().filter((write) => write.message === "hello")).toHaveLength(0);
    // The text stayed with the thread it was written for, unsent.
    fireEvent.click(screen.getByRole("button", { name: threadRow("s-next") }));
    expect((screen.getByLabelText("Message or /command") as HTMLTextAreaElement).value).toBe("hello");
    expect(payloads().filter((write) => write.message === "hello")).toHaveLength(0);
  });

  it("starts a never-started thread on send and delivers the message after the new handshake", async () => {
    mocks.listChatThreads.mockResolvedValueOnce([thread("s-fresh", { session: meta("s-fresh", { started_at: null, ended_at: null }) })]).mockResolvedValue([live("s-fresh")]);
    mocks.startChatThread.mockResolvedValue({ session: meta("s-fresh", liveMeta), execution: null, start: "started", errors: [] });
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-fresh") }));
    await waitFor(() => expect(link()).toBe("offline"));
    expect(mocks.chatRpcAttach).not.toHaveBeenCalled();
    sendIdle("hello");
    await waitFor(() => expect(mocks.chatRpcWrite).toHaveBeenCalledWith("/repo", "s-fresh", expect.objectContaining({ type: "prompt", message: "hello" })));
    expect(mocks.startChatThread).toHaveBeenCalledWith("/repo", "s-fresh");
    expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(1);
    const types = payloads().map((write) => write.type);
    expect(types.indexOf("prompt")).toBeGreaterThan(types.indexOf("get_available_models"));
  });

  it("reads an ended thread's history without attaching or reporting a lost connection", async () => {
    mocks.listChatThreads.mockResolvedValue([thread("s-done")]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-done") }));
    await waitFor(() => expect(link()).toBe("offline"));
    expect(mocks.chatRpcAttach).not.toHaveBeenCalled();
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
  });

  it("detaches again when an attach lands after the view let go of it", async () => {
    mocks.listChatThreads.mockResolvedValue([live("s-live")]);
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    let land: () => void = () => {};
    mocks.chatRpcAttach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    const { unmount } = render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    await waitFor(() => expect(mocks.chatRpcAttach).toHaveBeenCalledTimes(1));
    const attach = mocks.chatRpcAttach.mock.calls[0]?.[0] as { attachId: number };
    unmount();
    expect(mocks.chatDetach.mock.calls).toEqual([["/repo", "s-live", attach.attachId]]);
    await act(async () => land());
    await waitFor(() => expect(mocks.chatDetach).toHaveBeenCalledTimes(2));
    expect(mocks.chatDetach.mock.calls[1]).toEqual(["/repo", "s-live", attach.attachId]);
    expect(mocks.chatRpcWrite).not.toHaveBeenCalled();
  });

  it("shows a lost connection with its detail, sends nothing, and reconnects on request", async () => {
    mocks.listChatThreads.mockResolvedValue([live("s-live")]);
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    mocks.chatRpcAttach.mockRejectedValueOnce("daemon not responding after 5s").mockResolvedValue(undefined);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    expect(await screen.findByText(/Lost the connection to Ava/)).toBeTruthy();
    expect(screen.getByText("daemon not responding after 5s")).toBeTruthy();
    expect(titleBar().getByText("Disconnected")).toBeTruthy();
    sendIdle("hello");
    expect(await screen.findByText(/nothing was sent/)).toBeTruthy();
    expect(mocks.chatRpcWrite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(link()).toBe("ready"));
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
    expect((screen.getByLabelText("Message or /command") as HTMLTextAreaElement).value).toBe("hello");
  });

  it("says a running thread's archive stops it, and leaves Enter on Cancel", async () => {
    mocks.listChatThreads.mockResolvedValue([live("s-live")]);
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    vi.mocked(confirmDanger).mockResolvedValue(false);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    await titleBar().findByText("Idle");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalledWith("Archive chat", expect.stringContaining("still running, and archiving stops it"), "Stop and archive"));
    expect(mocks.archiveChatThread).not.toHaveBeenCalled();
  });

  it("will not remove a running thread's worktree on its own", async () => {
    const worktree = "/repo/.alinery/chat-worktrees/s-wt";
    mocks.listChatThreads.mockResolvedValue([live("s-wt", { checkout: false, session: meta("s-wt", { ...liveMeta, worktree }) })]);
    mocks.chatSessionStatus.mockResolvedValue(observed("idle"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-wt") }));
    const remove = (await screen.findByRole("button", { name: "Remove worktree" })) as HTMLButtonElement;
    await waitFor(() => expect(remove.disabled).toBe(true));
  });

  it("drops a repo's threads once it is no longer open in the app", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/repo"]).mockResolvedValue([]);
      mocks.listChatThreads.mockResolvedValueOnce([thread("s-live")]).mockResolvedValue([]);
      render(chat());
      expect(await screen.findByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(screen.queryByRole("button", { name: threadRow("s-live") })).toBeNull());
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(2);
      expect(within(rail()).getByText(NONE_OPEN)).toBeTruthy();
      expect(within(rail()).queryByRole("button", { name: "New thread in repo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the repositories are loading until the first read lands, never that there are none", async () => {
    mocks.listChatRepos.mockReturnValue(new Promise(() => {}));
    render(chat());
    expect(within(rail()).getByText("Loading repositories")).toBeTruthy();
    expect(within(rail()).queryByText(NONE_OPEN)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "New thread" });
    expect(within(dialog).getByText("Loading repositories")).toBeTruthy();
    expect(within(dialog).queryByText(NONE_OPEN)).toBeNull();
    expect((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a failed read with its detail, not an empty list", async () => {
    mocks.listChatRepos.mockRejectedValue(new Error("config.json unreadable"));
    render(chat());
    const alert = await within(rail()).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read which repositories are open in this window. Retrying every few seconds.");
    expect(within(alert).getByText("config.json unreadable")).toBeTruthy();
    expect(within(rail()).queryByText(NONE_OPEN)).toBeNull();
    expect(within(rail()).queryByText("Loading repositories")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "New thread" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Couldn't read which repositories are open in this window.");
    expect(within(dialog).queryByText(NONE_OPEN)).toBeNull();
  });

  it("says when no repository is available to Chat in this window", async () => {
    mocks.listChatRepos.mockResolvedValue([]);
    render(chat());
    expect(await within(rail()).findByText(NONE_OPEN)).toBeTruthy();
    expect(within(rail()).queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const dialog = await screen.findByRole("dialog", { name: "New thread" });
    expect(within(dialog).getByText(NONE_OPEN)).toBeTruthy();
  });

  it("clears a failed read once a retry succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockRejectedValueOnce(new Error("config.json unreadable")).mockResolvedValue(["/repo"]);
      render(chat());
      expect(await within(rail()).findByRole("alert")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await within(rail()).findByRole("button", { name: "New thread in repo" })).toBeTruthy();
      expect(within(rail()).queryByRole("alert")).toBeNull();
      expect(within(rail()).queryByText(NONE_OPEN)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the empty notice once a repository becomes available", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce([]).mockResolvedValue(["/repo"]);
      render(chat());
      expect(await within(rail()).findByText(NONE_OPEN)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await within(rail()).findByRole("button", { name: "New thread in repo" })).toBeTruthy();
      expect(within(rail()).queryByText(NONE_OPEN)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last list read when a refresh fails, and says it is stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/repo"]).mockRejectedValue(new Error("config.json unreadable"));
      mocks.listChatThreads.mockResolvedValue([thread("s-live")]);
      render(chat());
      expect(await within(rail()).findByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      const alert = await within(rail()).findByRole("alert");
      expect(alert.textContent).toContain("Couldn't refresh which repositories are open in this window. Showing the last list read. Retrying every few seconds.");
      expect(within(rail()).getByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      expect(within(rail()).getByRole("button", { name: "New thread in repo" })).toBeTruthy();
      expect(mocks.listChatThreads).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "New thread" }));
      const dialog = await screen.findByRole("dialog", { name: "New thread" });
      expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("/repo");
      expect(within(dialog).getByRole("alert").textContent).toContain("Showing the last list read.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never says no repository is available above a closed repo's group still reloading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reloadThreads: (rows: ChatThread[]) => void = () => {};
      const reloading = new Promise<ChatThread[]>((resolve) => {
        reloadThreads = resolve;
      });
      mocks.listChatRepos.mockResolvedValueOnce(["/repo"]).mockResolvedValue([]);
      mocks.listChatThreads.mockResolvedValueOnce([thread("s-live")]).mockReturnValue(reloading);
      render(chat());
      expect(await within(rail()).findByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(mocks.listChatThreads).toHaveBeenCalledTimes(2));
      expect(within(rail()).getByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      expect(within(rail()).queryByText(NONE_OPEN)).toBeNull();
      await act(async () => {
        reloadThreads([]);
        await reloading;
      });
      expect(within(rail()).getByText(NONE_OPEN)).toBeTruthy();
      expect(within(rail()).queryByRole("button", { name: threadRow("s-live") })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells same-named repositories apart in the new-thread dialog and shows the full path", async () => {
    mocks.listChatRepos.mockResolvedValue(["/a/work/alinery", "/a/oss/alinery"]);
    render(<ChatView terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} />);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["work/alinery", "oss/alinery"]));
    expect(screen.getByText("/a/work/alinery")).toBeTruthy();
  });

  it("keeps a picked repo through its close, says it is not open, and creates there once it reopens", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/a", "/b"]).mockResolvedValueOnce(["/a"]).mockResolvedValue(["/a", "/b"]);
      mocks.createChatThread.mockResolvedValue({ session: meta("s-new"), execution: null, start: "started", errors: [] });
      render(chat());
      expect(await within(rail()).findByRole("button", { name: "New thread in b" })).toBeTruthy();
      fireEvent.click(within(rail()).getByRole("button", { name: "New thread" }));
      const dialog = await screen.findByRole("dialog", { name: "New thread" });
      const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "/b" } });
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "New worktree and branch" }));
      const create = within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement;

      await vi.advanceTimersByTimeAsync(3000);
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe("b is not open in this window. Open it again, or choose another repository.");
      expect(select.value).toBe("/b");
      const closed = within(dialog).getByRole("option", { name: "b (not open)" }) as HTMLOptionElement;
      expect(closed.disabled).toBe(true);
      expect(within(dialog).getByText("/b")).toBeTruthy();
      expect(create.disabled).toBe(true);
      fireEvent.click(create);
      expect((within(dialog).getByRole("checkbox", { name: "New worktree and branch" }) as HTMLInputElement).checked).toBe(true);

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
      expect(select.value).toBe("/b");
      expect(create.disabled).toBe(false);
      fireEvent.click(create);
      await waitFor(() => expect(mocks.createChatThread).toHaveBeenCalledWith({ repoPath: "/b", createWorktree: true }));
      expect(mocks.createChatThread).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a repo's + pick until another repo is chosen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/a", "/b"]).mockResolvedValueOnce(["/a"]).mockResolvedValue(["/a", "/b"]);
      render(chat());
      fireEvent.click(await within(rail()).findByRole("button", { name: "New thread in b" }));
      const dialog = await screen.findByRole("dialog", { name: "New thread" });
      const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("/b");

      await vi.advanceTimersByTimeAsync(3000);
      expect(await within(dialog).findByRole("alert")).toBeTruthy();
      expect(select.value).toBe("/b");

      fireEvent.change(select, { target: { value: "/a" } });
      expect(select.value).toBe("/a");
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(within(dialog).queryByRole("option", { name: "b (not open)" })).toBeNull();
      expect((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      expect(await within(rail()).findByRole("button", { name: "New thread in b" })).toBeTruthy();
      expect(select.value).toBe("/a");
    } finally {
      vi.useRealTimers();
    }
  });

  it("points an unpicked form from the blank state at whichever repo is first open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/a", "/b"]).mockResolvedValue(["/b"]);
      mocks.createChatThread.mockResolvedValue({ session: meta("s-new"), execution: null, start: "started", errors: [] });
      render(chat());
      // The rail first, so the open repos are known when the form opens: it must still not pin /a.
      expect(await within(rail()).findByRole("button", { name: "New thread in a" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
      const dialog = await screen.findByRole("dialog", { name: "New thread" });
      const select = within(dialog).getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("/a");

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(select.value).toBe("/b"));
      expect(within(dialog).queryByRole("alert")).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(mocks.createChatThread).toHaveBeenCalledWith({ repoPath: "/b", createWorktree: false }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a remembered pick that closed while the form was shut", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/a", "/b"]).mockResolvedValue(["/a"]);
      render(chat());
      fireEvent.click(await within(rail()).findByRole("button", { name: "New thread in b" }));
      fireEvent.click(within(await screen.findByRole("dialog", { name: "New thread" })).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog", { name: "New thread" })).toBeNull();

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(within(rail()).queryByRole("button", { name: "New thread in b" })).toBeNull());
      fireEvent.click(within(rail()).getByRole("button", { name: "New thread" }));
      const dialog = await screen.findByRole("dialog", { name: "New thread" });
      expect(within(dialog).getByRole("alert").textContent).toBe("b is not open in this window. Open it again, or choose another repository.");
      expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("/b");
      expect((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("repoLabel", () => {
  it("keeps a unique basename and widens duplicates only until they differ", () => {
    expect(repoLabel("/a/work/alinery", ["/a/work/alinery", "/b/notes"])).toBe("alinery");
    expect(repoLabel("/a/work/alinery", ["/a/work/alinery", "/a/oss/alinery"])).toBe("work/alinery");
    expect(repoLabel("/x/work/alinery", ["/x/work/alinery", "/y/work/alinery"])).toBe("x/work/alinery");
  });
});
