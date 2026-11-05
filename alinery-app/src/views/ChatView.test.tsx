// Chat on this branch talks to Vinculum (transcript, prompt, abort) and does not attach or open a terminal.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatPrefs, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import type { VinculumTranscript } from "../chatTranscript";
import { askConfirm, confirmDanger } from "../confirm";
import { daemonTransport } from "../daemon/transport";
import { mockIpc } from "../test/mockIpc";
import { sessionDaemon } from "../test/sessionDaemon";
import type { ChatThread, SessionMeta, SessionObservation } from "../types";
import { ChatView, repoLabel } from "./ChatView";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
let daemon = sessionDaemon();
/** What the daemon says about a chat thread's session ("" is the task slug of a chat). */
const showChat = (id: string, o: unknown) => daemon.show("/repo", "", id, o as SessionObservation);
vi.mock("../confirm", () => ({
  confirmDanger: vi.fn(async () => true),
  askConfirm: vi.fn(async () => "cancel"),
}));
vi.mock("../SessionTerminal", () => ({ SessionTerminal: () => <div data-testid="terminal" /> }));
vi.mock("./ProviderSetupDialog", () => ({
  ProviderSetupDialog: ({ initialTab, preselect, current, onPick }: { initialTab?: string; preselect?: string; current?: string; onPick?: (model: string) => void }) => (
    <div data-testid="providers" data-tab={initialTab} data-preselect={preselect} data-current={current}>
      <button type="button" onClick={() => onPick?.("anthropic/claude")}>
        Apply test model
      </button>
    </div>
  ),
}));

const mocks = vi.hoisted(() => ({
  listChatThreads: vi.fn(),
  listChatRepos: vi.fn(),
  archiveChatThread: vi.fn(),
  setChatPinned: vi.fn(),
  resumeChatThread: vi.fn(),
  createChatThread: vi.fn(),
  onStreamClosed: vi.fn(),
  chatDetach: vi.fn(),
  chatSetModel: vi.fn(async () => ({ model: "anthropic/claude", thinking: "off", thinking_levels: [] as string[] })),
  chatSetThinkingLevel: vi.fn(async () => ({ model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] })),
  chatPrompt: vi.fn(async () => undefined),
  chatAbort: vi.fn(async () => undefined),
  openUrl: vi.fn(),
  chatThreadName: vi.fn(),
  startChatThread: vi.fn(),
  pickAttachmentFilesDialog: vi.fn(),
  chatFileStat: vi.fn(),
  copyChatThreadAttachments: vi.fn(),
  writeChatThreadAttachmentBytes: vi.fn(),
  readChatThreadImage: vi.fn(),
  getCurrentWebview: vi.fn(() => ({ onDragDropEvent: async () => () => {} })),
}));

