import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import type { BoardTask, Config, PlaybookStepSummary, PlaybookSummary, SessionListItem } from "../types";

const PREVIEW = "Resolved launch prompt for the task.";
const RESEARCH_PREVIEW = "Resolved research launch prompt.";
const MODEL_PREVIEW = "Resolved model launch prompt.";
const EDITED_PROMPT = `  ${PREVIEW}\n\nAlso verify the fallback path. ✓  `;

const task: BoardTask = {
  name: "A task",
  slug: "a-task",
  requested_slug: "a-task",
  parent_task: "",
  active_subtask: "",
  branch: "a-task",
  worktree: "/w/a-task",
  has_worktree: true,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  playbook: "superdevelop",
  draft: false,
  auto_advance: [],
  repo_path: "/r",
  session_count: 0,
  playbook_title: "SuperDevelop",
  updated: 1,
  current_phase: "research",
  current_step_title: "Research",
  current_column_key: "research-design",
  current_column_title: "Research & Design",
  latest_session_title: "",
  latest_session_column_key: "",
  artifact_count: 0,
  sessions: [],
} as BoardTask;

const secondTask: BoardTask = {
  ...task,
  name: "B task",
  slug: "b-task",
  requested_slug: "b-task",
  branch: "b-task",
  worktree: "/w/b-task",
};
const playbook = { key: "superdevelop", title: "SuperDevelop" } as PlaybookSummary;
const steps = [
  { key: "research", title: "Research" },
  { key: "design", title: "Design" },
] as PlaybookStepSummary[];

const { askConfirm, listBoardTasks, listSessionItems, listPlaybookStepsForRepo, listPlaybooksForRepo, previewSessionPrompt, readConfig } = vi.hoisted(() => ({
  askConfirm: vi.fn(),
  listBoardTasks: vi.fn(),
  listSessionItems: vi.fn(),
  listPlaybookStepsForRepo: vi.fn(),
  listPlaybooksForRepo: vi.fn(),
  previewSessionPrompt: vi.fn(),
  readConfig: vi.fn(),
}));

vi.mock("../confirm", () => ({ askConfirm }));
vi.mock("../ipc", () =>
  mockIpc({
    listBoardTasks,
    readConfig,
    listSessionItems,
    listPlaybooksForRepo,
    listPlaybookStepsForRepo,
    listHarnessModelsForRepo: async () => ["sonnet"],
    previewSessionPrompt,
  }),
);

beforeEach(() => {
  const storedModels = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storedModels.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storedModels.set(key, value)),
  });
  askConfirm.mockReset().mockResolvedValue("keep");
  readConfig.mockReset().mockResolvedValue({ defaults: { harness: "omp", model: "sonnet" } } as unknown as Config);

  listBoardTasks.mockReset().mockResolvedValue([task]);
  listSessionItems.mockReset().mockResolvedValue([]);
  listPlaybooksForRepo.mockReset().mockResolvedValue([playbook]);
  listPlaybookStepsForRepo.mockReset().mockResolvedValue(steps);
  previewSessionPrompt.mockReset().mockImplementation(async ({ phase, model }: { phase: string; model: string }) => {
    if (model === "gpt-5") return MODEL_PREVIEW;
    return phase === "design" ? PREVIEW : RESEARCH_PREVIEW;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function renderPage(onCreated = vi.fn(async () => {})) {
  const { CreateSessionPage } = await import("./CreateSessionPage");
  render(<CreateSessionPage allRepos={false} activeRepo="/r" onCancel={() => {}} onCreated={onCreated} />);
  const box = await waitFor(() => {
    const found = document.querySelector("textarea");
    if (!found || found.value !== PREVIEW || found.disabled) throw new Error("editable prompt has not resolved yet");
    return found;
  });
  return { box, onCreated };
}

const launch = () => fireEvent.click(screen.getByRole("button", { name: "Launch" }));
const selectOptionValue = (name: string) => (screen.getByRole("option", { name }) as HTMLOptionElement).value;
const changeSessionType = (name: string) => fireEvent.change(screen.getByLabelText("Session type"), { target: { value: selectOptionValue(name) } });

describe("the prompt field", () => {
  it("shows the generated value only after its exact context resolves", async () => {
    const pending = deferred<string>();
    previewSessionPrompt.mockReturnValueOnce(pending.promise);
    const { CreateSessionPage } = await import("./CreateSessionPage");
    render(<CreateSessionPage allRepos={false} activeRepo="/r" onCancel={() => {}} onCreated={async () => {}} />);

    const box = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => pending.resolve(PREVIEW));
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.value).toBe(PREVIEW);
  });

  it("keeps exact user edits in the controlled value", async () => {
    const { box } = await renderPage();
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });
    expect(box.value).toBe(EDITED_PROMPT);
  });

  it("labels the field and explains its per-session and OMP semantics", async () => {
    await renderPage();
    expect(screen.getByText("Launch prompt")).toBeDefined();
    expect(screen.getByText(/only.*this new session/i)).toBeDefined();
    expect(screen.getByText(/clearing removes the task instructions/i)).toBeDefined();
    expect(screen.getByText(/OMP.*completion contract.*runtime/i)).toBeDefined();
  });
});

