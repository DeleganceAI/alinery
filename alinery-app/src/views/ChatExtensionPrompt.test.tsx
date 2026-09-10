import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";

describe("ChatExtensionPrompt", () => {
  it("submits a select option", () => {
    const onSubmit = vi.fn();
    render(<ChatExtensionPrompt request={{ id: "s1", method: "select", title: "Pick", options: ["alpha", "beta"] }} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    expect(onSubmit).toHaveBeenCalledWith("alpha");
  });

  it("renders an input field for extension input", () => {
    const html = renderToStaticMarkup(
      <ChatExtensionPrompt request={{ id: "i1", method: "input", title: "Token", placeholder: "paste" }} onSubmit={() => undefined} onCancel={() => undefined} />,
    );
    expect(html).toContain("paste");
    expect(html).toContain("Token");
  });
});
