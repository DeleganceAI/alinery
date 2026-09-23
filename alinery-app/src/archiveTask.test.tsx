import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ArchiveTaskPhase, archiveBoardTask } from "./archiveTask";
import { ArchiveTaskModal } from "./shared";

const commands = vi.hoisted(() => ({ archiveTaskForRepo: vi.fn(), removeWorktreeForRepo: vi.fn() }));
// The hoisted IPC factory runs before static imports; load its test seam inside the factory.
vi.mock("./ipc", async () => {
  const { mockIpc } = await import("./test/mockIpc");
  return mockIpc(commands);
});
vi.mock("./toast", () => ({ toast: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const task = { repo_path: "/repo", slug: "task", name: "Task", has_worktree: true };

function ArchiveSurface() {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  const confirm = async (remove: boolean, onPhase: (phase: ArchiveTaskPhase) => void) => {
    const failure = await archiveBoardTask(task, remove, onPhase);
    if (failure) setError(`${failure.msg} ${failure.detail}`);
    else setOpen(false);
  };
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <ArchiveTaskModal task={open ? task : null} onCancel={() => setOpen(false)} onConfirm={confirm} />
    </>
  );
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe("archive pending feedback", () => {
  it("keeps one confirmation locked across archive then optional worktree removal", async () => {
    const archive = deferred();
    const removal = deferred();
    commands.archiveTaskForRepo.mockReturnValue(archive.promise);
    commands.removeWorktreeForRepo.mockReturnValue(removal.promise);
    render(<ArchiveSurface />);
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("checkbox"));
    const confirm = screen.getByRole("button", { name: "Archive task" });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(commands.archiveTaskForRepo).toHaveBeenCalledTimes(1);
    expect(commands.archiveTaskForRepo).toHaveBeenCalledWith("/repo", "task");
    expect(commands.removeWorktreeForRepo).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Archiving…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Archiving…");
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent(screen.getByRole("alertdialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    fireEvent.click(screen.getByRole("alertdialog"), { clientX: -10, clientY: -10 });
    expect(screen.getByRole("alertdialog")).toBeDefined();

    await act(async () => archive.resolve());
    expect(commands.removeWorktreeForRepo).toHaveBeenCalledTimes(1);
    expect(commands.removeWorktreeForRepo).toHaveBeenCalledWith("/repo", "task");
    expect((screen.getByRole("button", { name: "Removing worktree…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Removing worktree…");
    fireEvent.click(screen.getByRole("button", { name: "Removing worktree…" }));
    fireEvent(screen.getByRole("alertdialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(commands.archiveTaskForRepo).toHaveBeenCalledTimes(1);
    await act(async () => removal.resolve());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("settles without a removal phase when the worktree is kept", async () => {
    const archive = deferred();
    commands.archiveTaskForRepo.mockReturnValue(archive.promise);
    render(<ArchiveSurface />);
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    expect(screen.getByRole("button", { name: "Archiving…" })).toBeDefined();
    await act(async () => archive.resolve());
    expect(commands.removeWorktreeForRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each(["archive", "removal"])("clears pending after a %s error and allows another confirmation", async (phase) => {
    const archive = deferred();
    const removal = deferred();
    commands.archiveTaskForRepo.mockReturnValue(archive.promise);
    commands.removeWorktreeForRepo.mockReturnValue(removal.promise);
    render(<ArchiveSurface />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    if (phase === "removal") {
      await act(async () => archive.resolve());
      await act(async () => removal.reject(new Error("worktree is locked")));
    } else {
      await act(async () => archive.reject(new Error("task is locked")));
      expect(commands.removeWorktreeForRepo).not.toHaveBeenCalled();
    }
    expect(screen.getByRole("alert").textContent).toContain("Couldn't archive the task.");
    expect(screen.getByRole("alert").textContent).toContain(phase === "removal" ? "worktree is locked" : "task is locked");
    expect((screen.getByRole("button", { name: "Archive task" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("");
    const retry = deferred();
    commands.archiveTaskForRepo.mockReturnValue(retry.promise);
    commands.removeWorktreeForRepo.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    expect(commands.archiveTaskForRepo).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Archiving…" })).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("Archiving…");
    await act(async () => retry.resolve());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