vi.mock("../ipc", () =>
  mockIpc({
    listChatThreads: mocks.listChatThreads,
    listChatRepos: mocks.listChatRepos,
    archiveChatThread: mocks.archiveChatThread,
    setChatPinned: mocks.setChatPinned,
    resumeChatThread: mocks.resumeChatThread,
    createChatThread: mocks.createChatThread,
    onStreamClosed: mocks.onStreamClosed,
    chatDetach: mocks.chatDetach,
    chatSetModel: mocks.chatSetModel,
    chatSetThinkingLevel: mocks.chatSetThinkingLevel,
    chatPrompt: mocks.chatPrompt,
    chatAbort: mocks.chatAbort,
    openUrl: mocks.openUrl,
    chatThreadName: mocks.chatThreadName,
    startChatThread: mocks.startChatThread,
    pickAttachmentFilesDialog: mocks.pickAttachmentFilesDialog,
    chatFileStat: mocks.chatFileStat,
    copyChatThreadAttachments: mocks.copyChatThreadAttachments,
    writeChatThreadAttachmentBytes: mocks.writeChatThreadAttachmentBytes,
    readChatThreadImage: mocks.readChatThreadImage,
    getCurrentWebview: mocks.getCurrentWebview as never,
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

const THREADS = ["s-new", "s-live", "s-wt"];
/** What WatchTranscript serves for every thread under test. */
const setTranscripts = (t: VinculumTranscript) => {
  for (const id of THREADS) daemon.setTranscript(id, t);
};

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
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
  mocks.onStreamClosed.mockReset().mockReturnValue(() => {});
  mocks.chatDetach.mockResolvedValue(undefined);
  setTranscripts({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }] });
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.archiveChatThread.mockResolvedValue(undefined);
  mocks.setChatPinned.mockReset().mockResolvedValue(undefined);
  mocks.listChatThreads.mockResolvedValue([]);
  mocks.listChatRepos.mockResolvedValue(["/repo"]);
  mocks.chatThreadName.mockResolvedValue(null);
  mocks.pickAttachmentFilesDialog.mockReset().mockResolvedValue([]);
  mocks.chatFileStat.mockReset().mockImplementation(async (path: string) => ({ name: path.split("/").pop() ?? path, bytes: 4 }));
  mocks.copyChatThreadAttachments.mockReset().mockResolvedValue({ copied: [], failures: [] });
  mocks.writeChatThreadAttachmentBytes.mockReset().mockImplementation(async (_repo: string, _id: string, fileName: string) => fileName);
  mocks.readChatThreadImage.mockReset().mockResolvedValue({ mime_type: "image/png", data: "aa" });
  mocks.getCurrentWebview.mockReset().mockReturnValue({ onDragDropEvent: async () => () => {} });
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

  it("shows the transcript and sends through Vinculum without an OMP attach", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    for (const id of THREADS) showChat(id, observed("idle", "alive", "rpc"));
    setTranscripts({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }] });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    expect(await screen.findByText("seeded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Terminal" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalledWith("/repo", "s-new", "hello"));
  });

  it("shows the model and thinking level from the transcript and applies a set from the reply", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false, model: "stale/model" }) });
    mocks.listChatThreads.mockResolvedValue([row]);
    for (const id of THREADS) showChat(id, observed("idle", "alive", "rpc"));
    const transcript = {
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }],
      model: "xai/grok-4.6",
      thinking: "high",
      thinking_levels: ["off", "low", "high"],
    };
    setTranscripts(transcript);
    mocks.chatSetThinkingLevel.mockImplementation(async () => {
      setTranscripts({ ...transcript, thinking: "low" });
      return { model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] };
    });
    mocks.chatSetModel.mockImplementation(async () => {
      setTranscripts({ ...transcript, model: "anthropic/claude", thinking: "off", thinking_levels: [] });
      return { model: "anthropic/claude", thinking: "off", thinking_levels: [] };
    });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    const modelButton = await screen.findByRole("button", { name: "xai/grok-4.6" });
    const picker = (await screen.findByRole("combobox", { name: "Thinking level" })) as HTMLSelectElement;
    expect(picker.value).toBe("high");
    fireEvent.change(picker, { target: { value: "low" } });
    await waitFor(() => expect(mocks.chatSetThinkingLevel).toHaveBeenCalledWith("/repo", "s-new", "low"));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Thinking level" }) as HTMLSelectElement).value).toBe("low"));

    fireEvent.click(modelButton);
    expect((await screen.findByTestId("providers")).dataset.current).toBe("xai/grok-4.6");
    fireEvent.click(screen.getByRole("button", { name: "Apply test model" }));
    await waitFor(() => expect(mocks.chatSetModel).toHaveBeenCalledWith("/repo", "s-new", "anthropic/claude"));
    expect(await screen.findByRole("button", { name: "anthropic/claude" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Thinking level" })).toBeNull();
  });

  it("refreshes the thread status while it stays selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
      mocks.listChatThreads.mockResolvedValue([row]);
      for (const id of THREADS) showChat(id, observed("busy"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      expect(await screen.findByRole("button", { name: "Abort turn" })).toBeTruthy();
      for (const id of THREADS) showChat(id, observed("idle"));
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      expect(titleBar().getByText("Idle")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks rail threads with the shared status treatments for what was observed", async () => {
    const live = (id: string) => thread(id, { session: meta(id, { started_at: 1, ended_at: null, archived: false }) });
    mocks.listChatThreads.mockResolvedValue([live("s-run"), live("s-idle"), live("s-ask"), thread("s-done")]);
    showChat("s-run", observed("busy"));
    showChat("s-idle", observed("idle"));
    showChat("s-ask", observed("waiting_for_input"));
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

  const liveMeta = { started_at: 1, ended_at: null, archived: false };
  const live = (id: string, extra: Partial<ChatThread> = {}) => thread(id, { session: meta(id, liveMeta), ...extra });

  it("re-reads the open thread's name 3s after a turn ends and re-lists once it changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatThreads
        .mockResolvedValueOnce([thread("s-live", { session: meta("s-live", liveMeta) })])
        .mockResolvedValue([thread("s-live", { name: "Fix the build", session: meta("s-live", liveMeta) })]);
      for (const id of THREADS) showChat(id, observed("busy"));
      mocks.chatThreadName.mockResolvedValue("Fix the build");
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      await screen.findByRole("button", { name: "Abort turn" });
      for (const id of THREADS) showChat(id, observed("idle"));
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
      for (const id of THREADS) showChat(id, observed("busy"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      await screen.findByRole("button", { name: "Abort turn" });
      for (const id of THREADS) showChat(id, observed("idle"));
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
      for (const id of THREADS) showChat(id, observed("idle"));
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

  it("reads an ended thread's history without attaching or reporting a lost connection", async () => {
    mocks.listChatThreads.mockResolvedValue([thread("s-done")]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-done") }));
    await waitFor(() => expect(link()).toBe("offline"));
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
  });

  it("says a running thread's archive stops it, and leaves Enter on Cancel", async () => {
    mocks.listChatThreads.mockResolvedValue([live("s-live")]);
    for (const id of THREADS) showChat(id, observed("idle"));
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
    for (const id of THREADS) showChat(id, observed("idle"));
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