describe("Launch", () => {
  it("omits an override when the playbook preview is untouched", async () => {
    const { onCreated } = await renderPage();
    launch();
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "a-task", repo_path: "/r" }),
        { kind: "playbook-step", playbook: "superdevelop", phase: "design" },
        "omp",
        "sonnet",
        undefined,
      ),
    );
  });

  it("launches Terminal as a generic no-harness session without a prompt or model", async () => {
    const { box, onCreated } = await renderPage();
    changeSessionType("Terminal");

    await waitFor(() => expect(box.disabled).toBe(true));
    expect(box.value).toBe("");
    expect(screen.queryByPlaceholderText("Model (empty = harness default)")).toBeNull();
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), { kind: "generic" }, "no-harness", "", undefined));
  });

  it("hands the exact edited prompt to session creation", async () => {
    const { box, onCreated } = await renderPage();
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "sonnet", EDITED_PROMPT));
  });

  it("hands an explicitly cleared prompt to session creation", async () => {
    const { box, onCreated } = await renderPage();
    fireEvent.input(box, { target: { value: "" } });
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "sonnet", ""));
  });

  it("hands an option-like prompt to session creation as exact text", async () => {
    const { box, onCreated } = await renderPage();
    fireEvent.input(box, { target: { value: "--version" } });
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "sonnet", "--version"));
  });
});

