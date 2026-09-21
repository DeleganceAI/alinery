import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { ConceptNameDialog } from "./ConceptNameDialog";

// `shared` pulls in WindowChrome, which touches the Tauri window at module scope.
vi.mock("../ipc", () => mockIpc());

afterEach(cleanup);

// The contract worth pinning is the one the ticket's complaint came from: this dialog must not
// be able to produce a nameless concept. Everything else about it is markup.
describe("ConceptNameDialog", () => {
  const open = () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConceptNameDialog onConfirm={onConfirm} onCancel={onCancel} />);
    return {
      onConfirm,
      onCancel,
      input: screen.getByLabelText("Concept name"),
      create: screen.getByRole("button", { name: "Create" }) as HTMLButtonElement,
    };
  };

  it("cannot create until there is a name", () => {
    const { create } = open();
    expect(create.disabled).toBe(true);
  });

  it("treats whitespace as no name", () => {
    const { input, create } = open();
    fireEvent.change(input, { target: { value: "   " } });
    expect(create.disabled).toBe(true);
  });

  it("ignores Enter while the box is empty", () => {
    const { input, onConfirm } = open();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms a trimmed name from the button", () => {
    const { input, create, onConfirm } = open();
    fireEvent.change(input, { target: { value: "  Authentication  " } });
    fireEvent.click(create);
    expect(onConfirm).toHaveBeenCalledWith("Authentication");
  });

  it("confirms a trimmed name from Enter", () => {
    const { input, onConfirm } = open();
    fireEvent.change(input, { target: { value: " Billing " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("Billing");
  });

  it("cancels without a name", () => {
    const { onCancel, onConfirm } = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
