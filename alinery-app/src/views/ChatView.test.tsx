// Chat on this branch talks to Vinculum (transcript, prompt, abort) and does not attach or open a terminal.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE } from "../appearance";
import { type ChatPrefs, DEFAULT_CHAT_VISIBILITY } from "../chat/visibility";
import type { VinculumTranscript } from "../chatTranscript";
import { askConfirm, confirmDanger } from "../confirm";
import { daemonTransport } from "../daemon/transport";
import { fakeChat } from "../test/chatHooks";
import { mockIpc } from "../test/mockIpc";
import { sessionDaemon } from "../test/sessionDaemon";
import type { ChatThread, SessionMeta, SessionObservation } from "../types";
import { ChatView, repoLabel } from "./ChatView";
import { ChatSessionProvider, useChatThread } from "./chatThreadSession";

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
  listChatRepos: vi.fn(),
  archiveChatThread: vi.fn(),
  setChatPinned: vi.fn(),
  resumeChatThread: vi.fn(),
  renameSession: vi.fn(),
  createChatThread: vi.fn(),
  chatSetModel: vi.fn(async () => ({ model: "anthropic/claude", thinking: "off", thinking_levels: [] as string[] })),
  chatSetThinkingLevel: vi.fn(async () => ({ model: "xai/grok-4.6", thinking: "low", thinking_levels: ["off", "low", "high"] })),
  chatPrompt: vi.fn(async (..._args: unknown[]): Promise<{ submissionId: string; status: string } | undefined> => undefined),
  chatCompact: vi.fn(async (..._args: unknown[]) => undefined),
  chatAbort: vi.fn(async () => undefined),
  removeQueuedMessage: vi.fn(async () => "REMOVED" as const),
  notifySessionAttention: vi.fn(async () => {}),
  openUrl: vi.fn(),
  startChatThread: vi.fn(),
  pickAttachmentFilesDialog: vi.fn(),
  chatFileStat: vi.fn(),
  copyChatThreadAttachments: vi.fn(),
  writeChatThreadAttachmentBytes: vi.fn(),
  readChatThreadImage: vi.fn(),
  getCurrentWebview: vi.fn(() => ({ onDragDropEvent: async () => () => {} })),
  enableCanvas: vi.fn(async () => undefined),
  closeCanvasPanel: vi.fn(async () => undefined),
  useCanvas: vi.fn((): unknown => undefined),
  readCanvasPanel: vi.fn(async (_repo: string, _id: string, panel: string) => (panel === "p1" ? "# Plan heading" : "<p>page</p>")),
}));

vi.mock("../sync/chat", async (actual) => ({
  ...(await import("../test/chatHooks")).chatHooks(await actual()),
  archiveChatThread: mocks.archiveChatThread,
  setChatPinned: mocks.setChatPinned,
  resumeChatThread: mocks.resumeChatThread,
  createChatThread: mocks.createChatThread,
  startChatThread: mocks.startChatThread,
  copyChatThreadAttachments: mocks.copyChatThreadAttachments,
  writeChatThreadAttachmentBytes: mocks.writeChatThreadAttachmentBytes,
  readChatThreadImage: mocks.readChatThreadImage,
  setChatModel: mocks.chatSetModel,
  setChatThinkingLevel: mocks.chatSetThinkingLevel,
  promptChatThread: mocks.chatPrompt,
  compactChatThread: mocks.chatCompact,
  abortChatThread: mocks.chatAbort,
  enableCanvas: mocks.enableCanvas,
  closeCanvasPanel: mocks.closeCanvasPanel,
  useCanvas: mocks.useCanvas,
  readCanvasPanel: mocks.readCanvasPanel,
}));
vi.mock("../sync/sessions", async (actual) => ({
  ...(await actual<typeof import("../sync/sessions")>()),
  renameSession: mocks.renameSession,
  removeQueuedMessage: mocks.removeQueuedMessage,
}));
vi.mock("../ipc", () =>
  mockIpc({
    listChatRepos: mocks.listChatRepos,
    notifySessionAttention: mocks.notifySessionAttention,
    openUrl: mocks.openUrl,
    pickAttachmentFilesDialog: mocks.pickAttachmentFilesDialog,
    chatFileStat: mocks.chatFileStat,
    readModelFavorites: async () => ["anthropic/claude", "xai/grok-4.6"],
    getCurrentWebview: mocks.getCurrentWebview as never,
  }),
);
function chat(visibility: ChatPrefs = DEFAULT_CHAT_VISIBILITY, onFocusedCwdChange?: (cwd: string) => void) {
  return <ChatView appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} terminalFontSize={13} visibility={visibility} onFocusedCwdChange={onFocusedCwdChange} />;
}

/** Drives the resume stash without ChatView's refresh, so a test can make that refresh throw. The buttons call the handlers even while Send would be disabled. */
function CompactResumeProbe({ thread, onResumeRefresh, onRebind }: { thread: ChatThread; onResumeRefresh: () => Promise<void> | void; onRebind: (key: string) => void }) {
  const chat = useChatThread(thread, {
    active: true,
    autoCompaction: false,
    isFocused: () => true,
    onReload: () => undefined,
    onResumeRefresh,
    onRebind,
  });
  return (
    <div data-testid="resume-link" data-link={chat.connection.state} data-sending={chat.sending ? "yes" : "no"}>
      <textarea aria-label="Message or /command" value={chat.draft} onChange={(event) => chat.setDraft(event.currentTarget.value)} />
      <button type="button" onClick={() => chat.send()}>
        Send
      </button>
      <button type="button" onClick={() => chat.sendNow()}>
        Send now
      </button>
      <button type="button" onClick={() => chat.send("a plain sentence")}>
        Send ordinary
      </button>
      <button type="button" onClick={() => chat.reconnect()}>
        Reconnect
      </button>
      {chat.error ? <div role="alert">{chat.error}</div> : null}
    </div>
  );
}

/** Switches the probe onto the successor the resume rebind names, the way ChatView's selection does. */
function ResumeSwitch({ ended }: { ended: ChatThread }) {
  const [current, setCurrent] = useState(ended);
  return (
    <ChatSessionProvider>
      <CompactResumeProbe
        thread={current}
        onResumeRefresh={() => undefined}
        onRebind={(key) => {
          const id = key.slice(key.lastIndexOf(":") + 1);
          setCurrent(thread(id, { session: meta(id, { started_at: 3, ended_at: null, archived: false }) }));
        }}
      />
    </ChatSessionProvider>
  );
}

