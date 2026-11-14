import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMarkdown, PathLinksContext } from "./CopyMessage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

describe("ChatMarkdown block copying", () => {
  it("copies only the selected code block, preserving whitespace and literal characters", async () => {
    const writeText = clipboard();
    render(<ChatMarkdown text={'Run this:\n\n```sh\nsudo ls\n```\n\n~~~js\n  if (a < b && c) {\n\tprint("<&>");\n  }\n\n~~~\n\n    indented command\n\nDone.'} />);
    const buttons = screen.getAllByRole("button", { name: "Copy code block" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("sudo ls"));
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('  if (a < b && c) {\n\tprint("<&>");\n  }\n'));
    fireEvent.click(buttons[2]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("indented command"));
  });

  it("copies quote text without Markdown markers or nested copy controls", async () => {
    const writeText = clipboard();
    const { container } = render(
      <ChatMarkdown text={'> **Advice** with `code` and [link](https://example.com).  \n> Next line.\n>\n> ```sh\n> echo "<&>"\n> ```\n>\n> > Nested quote'} />,
    );
    const code = screen.getByRole("button", { name: "Copy code block" });
    fireEvent.click(code);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('echo "<&>"'));
    const outer = container.querySelector("blockquote");
    if (!outer) throw new Error("Missing quote");
    const quotes = within(outer).getAllByRole("button", { name: "Copy quote" });
    fireEvent.click(quotes[0]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("Nested quote"));
    fireEvent.click(quotes[1]);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expect.stringMatching(/^Advice with code and link\.\n+Next line\.\n+echo "<&>"\n+Nested quote\n*$/)));
  });

  it("reports clipboard rejection and retries with the updated block content", async () => {
    const writeText = clipboard(vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValue(undefined));
    const { rerender } = render(<ChatMarkdown text={"```\nfirst\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await screen.findByRole("button", { name: "Failed to copy code block" });
    rerender(<ChatMarkdown text={"```\nsecond\n```"} />);
    fireEvent.click(screen.getByRole("button", { name: "Failed to copy code block" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("second"));
    await screen.findByRole("button", { name: "Copied code block" });
  });
});

describe("ChatMarkdown path links", () => {
  const known = new Set(["src/app.ts", "notes.md"]);
  const links = { resolve: (path: string) => (known.has(path) ? `t:${path}` : null), open: vi.fn() };

  it("links inline code and relative links that resolve, and leaves the rest alone", () => {
    render(
      <PathLinksContext.Provider value={links}>
        <ChatMarkdown text={"See `src/app.ts`, `os.path` and [the notes](notes.md) or [docs](https://example.com).\n\n```\nsrc/app.ts\n```"} />
      </PathLinksContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "src/app.ts" }));
    expect(links.open).toHaveBeenLastCalledWith("t:src/app.ts", false);
    fireEvent.click(screen.getByRole("button", { name: "src/app.ts" }), { detail: 2 });
    expect(links.open).toHaveBeenLastCalledWith("t:src/app.ts", true);
    fireEvent.click(screen.getByRole("link", { name: "the notes" }));
    expect(links.open).toHaveBeenLastCalledWith("t:notes.md", false);
    expect(screen.queryByRole("button", { name: "os.path" })).toBeNull();
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("target")).toBe("_blank");
    expect(links.open).toHaveBeenCalledTimes(3);
  });

  it("links nothing without a provider", () => {
    render(<ChatMarkdown text="See `src/app.ts`." />);
    expect(screen.queryByRole("button", { name: "src/app.ts" })).toBeNull();
  });
});
