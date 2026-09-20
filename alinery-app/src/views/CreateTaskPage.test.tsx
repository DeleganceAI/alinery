import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as taskMutationGuard from "../taskMutationGuard";
import { mockIpc } from "../test/mockIpc";
import type { Config, CreateTaskResult, PlaybookStepSummary, PlaybookSummary, SessionMeta, TargetedCreateResult, Task } from "../types";
import { CreateTaskPage } from "./CreateTaskPage";

const playbooks = [
  {
    key: "superdevelop",
    title: "SuperDevelop",
    description: "Superpowers basic playbook",
    kind: "linear",
    default_harness: "claude",
    steps: ["research"],
    auto_advance: [],
  },
  {
    key: "one-shot",
    title: "One-shot",
    description: "Implement in one agent pass.",
    kind: "linear",
    default_harness: "claude",
    steps: ["implementation"],
    auto_advance: [],
  },
] as PlaybookSummary[];

const readConfigForRepo = vi.hoisted(() =>
  vi.fn(
    async () =>
      ({
        defaults: { harness: "claude", model: "", playbook: "superdevelop", draft_autosave: true },
      }) as Config,
  ),
);

vi.mock("../ipc", () =>
  mockIpc({
    readConfigForRepo,
    listPlaybooksForRepo: async () => playbooks,
    connectionStatuses: vi.fn(async () => []),
    listPlaybookStepsForRepo: async (_repoPath, playbook) =>
      [
        {
          key: playbook === "one-shot" ? "implementation" : "research",
          title: playbook === "one-shot" ? "Implementation" : "Research",
          short: playbook === "one-shot" ? "impl" : "research",
        },
      ] as PlaybookStepSummary[],
    listHarnessModelsForRepo: vi.fn(async () => []),
    getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) as unknown as ReturnType<typeof import("../ipc").getCurrentWebview>,
  }),
);

import * as ipc from "../ipc";

// The loading toast is how the form proves work started, and the guard refuses a
// concurrent mutation through this same module, so both are asserted from these spies.
const toastSpies = vi.hoisted(() => {
  return { toast: vi.fn(), loading: vi.fn(), success: vi.fn(), error: vi.fn() };
});
vi.mock("../toast", () => ({
  Toast: () => null,
  toast: Object.assign(toastSpies.toast, {
    loading: toastSpies.loading,
    success: toastSpies.success,
    error: toastSpies.error,
  }),
}));

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  readConfigForRepo.mockResolvedValue({
    defaults: { harness: "claude", model: "", playbook: "superdevelop", draft_autosave: true },
  } as Config);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  taskMutationGuard.release();
});

