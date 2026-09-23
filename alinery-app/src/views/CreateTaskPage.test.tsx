import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as taskMutationGuard from "../taskMutationGuard";
import { mockIpc } from "../test/mockIpc";
import type { BoardTask, Config, CreateTaskResult, PlaybookCatalog, PlaybookRef, ScopedPlaybook, TargetedCreateResult, Task } from "../types";
import { CreateTaskPage } from "./CreateTaskPage";

const sources: ScopedPlaybook[] = [
  { scope: "bundled", key: "superdevelop", title: "SuperDevelop" },
  { scope: "global", key: "superdevelop", title: "Global SuperDevelop" },
  { scope: "repo", key: "superdevelop", title: "Repository SuperDevelop" },
  { scope: "bundled", key: "one-shot", title: "One-shot" },
].map(({ scope, key, title }) => ({
  source: { reference: { scope, key } as PlaybookRef, path: null },
  source_text: `exact ${scope}/${key} source\r\n`,
  modified_at_ms: null,
  definition: {
    version: 2,
    key,
    title,
    description: `${title} instructions`,
    default_model: "",
    default_harness: "omp",
    preamble: "",
    section_order: ["build"],
    step: [
      {
        key: "build",
        title: "Build",
        short: "",
        inputs: [],
        outputs: [{ path: "result.md" }],
        model: "",
        harness: "",
        is_coding_step: true,
        auto_advance_default: false,
        prompt: "Build it.",
      },
    ],
  },
}));
const catalog: PlaybookCatalog = {
  candidates: [
    ...sources.map((source) => ({
      source: source.source,
      title: source.definition.title,
      description: source.definition.description,
      modified_at_ms: null,
      diagnostics: [],
    })),
    {
      source: { reference: { scope: "repo", key: "broken" }, path: "/repo/.alinery/playbooks/broken/playbook.md" },
      title: "Broken",
      description: "",
      modified_at_ms: null,
      diagnostics: [{ code: "invalid", message: "Overlapping output producers", line: 4, field: "outputs", severity: "error" }],
    },
  ],
  picker_preferences: { order: [], entries: [] },
  diagnostics: [],
};
const readyReply = {
  task: { slug: "new-task", name: "New task" } as Task,
  sessions: [],
  executions: [],
  creation: "ready",
  start: "not_requested",
  errors: [],
} satisfies CreateTaskResult;

const draftTask: BoardTask = {
  name: "Draft task",
  slug: "stable-draft",
  requested_slug: "final-task",
  repo_path: "/repo",
  playbook: "",
  playbook_ref: { scope: "bundled", key: "superdevelop" },
  auto_advance: [],
  draft: true,
  branch: "",
  worktree: "",
  has_worktree: false,
  created: 1,
  archived: false,
  pr_url: "",
  linear_id: "",
  github_issue: "",
  session_count: 0,
  playbook_title: "SuperDevelop",
  updated: 1,
  current_phase: "",
  current_step_title: "",
  latest_session_title: "",
  latest_session_column_key: "",
  current_column_key: "",
  current_column_title: "",
};

