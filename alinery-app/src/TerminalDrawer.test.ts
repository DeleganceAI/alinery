import type { Transport } from "@connectrpc/connect";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "./daemon/transport";
import * as ipc from "./ipc";
import { writeTerminal } from "./sync/terminal";
import { shellCdCommand, shellSingleQuote, TerminalDrawer } from "./TerminalDrawer";
import { daemonHarness, scriptedSync, untilAborted } from "./test/daemonHarness";
import { sessionDaemon } from "./test/sessionDaemon";
import type { RepoScope, SessionObservation, View } from "./types";

type SessionHostProps = {
  sessionId?: string;
  intent?: string;
  taskSlug?: string;
  harness?: string;
  cwd?: string;
};

// vi.mock is hoisted above imports, so the factory cannot call createElement directly.
// The slot is filled at module scope, after the static react import, and read at render.
const sessionHost = vi.hoisted(() => ({
  render: ((_props: SessionHostProps): ReactElement | null => null) as (props: SessionHostProps) => ReactElement | null,
}));

vi.mock("./ipc");
vi.mock("./sync/terminal", () => ({ writeTerminal: vi.fn() }));
vi.mock("./daemon/transport", () => ({ daemonTransport: vi.fn() }));
vi.mock("./SessionTerminal", () => ({
  SessionTerminal: (props: SessionHostProps) => sessionHost.render(props),
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));

sessionHost.render = (props) =>
  createElement("div", {
    "data-session": props.sessionId,
    "data-intent": props.intent,
    "data-task-slug": props.taskSlug,
    "data-harness": props.harness,
    "data-cwd": props.cwd,
  });

let daemon = sessionDaemon();
const observation = (state: SessionObservation["lifecycle"]["state"]): SessionObservation => ({
  lifecycle: { state } as SessionObservation["lifecycle"],
  state: null,
  checkpoint: {},
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(ipc.homeDir).mockResolvedValue("/Users/test");
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
  for (const id of ["drawer-1", "drawer-2"]) daemon.show("/repo", "", id, observation("live"));
});

afterEach(() => {
  cleanup();
});

// This is a shell-injection boundary: the result is written straight into a live pty. A
// repo path is attacker-adjacent input in the weak sense that it comes from the filesystem
// rather than from this app, and paths with quotes and spaces are ordinary on macOS.
describe("shellSingleQuote", () => {
  it("wraps a plain path", () => {
    expect(shellSingleQuote("/Users/x/alinery")).toBe("'/Users/x/alinery'");
  });

  it("keeps spaces inside the quotes rather than splitting the argument", () => {
    expect(shellSingleQuote("/Users/x/my repo")).toBe("'/Users/x/my repo'");
  });

  // The one case that actually matters. Inside single quotes a shell treats every
  // character literally except `'` itself, so the only escape is to close the quote,
  // emit a backslash-quote, and reopen: ' \' '
  it("escapes an embedded single quote by closing and reopening", () => {
    // The POSIX idiom, character by character: … it  '  \  '  '  s …
    // close the quoted run, emit an escaped quote outside quotes, reopen.
    expect(shellSingleQuote("/Users/x/it's")).toBe("'/Users/x/it'\\''s'");
  });

  it("neutralises characters that would otherwise be shell syntax", () => {
    for (const path of ["/a;rm -rf /", "/a$(whoami)", "/a`id`", "/a&&b", "/a|b", "/a>b"]) {
      const quoted = shellSingleQuote(path);
      expect(quoted.startsWith("'")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
      // No unescaped quote can appear in the middle, which is the only way out.
      expect(quoted.slice(1, -1).includes("'")).toBe(false);
    }
  });

  it("handles an empty path", () => {
    expect(shellSingleQuote("")).toBe("''");
  });
});

describe("shellCdCommand", () => {
  it("emits a newline-terminated cd", () => {
    expect(shellCdCommand("/Users/x/alinery")).toBe("cd '/Users/x/alinery'\n");
  });

  it("returns a bare cd for an empty path, sending the shell home", () => {
    expect(shellCdCommand("")).toBe("cd\n");
    expect(shellCdCommand("   ")).toBe("cd\n");
  });

  // `cd '~'` looks for a directory literally named "~". Tilde expansion happens before
  // quote removal, so the tilde has to stay bare for the shell to expand it.
  it("leaves a bare tilde unquoted so the shell expands it", () => {
    expect(shellCdCommand("~")).toBe("cd ~\n");
  });

  it("still quotes a path that merely starts with a tilde", () => {
    expect(shellCdCommand("~/Repositories/alinery")).toBe("cd '~/Repositories/alinery'\n");
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(shellCdCommand("  ~  ")).toBe("cd ~\n");
  });
});

type DrawerTab = { id: string; ordinal: number; cwd: string };

type DrawerProps = {
  open: boolean;
  width: number;
  onWidthChange: (w: number) => void;
  tabs: DrawerTab[];
  activeId: string | null;
  terminalFontSize: number;
  onSelect: (id: string) => void;
  creating: boolean;
  onClose: (id: string) => void;
  onNew: () => void;
  onKillAll: () => void;
  onTabExited: (id: string) => void;
  view: View;
  scope: RepoScope;
  activeRepo: string | undefined;
};

const tabs: DrawerTab[] = [
  { id: "drawer-1", ordinal: 1, cwd: "/repo" },
  { id: "drawer-2", ordinal: 2, cwd: "/repo" },
];

function renderDrawer(overrides: Partial<DrawerProps> = {}) {
  const props: DrawerProps = {
    open: true,
    width: 360,
    onWidthChange: vi.fn(),
    tabs,
    activeId: "drawer-1",
    terminalFontSize: 13,
    onSelect: vi.fn(),
    creating: false,
    onClose: vi.fn(),
    onNew: vi.fn(),
    onKillAll: vi.fn(),
    onTabExited: vi.fn(),
    view: { kind: "list" },
    scope: "active",
    activeRepo: "/repo",
    ...overrides,
  };
  // Cast: TerminalDrawer still takes the single-session props. The assertions are the
  // approved tab contract; they fail until that component renders this shape.
  const Drawer = TerminalDrawer as unknown as (props: DrawerProps) => ReactElement;
  return { ...render(createElement(Drawer, props)), props };
}

function actionButtons(container: HTMLElement) {
  const actions = container.querySelector(".terminal-drawer-actions");
  expect(actions, "right cluster").toBeInstanceOf(HTMLElement);
  if (!(actions instanceof HTMLElement)) throw new Error("right cluster missing");
  return Array.from(actions.querySelectorAll("button"));
}
describe("TerminalDrawer tab bar", () => {
  it("shows ordinal tabs and the Plus, kill-all, jump cluster in that order", async () => {
    const { container } = renderDrawer();

    expect(screen.getByRole("tablist", { name: "Terminals" })).toBeTruthy();
    const tab1 = screen.getByRole("tab", { name: "Terminal 1" });
    const tab2 = screen.getByRole("tab", { name: "Terminal 2" });
    expect(tab1.getAttribute("aria-selected")).toBe("true");
    expect(tab2.getAttribute("aria-selected")).toBe("false");
    expect(tab1.textContent).toContain("1");
    expect(tab2.textContent).toContain("2");
    expect(tab1.textContent).not.toContain("/repo");
    expect(tab2.textContent).not.toContain("/repo");
    expect(tab1.tagName).not.toBe("BUTTON");

    const close1 = screen.getByRole("button", { name: /^Close terminal 1 — terminate shell and child processes$/ });
    const close2 = screen.getByRole("button", { name: /^Close terminal 2 — terminate shell and child processes$/ });
    expect(tab1.contains(close1)).toBe(true);
    expect(tab2.contains(close2)).toBe(true);
    expect(close1.querySelector("svg")?.classList.contains("lucide-x")).toBe(true);
    expect(close1.querySelector("svg")?.classList.contains("lucide-square-x")).toBe(false);

    const buttons = actionButtons(container);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["New terminal", "Kill all terminals", expect.stringMatching(/^cd here/)]);
    for (const button of buttons) {
      expect(button.classList.contains("iconbtn")).toBe(true);
      expect(button.className).not.toContain("btn small");
      expect(button.className).not.toContain("btn danger small");
    }
    expect(buttons[1].classList.contains("terminal-drawer-killall")).toBe(true);
    expect(buttons[0].querySelector("svg")?.classList.contains("lucide-plus")).toBe(true);
    expect(buttons[1].querySelector("svg")?.classList.contains("lucide-square-x")).toBe(true);
    expect(buttons[2].querySelector("svg")?.classList.contains("lucide-corner-down-right")).toBe(true);

    const chrome = container.querySelector(".terminal-drawer-chrome");
    const termhost = container.querySelector(".termhost");
    const strip = container.querySelector(".terminal-drawer-tabs");
    expect(chrome).not.toBeNull();
    expect(termhost).not.toBeNull();
    expect(chrome?.contains(termhost)).toBe(false);
    expect(chrome?.parentElement).toBe(termhost?.parentElement);
    expect(chrome?.contains(buttons[0])).toBe(true);
    expect(strip?.contains(buttons[0])).toBe(false);
  });

  it("mounts only the active terminal, with spawn intent and that tab's cwd", () => {
    const { container } = renderDrawer();
    const hosts = container.querySelectorAll("[data-session]");
    expect(hosts).toHaveLength(1);
    expect(hosts[0].getAttribute("data-session")).toBe("drawer-1");
    expect(hosts[0].getAttribute("data-intent")).toBe("spawn");
    expect(hosts[0].getAttribute("data-task-slug")).toBe("");
    expect(hosts[0].getAttribute("data-harness")).toBe("no-harness");
    expect(hosts[0].getAttribute("data-cwd")).toBe("/repo");

    const next = renderDrawer({ activeId: "drawer-2" });
    const switched = next.container.querySelectorAll("[data-session]");
    expect(switched).toHaveLength(1);
    expect(switched[0].getAttribute("data-session")).toBe("drawer-2");
    expect(switched[0].getAttribute("data-cwd")).toBe("/repo");
  });

  it("selects a tab without closing it, and closes without selecting", () => {
    const { props } = renderDrawer();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal 2" }));
    expect(props.onSelect).toHaveBeenCalledWith("drawer-2");
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Terminal 2" }), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Terminal 2" }), { key: " " });
    expect(props.onSelect).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole("button", { name: /^Close terminal 2 — terminate shell and child processes$/ }));
    expect(props.onClose).toHaveBeenCalledWith("drawer-2");
    expect(props.onSelect).toHaveBeenCalledTimes(3);
  });

  it("lets the nested X activate natively and keeps its keys from the board shortcuts", () => {
    const { props } = renderDrawer();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    const x = screen.getByRole("button", { name: /^Close terminal 2/ });
    for (const key of ["Enter", " "]) {
      const notCancelled = fireEvent.keyDown(x, { key });
      expect(notCancelled, `${key} on X keeps its default`).toBe(true);
    }
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen);
  });

  it("moves between tabs with the arrow keys, Home and End, wrapping, without leaking the key", () => {
    const { props } = renderDrawer();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    const tab1 = screen.getByRole("tab", { name: "Terminal 1" });
    const tab2 = screen.getByRole("tab", { name: "Terminal 2" });
    tab1.focus();
    fireEvent.keyDown(tab1, { key: "ArrowRight" });
    expect(props.onSelect).toHaveBeenLastCalledWith("drawer-2");
    expect(document.activeElement).toBe(tab2);
    fireEvent.keyDown(tab2, { key: "ArrowRight" });
    expect(props.onSelect).toHaveBeenLastCalledWith("drawer-1");
    fireEvent.keyDown(tab1, { key: "ArrowLeft" });
    expect(props.onSelect).toHaveBeenLastCalledWith("drawer-2");
    fireEvent.keyDown(tab2, { key: "Home" });
    expect(props.onSelect).toHaveBeenLastCalledWith("drawer-1");
    fireEvent.keyDown(tab1, { key: "End" });
    expect(props.onSelect).toHaveBeenLastCalledWith("drawer-2");
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("keydown", seen);
  });

  it("associates the active tab with the panel", () => {
    const { container } = renderDrawer();
    const panel = container.querySelector(".termhost");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(screen.getByRole("tab", { name: "Terminal 1" }).getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(screen.getByRole("tab", { name: "Terminal 1" }).id);
  });

  it("returns focus to the active tab once the closed tab is gone, not before", () => {
    const { props, rerender } = renderDrawer();
    const Drawer = TerminalDrawer as unknown as (p: DrawerProps) => ReactElement;
    const x = screen.getByRole("button", { name: /^Close terminal 2/ });
    x.focus();
    fireEvent.click(x);
    expect(props.onClose).toHaveBeenCalledWith("drawer-2");
    rerender(createElement(Drawer, { ...props, tabs: [tabs[0]] }));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Terminal 1" }));
  });

  it("disables Plus and says a terminal is starting while a create is pending", () => {
    const { props } = renderDrawer({ creating: true });
    const plus = screen.getByRole("button", { name: "Starting terminal" }) as HTMLButtonElement;
    expect(plus.disabled).toBe(true);
    expect(plus.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Starting terminal");
    fireEvent.click(plus);
    expect(props.onNew).not.toHaveBeenCalled();
  });

  it("notifies new and kill-all without swallowing a second Plus click", () => {
    const { props } = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(props.onNew).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Kill all terminals" }));
    expect(props.onKillAll).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("writes the cd command into the active id only", async () => {
    renderDrawer();
    const cdHere = await screen.findByRole("button", { name: "cd here: /repo" });
    expect(cdHere.getAttribute("title")).toBe("cd here: /repo");
    fireEvent.click(cdHere);
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(writeTerminal).toHaveBeenCalledWith("drawer-1", shellCdCommand("/repo"));
    expect(writeTerminal).not.toHaveBeenCalledWith("drawer-2", expect.anything());

    cleanup();
    vi.mocked(writeTerminal).mockClear();
    const other = renderDrawer({ activeId: "drawer-2" });
    fireEvent.click(await screen.findByRole("button", { name: "cd here: /repo" }));
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(writeTerminal).toHaveBeenCalledWith("drawer-2", shellCdCommand("/repo"));
    expect(writeTerminal).not.toHaveBeenCalledWith("drawer-1", shellCdCommand("/repo"));
    expect(other.props.onSelect).not.toHaveBeenCalled();
  });

  it("cds to the task's worktree from the repo stream, and to the repo until the task row arrives", async () => {
    renderDrawer({ view: { kind: "task", slug: "task", from: { kind: "list" } } });
    await screen.findByRole("button", { name: "cd here: /repo" });
    act(() => daemon.showTask("/repo", "task", { worktree: "/repo/.alinery/worktrees/task" }));
    const button = await screen.findByRole("button", { name: "cd here: /repo/.alinery/worktrees/task" });
    fireEvent.click(button);
    expect(writeTerminal).toHaveBeenCalledWith("drawer-1", shellCdCommand("/repo/.alinery/worktrees/task"));
  });

  it("keeps cd-here disabled when there is no active id", async () => {
    renderDrawer({ activeId: null });
    const missing = await screen.findByRole("button", { name: "cd here: /repo" });
    expect(missing.hasAttribute("disabled")).toBe(true);
    fireEvent.click(missing);
    expect(writeTerminal).not.toHaveBeenCalled();
  });

  it("hides chrome without unmounting the active terminal", () => {
    const { container } = renderDrawer({ open: false });
    expect(screen.queryByRole("tablist", { name: "Terminals" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    expect(container.querySelector("[data-session]")?.getAttribute("data-session")).toBe("drawer-1");
    expect(container.querySelector(".terminal-drawer")?.classList.contains("is-hidden")).toBe(true);
  });

  it("does not render a Plus-only bar when there are no tabs", () => {
    const { container } = renderDrawer({ tabs: [], activeId: null });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    expect(container.querySelector("[data-session]")).toBeNull();
  });
});

describe("TerminalDrawer tab exit", () => {
  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it("reports one exited tab, once, and does not kill the drawer", async () => {
    daemon.show("/repo", "", "drawer-2", observation("exited"));
    const { props } = renderDrawer();
    await flush();
    expect(props.onTabExited).toHaveBeenCalledTimes(1);
    expect(props.onTabExited).toHaveBeenCalledWith("drawer-2");
    expect(props.onKillAll).not.toHaveBeenCalled();
    await flush();
    expect(props.onTabExited).toHaveBeenCalledTimes(1);
  });

  it("reports a tab whose session exits while the drawer is open", async () => {
    const { props } = renderDrawer();
    await flush();
    expect(props.onTabExited).not.toHaveBeenCalled();
    daemon.show("/repo", "", "drawer-1", observation("live_exited"));
    await flush();
    expect(props.onTabExited).toHaveBeenCalledTimes(1);
    expect(props.onTabExited).toHaveBeenCalledWith("drawer-1");
  });

  it("reports an exited tab while the drawer is hidden", async () => {
    daemon.show("/repo", "", "drawer-2", observation("exited"));
    const { props } = renderDrawer({ open: false });
    await flush();
    expect(props.onTabExited).toHaveBeenCalledWith("drawer-2");
    expect(props.onKillAll).not.toHaveBeenCalled();
  });

  it("does not treat never_started as an exit, and does report live_exited", async () => {
    for (const id of ["drawer-1", "drawer-2"]) daemon.show("/repo", "", id, observation("never_started"));
    const waiting = renderDrawer();
    await flush();
    expect(waiting.props.onTabExited).not.toHaveBeenCalled();
    cleanup();

    for (const id of ["drawer-1", "drawer-2"]) daemon.show("/repo", "", id, observation("live_exited"));
    const exited = renderDrawer();
    await flush();
    expect(exited.props.onTabExited).toHaveBeenCalledWith("drawer-1");
    expect(exited.props.onTabExited).toHaveBeenCalledWith("drawer-2");
    expect(exited.props.onKillAll).not.toHaveBeenCalled();
  });

  it("drops no tab while the daemon has not answered", async () => {
    const down = scriptedSync(async function* (_req, _call, signal) {
      yield* [];
      await untilAborted(signal);
      throw new Error("daemon offline");
    });
    vi.mocked(daemonTransport).mockImplementation(() => daemonHarness({ sync: down.sync }).transport as Transport);
    const { props } = renderDrawer();
    await flush();
    expect(props.onTabExited).not.toHaveBeenCalled();
    expect(props.onKillAll).not.toHaveBeenCalled();
  });
});
