import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";

afterEach(cleanup);

describe("ChatExtensionPrompt", () => {
  it("submits a select option", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <ChatExtensionPrompt
        request={{ id: "s1", method: "select", title: "Pick", instructions: "Consider:\n\n- **Scope**\n- Risk", options: ["alpha", "beta"] }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Scope", "Risk"]);
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    expect(onSubmit).toHaveBeenCalledWith("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows formatted instructions alongside the title without changing the submitted input", () => {
    const onSubmit = vi.fn();
    render(
      <ChatExtensionPrompt
        request={{ id: "i1", method: "input", title: "Token", instructions: "Use `read-only` access.\nDo not share it.", placeholder: "paste" }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("read-only").tagName).toBe("CODE");
    expect(screen.getByText(/Do not share it/).querySelector("br")).not.toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Token" }), { target: { value: " raw value " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSubmit).toHaveBeenCalledWith(" raw value ");
  });
});