describe("launch context changes", () => {
  it("regenerates a pristine preview for exact model and session type changes without confirmation", async () => {
    const { box } = await renderPage();
    fireEvent.input(screen.getByLabelText("Model"), { target: { value: "gpt-5" } });

    await waitFor(() => expect(box.value).toBe(MODEL_PREVIEW));
    expect(previewSessionPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ harness: "omp", model: "gpt-5" }));

    changeSessionType("SuperDevelop · Research");
    await waitFor(() => expect(previewSessionPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ harness: "omp", phase: "research", model: "gpt-5" })));
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("rejects a delayed stale preview after the current draft is edited", async () => {
    const oldPreview = deferred<string>();
    const newPreview = deferred<string>();
    const { box } = await renderPage();
    previewSessionPrompt.mockImplementation(({ phase, model }: { phase: string; model: string }) => {
      if (phase === "research" && model === "sonnet") return oldPreview.promise;
      if (phase === "research" && model === "gpt-5") return newPreview.promise;
      return Promise.resolve(PREVIEW);
    });

    changeSessionType("SuperDevelop · Research");
    fireEvent.input(screen.getByLabelText("Model"), { target: { value: "gpt-5" } });
    await act(async () => newPreview.resolve("Current preview"));
    await waitFor(() => expect(box.value).toBe("Current preview"));
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });

    await act(async () => oldPreview.resolve("Obsolete preview"));
    expect(box.value).toBe(EDITED_PROMPT);
  });

  it("does not preview a new task with the previous task's playbook choice", async () => {
    listBoardTasks.mockResolvedValue([task, secondTask]);
    const playbooks = deferred<PlaybookSummary[]>();
    const { box } = await renderPage();
    previewSessionPrompt.mockClear();
    listPlaybooksForRepo.mockReturnValueOnce(playbooks.promise);

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: selectOptionValue("B task") } });
    expect(box.disabled).toBe(true);
    await act(async () => Promise.resolve());
    expect(previewSessionPrompt.mock.calls.some(([request]) => request.taskSlug === "b-task")).toBe(false);

    await act(async () => playbooks.resolve([playbook]));
    await waitFor(() =>
      expect(previewSessionPrompt).toHaveBeenCalledWith(expect.objectContaining({ taskSlug: "b-task", playbook: "superdevelop", phase: "design", harness: "omp" })),
    );
    await waitFor(() => expect(box.disabled).toBe(false));
  });

  it("keeps an exact edit under the new context after the safe-default decision", async () => {
    const { box, onCreated } = await renderPage();
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });
    previewSessionPrompt.mockClear();
    changeSessionType("SuperDevelop · Research");

    await waitFor(() =>
      expect(askConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          cancelKey: "cancel",
          defaultKey: "cancel",
          choices: expect.arrayContaining([expect.objectContaining({ key: "keep" }), expect.objectContaining({ key: "discard" }), expect.objectContaining({ key: "cancel" })]),
        }),
      ),
    );
    await waitFor(() => expect(box.value).toBe(EDITED_PROMPT));
    expect(previewSessionPrompt).not.toHaveBeenCalled();
    launch();
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.anything(), { kind: "playbook-step", playbook: "superdevelop", phase: "research" }, "omp", "sonnet", EDITED_PROMPT),
    );
  });

  it("prefers the task's recent omp model over the global default", async () => {
    listSessionItems.mockResolvedValue([
      {
        repo_path: "/r",
        task_slug: "a-task",
        harness: "omp",
        model: "task-opus",
      } as SessionListItem,
    ]);
    const { onCreated } = await renderPage();
    const modelInput = screen.getByLabelText("Model") as HTMLInputElement;
    await waitFor(() => expect(modelInput.value).toBe("task-opus"));
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "task-opus", undefined));
  });

  it("ignores a leftover non-omp recent session model", async () => {
    listSessionItems.mockResolvedValue([
      {
        repo_path: "/r",
        task_slug: "a-task",
        harness: "claude",
        model: "task-opus",
      } as SessionListItem,
    ]);
    const { onCreated } = await renderPage();
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("sonnet"));
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "sonnet", undefined));
  });

  it("clears a leftover claude-owned default model", async () => {
    readConfig.mockResolvedValue({ defaults: { harness: "claude", model: "sonnet" } } as unknown as Config);
    const { onCreated } = await renderPage();
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "", undefined));
  });

  it("discards an edit and regenerates a pristine draft only after confirmation", async () => {
    askConfirm.mockResolvedValueOnce("discard");
    const { box, onCreated } = await renderPage();
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });
    changeSessionType("SuperDevelop · Research");

    await waitFor(() => expect(box.value).toBe(RESEARCH_PREVIEW));
    launch();
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.anything(), { kind: "playbook-step", playbook: "superdevelop", phase: "research" }, "omp", "sonnet", undefined),
    );
  });

  it("cancels a context change without losing the prior edit or selection", async () => {
    askConfirm.mockResolvedValueOnce("cancel");
    const { box, onCreated } = await renderPage();
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });
    previewSessionPrompt.mockClear();
    changeSessionType("SuperDevelop · Research");

    await waitFor(() => expect(askConfirm).toHaveBeenCalledOnce());
    expect((screen.getByLabelText("Session type") as HTMLSelectElement).value).toBe(JSON.stringify({ kind: "playbook-step", playbook: "superdevelop", phase: "design" }));
    expect(box.value).toBe(EDITED_PROMPT);
    expect(previewSessionPrompt).not.toHaveBeenCalled();
    launch();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.anything(), expect.anything(), "omp", "sonnet", EDITED_PROMPT));
  });

  it("serializes rapid changes while one edited-context decision is pending", async () => {
    listBoardTasks.mockResolvedValue([task, secondTask]);
    const answer = deferred<string>();
    askConfirm.mockReturnValueOnce(answer.promise);
    const { box } = await renderPage();
    fireEvent.input(box, { target: { value: EDITED_PROMPT } });

    changeSessionType("SuperDevelop · Research");
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: selectOptionValue("B task") } });

    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(box.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer.resolve("keep"));
    await waitFor(() =>
      expect((screen.getByLabelText("Session type") as HTMLSelectElement).value).toBe(JSON.stringify({ kind: "playbook-step", playbook: "superdevelop", phase: "research" })),
    );
    expect((screen.getByLabelText("Task") as HTMLSelectElement).value).toBe(selectOptionValue("A task"));
    await waitFor(() => expect(box.value).toBe(EDITED_PROMPT));
  });

  it("keeps a failed preview non-launchable", async () => {
    const { box } = await renderPage();
    previewSessionPrompt.mockRejectedValueOnce(new Error("preview failed"));
    changeSessionType("SuperDevelop · Research");

    await screen.findByText("Could not create the session.");
    expect(box.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["playbook list", () => listPlaybooksForRepo.mockRejectedValueOnce(new Error("playbook list failed"))],
    ["playbook steps", () => listPlaybookStepsForRepo.mockRejectedValueOnce(new Error("playbook steps failed"))],
  ])("keeps a %s failure visible and non-launchable", async (_source, failLoad) => {
    failLoad();
    const { CreateSessionPage } = await import("./CreateSessionPage");
    render(<CreateSessionPage allRepos={false} activeRepo="/r" onCancel={() => {}} onCreated={async () => {}} />);

    await screen.findByText("Could not load playbooks.");
    const box = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Launch" }) as HTMLButtonElement).disabled).toBe(true);
    expect(previewSessionPrompt).not.toHaveBeenCalled();
  });
});