describe("provider imports", () => {
  it("does not inspect providers while opening the task form", async () => {
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);

    await screen.findByRole("radiogroup", { name: "Choose playbook" });

    expect(ipc.connectionStatuses).not.toHaveBeenCalled();
    await waitFor(() => expect(ipc.listHarnessModelsForRepo).toHaveBeenCalledWith("/repo", "omp"));
    expect(screen.queryByLabelText("Initial harness")).toBeNull();
    expect(screen.queryByLabelText("Harness")).toBeNull();
    expect(screen.getByRole("button", { name: "GitHub" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Linear" })).toBeDefined();
  });
});

describe("GitHub imports", () => {
  it("uses resource-generic copy and preserves fields when an import fails", async () => {
    vi.mocked(ipc.importGithubForRepo).mockRejectedValue(new Error("request failed"));
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Existing name" } });
    fireEvent.change(screen.getByPlaceholderText(/Describe the feature/), { target: { value: "Existing description" } });
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const reference = screen.getByPlaceholderText("GitHub issue or pull request URL, owner/repo#123, or #123…");
    fireEvent.change(reference, { target: { value: "owner/repo#9" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await screen.findByText("Couldn't import the GitHub issue or pull request.");
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Existing name");
    expect(screen.getByPlaceholderText(/Describe the feature/)).toHaveProperty("value", "Existing description");
    expect(screen.queryByText("Couldn't import the GitHub issue.")).toBeNull();
  });

  it("imports a pasted GitHub URL from the visible action", async () => {
    vi.mocked(ipc.importGithubForRepo).mockResolvedValue({
      reference: "bitcoin/bitcoin#35761",
      title: "Imported Bitcoin issue",
      description: "Opening body and comments",
    });
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const reference = screen.getByPlaceholderText("GitHub issue or pull request URL, owner/repo#123, or #123…");
    fireEvent.change(reference, { target: { value: "https://github.com/bitcoin/bitcoin/issues/35761" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(ipc.importGithubForRepo).toHaveBeenCalledWith("/repo", "https://github.com/bitcoin/bitcoin/issues/35761"));
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Imported Bitcoin issue");
    expect(screen.getByPlaceholderText(/Describe the feature/)).toHaveProperty("value", "Opening body and comments");
  });

  it("populates the same fields without dirtying the draft until a user edit", async () => {
    vi.mocked(ipc.importGithubForRepo).mockResolvedValue({
      reference: "owner/repo#2",
      title: "Imported title",
      description: "Imported description",
    });
    vi.mocked(ipc.writeDraftForRepo).mockResolvedValue({
      slug: "imported-title",
    } as Task);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const reference = await screen.findByPlaceholderText("GitHub issue or pull request URL, owner/repo#123, or #123…");
    fireEvent.change(reference, { target: { value: "owner/repo#2" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Imported title"));
    expect(screen.getByPlaceholderText(/Describe the feature/)).toHaveProperty("value", "Imported description");
    expect(ipc.importGithubForRepo).toHaveBeenCalledWith("/repo", "owner/repo#2");
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
    expect(ipc.writeDraftForRepo).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Edited title" } });
    await waitFor(() => expect(ipc.writeDraftForRepo).toHaveBeenCalled(), { timeout: 1_000 });
    expect(ipc.writeDraftForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/repo",
        name: "Edited title",
        description: "Imported description",
        githubIssue: "owner/repo#2",
        harness: "omp",
      }),
    );
  });

  it("ignores an import response after the selected repository changes", async () => {
    let resolveImport!: (issue: { reference: string; title: string; description: string }) => void;
    const deferred = new Promise<{ reference: string; title: string; description: string }>((resolve) => {
      resolveImport = resolve;
    });
    vi.mocked(ipc.importGithubForRepo).mockReturnValue(deferred);
    render(<CreateTaskPage activeRepo="/repo-a" knownRepos={["/repo-a", "/repo-b"]} onCancel={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Repository B state" } });
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const reference = screen.getByPlaceholderText("GitHub issue or pull request URL, owner/repo#123, or #123…");
    fireEvent.change(reference, { target: { value: "owner/repo#9" } });
    fireEvent.keyDown(reference, { key: "Enter" });
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "/repo-b" } });
    resolveImport({ reference: "owner/repo#9", title: "Stale title", description: "Stale description" });

    await waitFor(() => expect(ipc.importGithubForRepo).toHaveBeenCalledWith("/repo-a", "owner/repo#9"));
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Repository B state");
    expect(screen.getByPlaceholderText(/Describe the feature/)).not.toHaveProperty("value", "Stale description");
  });
});

describe("playbook selection", () => {
  it("lives in the right panel and updates the playbook preview", async () => {
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);

    const picker = await screen.findByRole("radiogroup", { name: "Choose playbook" });
    expect(picker.closest("aside")).not.toBeNull();
    expect(screen.getByText(playbooks[0].description)).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: /One-shot/ }));

    await waitFor(() => expect(screen.getByText(playbooks[1].description)).toBeDefined());
    expect(screen.getByRole("radio", { name: /One-shot/ })).toHaveProperty("checked", true);
    expect(screen.getByLabelText("One-shot steps")).toBeDefined();
  });
});

describe("OMP model default", () => {
  it("does not prefill a leftover claude-owned model", async () => {
    readConfigForRepo.mockResolvedValue({
      defaults: { harness: "claude", model: "sonnet", playbook: "superdevelop", draft_autosave: true },
    } as Config);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("radiogroup", { name: "Choose playbook" });
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
  });
});

describe("task creation feedback", () => {
  it("signals opened only after repository settings settle", async () => {
    let finishConfig!: (config: Config) => void;
    readConfigForRepo.mockReturnValue(
      new Promise<Config>((resolve) => {
        finishConfig = resolve;
      }),
    );
    const onOpened = vi.fn();
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} onOpened={onOpened} />);
    expect(onOpened).not.toHaveBeenCalled();

    finishConfig({ defaults: { harness: "claude", model: "", playbook: "superdevelop", draft_autosave: true } } as Config);
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
  });

  const startCreate = async (onCreated: (result: TargetedCreateResult) => void) => {
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={onCreated} />);
    fireEvent.change(await screen.findByPlaceholderText("New task name…"), { target: { value: "Slow task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  };

  it("shows the loader the instant Create is clicked and resolves it when the task lands", async () => {
    const result: CreateTaskResult = {
      task: { name: "Slow task", slug: "slow-task", branch: "slow-task", worktree: "/repo/.alinery/worktrees/slow-task" } as Task,
      session: { id: "s-slow-task", harness: "omp" } as SessionMeta,
      attachment_errors: [],
    };
    let finishCreate!: (result: CreateTaskResult) => void;
    vi.mocked(ipc.createTaskForRepo).mockReturnValue(
      new Promise<CreateTaskResult>((resolve) => {
        finishCreate = resolve;
      }),
    );
    const onCreated = vi.fn();
    const onBusy = vi.fn();
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={onCreated} onBusy={onBusy} />);
    fireEvent.change(await screen.findByPlaceholderText("New task name…"), { target: { value: "Slow task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(onBusy).toHaveBeenCalledWith("create");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDefined();
    expect(screen.getByText(/Creating New Task… You can keep using Alinery/)).toBeDefined();
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();

    finishCreate(result);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ repoPath: "/repo", task: result.task, session: result.session }));
    expect(onBusy).toHaveBeenCalledWith(null);
    expect(toastSpies.success).toHaveBeenCalledWith("Task created");
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it("resolves the loader to an error and keeps the typed name when creation fails", async () => {
    vi.mocked(ipc.createTaskForRepo).mockRejectedValue(new Error("worktree add failed"));
    const onCreated = vi.fn();
    await startCreate(onCreated);

    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith("Couldn't create the task: Error: worktree add failed"));
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Slow task");
  });

  it("refuses to start while a duplicate from another surface is running", async () => {
    const onCreated = vi.fn();
    taskMutationGuard.claim("duplicate");
    await startCreate(onCreated);

    await waitFor(() => expect(toastSpies.toast).toHaveBeenCalledWith("A task is already being duplicated — wait for it to finish.", "error"));
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    expect(toastSpies.loading).not.toHaveBeenCalled();
  });
});