const readConfigForRepo = vi.hoisted(() =>
  vi.fn(
    async () =>
      ({
        defaults: { harness: "claude", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
      }) as Config,
  ),
);

vi.mock("../ipc", () =>
  mockIpc({
    readConfigForRepo,
    listPlaybookCatalog: vi.fn(async () => structuredClone(catalog)),
    readPlaybook: vi.fn(),
    prepareTaskAttachments: vi.fn(async () => ({ attachments: [], attachment_urls: [], attachment_errors: [] })),
    connectionStatuses: vi.fn(async () => []),
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  readConfigForRepo.mockResolvedValue({
    defaults: { harness: "claude", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
  } as Config);
  vi.mocked(ipc.listPlaybookCatalog).mockImplementation(async () => structuredClone(catalog));
  vi.mocked(ipc.readPlaybook).mockImplementation(async (reference) => {
    const source = sources.find((item) => item.source.reference.scope === reference.scope && item.source.reference.key === reference.key);
    if (!source) throw new Error(`Unknown test playbook: ${reference.scope}/${reference.key}`);
    return structuredClone(source);
  });
  vi.mocked(ipc.createTaskForRepo).mockResolvedValue(readyReply);
  vi.mocked(ipc.writeDraftForRepo).mockResolvedValue({ slug: "draft-storage" } as Task);
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
  it("preserves edited fields when an import fails", async () => {
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

    await waitFor(() => expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Imported Bitcoin issue"));
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

describe("scoped playbook selection", () => {
  it.each([false, true])("opens the exact scoped seed first without persisting or creating (preferred: %s)", async (seedPreferred) => {
    const preferred = structuredClone(catalog);
    preferred.picker_preferences = {
      order: [sources[0].source.reference],
      entries: [{ reference: sources[0].source.reference, preferred: true, hidden: false, collapsed: false, badge: null, color: null, last_imported_at_ms: null }],
    };
    if (seedPreferred) preferred.picker_preferences.entries.push({ ...preferred.picker_preferences.entries[0], reference: sources[2].source.reference });
    vi.mocked(ipc.listPlaybookCatalog).mockResolvedValue(preferred);
    render(<CreateTaskPage initialPlaybook={sources[2].source.reference} activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("region", { name: "Repository SuperDevelop graph" });
    expect(screen.getByRole("radio", { name: "Repository SuperDevelop — repo/superdevelop" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" })).toHaveProperty("checked", false);
    const displayedOrder = ["repo/superdevelop", "bundled/superdevelop"];
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(displayedOrder);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
    });
    expect(ipc.savePlaybookPickerPreferences).not.toHaveBeenCalled();
    expect(ipc.writeDraftForRepo).not.toHaveBeenCalled();
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    expect(ipc.createSessionForRepo).not.toHaveBeenCalled();
    expect(ipc.startSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" }));
    await screen.findByRole("region", { name: "SuperDevelop graph" });
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(displayedOrder);
    fireEvent.click(screen.getByRole("radio", { name: "Repository SuperDevelop — repo/superdevelop" }));
    await screen.findByRole("region", { name: "Repository SuperDevelop graph" });

    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Seeded task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("button", { name: "Open task" });
    expect(ipc.createTaskForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ playbook: { reference: sources[2].source.reference, source: sources[2].source_text } }),
      }),
    );
  });

  it.each([
    { scope: "global", key: "missing" },
    { scope: "repo", key: "broken" },
  ] as const)("blocks unavailable or invalid seed $scope/$key instead of falling back to the default", async (initialPlaybook) => {
    render(<CreateTaskPage initialPlaybook={initialPlaybook} activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("radio", { name: /One-shot/ });
    expect(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" })).toHaveProperty("checked", false);
    expect(screen.queryByRole("region", { name: /graph$/ })).toBeNull();
    expect(ipc.readPlaybook).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Blocked task" } });
    expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByPlaceholderText("New task name…"), { key: "Enter", metaKey: true });
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /One-shot/ }));
    await screen.findByRole("region", { name: "One-shot graph" });
    expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", false);
  });

  it.each([null, undefined])("does not replace a draft's absent reference (%s) with an explicit seed or repository default", async (playbook_ref) => {
    const initialDraft = { ...draftTask, playbook_ref };
    render(
      <CreateTaskPage
        initialDraft={initialDraft}
        initialPlaybook={sources[2].source.reference}
        activeRepo="/repo"
        knownRepos={["/repo"]}
        onCancel={() => {}}
        onCreated={() => {}}
      />,
    );
    await screen.findByRole("radio", { name: /One-shot/ });
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByRole("region", { name: /graph$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByPlaceholderText("New task name…"), { key: "Enter", metaKey: true });
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    expect(ipc.writeDraftForRepo).not.toHaveBeenCalled();
  });

  it("keeps preferred order independent of the default and expands only the selected card", async () => {
    const preferred = structuredClone(catalog);
    preferred.picker_preferences = {
      order: [sources[3].source.reference, sources[0].source.reference],
      entries: [sources[3], sources[0]].map((source) => ({
        reference: source.source.reference,
        preferred: true,
        hidden: false,
        collapsed: false,
        badge: null,
        color: null,
        last_imported_at_ms: null,
      })),
    };
    vi.mocked(ipc.listPlaybookCatalog).mockResolvedValue(preferred);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("region", { name: "SuperDevelop graph" });
    const choices = () => screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    expect(choices()).toEqual(["bundled/one-shot", "bundled/superdevelop"]);
    expect(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: /One-shot/ }));
    const graph = await screen.findByRole("region", { name: "One-shot graph" });
    expect(screen.queryByRole("region", { name: "SuperDevelop graph" })).toBeNull();
    expect(choices()).toEqual(["bundled/one-shot", "bundled/superdevelop"]);
    if (!graph.parentElement) throw new Error("Graph must be inside the selected card");
    expect(within(graph.parentElement).getByRole("radio", { name: /One-shot/ })).toHaveProperty("checked", true);
    expect(within(graph).getByRole("button", { name: "Highlight Build" })).toBeTruthy();
  });

  it("browses inline without losing form data or preferring a one-task selection", async () => {
    const preferred = structuredClone(catalog);
    preferred.picker_preferences = {
      order: [sources[0].source.reference],
      entries: [{ reference: sources[0].source.reference, preferred: true, hidden: false, collapsed: false, badge: null, color: null, last_imported_at_ms: null }],
    };
    vi.mocked(ipc.listPlaybookCatalog).mockResolvedValue(preferred);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("region", { name: "SuperDevelop graph" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Preserved draft" } });
    const description = screen.getByPlaceholderText(/Describe the feature/);
    fireEvent.change(description, { target: { value: "Keep this task description" } });
    fireEvent.click(screen.getByRole("button", { name: "Browse all playbooks" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search playbooks" }), { target: { value: "global/superdevelop" } });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: /Global SuperDevelop/ }));
    await screen.findByRole("region", { name: "Global SuperDevelop graph" });
    expect(screen.getByRole("searchbox", { name: "Search playbooks" })).toHaveProperty("value", "global/superdevelop");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search playbooks" }), { target: { value: "" } });
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual([
      "bundled/superdevelop",
      "bundled/one-shot",
      "global/superdevelop",
      "repo/broken",
      "repo/superdevelop",
    ]);
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Preserved draft");
    expect(description).toHaveProperty("value", "Keep this task description");
    fireEvent.click(screen.getByRole("button", { name: "Back to preferred" }));
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["bundled/superdevelop", "global/superdevelop"]);
    fireEvent.click(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" }));
    await screen.findByRole("region", { name: "SuperDevelop graph" });
    expect(screen.getByRole("radio", { name: /Global SuperDevelop/ })).toHaveProperty("checked", false);
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["bundled/superdevelop", "global/superdevelop"]);
    fireEvent.click(screen.getByRole("button", { name: "Browse all playbooks" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search playbooks" }), { target: { value: "no matching workflow" } });
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to preferred" }));
    expect(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" })).toHaveProperty("checked", true);
    expect(screen.queryByRole("radio", { name: /Global SuperDevelop/ })).toBeNull();
  });

  it("opens an unconfigured repository in the searchable library including legacy-hidden choices", async () => {
    const unconfigured = structuredClone(catalog);
    unconfigured.picker_preferences.entries = [{ reference: sources[1].source.reference, hidden: true, collapsed: false, badge: null, color: null, last_imported_at_ms: null }];
    vi.mocked(ipc.listPlaybookCatalog).mockResolvedValue(unconfigured);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("searchbox", { name: "Search playbooks" });
    const choices = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    fireEvent.click(screen.getByRole("radio", { name: /Global SuperDevelop/ }));
    await screen.findByRole("region", { name: "Global SuperDevelop graph" });
    expect(screen.getByRole("searchbox", { name: "Search playbooks" })).toHaveProperty("value", "");
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(choices);
    fireEvent.click(screen.getByRole("radio", { name: /One-shot/ }));
    await screen.findByRole("region", { name: "One-shot graph" });
    expect(screen.queryByRole("region", { name: "Global SuperDevelop graph" })).toBeNull();
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(choices);
    expect(screen.getByRole("radio", { name: /Broken/ })).toHaveProperty("disabled", true);
  });

  it("retains the seed on refresh and a later user choice across catalog and repository changes", async () => {
    render(<CreateTaskPage initialPlaybook={sources[2].source.reference} activeRepo="/repo" knownRepos={["/repo", "/other"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("region", { name: "Repository SuperDevelop graph" });
    const displayedOrder = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    expect(displayedOrder[0]).toBe("repo/superdevelop");
    fireEvent.click(screen.getByRole("button", { name: "Refresh playbooks" }));
    await screen.findByRole("region", { name: "Repository SuperDevelop graph" });
    expect(screen.getByRole("radio", { name: /Repository SuperDevelop/ })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: /Global SuperDevelop/ }));
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh playbooks" }));
    await waitFor(() => expect(ipc.listPlaybookCatalog).toHaveBeenCalledTimes(3));
    await screen.findByRole("checkbox", { name: "Build" });
    expect(screen.getByRole("radio", { name: /Global SuperDevelop/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /Broken/ })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "/other" } });
    await screen.findByRole("region", { name: "Global SuperDevelop graph" });
    expect(screen.getByRole("radio", { name: /Global SuperDevelop/ })).toHaveProperty("checked", true);
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(displayedOrder);
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Scoped task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("button", { name: "Open task" });
    expect(ipc.createTaskForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "/other",
        request: expect.objectContaining({ playbook: { reference: { scope: "global", key: "superdevelop" }, source: sources[1].source_text } }),
      }),
    );
  });

  it("drops removed step keys on same-source refresh without restoring unchecked completion choices", async () => {
    const original = structuredClone(sources[0]);
    const build = { ...original.definition.step[0], auto_advance_default: true };
    original.definition.step = [build, { ...build, key: "removed", title: "Removed" }, { ...build, key: "keep", title: "Keep" }];
    const revised = structuredClone(original);
    revised.source_text = "revised bundled/superdevelop source\n";
    revised.definition.step = [build, { ...build, key: "keep", title: "Keep" }, { ...build, key: "added", title: "Added" }];
    vi.mocked(ipc.readPlaybook).mockResolvedValue(original);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);

    const buildChoice = await screen.findByRole("checkbox", { name: "Build" });
    expect(buildChoice).toHaveProperty("checked", true);
    fireEvent.click(buildChoice);
    expect(screen.getByRole("checkbox", { name: "Removed" })).toHaveProperty("checked", true);
    vi.mocked(ipc.readPlaybook).mockResolvedValue(revised);
    fireEvent.click(screen.getByRole("button", { name: "Refresh playbooks" }));

    expect(await screen.findByRole("checkbox", { name: "Added" })).toHaveProperty("checked", false);
    expect(screen.queryByRole("checkbox", { name: "Removed" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Build" })).toHaveProperty("checked", false);
    expect(screen.getByRole("checkbox", { name: "Keep" })).toHaveProperty("checked", true);
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Refreshed task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("button", { name: "Open task" });
    expect(ipc.createTaskForRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          playbook: { reference: original.source.reference, source: revised.source_text },
          auto_advance_steps: ["keep"],
        }),
      }),
    );
  });

  it("does not replace an unavailable configured default with the first catalog item", async () => {
    readConfigForRepo.mockResolvedValue({ defaults: { harness: "omp", model: "", playbook: { scope: "global", key: "missing" }, draft_autosave: false } } as Config);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("radio", { name: /One-shot/ });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", true);
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    fireEvent.keyDown(screen.getByPlaceholderText("New task name…"), { key: "Enter", metaKey: true });
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /One-shot/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", false));
  });
});

describe("OMP model default", () => {
  it("does not prefill a leftover claude-owned model", async () => {
    readConfigForRepo.mockResolvedValue({
      defaults: { harness: "claude", model: "sonnet", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true },
    } as Config);
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("radiogroup", { name: "Choose playbook" });
    await waitFor(() => expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""));
  });
});

describe("v2 task creation", () => {
  it("requires a positive u32 cap and always creates a dedicated worktree", async () => {
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    const cap = screen.getByRole("spinbutton", { name: "Maximum live sessions" });
    expect(cap).toHaveProperty("value", "10");
    expect(screen.queryByRole("checkbox", { name: "Use worktree" })).toBeNull();
    for (const value of ["0", "-1", "1.5", "4294967296"]) {
      fireEvent.change(cap, { target: { value } });
      expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", true);
      fireEvent.keyDown(screen.getByPlaceholderText("New task name…"), { key: "Enter", metaKey: true });
    }
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    fireEvent.change(cap, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("button", { name: "Open task" });
    expect(ipc.createTaskForRepo).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ max_live_sessions: 3 }) }));
  });

  it.each(["started", "queued", "not_requested"] as const)("opens task detail automatically after successful creation (%s)", async (start) => {
    vi.mocked(ipc.createTaskForRepo).mockResolvedValue({
      ...readyReply,
      start,
      sessions: [{ id: "root-a" }, { id: "root-b" }] as CreateTaskResult["sessions"],
    });
    function CreationFlow() {
      const [destination, setDestination] = useState("");
      return destination ? (
        <h1>{destination}</h1>
      ) : (
        <CreateTaskPage
          activeRepo="/repo"
          knownRepos={["/repo"]}
          onCancel={() => {}}
          onCreated={(result) => setDestination(result.selectedSessionId ? `Session: ${result.selectedSessionId}` : `Task detail: ${result.task?.slug}`)}
        />
      );
    }
    render(<CreationFlow />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    if (start === "not_requested") fireEvent.click(screen.getByRole("checkbox", { name: "Start eligible sessions after creation" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("heading", { name: "Task detail: new-task" });
    expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
  });

  it("keeps attachment warnings visible before opening a ready task", async () => {
    vi.mocked(ipc.createTaskForRepo).mockResolvedValue({ ...readyReply, attachment_errors: ["Could not copy evidence.pdf"] });
    const onCreated = vi.fn();
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={onCreated} />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText("Could not copy evidence.pdf");
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("keeps partial multi-root results inspectable without repeating creation or spawning", async () => {
    const reply = {
      ...readyReply,
      creation: "partial",
      start: "failed",
      sessions: [{ id: "root-a" }, { id: "root-b" }],
      executions: [
        { id: "a", candidate: { step_key: "build" }, lifecycle: "running", error: null },
        { id: "b", candidate: { step_key: "review" }, lifecycle: "launch_failed", error: "Runner unavailable" },
      ],
      errors: [{ stage: "launch", code: "spawn_failed", message: "Runner unavailable" }],
    } as CreateTaskResult;
    vi.mocked(ipc.createTaskForRepo).mockResolvedValue(reply);
    const onCreated = vi.fn();
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={onCreated} />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    const create = screen.getByRole("button", { name: "Create task" });
    fireEvent.click(create);
    fireEvent.click(create);
    await screen.findByRole("button", { name: "Open session root-b" });
    expect(screen.getByText(/review: launch_failed/)).toBeDefined();
    expect(screen.getByText(/launch: Runner unavailable/)).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
    expect(toastSpies.error).toHaveBeenCalledWith(expect.stringContaining("Runner unavailable"));
    expect(toastSpies.success).not.toHaveBeenCalled();
    await waitFor(() => expect(taskMutationGuard.currentKind()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open session root-b" }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ repoPath: "/repo", task: reply.task, selectedSessionId: "root-b" }));
    expect(ipc.createTaskForRepo).toHaveBeenCalledTimes(1);
    expect(ipc.createSessionForRepo).not.toHaveBeenCalled();
    expect(ipc.startSession).not.toHaveBeenCalled();
  });

  it("waits for the stable draft identity and stops autosave throughout promotion", async () => {
    let resolveSave!: (task: Task) => void;
    const saved = new Promise<Task>((resolve) => {
      resolveSave = resolve;
    });
    vi.mocked(ipc.writeDraftForRepo).mockReturnValueOnce(saved);
    render(
      <CreateTaskPage initialDraft={draftTask} initialPlaybook={sources[2].source.reference} activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />,
    );
    await screen.findByRole("checkbox", { name: "Build" });
    expect(screen.getByRole("radio", { name: "SuperDevelop — bundled/superdevelop" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /Repository SuperDevelop/ })).toHaveProperty("checked", false);
    await waitFor(() => expect(ipc.writeDraftForRepo).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Late edit" } });
    expect(ipc.createTaskForRepo).not.toHaveBeenCalled();
    await act(async () => resolveSave({ slug: "stable-draft" } as Task));
    await screen.findByRole("button", { name: "Open task" });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
    });
    expect(ipc.writeDraftForRepo).toHaveBeenCalledTimes(1);
    expect(ipc.createTaskForRepo).toHaveBeenCalledTimes(1);
    expect(ipc.createTaskForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ draft_slug: "stable-draft", requested_slug: "final-task", name: "Draft task" }) }),
    );
  });

  it("keeps a partial reply without a task identity visible and blocks repeated creation", async () => {
    vi.mocked(ipc.createTaskForRepo).mockResolvedValue({
      ...readyReply,
      task: null,
      creation: "partial",
      errors: [{ stage: "provisioning", code: "ambiguous", message: "Inspect durable state" }],
    });
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText(/provisioning: Inspect durable state/);
    expect(screen.getByRole("button", { name: "Open task" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByPlaceholderText("New task name…"), { key: "Enter", metaKey: true });
    expect(ipc.createTaskForRepo).toHaveBeenCalledTimes(1);
  });

  it("freezes creation and autosave after a lost provisioning reply", async () => {
    vi.mocked(ipc.createTaskForRepo).mockRejectedValue(new Error("Connection closed"));
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={() => {}} />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByText(/Creation outcome is unknown/);
    fireEvent.change(screen.getByPlaceholderText("New task name…"), { target: { value: "Another name" } });
    fireEvent.keyDown(screen.getByPlaceholderText("New task name…"), { key: "Enter", metaKey: true });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
    });
    expect(ipc.createTaskForRepo).toHaveBeenCalledTimes(1);
    expect(ipc.writeDraftForRepo).not.toHaveBeenCalled();
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

    finishConfig({ defaults: { harness: "claude", model: "", playbook: { scope: "bundled", key: "superdevelop" }, draft_autosave: true } } as Config);
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
  });

  const startCreate = async (onCreated: (result: TargetedCreateResult) => void) => {
    render(<CreateTaskPage activeRepo="/repo" knownRepos={["/repo"]} onCancel={() => {}} onCreated={onCreated} />);
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(await screen.findByPlaceholderText("New task name…"), { target: { value: "Slow task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
  };

  it("shows the loader the instant Create is clicked and resolves it when the task lands", async () => {
    const result: CreateTaskResult = {
      ...readyReply,
      task: { name: "Slow task", slug: "slow-task", branch: "slow-task", worktree: "/repo/.alinery/worktrees/slow-task" } as Task,
      sessions: [{ id: "s-slow-task", harness: "omp" }] as CreateTaskResult["sessions"],
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
    await screen.findByRole("checkbox", { name: "Build" });
    fireEvent.change(await screen.findByPlaceholderText("New task name…"), { target: { value: "Slow task" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(onBusy).toHaveBeenCalledWith("create");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDefined();
    expect(screen.getByText(/Creating New Task… You can keep using Alinery/)).toBeDefined();
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();

    await waitFor(() => expect(ipc.createTaskForRepo).toHaveBeenCalledOnce());
    finishCreate(result);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ ...result, repoPath: "/repo" }));
    await waitFor(() => expect(onBusy).toHaveBeenCalledWith(null));
    expect(toastSpies.success).toHaveBeenCalledWith("Task created");
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it("resolves the loader to an error and keeps the typed name when the creation reply is lost", async () => {
    vi.mocked(ipc.createTaskForRepo).mockRejectedValue(new Error("worktree add failed"));
    const onCreated = vi.fn();
    await startCreate(onCreated);

    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith(expect.stringContaining("worktree add failed")));
    expect(await screen.findByText(/Creation outcome is unknown/)).toBeDefined();
    expect(toastSpies.success).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("New task name…")).toHaveProperty("value", "Slow task");
    expect(taskMutationGuard.currentKind()).toBeNull();
    expect(screen.getByRole("button", { name: "Create task" })).toHaveProperty("disabled", true);
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
