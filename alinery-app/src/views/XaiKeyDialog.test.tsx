import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";

vi.mock("../ipc", () => mockIpc());

import * as ipc from "../ipc";
import { XaiKeyDialog } from "./XaiKeyDialog";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("XaiKeyDialog", () => {
  const open = () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<XaiKeyDialog onClose={onClose} onSaved={onSaved} />);
    return {
      onClose,
      onSaved,
      input: document.querySelector('input[type="password"]') as HTMLInputElement,
      save: screen.getByRole("button", { name: "Save" }) as HTMLButtonElement,
    };
  };

  it("cannot save until there is a key", () => {
    expect(open().save.disabled).toBe(true);
  });

  it("treats whitespace as no key", () => {
    const { input, save } = open();
    fireEvent.change(input, { target: { value: "   " } });
    expect(save.disabled).toBe(true);
  });

  it("ignores Enter while the box is empty", () => {
    const { input } = open();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ipc.setOrbitronXaiKey).not.toHaveBeenCalled();
  });

  it("saves a trimmed key", async () => {
    vi.mocked(ipc.setOrbitronXaiKey).mockResolvedValueOnce({ present: true });
    const { input, save, onSaved } = open();
    fireEvent.change(input, { target: { value: "  sk-live  " } });
    fireEvent.click(save);
    await waitFor(() => expect(ipc.setOrbitronXaiKey).toHaveBeenCalledWith("sk-live"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("confirms a trimmed key from Enter", async () => {
    vi.mocked(ipc.setOrbitronXaiKey).mockResolvedValueOnce({ present: true });
    const { input } = open();
    fireEvent.change(input, { target: { value: " sk-enter " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipc.setOrbitronXaiKey).toHaveBeenCalledWith("sk-enter"));
  });

  it("cancels without saving", () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ipc.setOrbitronXaiKey).not.toHaveBeenCalled();
  });

  it("uses a password field with autocomplete off", () => {
    const { input } = open();
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
  });

  it("does not put the typed key into error detail", async () => {
    vi.mocked(ipc.setOrbitronXaiKey).mockRejectedValueOnce(new Error("boom"));
    const { input, save } = open();
    fireEvent.change(input, { target: { value: "sk-secret-value" } });
    fireEvent.click(save);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save the xAI key.");
    expect(alert.textContent).not.toContain("sk-secret-value");
  });
});
