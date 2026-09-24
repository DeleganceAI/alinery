import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NameEditor } from "./NameEditor";

afterEach(cleanup);

describe("work name editor", () => {
  it("retains failed drafts, serializes commits, and returns focus after retry", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    let reject!: (error: Error) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    render(<NameEditor value="Old name" label="Session name" onSave={save} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "  New name  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("New name");
    await act(async () => reject(new Error("Repository is busy")));
    expect(screen.getByRole("alert").textContent).toContain("Repository is busy");
    expect((input as HTMLInputElement).value).toBe("  New name  ");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(save).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("does not steal focus when an old save finishes after navigation", async () => {
    const trigger = document.createElement("button");
    const nextInput = document.createElement("input");
    document.body.append(trigger, nextInput);
    trigger.focus();
    let resolve!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const view = render(<NameEditor value="Old name" label="Session name" onSave={save} onCancel={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Enter" });
    view.unmount();
    nextInput.focus();
    await act(async () => resolve());
    const focused = document.activeElement === nextInput;
    trigger.remove();
    nextInput.remove();
    expect(focused).toBe(true);
  });

  it("isolates editor keys, ignores IME Enter, and cancels without saving", () => {
    const navigate = vi.fn();
    const key = vi.fn();
    const cancel = vi.fn();
    const save = vi.fn();
    render(
      <div onClick={navigate} onKeyDown={key}>
        <NameEditor value="Old" label="Session name" onSave={save} onCancel={cancel} />
      </div>,
    );
    const input = screen.getByRole("textbox");
    fireEvent.click(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(save).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "k", metaKey: true });
    expect(key).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not turn keyboard activation of Cancel into a save", () => {
    const save = vi.fn();
    const cancel = vi.fn();
    render(<NameEditor value="Old name" label="Session name" onSave={save} onCancel={cancel} />);
    const button = screen.getByRole("button", { name: "Cancel" });
    button.focus();
    const nativeActivation = fireEvent.keyDown(button, { key: "Enter" });
    expect(save).not.toHaveBeenCalled();
    expect(nativeActivation).toBe(true);
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("counts scalars rather than UTF-16 and trims Rust whitespace", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<NameEditor value="" label="Session name" onSave={save} onCancel={vi.fn()} />);
    const input = screen.getByRole("textbox");
    for (const value of [" ", "x".repeat(41), "😀".repeat(41), "bad\u2028name", "bad\u0007name", "\ud800", "\ufeff" + "x".repeat(40)]) {
      fireEvent.change(input, { target: { value } });
      await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
      expect(screen.getByRole("alert")).toBeDefined();
      expect(save).not.toHaveBeenCalled();
    }
    for (const value of ["😀".repeat(40), "e\u0301".repeat(20), "x".repeat(30)]) {
      fireEvent.change(input, { target: { value: `\u0085${value}\u0085` } });
      await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
      expect(save).toHaveBeenLastCalledWith(value);
    }
  });

  it("does not apply the session length cap to task names", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<NameEditor value="" label="Task name" kind="task" onSave={save} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `  ${"x".repeat(80)}  ` } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(save).toHaveBeenCalledWith("x".repeat(80));
  });
});
