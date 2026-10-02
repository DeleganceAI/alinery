import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { shellCdCommand, shellSingleQuote, TerminalDrawer } from "./TerminalDrawer";
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

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(ipc.homeDir).mockResolvedValue("/Users/test");
  vi.mocked(ipc.sessionStatus).mockResolvedValue({
    lifecycle: { state: "live" },
    state: null,
    checkpoint: {},
  });
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

    const close1 = screen.getByRole("button", { name: "Close terminal 1" });
    const close2 = screen.getByRole("button", { name: "Close terminal 2" });
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

    fireEvent.click(screen.getByRole("button", { name: "Close terminal 2" }));
    expect(props.onClose).toHaveBeenCalledWith("drawer-2");
    expect(props.onSelect).toHaveBeenCalledTimes(3);
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
    fireEvent.click(cdHere);
    expect(ipc.writeSession).toHaveBeenCalledTimes(1);
    expect(ipc.writeSession).toHaveBeenCalledWith("drawer-1", shellCdCommand("/repo"));
    expect(ipc.writeSession).not.toHaveBeenCalledWith("drawer-2", expect.anything());

    cleanup();
    vi.mocked(ipc.writeSession).mockClear();
    const other = renderDrawer({ activeId: "drawer-2" });
    fireEvent.click(await screen.findByRole("button", { name: "cd here: /repo" }));
    expect(ipc.writeSession).toHaveBeenCalledTimes(1);
    expect(ipc.writeSession).toHaveBeenCalledWith("drawer-2", shellCdCommand("/repo"));
    expect(ipc.writeSession).not.toHaveBeenCalledWith("drawer-1", shellCdCommand("/repo"));
    expect(other.props.onSelect).not.toHaveBeenCalled();
  });

  it("keeps cd-here disabled until a target exists, and when there is no active id", async () => {
    // ES2020 lib: Promise.withResolvers is not in this tsconfig.
    vi.mocked(ipc.listTasks).mockReturnValue(new Promise(() => {}));
    renderDrawer({ view: { kind: "task", slug: "task", from: { kind: "list" } } });
    const resolving = await screen.findByRole("button", { name: "cd here (resolving path)" });
    expect(resolving.hasAttribute("disabled")).toBe(true);

    renderDrawer({ activeId: null });
    const missing = await screen.findByRole("button", { name: "cd here: /repo" });
    expect(missing.hasAttribute("disabled")).toBe(true);
    fireEvent.click(missing);
    expect(ipc.writeSession).not.toHaveBeenCalled();
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

describe("TerminalDrawer exit poll", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function flushPoll() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("reports one exited tab and does not kill the drawer", async () => {
    vi.mocked(ipc.sessionStatus).mockImplementation(
      async (id: string) =>
        ({
          lifecycle: { state: id === "drawer-2" ? "exited" : "live" },
          state: null,
          checkpoint: {},
        }) as SessionObservation,
    );
    const { props } = renderDrawer();
    await flushPoll();
    expect(props.onTabExited).toHaveBeenCalledTimes(1);
    expect(props.onTabExited).toHaveBeenCalledWith("drawer-2");
    expect(props.onKillAll).not.toHaveBeenCalled();
    expect(ipc.sessionStatus).toHaveBeenCalledWith("drawer-1", "");
    expect(ipc.sessionStatus).toHaveBeenCalledWith("drawer-2", "");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(props.onTabExited).toHaveBeenCalledTimes(1);
  });

  it("reports an exited tab while the drawer is hidden", async () => {
    vi.mocked(ipc.sessionStatus).mockImplementation(
      async (id: string) =>
        ({
          lifecycle: { state: id === "drawer-2" ? "exited" : "live" },
          state: null,
          checkpoint: {},
        }) as SessionObservation,
    );
    const { props } = renderDrawer({ open: false });
    await flushPoll();
    expect(props.onTabExited).toHaveBeenCalledWith("drawer-2");
    expect(props.onKillAll).not.toHaveBeenCalled();
  });

  it("does not treat never_started as an exit, and does report live_exited", async () => {
    vi.mocked(ipc.sessionStatus).mockResolvedValue({
      lifecycle: { state: "never_started" },
      state: null,
      checkpoint: {},
    });
    const waiting = renderDrawer();
    await flushPoll();
    expect(ipc.sessionStatus).toHaveBeenCalledWith("drawer-1", "");
    expect(ipc.sessionStatus).toHaveBeenCalledWith("drawer-2", "");
    expect(waiting.props.onTabExited).not.toHaveBeenCalled();

    vi.mocked(ipc.sessionStatus).mockResolvedValue({
      lifecycle: { state: "live_exited" },
      state: null,
      checkpoint: {},
    });
    const exited = renderDrawer();
    await flushPoll();
    expect(exited.props.onTabExited).toHaveBeenCalledWith("drawer-1");
    expect(exited.props.onTabExited).toHaveBeenCalledWith("drawer-2");
    expect(exited.props.onKillAll).not.toHaveBeenCalled();
  });

  it("ignores a rejected status instead of dropping the tab", async () => {
    vi.mocked(ipc.sessionStatus).mockRejectedValue(new Error("daemon offline"));
    const { props } = renderDrawer();
    await flushPoll();
    expect(ipc.sessionStatus).toHaveBeenCalledWith("drawer-1", "");
    expect(props.onTabExited).not.toHaveBeenCalled();
    expect(props.onKillAll).not.toHaveBeenCalled();
  });
});
