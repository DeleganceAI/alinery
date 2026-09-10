import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { shellCdCommand, shellSingleQuote, TerminalDrawer } from "./TerminalDrawer";

vi.mock("./ipc");
vi.mock("./SessionTerminal", () => ({ SessionTerminal: () => null }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.homeDir).mockResolvedValue("/Users/test");
  vi.mocked(ipc.sessionStatus).mockResolvedValue({
    lifecycle: { state: "live" },
    state: null,
    checkpoint: {},
  });
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

describe("TerminalDrawer controls", () => {
  it("keeps app controls in chrome and the terminal host on its own surface", async () => {
    const { container } = render(
      createElement(TerminalDrawer, {
        open: true,
        width: 360,
        onWidthChange: vi.fn(),
        session: { id: "drawer-1", cwd: "/repo" },
        terminalFontSize: 13,
        onKilled: vi.fn(),
        onExited: vi.fn(),
        view: { kind: "list" },
        scope: "active",
        activeRepo: "/repo",
      }),
    );

    const cdHere = screen.getByRole("button", { name: /^cd here/ });
    const kill = await screen.findByRole("button", { name: "Kill" });
    expect(cdHere.className).toBe("btn small");
    expect(kill.className).toBe("btn danger small");

    const chrome = container.querySelector(".terminal-drawer-chrome");
    const termhost = container.querySelector(".termhost");
    expect(chrome).not.toBeNull();
    expect(termhost).not.toBeNull();
    expect(chrome?.contains(cdHere)).toBe(true);
    expect(chrome?.contains(kill)).toBe(true);
    expect(chrome?.contains(termhost)).toBe(false);
    expect(chrome?.parentElement).toBe(termhost?.parentElement);
  });
});