/** Same switch, plus a way to stamp ended_at onto the successor the hook already holds. */
function ResumeSwitchStamp({ ended }: { ended: ChatThread }) {
  const [current, setCurrent] = useState(ended);
  return (
    <ChatSessionProvider>
      <CompactResumeProbe
        thread={current}
        onResumeRefresh={() => undefined}
        onRebind={(key) => {
          const id = key.slice(key.lastIndexOf(":") + 1);
          setCurrent(thread(id, { session: meta(id, { started_at: 3, ended_at: null, archived: false }) }));
        }}
      />
      <button
        type="button"
        onClick={() => {
          setCurrent((prev) => {
            if (prev.session.id === ended.session.id) return prev;
            return thread(prev.session.id, { session: meta(prev.session.id, { started_at: prev.session.started_at, ended_at: 9, archived: false }) });
          });
        }}
      >
        Stamp ended
      </button>
    </ChatSessionProvider>
  );
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    worktree: "/repo",
    created: 1,
    archived: false,
    phase: "",
    harness: "vinculum",
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

/** A live Vinculum chat as the daemon reports it; `unknown` is a process that has not printed `ready` yet. */
function observed(agent: "unknown" | "idle" | "busy" | "waiting_for_input", process: "alive" | "exited" = "alive", transport?: "pty" | "rpc") {
  return {
    transport,
    lifecycle: { state: process === "alive" ? "live" : "live_exited" },
    checkpoint: {},
    state: {
      process: { state: process },
      agent: { state: agent },
      playbook: { state: "in_progress" },
      adapter: "vinculum",
      message_adapter: "vinculum_bracketed_paste",
      compactions: [],
      compactionFailure: null,
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
  setTranscripts({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }] });
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.archiveChatThread.mockResolvedValue(undefined);
  mocks.setChatPinned.mockReset().mockResolvedValue(undefined);
  fakeChat.reset();
  mocks.listChatRepos.mockResolvedValue(["/repo"]);
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
/** The open set is read again when the window regains focus (the view has no timer), so a test says when. */
const rereadRepos = () => act(async () => void window.dispatchEvent(new Event("focus")));
const NONE_OPEN = "No repositories are currently available to Chat in this window. Open or check one in the repo switcher.";

describe("ChatView", () => {
  it("asks for a repo and leaves the worktree checkbox off", async () => {
    fakeChat.set([]);
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const box = screen.getByRole("checkbox", { name: "New worktree and branch" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Ava" })).toBeTruthy();
  });

  it("archives a checkout thread without deleting the repo", async () => {
    const row = thread("s-checkout");
    fakeChat.set([row]);
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
    fakeChat.set([row]);
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

  it("opens each picked thread as a tab, marks open threads in the rail, and closing a tab shows its neighbour", async () => {
    fakeChat.set([thread("s-one"), thread("s-two")]);
    render(chat());
    fireEvent.click(await within(rail()).findByRole("button", { name: threadRow("s-one") }));
    fireEvent.click(within(rail()).getByRole("button", { name: threadRow("s-two") }));
    const tabs = within(screen.getByRole("group", { name: "Open files" }));
    expect(tabs.getByRole("button", { name: "Chat s-one" }).getAttribute("aria-pressed")).toBe("false");
    expect(tabs.getByRole("button", { name: "Chat s-two" }).getAttribute("aria-pressed")).toBe("true");
    const one = within(rail()).getByRole("button", { name: threadRow("s-one") });
    expect(one.dataset.open).toBe("true");
    expect(one.getAttribute("aria-current")).toBeNull();
    fireEvent.click(tabs.getByRole("button", { name: "Close Chat s-two" }));
    expect(tabs.queryByRole("button", { name: "Chat s-two" })).toBeNull();
    expect(
      within(rail())
        .getByRole("button", { name: threadRow("s-one") })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(within(rail()).getByRole("button", { name: threadRow("s-two") }).dataset.open).toBeUndefined();
  });

  it("starts the rail collapsed at 900 and still offers a new chat", () => {
    fakeChat.set([]);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    render(chat());
    expect(screen.queryByTestId("chat-rail")).toBeNull();
    expect(screen.getByRole("button", { name: "Start a new chat" })).toBeTruthy();
  });

  it("hides the composer until a thread is picked and starts a new chat in the first repo", async () => {
    fakeChat.set([]);
    mocks.listChatRepos.mockResolvedValue(["/first", "/second"]);
    render(<ChatView appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} />);
    expect(screen.queryByLabelText("Message or /command")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    const dialog = await screen.findByRole("dialog", { name: "New thread" });
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("/first");
  });

  it("lists archived threads and resumes immediately", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    fakeChat.set([row]);
    mocks.resumeChatThread.mockResolvedValue("s-next");
    render(chat());
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", "s-arch"));
  });

  it("pins and unpins a thread from its own row without selecting it", async () => {
    const plain = thread("s-plain");
    const pinned = thread("s-pinned", { session: meta("s-pinned", { pinned: true }) });
    fakeChat.set([plain, pinned]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Pin Chat s-plain" }));
    await waitFor(() => expect(mocks.setChatPinned).toHaveBeenCalledWith("/repo", "s-plain", true));
    fireEvent.click(screen.getByRole("button", { name: "Unpin Chat s-pinned" }));
    await waitFor(() => expect(mocks.setChatPinned).toHaveBeenCalledWith("/repo", "s-pinned", false));
    // Nothing was opened; the row's icon and order follow from the rail stream.
    expect(screen.getByRole("heading", { name: "Ava" })).toBeTruthy();
  });

  it("archives the hovered thread, not the open one", async () => {
    const open = thread("s-open");
    const other = thread("s-other");
    fakeChat.set([open, other]);
    vi.mocked(confirmDanger).mockResolvedValue(true);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-open") }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Chat s-other" }));
    await waitFor(() => expect(mocks.archiveChatThread).toHaveBeenCalledWith("/repo", "s-other", false));
    expect(mocks.archiveChatThread).not.toHaveBeenCalledWith("/repo", "s-open", expect.anything());
  });

  it("offers Resume instead of row actions on an archived thread", async () => {
    const row = thread("s-arch", { session: meta("s-arch", { archived: true }) });
    fakeChat.set([row]);
    render(chat());
    fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Archive Chat s-arch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin Chat s-arch" })).toBeNull();
  });

  it("a queued send adds a panel line and no thread row, and Send now does the same", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    mocks.chatPrompt.mockResolvedValue({ submissionId: "7", status: "queued" });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    fireEvent.change(screen.getByLabelText("Send after this turn…"), { target: { value: "wait for me" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(document.querySelector(".chat-list")?.textContent).not.toContain("wait for me");

    fireEvent.change(screen.getByLabelText("Send after this turn…"), { target: { value: "send this now" } });
    mocks.chatPrompt.mockResolvedValue({ submissionId: "8", status: "queued" });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByText("send this now", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(document.querySelector(".chat-list")?.textContent).not.toContain("send this now");
    expect(document.querySelector(".chat-list")?.textContent).not.toContain("wait for me");
  });

  it("a queued send with a staged file leaves the panel when the frame places its message", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    mocks.pickAttachmentFilesDialog.mockResolvedValueOnce(["/tmp/notes.pdf"]);
    mocks.copyChatThreadAttachments.mockResolvedValueOnce({ copied: ["notes.pdf"], failures: [] });
    mocks.chatPrompt.mockResolvedValueOnce({ submissionId: "7", status: "queued" });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    fireEvent.click(await screen.findByRole("button", { name: "Attach files" }));
    expect(await screen.findByRole("button", { name: "Remove notes.pdf" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Send after this turn…|Message or \/command/), { target: { value: "see" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Send|Queue)$/ }));
    await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalledTimes(1));
    const prepared = vi.mocked(mocks.chatPrompt).mock.calls[0][2] as string;
    // The line carries the prepared message, file trailers and all: the case no test covered.
    expect(prepared).toContain("Attached file:");
    expect(await screen.findByText("Queued · 1")).toBeTruthy();
    expect(document.querySelector(".queued-panel-text")?.textContent).toContain("Attached file:");
    // The frame that places the message carries the same words: the line is gone in that fold, and the count with it.
    await act(async () => {
      setTranscripts({
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] },
          { id: "u2", role: "user", content: [{ type: "text", text: prepared }] },
        ],
        queued: [],
      });
    });
    expect(screen.queryByText(/^Queued · /)).toBeNull();
    expect(document.querySelector(".queued-panel")).toBeNull();
    expect(document.querySelector(".chat-list")?.textContent).toContain("see");
  });

  it("Remove calls removeQueuedMessage and a rejection restores the line", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    mocks.chatPrompt.mockResolvedValueOnce({ submissionId: "7", status: "queued" });
    let rejectRemove: (error: Error) => void = () => {};
    mocks.removeQueuedMessage.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectRemove = reject;
      }),
    );
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    fireEvent.change(screen.getByLabelText("Send after this turn…"), { target: { value: "wait for me" } });
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove wait for me" }));
    await waitFor(() => expect(mocks.removeQueuedMessage).toHaveBeenCalledWith("/repo", "s-new", "7"));
    await waitFor(() => expect(screen.queryByText("wait for me", { selector: ".queued-panel-text" })).toBeNull());
    await act(async () => {
      rejectRemove(new Error("daemon down"));
    });
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
  });

  it("Interrupt with an empty queue leaves the line a later queued send makes", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    fireEvent.click(screen.getByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(mocks.chatAbort).toHaveBeenCalledWith("/repo", "s-new"));
    mocks.chatPrompt.mockResolvedValueOnce({ submissionId: "7", status: "queued" });
    fireEvent.change(screen.getByLabelText(/Send after this turn…|Message or \/command/), { target: { value: "wait for me" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Send|Queue)$/ }));
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    // The next streamed delta carries no queue, and an absent queue says nothing about what this send queued.
    await act(async () => {
      setTranscripts({ messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "streaming" }] }] });
    });
    expect(screen.getByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
  });

  it("Interrupt whose abort call rejects leaves the lines the server already held", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    mocks.chatAbort.mockRejectedValueOnce(new Error("the daemon would not abort"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    await act(async () => {
      setTranscripts({
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }],
        queued: [{ id: "7", mode: "followUp", text: "wait for me", images: [] }],
      });
    });
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abort turn" }));
    await waitFor(() => expect(mocks.chatAbort).toHaveBeenCalledWith("/repo", "s-new"));
    // The abort withdrew nothing: the panel still shows what the server holds, in the update that reports the error.
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(screen.getByText("Queued · 1")).toBeTruthy();
    // A frame that carries no queue says nothing about the queue and must not empty the panel.
    await act(async () => {
      setTranscripts({
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] },
          { id: "m1", role: "assistant", content: [{ type: "text", text: "streaming" }] },
        ],
      });
    });
    expect(screen.getByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(screen.getByText("Queued · 1")).toBeTruthy();
  });

  it("Send now whose abort call rejects puts the lines it dropped back", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    mocks.chatAbort.mockRejectedValueOnce(new Error("the daemon would not abort"));
    mocks.chatPrompt.mockResolvedValueOnce({ submissionId: "8", status: "queued" });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    await act(async () => {
      setTranscripts({
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }],
        queued: [{ id: "7", mode: "followUp", text: "wait for me", images: [] }],
      });
    });
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Send after this turn…|Message or \/command/), { target: { value: "send this now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalled());
    // The abort withdrew nothing, so the line its clear dropped is back and the new one waits with it.
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(screen.getByText("send this now", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(screen.getByText("Queued · 2")).toBeTruthy();
  });

  it("Send now whose abort call rejects after a frame folded in between puts the lines back", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    let rejectAbort: (error: Error) => void = () => {};
    mocks.chatAbort.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectAbort = reject;
      }),
    );
    mocks.chatPrompt.mockResolvedValueOnce({ submissionId: "8", status: "queued" });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByText("seeded");
    await act(async () => {
      setTranscripts({
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }],
        queued: [{ id: "7", mode: "followUp", text: "wait for me", images: [] }],
      });
    });
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Send after this turn…|Message or \/command/), { target: { value: "send this now" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatAbort).toHaveBeenCalledWith("/repo", "s-new"));
    // A frame folds while the abort call is still in flight — the coalesce window hides the emptied queue. The list it
    // must put back after a rejection is the one from before the cue was raised, not whatever this fold leaves.
    await act(async () => {
      setTranscripts({
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] },
          { id: "m1", role: "assistant", content: [{ type: "text", text: "streaming" }] },
        ],
      });
    });
    await act(async () => {
      rejectAbort(new Error("the daemon would not abort"));
    });
    await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalled());
    // The abort withdrew nothing: the line the server still holds is back, and the new one waits with it.
    expect(await screen.findByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(screen.getByText("send this now", { selector: ".queued-panel-text" })).toBeTruthy();
    // And no later queue-less frame takes the lines again.
    await act(async () => {
      setTranscripts({
        messages: [
          { id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] },
          { id: "m1", role: "assistant", content: [{ type: "text", text: "streaming more" }] },
        ],
      });
    });
    expect(screen.getByText("wait for me", { selector: ".queued-panel-text" })).toBeTruthy();
    expect(screen.getByText("Queued · 2")).toBeTruthy();
  });

  it("shows the transcript and sends through Vinculum without a Vinculum attach", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("idle", "alive", "rpc"));
    setTranscripts({ messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "seeded" }] }] });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    expect(await screen.findByText("seeded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Terminal" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalledWith("/repo", "s-new", "hello", undefined, undefined));
  });

  it("admits /compact through the chat wrapper and does not prompt", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("idle", "alive", "rpc"));
    setTranscripts({ messages: [] });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    mocks.chatCompact.mockImplementation(async () => {
      expect(screen.getByText("/compact keep the names")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatCompact).toHaveBeenCalledWith("/repo", "s-new", "keep the names"));
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", ""));
  });

  it("leaves the draft when a running chat refuses /compact", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("idle", "alive", "rpc"));
    setTranscripts({ messages: [] });
    mocks.chatCompact.mockReset().mockRejectedValueOnce(new Error("compaction refused"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("compaction refused");
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    // The row paints `/{name}` and the args apart. queryByText of the whole command matches the composer field, not the row.
    expect(screen.queryByText("/compact", { selector: ".chat-face-strong" })).toBeNull();
    expect(screen.queryByText("keep the names", { selector: "p.chat-work-meta" })).toBeNull();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();

    cleanup();
    fakeChat.reset();
    mocks.chatCompact.mockReset().mockRejectedValueOnce(new Error("compaction refused"));
    mocks.chatPrompt.mockClear();
    mocks.chatAbort.mockClear();
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    setTranscripts({ messages: [] });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByRole("button", { name: "Abort turn" });
    fireEvent.change(screen.getByLabelText("Send after this turn…"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect((await screen.findByRole("alert")).textContent).toContain("compaction refused");
    expect(screen.getByLabelText("Send after this turn…")).toHaveProperty("value", "/compact keep the names");
    expect(screen.queryByText("/compact", { selector: ".chat-face-strong" })).toBeNull();
    expect(screen.queryByText("keep the names", { selector: "p.chat-work-meta" })).toBeNull();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    expect(mocks.chatAbort).not.toHaveBeenCalled();

    cleanup();
    fakeChat.reset();
    const fresh = thread("s-fresh", { session: meta("s-fresh", { started_at: null, ended_at: null, archived: false }) });
    mocks.chatCompact.mockReset().mockRejectedValueOnce(new Error("compaction refused"));
    mocks.chatPrompt.mockClear();
    mocks.startChatThread.mockReset().mockImplementation(async () => {
      fakeChat.set([thread("s-fresh", { session: meta("s-fresh", { started_at: 4, ended_at: null, archived: false }) })]);
      return { start: "started", session: fresh.session, execution: null };
    });
    fakeChat.set([fresh]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-fresh") }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("compaction refused");
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    expect(screen.queryByText("/compact", { selector: ".chat-face-strong" })).toBeNull();
    expect(screen.queryByText("keep the names", { selector: "p.chat-work-meta" })).toBeNull();
    expect(mocks.chatCompact).toHaveBeenCalled();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
  });

  it("compacts a never-started chat instead of prompting", async () => {
    const row = thread("s-fresh", { session: meta("s-fresh", { started_at: null, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    mocks.startChatThread.mockImplementation(async () => {
      // The chat-scope stream, not onReload, is what sets started_at.
      fakeChat.set([thread("s-fresh", { session: meta("s-fresh", { started_at: 4, ended_at: null, archived: false }) })]);
      return { start: "started", session: row.session, execution: null };
    });
    mocks.chatCompact.mockReset().mockImplementation(async () => {
      expect(screen.getByText("/compact keep the names")).toBeTruthy();
    });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-fresh") }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.startChatThread).toHaveBeenCalledWith("/repo", "s-fresh", "grok"));
    await waitFor(() => expect(mocks.chatCompact).toHaveBeenCalledWith("/repo", "s-fresh", "keep the names"));
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", ""));
    await waitFor(() => expect(screen.getByTestId("chat-view").getAttribute("data-link")).toBe("ready"));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "hello after compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalledWith("/repo", "s-fresh", "hello after compact", undefined, undefined));
    expect(mocks.chatCompact).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")?.textContent ?? "").not.toContain("Still connecting to Ava");
  });

  it("shows the start error when a never-started /compact cannot start", async () => {
    const row = thread("s-fresh", { session: meta("s-fresh", { started_at: null, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    mocks.startChatThread.mockResolvedValue({ start: "failed", session: row.session, execution: null, errors: [{ stage: "start", code: "failed", message: "model unavailable" }] });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-fresh") }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain("model unavailable");
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
  });

  it("compacts a resumed chat only once the successor has a conversation, and does not prompt", async () => {
    for (const extra of [
      { id: "s-ended", archived: false },
      { id: "s-arch", archived: true },
    ]) {
      cleanup();
      fakeChat.reset();
      mocks.chatPrompt.mockClear();
      mocks.chatCompact.mockReset();
      mocks.resumeChatThread.mockReset();
      mocks.startChatThread.mockClear();
      const ended = thread(extra.id, { session: meta(extra.id, { started_at: 1, ended_at: 2, archived: extra.archived }) });
      fakeChat.set([ended]);
      render(chat());
      if (extra.archived) fireEvent.click(screen.getByRole("button", { name: "Show archived" }));
      fireEvent.click(await screen.findByRole("button", { name: threadRow(extra.id) }));
      fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/Compact focus text" } });
      // started_at is set and the process is only starting: in `live`, but harnessSession would still fail.
      let conversationReady = false;
      const starting = observed("unknown", "alive", "rpc");
      mocks.resumeChatThread.mockImplementation(async () => {
        showChat("s-next", { ...starting, state: { ...starting.state, process: { state: "starting" } } });
        // The predecessor stays until the pane's own refresh. Dropping it here unmounts the hook before rebind.
        fakeChat.set([ended, thread("s-next", { session: meta("s-next", { started_at: 3, ended_at: null, archived: false }) })]);
        return "s-next";
      });
      mocks.chatCompact.mockImplementation(async () => {
        expect(conversationReady).toBe(true);
        expect(screen.getByRole("heading", { name: "Chat s-next" })).toBeTruthy();
        expect(screen.getByText("/Compact")).toBeTruthy();
        expect(screen.getByText("focus text")).toBeTruthy();
      });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(screen.getByTestId("chat-view").getAttribute("data-link")).toBe("ready"));
      expect(screen.getByRole("heading", { name: "Chat s-next" })).toBeTruthy();
      expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/Compact focus text");
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      expect(mocks.chatPrompt).not.toHaveBeenCalled();
      expect(mocks.startChatThread).not.toHaveBeenCalled();
      expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", extra.id);
      // The successor is connection-ready but still starting. The resume lock must hold both sends.
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      const sendNow = screen.queryByRole("button", { name: "Send now" });
      expect(sendNow === null || (sendNow as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      if (sendNow) fireEvent.click(sendNow);
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      expect(mocks.chatPrompt).not.toHaveBeenCalled();
      conversationReady = true;
      showChat("s-next", observed("idle", "alive", "rpc"));
      await waitFor(() => expect(mocks.chatCompact).toHaveBeenCalledTimes(1));
      expect(mocks.chatCompact).toHaveBeenCalledWith("/repo", "s-next", "focus text");
      expect(mocks.chatPrompt).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", ""));
    }
  });

  it("does not leave a resumed /compact armed when refresh or rebind throws", async () => {
    for (const which of ["refresh", "rebind"] as const) {
      cleanup();
      mocks.chatCompact.mockClear();
      mocks.chatPrompt.mockClear();
      mocks.resumeChatThread.mockReset().mockResolvedValue("s-next");
      const ended = thread("s-ended", { session: meta("s-ended", { started_at: 1, ended_at: 5 }) });
      const successor = thread("s-next", { session: meta("s-next", { started_at: 3, ended_at: null, archived: false }) });
      showChat("s-next", observed("idle", "alive", "rpc"));
      const refresh = vi.fn(async () => {
        if (which === "refresh") throw new Error("refresh failed");
      });
      const rebind = vi.fn(() => {
        if (which === "rebind") throw new Error("rebind failed");
      });
      const { rerender } = render(
        <ChatSessionProvider>
          <CompactResumeProbe thread={ended} onResumeRefresh={refresh} onRebind={rebind} />
        </ChatSessionProvider>,
      );
      await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("offline"));
      fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect((await screen.findByRole("alert")).textContent).toContain(which === "refresh" ? "refresh failed" : "rebind failed");
      expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
      expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", "s-ended");
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      rerender(
        <ChatSessionProvider>
          <CompactResumeProbe thread={successor} onResumeRefresh={refresh} onRebind={rebind} />
        </ChatSessionProvider>,
      );
      showChat("s-next", observed("idle", "alive", "rpc"));
      await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("ready"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      expect(mocks.chatPrompt).not.toHaveBeenCalled();
    }
  });

  it("calls compact once after alive even if send runs while the successor is only starting", async () => {
    const ended = thread("s-ended", { session: meta("s-ended", { started_at: 1, ended_at: 5 }) });
    const starting = observed("unknown", "alive", "rpc");
    mocks.resumeChatThread.mockImplementation(async () => {
      showChat("s-next", { ...starting, state: { ...starting.state, process: { state: "starting" } } });
      return "s-next";
    });
    render(<ResumeSwitch ended={ended} />);
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("offline"));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("ready"));
    expect(screen.getByTestId("resume-link").getAttribute("data-sending")).toBe("yes");
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    // The composer button is disabled while the lock is held. These call the handlers anyway.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    showChat("s-next", observed("idle", "alive", "rpc"));
    await waitFor(() => expect(mocks.chatCompact).toHaveBeenCalledTimes(1));
    expect(mocks.chatCompact).toHaveBeenCalledWith("/repo", "s-next", "keep the names");
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
  });

  it("releases a resumed /compact when the successor will not become alive", async () => {
    const starting = observed("unknown", "alive", "rpc");
    const flips = [
      {
        // observationOf derives live_exited from process exited, so the stopped effect ends the attach.
        // The ordinary send must still pass the stash gate: the refusal is the connection one, not a silent return.
        name: "exited",
        prompts: false,
        observation: observed("unknown", "exited", "rpc"),
      },
      {
        name: "failed",
        prompts: true,
        observation: {
          ...starting,
          state: { ...starting.state, process: { state: "starting" as const }, playbook: { state: "failed" as const, reason: "open failed" } },
        },
      },
    ];
    for (const flip of flips) {
      cleanup();
      mocks.chatCompact.mockClear();
      mocks.chatPrompt.mockClear();
      mocks.resumeChatThread.mockReset().mockImplementation(async () => {
        showChat("s-next", { ...starting, state: { ...starting.state, process: { state: "starting" } } });
        return "s-next";
      });
      const ended = thread("s-ended", { session: meta("s-ended", { started_at: 1, ended_at: 5 }) });
      render(<ResumeSwitch ended={ended} />);
      await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("offline"));
      fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-sending")).toBe("yes"));
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      showChat("s-next", flip.observation);
      expect((await screen.findByRole("alert")).textContent).toContain("will not start");
      await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-sending")).toBe("no"));
      if (flip.name === "exited") {
        await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("failed"));
      }
      expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      showChat("s-next", observed("idle", "alive", "rpc"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      expect(mocks.chatPrompt).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
      if (flip.name === "exited") expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("failed");
      fireEvent.click(screen.getByRole("button", { name: "Send ordinary" }));
      if (flip.prompts) {
        await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalledWith("/repo", "s-next", "a plain sentence", undefined, undefined));
      } else {
        expect((await screen.findByRole("alert")).textContent).toContain("Not connected to Ava, so nothing was sent. Reconnect, then send again.");
        expect(mocks.chatPrompt).not.toHaveBeenCalled();
        expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("failed");
        fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
        await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("ready"));
        expect(mocks.chatCompact).not.toHaveBeenCalled();
        expect(mocks.chatPrompt).not.toHaveBeenCalled();
      }
      expect(mocks.chatCompact).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    }
  });

  it("keeps Reconnect when a resumed /compact successor is exited and ended_at is set", async () => {
    const starting = observed("unknown", "alive", "rpc");
    const ended = thread("s-ended", { session: meta("s-ended", { started_at: 1, ended_at: 5 }) });
    mocks.chatCompact.mockClear();
    mocks.chatPrompt.mockClear();
    mocks.resumeChatThread.mockReset().mockImplementation(async () => {
      showChat("s-next", { ...starting, state: { ...starting.state, process: { state: "starting" } } });
      return "s-next";
    });
    render(<ResumeSwitchStamp ended={ended} />);
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("offline"));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-sending")).toBe("yes"));
    showChat("s-next", observed("unknown", "exited", "rpc"));
    expect((await screen.findByRole("alert")).textContent).toContain("will not start");
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-sending")).toBe("no"));
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("failed"));
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    // The failed open stamps ended_at while the process is still exited. showChat does not write that field.
    fireEvent.click(screen.getByRole("button", { name: "Stamp ended" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("failed"));
    expect(screen.queryByText(/Still connecting/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    showChat("s-next", observed("idle", "alive", "rpc"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
    expect(screen.getByTestId("resume-link").getAttribute("data-link")).toBe("failed");
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    mocks.resumeChatThread.mockClear();
    mocks.resumeChatThread.mockResolvedValue("s-later");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mocks.resumeChatThread).toHaveBeenCalledWith("/repo", "s-next"));
    expect(screen.queryByText(/Reconnect, then send again/)).toBeNull();
    expect(screen.queryByText(/Still connecting/)).toBeNull();
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
  });

  it("keeps a resumed /compact in the composer when the admit is refused", async () => {
    const ended = thread("s-ended", { session: meta("s-ended", { started_at: 1, ended_at: 5 }) });
    fakeChat.set([ended]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-ended") }));
    fireEvent.change(screen.getByLabelText("Message or /command"), { target: { value: "/compact keep the names" } });
    let conversationReady = false;
    mocks.resumeChatThread.mockImplementation(async () => {
      fakeChat.set([ended, thread("s-next", { session: meta("s-next", { started_at: 3, ended_at: null, archived: false }) })]);
      return "s-next";
    });
    mocks.chatCompact.mockImplementation(async () => {
      expect(conversationReady).toBe(true);
      throw new Error("compaction refused");
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("chat-view").getAttribute("data-link")).toBe("ready"));
    expect(mocks.chatCompact).not.toHaveBeenCalled();
    conversationReady = true;
    showChat("s-next", observed("idle", "alive", "rpc"));
    expect((await screen.findByRole("alert")).textContent).toContain("compaction refused");
    expect(screen.getByLabelText("Message or /command")).toHaveProperty("value", "/compact keep the names");
    expect(mocks.chatPrompt).not.toHaveBeenCalled();
  });

  it("Send now of /compact compacts without aborting or prompting", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("busy", "alive", "rpc"));
    setTranscripts({ messages: [] });
    mocks.chatCompact.mockReset().mockResolvedValue(undefined);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
    await screen.findByRole("button", { name: "Abort turn" });
    for (const body of ["/compact", "/Compact focus text", "/compact soft remote"]) {
      mocks.chatCompact.mockClear();
      mocks.chatPrompt.mockClear();
      mocks.chatAbort.mockClear();
      fireEvent.change(screen.getByLabelText("Send after this turn…"), { target: { value: body } });
      fireEvent.click(screen.getByRole("button", { name: "Send now" }));
      const instructions = body === "/compact" ? undefined : body.slice(body.indexOf(" ") + 1);
      await waitFor(() => expect(mocks.chatCompact).toHaveBeenCalledWith("/repo", "s-new", instructions));
      expect(mocks.chatPrompt).not.toHaveBeenCalled();
      expect(mocks.chatAbort).not.toHaveBeenCalled();
    }
    mocks.chatCompact.mockClear();
    mocks.chatPrompt.mockClear();
    mocks.chatAbort.mockClear();
    fireEvent.change(screen.getByLabelText("Send after this turn…"), { target: { value: "keep going" } });
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(mocks.chatAbort).toHaveBeenCalledWith("/repo", "s-new"));
    expect(mocks.chatPrompt).toHaveBeenCalledWith("/repo", "s-new", "keep going", undefined, undefined);
    expect(mocks.chatCompact).not.toHaveBeenCalled();
  });

  it("sends a pasted image to the model with the prompt, not only as a file the prompt names", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false }) });
    fakeChat.set([row]);
    for (const id of THREADS) showChat(id, observed("idle", "alive", "rpc"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shot");
    try {
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-new") }));
      const input = await screen.findByLabelText("Message or /command");
      const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
      fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], files: [file] } });
      fireEvent.change(input, { target: { value: "what is this" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(mocks.chatPrompt).toHaveBeenCalled());
      // The part is named after the copy the daemon holds, so the transcript can point the pane at the same file.
      expect(mocks.chatPrompt.mock.lastCall?.[3]).toEqual([{ type: "image", data: "aa", mimeType: "image/png", name: "shot.png" }]);
    } finally {
      createObjectURL.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("shows the model and thinking level from the transcript and applies a set from the reply", async () => {
    const row = thread("s-new", { session: meta("s-new", { started_at: 1, ended_at: null, archived: false, model: "stale/model" }) });
    fakeChat.set([row]);
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
    fireEvent.click(await screen.findByRole("button", { name: "Thinking level: high" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "low" }));
    await waitFor(() => expect(mocks.chatSetThinkingLevel).toHaveBeenCalledWith("/repo", "s-new", "low"));
    expect(await screen.findByRole("button", { name: "Thinking level: low" })).toBeTruthy();

    fireEvent.click(modelButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Providers…" }));
    expect((await screen.findByTestId("providers")).dataset.current).toBe("xai/grok-4.6");
    fireEvent.click(screen.getByRole("button", { name: "Apply test model" }));
    await waitFor(() => expect(mocks.chatSetModel).toHaveBeenCalledWith("/repo", "s-new", "anthropic/claude"));
    const changed = await screen.findByRole("button", { name: "anthropic/claude" });
    // The new model names no levels, so the stored one shows but cannot change.
    expect((screen.getByRole("button", { name: "Thinking level: off" }) as HTMLButtonElement).disabled).toBe(true);

    // A starred model is one pick from the list above the composer.
    fireEvent.click(changed);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "xai/grok-4.6" }));
    await waitFor(() => expect(mocks.chatSetModel).toHaveBeenCalledWith("/repo", "s-new", "xai/grok-4.6"));
  });

  it("keeps the model fixed while Ava is not running in the thread", async () => {
    const row = thread("s-ended", { session: meta("s-ended", { started_at: 1, ended_at: 2, archived: false, model: "xai/grok-4.6" }) });
    fakeChat.set([row]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-ended") }));
    // The daemon refuses a model change on a thread with no live session ("unknown-session"); a send resumes it first.
    expect(((await screen.findByRole("button", { name: "xai/grok-4.6" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refreshes the thread status while it stays selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = thread("s-live", { session: meta("s-live", { started_at: 1, ended_at: null, archived: false }) });
      fakeChat.set([row]);
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
    fakeChat.set([live("s-run"), live("s-idle"), live("s-ask"), thread("s-done")]);
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

  it("notifies once when a running thread fails after switching to another chat", async () => {
    fakeChat.set([live("s-live"), live("s-wt")]);
    const busy = observed("busy", "alive", "rpc");
    const failure = { ...busy, state: { ...busy.state, agent: { state: "errored", correlation_id: "failure-a", reason: "Provider unavailable" } } };
    showChat("s-live", busy);
    showChat("s-wt", observed("idle", "alive", "rpc"));
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: "Chat s-live, Running" }));
    await screen.findByRole("button", { name: "Abort turn" });
    fireEvent.click(screen.getByRole("button", { name: "Chat s-wt, Idle" }));
    await screen.findByRole("heading", { name: "Chat s-wt" });
    act(() => showChat("s-live", failure));
    const failed = await screen.findByRole("button", { name: "Chat s-live, Turn failed" });
    await waitFor(() => expect(mocks.notifySessionAttention).toHaveBeenCalledWith("Chat s-live — turn failed"));
    fireEvent.click(failed);
    await screen.findByRole("button", { name: "Retry" });
    act(() => showChat("s-live", failure));
    expect(mocks.notifySessionAttention).toHaveBeenCalledTimes(1);
  });

  it("retains the failed turn's reason across a disconnect and offers Retry again only for the same live thread", async () => {
    const id = "s-live";
    const old = "turn-a";
    const reason = "Provider declined the turn";
    const rpc = observed("idle", "alive", "rpc");
    fakeChat.set([live(id)]);
    showChat(id, { ...rpc, state: { ...rpc.state, agent: { state: "errored", correlation_id: old, reason } } });
    daemon.setTranscript(id, [{ id: old, role: "assistant", content: [], turnError: reason }]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow(id) }));
    await screen.findByRole("button", { name: "Retry" });

    act(() => daemon.drop("/repo"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getByText(reason)).toBeTruthy();
    act(() => daemon.up("/repo"));
    await screen.findByRole("button", { name: "Retry" });
    act(() => showChat(id, observed("idle", "exited", "rpc")));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getByText(reason)).toBeTruthy();
    expect(mocks.startChatThread).not.toHaveBeenCalled();
    expect(mocks.resumeChatThread).not.toHaveBeenCalled();
  });

  it("shows the name the daemon publishes after a turn, and never asks for it on a timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fakeChat.set([thread("s-live", { session: meta("s-live", liveMeta) })]);
      for (const id of THREADS) showChat(id, observed("busy"));
      render(chat());
      fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
      await screen.findByRole("button", { name: "Abort turn" });
      for (const id of THREADS) showChat(id, observed("idle"));
      await vi.advanceTimersByTimeAsync(1500);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Abort turn" })).toBeNull());
      expect(screen.getByRole("heading", { name: "Chat s-live" })).toBeTruthy();
      const reads = mocks.listChatRepos.mock.calls.length;
      // The title lands later: it arrives on the rail stream, with no read in between.
      act(() => fakeChat.set([thread("s-live", { name: "Fix the build", session: meta("s-live", liveMeta) })]));
      expect(await screen.findByRole("heading", { name: "Fix the build" })).toBeTruthy();
      expect(within(rail()).getByRole("button", { name: /^Fix the build/ })).toBeTruthy();
      await vi.advanceTimersByTimeAsync(60000);
      expect(mocks.listChatRepos.mock.calls.length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renames a thread through the daemon and shows the name once the stream carries it", async () => {
    fakeChat.set([live("s-live")]);
    for (const id of THREADS) showChat(id, observed("idle"));
    mocks.renameSession.mockImplementation(async ({ name }: { name: string }) => {
      fakeChat.set([live("s-live", { name })]);
      return { name, source: "user" };
    });
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename thread" }));
    fireEvent.change(screen.getByLabelText("Thread name"), { target: { value: "Release notes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.renameSession).toHaveBeenCalledWith({ repoPath: "/repo", taskSlug: "", sessionId: "s-live", name: "Release notes" }));
    expect(await screen.findByRole("heading", { name: "Release notes" })).toBeTruthy();
  });

  it("reads an ended thread's history without attaching or reporting a lost connection", async () => {
    fakeChat.set([thread("s-done")]);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-done") }));
    await waitFor(() => expect(link()).toBe("offline"));
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
  });

  it("says a running thread's archive stops it, and leaves Enter on Cancel", async () => {
    fakeChat.set([live("s-live")]);
    for (const id of THREADS) showChat(id, observed("idle"));
    vi.mocked(confirmDanger).mockResolvedValue(false);
    render(chat());
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
    await titleBar().findByText("Idle");
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalledWith("Archive chat", expect.stringContaining("still running, and archiving stops it"), "Stop and archive"));
    expect(mocks.archiveChatThread).not.toHaveBeenCalled();
  });

  it("reports the focused thread's directory for the terminal drawer, and clears it with no thread open", async () => {
    const onFocusedCwdChange = vi.fn();
    const worktree = "/repo/.alinery/chat-worktrees/s-wt";
    fakeChat.set([thread("s-wt", { checkout: false, session: meta("s-wt", { worktree }) }), thread("s-checkout")]);
    render(chat(DEFAULT_CHAT_VISIBILITY, onFocusedCwdChange));
    await waitFor(() => expect(onFocusedCwdChange).toHaveBeenLastCalledWith(""));
    fireEvent.click(await within(rail()).findByRole("button", { name: threadRow("s-wt") }));
    await waitFor(() => expect(onFocusedCwdChange).toHaveBeenLastCalledWith(worktree));
    // A thread without a worktree runs in the checkout, and that is the directory to land in.
    fireEvent.click(within(rail()).getByRole("button", { name: threadRow("s-checko") }));
    await waitFor(() => expect(onFocusedCwdChange).toHaveBeenLastCalledWith("/repo"));
  });

  it("will not remove a running thread's worktree on its own", async () => {
    const worktree = "/repo/.alinery/chat-worktrees/s-wt";
    fakeChat.set([live("s-wt", { checkout: false, session: meta("s-wt", { ...liveMeta, worktree }) })]);
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
      fakeChat.set([thread("s-live")]);
      render(chat());
      expect(await screen.findByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      await rereadRepos();
      await waitFor(() => expect(screen.queryByRole("button", { name: threadRow("s-live") })).toBeNull());
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
    expect(alert.textContent).toContain("Couldn't read which repositories are open in this window. Reading again when you return to this window.");
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
      await rereadRepos();
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
      await rereadRepos();
      expect(await within(rail()).findByRole("button", { name: "New thread in repo" })).toBeTruthy();
      expect(within(rail()).queryByText(NONE_OPEN)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the open repos again when the active repo's daemon attaches after the view opened", async () => {
    fakeChat.set([]);
    mocks.listChatRepos.mockResolvedValueOnce([]).mockResolvedValue(["/repo"]);
    const view = (linkKey: string) => (
      <ChatView appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} linkKey={linkKey} />
    );
    const { rerender } = render(view("false"));
    expect(await within(rail()).findByText(NONE_OPEN)).toBeTruthy();
    rerender(view("true"));
    expect(await within(rail()).findByRole("button", { name: "New thread in repo" })).toBeTruthy();
  });

  it("keeps the last list read when a refresh fails, and says it is stale", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.listChatRepos.mockResolvedValueOnce(["/repo"]).mockRejectedValue(new Error("config.json unreadable"));
      fakeChat.set([thread("s-live")]);
      render(chat());
      expect(await within(rail()).findByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      await rereadRepos();
      const alert = await within(rail()).findByRole("alert");
      expect(alert.textContent).toContain("Couldn't refresh which repositories are open in this window. Showing the last list read. Reading again when you return to this window.");
      expect(within(rail()).getByRole("button", { name: threadRow("s-live") })).toBeTruthy();
      expect(within(rail()).getByRole("button", { name: "New thread in repo" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "New thread" }));
      const dialog = await screen.findByRole("dialog", { name: "New thread" });
      expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("/repo");
      expect(within(dialog).getByRole("alert").textContent).toContain("Showing the last list read.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells same-named repositories apart in the new-thread dialog and shows the full path", async () => {
    mocks.listChatRepos.mockResolvedValue(["/a/work/alinery", "/a/oss/alinery"]);
    render(<ChatView appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} />);
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

      await rereadRepos();
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe("b is not open in this window. Open it again, or choose another repository.");
      expect(select.value).toBe("/b");
      const closed = within(dialog).getByRole("option", { name: "b (not open)" }) as HTMLOptionElement;
      expect(closed.disabled).toBe(true);
      expect(within(dialog).getByText("/b")).toBeTruthy();
      expect(create.disabled).toBe(true);
      fireEvent.click(create);
      expect((within(dialog).getByRole("checkbox", { name: "New worktree and branch" }) as HTMLInputElement).checked).toBe(true);

      await rereadRepos();
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

      await rereadRepos();
      expect(await within(dialog).findByRole("alert")).toBeTruthy();
      expect(select.value).toBe("/b");

      fireEvent.change(select, { target: { value: "/a" } });
      expect(select.value).toBe("/a");
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(within(dialog).queryByRole("option", { name: "b (not open)" })).toBeNull();
      expect((within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);

      await rereadRepos();
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

      await rereadRepos();
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

      await rereadRepos();
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

describe("ChatView canvas", () => {
  const CANVAS = {
    threadId: "s-live",
    focus: "",
    enabledAtMs: 1n,
    panels: [
      { id: "p1", kind: "markdown", title: "Plan", rev: 1n, updatedAtMs: 1n },
      { id: "p2", kind: "html", title: "Demo", rev: 1n, updatedAtMs: 1n },
    ],
  };
  const open = async (canvasAllowed: boolean) => {
    fakeChat.set([thread("s-live")]);
    render(<ChatView appearance={DEFAULT_APPEARANCE} onAppearanceChange={() => {}} terminalFontSize={13} visibility={DEFAULT_CHAT_VISIBILITY} canvasAllowed={canvasAllowed} />);
    fireEvent.click(await screen.findByRole("button", { name: threadRow("s-live") }));
  };

  it("shows neither the switch nor a canvas while Settings has it off", async () => {
    mocks.useCanvas.mockReturnValue(CANVAS);
    await open(false);
    expect(screen.queryByRole("button", { name: "Turn on the canvas" })).toBeNull();
    expect(screen.queryByTestId("chat-canvas")).toBeNull();
  });

  it("turns a thread's canvas on only after the user confirms it is for good", async () => {
    mocks.useCanvas.mockReturnValue(undefined);
    vi.mocked(confirmDanger).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await open(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn on the canvas" }));
    await waitFor(() => expect(confirmDanger).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("cannot be turned off"), "Turn on"));
    expect(mocks.enableCanvas).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn on the canvas" }));
    await waitFor(() => expect(mocks.enableCanvas).toHaveBeenCalledWith("/repo", "s-live"));
  });

  it("lays the panels out beside the chat, sandboxes a page, and closes a panel for the user", async () => {
    mocks.useCanvas.mockReturnValue(CANVAS);
    await open(true);
    const canvas = screen.getByTestId("chat-canvas");
    expect(canvas.dataset.count).toBe("2");
    expect(screen.getByTestId("chat-view").dataset.canvas).toBe("on");
    expect(screen.queryByRole("button", { name: "Turn on the canvas" })).toBeNull();
    expect(await within(canvas).findByRole("heading", { name: "Plan heading" })).toBeTruthy();
    const frame = await waitFor(() => canvas.querySelector("iframe") as HTMLIFrameElement);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toMatch(/^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    fireEvent.click(screen.getByRole("button", { name: "Maximise Plan" }));
    expect(canvas.dataset.count).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Close Plan" }));
    await waitFor(() => expect(mocks.closeCanvasPanel).toHaveBeenCalledWith("/repo", "s-live", "p1"));
  });
});
