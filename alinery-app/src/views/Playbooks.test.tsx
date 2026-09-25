import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../confirm";
import * as ipc from "../ipc";
import type * as IpcFixtures from "../test/mockIpc";
import type { NormalizedPlaybook, PickerPreference, PickerPreferences, PlaybookCatalog, PlaybookRef, SavePlaybookRequest, ScopedPlaybook } from "../types";
import { Playbooks } from "./Playbooks";

const mocks = vi.hoisted(() => ({
  listPlaybookCatalog: vi.fn(),
  readPlaybook: vi.fn(),
  validatePlaybookSource: vi.fn(),
  renderPlaybookSource: vi.fn(),
  savePlaybookSource: vi.fn(),
  deletePlaybookSource: vi.fn(),
  savePlaybookPickerPreferences: vi.fn(),
}));
const community = vi.hoisted(() => ({
  accountStatus: vi.fn(),
  accountSignIn: vi.fn(),
  accountRefresh: vi.fn(),
  listCommunityImports: vi.fn(),
  listCommunityPlaybooks: vi.fn(),
  communityDownloadStatus: vi.fn(),
  importCommunityPlaybook: vi.fn(),
  updateCommunityImport: vi.fn(),
  previewCommunityPlaybook: vi.fn(),
  publishCommunityPlaybook: vi.fn(),
}));
vi.mock("../ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc({ ...mocks, ...community });
});
const definition: NormalizedPlaybook = {
  version: 2,
  key: "review",
  title: "Review",
  description: "Review work",
  default_model: "default-model",
  default_harness: "omp",
  preamble: "Keep this prose.\n",
  section_order: ["inspect"],
  step: [
    {
      key: "inspect",
      title: "Inspect",
      short: "Inspect",
      is_coding_step: false,
      auto_advance_default: false,
      inputs: [{ path: "ticket.md", mode: "single" }],
      outputs: [{ path: "findings.md" }],
      model: "",
      harness: "",
      prompt: "Read assigned inputs.\n",
    },
  ],
};
let stored: ScopedPlaybook[];
let preferencesByRepo: Map<string | undefined, PickerPreferences>;
const onCreateTask = vi.fn();
const preference = (scope: PlaybookRef["scope"], preferred = true): PickerPreference => ({
  reference: { scope, key: "review" },
  preferred,
  hidden: false,
  collapsed: false,
  badge: null,
  color: null,
  last_imported_at_ms: null,
});
const identity = (ref: PlaybookRef) => `${ref.scope}/${ref.key}`;
const entry = (scope: PlaybookRef["scope"], overrides: Partial<NormalizedPlaybook> = {}, modifiedAt = scope === "bundled" ? null : 1234): ScopedPlaybook => {
  const value = { ...structuredClone(definition), ...overrides };
  return {
    source: { reference: { scope, key: value.key }, path: scope === "bundled" ? null : `/${scope}/${value.key}/playbook.md` },
    definition: value,
    source_text: JSON.stringify(value),
    modified_at_ms: modifiedAt,
  };
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.clearAllMocks();
  stored = [entry("bundled"), entry("global"), entry("repo")];
  preferencesByRepo = new Map();
  mocks.listPlaybookCatalog.mockImplementation(
    async (repoPath?: string): Promise<PlaybookCatalog> => ({
      candidates: stored.map((item) => ({
        source: item.source,
        title: item.definition.title,
        description: item.definition.description,
        modified_at_ms: item.modified_at_ms,
        diagnostics: [],
      })),
      picker_preferences: structuredClone(preferencesByRepo.get(repoPath) ?? { order: [], entries: [] }),
      diagnostics: [],
    }),
  );
  mocks.savePlaybookPickerPreferences.mockImplementation(async (next: PickerPreferences, repoPath?: string) => {
    preferencesByRepo.set(repoPath, structuredClone(next));
  });
  mocks.readPlaybook.mockImplementation(async (ref: PlaybookRef) => structuredClone(stored.find((item) => identity(item.source.reference) === identity(ref))));
  mocks.validatePlaybookSource.mockImplementation(async (source: string) => {
    try {
      return { definition: JSON.parse(source), diagnostics: [] };
    } catch {
      return {
        definition: null,
        diagnostics: [{ code: "overlapping_outputs", message: "inspect and build overlap findings.md", line: 12, field: "step.outputs", severity: "error" }],
      };
    }
  });
  mocks.renderPlaybookSource.mockImplementation(async (value: NormalizedPlaybook) => JSON.stringify(value));
  mocks.savePlaybookSource.mockImplementation(async (request: SavePlaybookRequest) => {
    const index = stored.findIndex((item) => identity(item.source.reference) === identity(request.target));
    if (index >= 0 && !request.overwrite) throw { kind: "conflict" };
    const saved = {
      source: { reference: request.target, path: `/library/${request.target.key}/playbook.md` },
      definition: JSON.parse(request.source),
      source_text: request.source,
      modified_at_ms: 2345,
    };
    if (index >= 0) stored[index] = saved;
    else stored.push(saved);
    return saved;
  });
  mocks.deletePlaybookSource.mockImplementation(async (reference: PlaybookRef) => {
    stored = stored.filter((item) => identity(item.source.reference) !== identity(reference));
  });
  community.accountStatus.mockResolvedValue({ signedIn: false, email: null, plan: null, paid: false, unavailable: false });
  community.accountSignIn.mockReset();
  community.accountRefresh.mockReset();
  community.listCommunityImports.mockResolvedValue({ imports: [] });
  community.listCommunityPlaybooks.mockReset();
  community.communityDownloadStatus.mockReset();
  community.importCommunityPlaybook.mockReset();
  community.updateCommunityImport.mockReset();
  community.publishCommunityPlaybook.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openRepo() {
  fireEvent.click(await screen.findByRole("button", { name: "Review Repository" }));
  await screen.findByRole("region", { name: "Review graph" });
}
function edit(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "Editor" }));
  fireEvent.change(screen.getByLabelText("Playbook source"), { target: { value } });
}
async function overwrite() {
  fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
  fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
}
function libraryOrder() {
  return within(screen.getByRole("table", { name: "Playbook library" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("aria-label"));
}

describe("playbook library", () => {
  it("searches titles, descriptions, keys and scoped identities across every source", async () => {
    stored = stored.map((item) => entry(item.source.reference.scope, { title: "Release checklist", description: "Audit deployment gates" }));
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await screen.findByRole("button", { name: "Release checklist Repository" });
    const search = screen.getByLabelText("Search playbooks");
    for (const query of ["  ReLeAsE  ", "DEPLOYMENT", "review"]) {
      fireEvent.change(search, { target: { value: query } });
      expect(libraryOrder()).toEqual(["bundled/review", "global/review", "repo/review"]);
    }
    for (const scope of ["bundled", "global", "repo"]) {
      fireEvent.change(search, { target: { value: `${scope}/review` } });
      expect(libraryOrder()).toEqual([`${scope}/review`]);
    }
    fireEvent.change(search, { target: { value: "no such playbook" } });
    expect(screen.queryByRole("button", { name: /Release checklist/ })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(libraryOrder()).toEqual(["bundled/review", "global/review", "repo/review"]);
  });

  it("toggles every column's sort direction, treats undated entries as oldest and leaves preferred order unchanged", async () => {
    stored = [
      entry("repo", { title: "Alpha" }, 1000),
      entry("repo", { key: "zulu", title: "Zulu" }, null),
      entry("global", { key: "omega", title: "Omega" }, 2000),
      entry("global", { title: "Alpha" }, 1000),
      entry("bundled", { title: "Alpha" }),
    ];
    const preferences = {
      order: [
        { scope: "repo", key: "review" },
        { scope: "global", key: "review" },
      ],
      entries: [preference("global"), preference("repo")],
    } satisfies PickerPreferences;
    preferencesByRepo.set("/repo", structuredClone(preferences));
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await screen.findByRole("button", { name: "Alpha Repository" });
    expect(screen.queryByRole("combobox", { name: "Sort playbooks" })).toBeNull();
    expect(libraryOrder()).toEqual(["bundled/review", "global/review", "repo/review", "global/omega", "repo/zulu"]);
    const orders = [
      ["Playbook Name", "descending", ["repo/zulu", "global/omega", "bundled/review", "global/review", "repo/review"]],
      ["Playbook Name", "ascending", ["bundled/review", "global/review", "repo/review", "global/omega", "repo/zulu"]],
      ["Source", "ascending", ["bundled/review", "global/review", "global/omega", "repo/review", "repo/zulu"]],
      ["Source", "descending", ["repo/review", "repo/zulu", "global/review", "global/omega", "bundled/review"]],
      ["Last modified", "descending", ["global/omega", "global/review", "repo/review", "bundled/review", "repo/zulu"]],
      ["Last modified", "ascending", ["bundled/review", "repo/zulu", "global/review", "repo/review", "global/omega"]],
      ["Preferred for this repo", "descending", ["global/review", "repo/review", "bundled/review", "global/omega", "repo/zulu"]],
      ["Preferred for this repo", "ascending", ["bundled/review", "global/omega", "repo/zulu", "global/review", "repo/review"]],
    ] as const;
    for (const [column, direction, expected] of orders) {
      const header = screen.getByRole("button", { name: `Sort by ${column}` });
      fireEvent.click(header);
      expect(libraryOrder()).toEqual(expected);
      expect(header.closest("th")?.getAttribute("aria-sort")).toBe(direction);
      expect(
        within(screen.getByRole("table", { name: "Playbook library" }))
          .getAllByRole("columnheader")
          .filter((header) => header.hasAttribute("aria-sort")),
      ).toHaveLength(1);
    }
    expect(preferencesByRepo.get("/repo")).toEqual(preferences);
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
  });

  it("filters preferred membership and changes it from the row without opening a playbook", async () => {
    preferencesByRepo.set("/repo", { order: [], entries: [preference("global")] });
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await screen.findByRole("button", { name: "Review Repository" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Preferred only" }));
    expect(libraryOrder()).toEqual(["global/review"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Preferred for this repo: global/review" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Review Global" })).toBeNull());
    expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull();
    expect(screen.getByLabelText("Search playbooks")).toBeTruthy();
    expect(mocks.readPlaybook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Preferred only" }));
    expect(libraryOrder()).toEqual(["bundled/review", "global/review", "repo/review"]);
    expect(screen.getByRole("checkbox", { name: "Preferred for this repo: global/review" })).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Preferred for this repo: repo/review" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Preferred for this repo: repo/review" })).toHaveProperty("checked", true));
    fireEvent.click(screen.getByRole("checkbox", { name: "Preferred only" }));
    expect(libraryOrder()).toEqual(["repo/review"]);
    expect(mocks.readPlaybook).not.toHaveBeenCalled();
  });

  it("opens a graph-only workspace and Back restores the library controls, scroll and search focus", async () => {
    preferencesByRepo.set("/repo", { order: [], entries: [preference("global"), preference("repo")] });
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await screen.findByRole("button", { name: "Review Repository" });
    fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Sort by Last modified" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Preferred only" }));
    const library = screen.getByRole("region", { name: "Playbook library" });
    library.scrollTop = 312;
    fireEvent.scroll(library);
    fireEvent.click(screen.getByRole("button", { name: "Review Global" }));
    await screen.findByRole("region", { name: "Review graph" });
    expect(screen.queryByRole("region", { name: "Playbook library" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Playbook library" })).toBeNull();
    expect(screen.queryByLabelText("Search playbooks")).toBeNull();
    expect(screen.queryByLabelText("Playbook source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", JSON.stringify(definition));
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Playbook library" }).scrollTop).toBe(312);
      expect(document.activeElement).toBe(screen.getByLabelText("Search playbooks"));
    });
    expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull();
    expect(screen.getByLabelText("Search playbooks")).toHaveProperty("value", "review");
    expect(screen.getByRole("button", { name: "Sort by Last modified" }).closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("checkbox", { name: "Preferred only" })).toHaveProperty("checked", true);
    expect(libraryOrder()).toEqual(["global/review", "repo/review"]);
  });
});

describe("creating a task from a saved playbook", () => {
  it("opens each scoped saved definition without persisting or changing its source", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await screen.findByRole("button", { name: "Review Repository" });
    expect(screen.queryByRole("button", { name: "Create task from this playbook" })).toBeNull();
    const initialStored = structuredClone(stored);
    for (const [scope, label] of [
      ["bundled", "Bundled"],
      ["global", "Global"],
      ["repo", "Repository"],
    ] as const) {
      fireEvent.click(await screen.findByRole("button", { name: `Review ${label}` }));
      await screen.findByRole("region", { name: "Review graph" });
      const create = screen.getByRole("button", { name: "Create task from this playbook" });
      expect(create).toHaveProperty("disabled", false);
      fireEvent.click(create);
      expect(onCreateTask).toHaveBeenLastCalledWith({ scope, key: "review" });
      fireEvent.click(screen.getByRole("button", { name: "Editor" }));
      expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", initialStored[0].source_text);
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
      await screen.findByRole("table", { name: "Playbook library" });
    }
    expect(onCreateTask).toHaveBeenCalledTimes(3);
    expect(stored).toEqual(initialStored);
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
    expect(ipc.writeRepoOverridesForRepo).not.toHaveBeenCalled();
  });

  it("does not offer task creation for a new unsaved definition", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    fireEvent.click(screen.getByRole("button", { name: "New playbook" }));
    await screen.findByLabelText("Save key");
    expect(screen.queryByRole("button", { name: "Create task from this playbook" })).toBeNull();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(onCreateTask).not.toHaveBeenCalled();
  });

  it("requires an explicit repository even for a saved global definition", async () => {
    const view = render(<Playbooks onCreateTask={onCreateTask} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review Global" }));
    await screen.findByRole("region", { name: "Review graph" });
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    expect(create.getAttribute("title")).toMatch(/select a repository/i);
    fireEvent.click(create);
    expect(onCreateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    view.rerender(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review Global" }));
    await screen.findByRole("region", { name: "Review graph" });
    expect(screen.getByRole("button", { name: "Create task from this playbook" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Create task from this playbook" }));
    expect(onCreateTask).toHaveBeenCalledWith({ scope: "global", key: "review" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
  });

  it("blocks the selected definition in another repository and restores availability on return", async () => {
    const view = render(<Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />);
    await openRepo();
    view.rerender(<Playbooks repoPath="/repo-b" onCreateTask={onCreateTask} />);
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    expect(create.getAttribute("title")).toContain("/repo-a");
    fireEvent.click(create);
    expect(onCreateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", JSON.stringify(definition));
    view.rerender(<Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />);
    expect(create).toHaveProperty("disabled", false);
    fireEvent.click(create);
    expect(onCreateTask).toHaveBeenCalledWith({ scope: "repo", key: "review" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
  });

  it("waits for an in-progress operation even when the saved source is clean", async () => {
    let resolveValidation!: (result: { definition: NormalizedPlaybook; diagnostics: [] }) => void;
    mocks.validatePlaybookSource.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveValidation = resolve;
      }),
    );
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await openRepo();
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    fireEvent.click(create);
    expect(onCreateTask).not.toHaveBeenCalled();
    await act(async () => resolveValidation({ definition, diagnostics: [] }));
    expect(create).toHaveProperty("disabled", false);
    fireEvent.click(create);
    expect(onCreateTask).toHaveBeenCalledWith({ scope: "repo", key: "review" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
  });
});

describe("graph-first playbook management", () => {
  it("keeps the saved graph through mode switches and updates it only after persistence", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    expect(screen.queryByLabelText("Playbook source")).toBeNull();
    const next = { ...definition, step: [{ ...definition.step[0], title: "Revised inspection", prompt: "New prompt" }] };
    const draft = JSON.stringify(next);
    edit(draft);
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    expect(create.getAttribute("title")).toMatch(/save/i);
    fireEvent.click(create);
    expect(onCreateTask).not.toHaveBeenCalled();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", draft);
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.queryByRole("button", { name: /Revised inspection/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", draft);
    await overwrite();
    await screen.findByText("Definition saved.");
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    expect(onCreateTask).toHaveBeenCalledWith({ scope: "repo", key: "review" });
    expect(screen.getByRole("button", { name: /Revised inspection/ })).toBeTruthy();
    expect(stored[2].source_text).toBe(draft);
  });

  it("invalid source retains its draft, diagnostics and previous saved graph", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    edit("invalid edit");
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    const diagnostics = await screen.findByRole("list", { name: "Validation diagnostics" });
    expect(diagnostics.textContent).toContain("step.outputs");
    expect(diagnostics.textContent).toContain("Line 12");
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", "invalid edit");
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("region", { name: "Review graph" })).toBeTruthy();
    expect(stored[2].source_text).toBe(JSON.stringify(definition));
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
  });

  it("failed persistence does not install a validated draft as the saved graph", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    const draft = JSON.stringify({ ...definition, title: "Not saved" });
    edit(draft);
    mocks.savePlaybookSource.mockRejectedValueOnce("Disk is read-only");
    await overwrite();
    await screen.findByText("Disk is read-only");
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", draft);
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    fireEvent.click(create);
    expect(onCreateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("region", { name: "Review graph" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Not saved graph" })).toBeNull();
  });

  it("shows a save rejection's diagnostics one per line, not the raw result object", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    edit(JSON.stringify({ ...definition, title: "Not saved" }));
    mocks.savePlaybookSource.mockRejectedValueOnce({
      kind: "invalid",
      diagnostics: [
        { code: "invalid_key", message: "playbook key must be a lowercase ASCII slug", line: null, field: "key", severity: "error" },
        { code: "invalid_key", message: "unsafe playbook key 'spec driven development'", line: 3, field: "key", severity: "error" },
      ],
    });
    await overwrite();
    const box = await screen.findByText(/playbook key must be a lowercase ASCII slug/, { selector: ".inline-status-msg" });
    expect(box.textContent).toBe("invalid_key: playbook key must be a lowercase ASCII slug\ninvalid_key: unsafe playbook key 'spec driven development' · line 3");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByText(/playbook key must be a lowercase ASCII slug/, { selector: ".inline-status-msg" })).toBeNull();
  });

  it("requires confirmation for bundled deletion and keeps the definition available after failure", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review Bundled" }));
    await screen.findByRole("region", { name: "Review graph" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    const cancel = await screen.findByText("Cancel", { selector: "button" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    expect(mocks.deletePlaybookSource).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Review graph" })).toBeTruthy();

    mocks.deletePlaybookSource.mockRejectedValueOnce("Disk is read-only");
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByText("Disk is read-only");
    expect(screen.getByRole("region", { name: "Review graph" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("table", { name: "Playbook library" });
    expect(libraryOrder()).toEqual(["global/review", "repo/review"]);
    expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull();
  });

  it("bundled source is read-only and copying creates a distinct writable identity", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review Bundled" }));
    await screen.findByRole("region", { name: "Review graph" });
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("readOnly", true);
    expect(screen.queryByRole("button", { name: "Save definition" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Make a copy to edit" }));
    await screen.findByLabelText("Save key");
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("readOnly", false);
    expect(screen.queryByRole("button", { name: "Create task from this playbook" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.queryByRole("region", { name: "Review graph" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await screen.findByText("Definition saved.");
    expect(stored.map((item) => identity(item.source.reference))).toEqual(["bundled/review", "global/review", "repo/review", "repo/review-copy"]);
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    expect(onCreateTask).toHaveBeenCalledWith({ scope: "repo", key: "review-copy" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(stored).toHaveLength(3));
    expect(stored[0].source_text).toBe(JSON.stringify(definition));
  });

  it("cancelled Back preserves the unsaved buffer and discard returns focus to the library", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    edit("unsaved buffer");
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", "unsaved buffer");
    expect(screen.queryByRole("table", { name: "Playbook library" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText("Search playbooks"));
  });

  it("repository changes retain draft ownership even when save finishes in another repository", async () => {
    const view = render(
      <>
        <Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    edit(JSON.stringify({ ...definition, description: "Draft in A" }));
    view.rerender(
      <>
        <Playbooks repoPath="/repo-b" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    expect(screen.getByText(/This definition belongs to \/repo-a/)).toBeTruthy();
    await overwrite();
    await screen.findByText("Definition saved.");
    expect(mocks.savePlaybookSource).toHaveBeenCalledWith(expect.anything(), "/repo-a");
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    expect(await screen.findByRole("button", { name: "Review Repository" })).toBeTruthy();
  });

  it("preserves pasted source on cancelled overwrite", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste source" }));
    await screen.findByLabelText("Save key");
    const draft = JSON.stringify({ ...definition, description: "Pasted source" });
    edit(draft);
    fireEvent.change(screen.getByLabelText("Save key"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    fireEvent.click(await screen.findByText("Cancel", { selector: "button" }));
    await waitFor(() => expect(screen.getByLabelText("Playbook source")).toHaveProperty("disabled", false));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", draft);
    expect(stored[2].definition.description).toBe("Review work");
  });

  it("retains the chosen pane split across mode and playbook changes", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await openRepo();
    const divider = screen.getByRole("separator", { name: "Resize graph and description" });
    fireEvent.keyDown(divider, { key: "Home" });
    const chosen = divider.getAttribute("aria-valuenow");
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("separator", { name: "Resize graph and description" }).getAttribute("aria-valuenow")).toBe(chosen);
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review Bundled" }));
    await screen.findByRole("button", { name: "Make a copy to edit" });
    expect(screen.getByRole("separator", { name: "Resize graph and description" }).getAttribute("aria-valuenow")).toBe(chosen);
  });
});

describe("repository preferred playbooks", () => {
  it("preserves unreadable preferences until a successful reload, then retains unrelated metadata on change", async () => {
    const saved: PickerPreferences = {
      order: [{ scope: "global", key: "review" }],
      entries: [{ ...preference("global"), badge: "Keep me", color: "#123456", last_imported_at_ms: 1234 }],
    };
    preferencesByRepo.set("/repo", structuredClone(saved));
    const catalog = await mocks.listPlaybookCatalog("/repo");
    mocks.listPlaybookCatalog.mockResolvedValueOnce({
      ...catalog,
      picker_preferences: { order: [], entries: [] },
      diagnostics: [{ code: "picker_preferences", message: "Cannot parse picker.toml", severity: "error" }],
    });
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const checkbox = await screen.findByRole("checkbox", { name: "Preferred for this repo: repo/review" });
    fireEvent.click(checkbox);
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
    expect(preferencesByRepo.get("/repo")).toEqual(saved);
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByRole("button", { name: "Review Repository" })).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
    await waitFor(() => expect(checkbox).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toHaveProperty("checked", true));
    expect(preferencesByRepo.get("/repo")).toEqual({ ...saved, entries: [...saved.entries, preference("repo")] });
  });

  it("persists membership without changing defaults or metadata and keeps nonpreferred and hidden entries searchable", async () => {
    const legacy = { ...preference("global", false), hidden: true, badge: "Imported", color: "#123456", last_imported_at_ms: 1234 };
    const order: PlaybookRef[] = [
      { scope: "repo", key: "unavailable" },
      { scope: "global", key: "review" },
    ];
    preferencesByRepo.set("/repo", { order, entries: [legacy] });
    const view = render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const initialCheckbox = await screen.findByRole("checkbox", { name: "Preferred for this repo: global/review" });
    fireEvent.click(initialCheckbox);
    await waitFor(() => expect(initialCheckbox).toHaveProperty("checked", true));
    expect(preferencesByRepo.get("/repo")?.entries).toEqual([{ ...legacy, preferred: true }]);
    expect(mocks.savePlaybookPickerPreferences).toHaveBeenCalledWith(expect.anything(), "/repo");
    fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "repo/review" } });
    expect(screen.getByRole("button", { name: "Review Repository" })).toBeTruthy();
    expect(preferencesByRepo.get("/repo")?.order).toEqual(order);
    view.unmount();
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const checkbox = await screen.findByRole("checkbox", { name: "Preferred for this repo: global/review" });
    expect(checkbox).toHaveProperty("checked", true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toHaveProperty("checked", false));
    expect(screen.getByRole("button", { name: "Review Global" })).toBeTruthy();
    expect(preferencesByRepo.get("/repo")?.entries).toEqual([legacy]);
    expect(preferencesByRepo.get("/repo")?.order).toEqual(order);
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
    expect(ipc.writeRepoOverridesForRepo).not.toHaveBeenCalled();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
  });

  it("blocks concurrent changes, retains saved membership on failure and allows retry", async () => {
    let rejectSave!: (reason: string) => void;
    mocks.savePlaybookPickerPreferences.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const checkbox = await screen.findByRole("checkbox", { name: "Preferred for this repo: repo/review" });
    fireEvent.click(checkbox);
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByRole("checkbox", { name: "Preferred for this repo: global/review" })).toHaveProperty("disabled", true);
    await act(async () => rejectSave("Read-only repository"));
    await screen.findByText("Read-only repository");
    expect(checkbox).toHaveProperty("checked", false);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toHaveProperty("checked", true));
    expect(screen.queryByText("Read-only repository")).toBeNull();
  });

  it.each(["resolve", "reject"] as const)("ignores a stale save %s after switching repositories and returning", async (outcome) => {
    let resolveSave!: () => void;
    let rejectSave!: (reason: string) => void;
    mocks.savePlaybookPickerPreferences.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveSave = resolve;
          rejectSave = reject;
        }),
    );
    const view = render(<Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Preferred for this repo: repo/review" }));
    view.rerender(<Playbooks repoPath="/repo-b" onCreateTask={onCreateTask} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Preferred for this repo: global/review" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Preferred for this repo: global/review" })).toHaveProperty("checked", true));
    expect(mocks.savePlaybookPickerPreferences).toHaveBeenLastCalledWith(expect.anything(), "/repo-b");
    view.rerender(<Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />);
    await screen.findByRole("checkbox", { name: "Preferred for this repo: repo/review" });
    await act(async () => (outcome === "resolve" ? resolveSave() : rejectSave("Stale repository failure")));
    expect(screen.getByRole("checkbox", { name: "Preferred for this repo: repo/review" })).toHaveProperty("checked", false);
    expect(screen.queryByText("Stale repository failure")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Preferred for this repo: repo/review" })).toHaveProperty("disabled", false);
  });

  it("does not allow preferences to mutate without an explicit repository", async () => {
    render(<Playbooks onCreateTask={onCreateTask} />);
    const checkbox = await screen.findByRole("checkbox", { name: "Preferred for this repo: repo/review" });
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByRole("checkbox", { name: "Preferred only" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("checkbox", { name: "Preferred only" })).toHaveProperty("checked", false);
    expect(checkbox).toHaveProperty("checked", false);
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
  });
});

const NYX_ID = "8c19b367-d20b-4e60-b2ec-df73d8123aa1";
const ADA_ID = "11111111-1111-4111-8111-111111111111";
const publication = (id: string, label: string, version = 3) => ({
  id,
  label,
  playbookKey: "review",
  title: "Review",
  description: "Review a change.",
  defaultHarness: "omp",
  hasCodingStep: false,
  stepCount: 1,
  version,
  bodySha256: "a".repeat(64),
  publishedAt: "2026-09-22T18:04:11Z",
  updatedAt: "2026-09-22T19:10:00Z",
});

function renderLibrary() {
  render(
    <>
      <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
      <ConfirmHost />
    </>,
  );
}

async function openCommunity() {
  fireEvent.click(screen.getByRole("tab", { name: "Community" }));
  return screen.findByRole("table", { name: "Community playbooks" });
}

describe("community playbooks", () => {
  it("keeps local New playbook and file paste import when signed out, and does not publish or browse", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    expect(screen.queryByRole("button", { name: "Publish playbook" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New playbook" }));
    await screen.findByLabelText("Save key");
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste source" }));
    await screen.findByLabelText("Save key");
    expect(community.accountStatus).not.toHaveBeenCalled();
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
    expect(community.communityDownloadStatus).not.toHaveBeenCalled();
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("opens on Local beside Community", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const tabs = screen.getByRole("tablist", { name: "Playbook libraries" });
    expect(within(tabs).getByRole("tab", { name: "Local" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tabs).getByRole("tab", { name: "Community" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("button", { name: "New playbook" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
  });

  it("marks a saved repo import in the local source cell", async () => {
    community.listCommunityImports.mockResolvedValue({
      imports: [{ id: NYX_ID, label: "nyx", playbookKey: "review", localKey: "review", importedVersion: 3 }],
    });
    renderLibrary();
    const row = await screen.findByRole("row", { name: "repo/review" });
    expect(row.textContent).toContain("Repository");
    expect(row.textContent).toContain("Imported from community");
    expect(row.textContent).toContain("nyx/review");
    expect(community.listCommunityImports).toHaveBeenCalledWith({ repoPath: "/repo" });
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
  });

  it("lists two community rows that share a playbook key and hides local import", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({
      playbooks: [publication(NYX_ID, "nyx"), publication(ADA_ID, "ada")],
      nextCursor: null,
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    expect(screen.queryByRole("button", { name: "New playbook" })).toBeNull();
    expect(screen.queryByLabelText("Import local file")).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste source" })).toBeNull();
    expect(within(table).getByText("nyx/review")).toBeTruthy();
    expect(within(table).getByText("ada/review")).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Import nyx/review" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Import ada/review" })).toBeTruthy();
    expect(community.accountStatus).not.toHaveBeenCalled();
  });

  it("opens sign up for a signed-out import and does not download", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Import nyx/review" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    expect(within(dialog).getByRole("button", { name: "SIGN UP" })).toBeTruthy();
    expect(within(dialog).getByText("browse does not need an account. Import, update, and publish do.")).toBeTruthy();
    expect(dialog.querySelector("input[type='password']")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("data-autofocus")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Sign up" })).toBeNull();
  });

  it("opens sign up for a signed-out update and does not download", async () => {
    community.communityDownloadStatus.mockResolvedValue({
      rows: [
        {
          id: NYX_ID,
          label: "nyx",
          playbookKey: "review",
          localKey: "review",
          title: "Review",
          description: "Review a change.",
          importedVersion: 3,
          remoteVersion: 4,
          updateAvailable: true,
          remoteMissing: false,
          localMissing: false,
          locallyEdited: false,
          error: null,
        },
      ],
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update nyx/review" }));
    await screen.findByRole("dialog", { name: "Sign up" });
    expect(community.updateCommunityImport).not.toHaveBeenCalled();
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({});
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalledWith(expect.objectContaining({ q: expect.anything() }));
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: expect.anything() }));
  });

  it("shows a higher remote version as update available without sending q or cursor", async () => {
    community.communityDownloadStatus.mockResolvedValue({
      rows: [
        {
          id: NYX_ID,
          label: "nyx",
          playbookKey: "review",
          localKey: "review",
          title: "Review",
          description: "Review a change.",
          importedVersion: 3,
          remoteVersion: 4,
          updateAvailable: true,
          remoteMissing: false,
          localMissing: false,
          locallyEdited: false,
          error: null,
        },
      ],
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    const table = await screen.findByRole("table", { name: "Community playbooks" });
    expect(table.textContent).toContain("nyx/review");
    expect(table.textContent).toContain("Update available");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({});
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalledWith(expect.objectContaining({ q: expect.anything() }));
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: expect.anything() }));
    expect(community.communityDownloadStatus).toHaveBeenCalledWith({ repoPath: "/repo" });
  });

  it("asks before overwriting an edited local copy and retries only after accept", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.communityDownloadStatus.mockResolvedValue({
      rows: [
        {
          id: NYX_ID,
          label: "nyx",
          playbookKey: "review",
          localKey: "review",
          title: "Review",
          description: "Review a change.",
          importedVersion: 3,
          remoteVersion: 4,
          updateAvailable: true,
          remoteMissing: false,
          localMissing: false,
          locallyEdited: true,
          error: null,
        },
      ],
    });
    community.updateCommunityImport.mockResolvedValueOnce({ kind: "edited" });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update nyx/review" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(1));
    expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false });
    fireEvent.click(await screen.findByText("Cancel", { selector: "button.btn" }));
    expect(community.updateCommunityImport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Update nyx/review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(2));
    expect(community.updateCommunityImport).toHaveBeenLastCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: true });
  });

  it("keeps a dirty local editor when discard is cancelled, then shows Community after discard", async () => {
    renderLibrary();
    await openRepo();
    edit("unsaved buffer");
    fireEvent.click(screen.getByRole("tab", { name: "Community" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", "unsaved buffer");
    expect(screen.getByRole("tab", { name: "Local" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("table", { name: "Community playbooks" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Community" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull());
    expect(screen.getByRole("tab", { name: "Community" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull();
  });

  it("sends the previous cursor from Load more", async () => {
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: "opaque,cursor" });
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(ADA_ID, "ada")], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({ cursor: "opaque,cursor" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("sends the current query with Load more", async () => {
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: "opaque,cursor" });
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(ADA_ID, "ada")], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText("Search community playbooks"), { target: { value: " review " } });
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({ q: "review" });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(community.listCommunityPlaybooks).toHaveBeenLastCalledWith({ q: "review", cursor: "opaque,cursor" }));
  });

  it("does not send a query longer than 80 characters", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    vi.useFakeTimers();
    try {
      community.listCommunityPlaybooks.mockClear();
      fireEvent.change(screen.getByLabelText("Search community playbooks"), { target: { value: `  ${"q".repeat(81)}  ` } });
      await vi.advanceTimersByTimeAsync(300);
      expect(screen.getByText("Invalid query.")).toBeTruthy();
      expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens sign up for signed-out publish and does not publish", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.publishCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("keeps publish confirm disabled until a row and the attest box are set", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Review Repository" }));
    expect(confirm).toHaveProperty("disabled", false);
  });

  it("publishes the picked reference without a label, title, key, or version", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    community.publishCommunityPlaybook.mockResolvedValue({ kind: "saved", id: NYX_ID, label: "nyx", playbookKey: "review", title: "Review", description: "", version: 1 });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Review Repository" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(1));
    const payload = community.publishCommunityPlaybook.mock.calls[0][0];
    expect(payload).toEqual({ reference: { scope: "repo", key: "review" }, repoPath: "/repo" });
    expect(payload).not.toHaveProperty("label");
    expect(payload).not.toHaveProperty("title");
    expect(payload).not.toHaveProperty("key");
    expect(payload).not.toHaveProperty("version");
  });

  it("retries label_required only after a valid slug", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "label_required" });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Review Global" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const label = await within(dialog).findByLabelText("Public label");
    fireEvent.change(label, { target: { value: "No" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(1);
    fireEvent.change(label, { target: { value: "nyx" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(2));
    expect(community.publishCommunityPlaybook).toHaveBeenLastCalledWith({
      reference: { scope: "global", key: "review" },
      repoPath: "/repo",
      label: "nyx",
    });
  });

  it("disables confirm and states the rule while the public label is not a slug", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "label_required" });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Review Repository" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const label = await within(dialog).findByLabelText("Public label");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(within(dialog).getByText("Label must be a lowercase slug, 2 to 32 characters, like spec-driven-development.")).toBeTruthy();
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(label, { target: { value: "Spec Driven Development" } });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(confirm);
    expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(1);
    fireEvent.change(label, { target: { value: "spec-driven-development" } });
    expect(confirm).toHaveProperty("disabled", false);
    expect(within(dialog).queryByText(/lowercase slug/)).toBeNull();
  });

  it("previews a published playbook beside import", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.previewCommunityPlaybook.mockResolvedValue({ kind: "loaded", source: '+++\nversion = 2\nkey = "review"\n+++' });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Preview nyx/review" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview nyx/review" });
    expect(community.previewCommunityPlaybook).toHaveBeenCalledWith({ id: NYX_ID });
    expect(within(dialog).getByText(/key = "review"/)).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Import nyx/review" })).toBeTruthy();
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("gates preview behind sign up when signed out", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Preview nyx/review" }));
    await screen.findByRole("dialog", { name: "Sign up" });
    expect(community.previewCommunityPlaybook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Preview nyx/review" })).toBeNull();
  });

  it("shows a preview failure inside the dialog", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.previewCommunityPlaybook.mockResolvedValue({ kind: "failed", message: "Playbook not found." });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Preview nyx/review" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview nyx/review" });
    expect(await within(dialog).findByText("Playbook not found.")).toBeTruthy();
    expect(within(dialog).queryByText(/version = 2/)).toBeNull();
  });

  it("offers preview beside update only when an update is available", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.communityDownloadStatus.mockResolvedValue({
      rows: [
        {
          id: NYX_ID,
          label: "nyx",
          playbookKey: "review",
          localKey: "review",
          title: "Review",
          description: "Review a change.",
          importedVersion: 3,
          remoteVersion: 4,
          updateAvailable: true,
          remoteMissing: false,
          localMissing: false,
          locallyEdited: false,
          error: null,
        },
        {
          id: ADA_ID,
          label: "ada",
          playbookKey: "review",
          localKey: "review-copy",
          title: "Review",
          description: "Review a change.",
          importedVersion: 4,
          remoteVersion: 4,
          updateAvailable: false,
          remoteMissing: false,
          localMissing: false,
          locallyEdited: false,
          error: null,
        },
      ],
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    expect(await screen.findByRole("button", { name: "Preview nyx/review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update nyx/review" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Preview ada/review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Update ada/review" })).toHaveProperty("disabled", true);
  });

  it("calls update once when the local hash still matches", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.communityDownloadStatus.mockResolvedValue({
      rows: [
        {
          id: NYX_ID,
          label: "nyx",
          playbookKey: "review",
          localKey: "review",
          title: "Review",
          description: "Review a change.",
          importedVersion: 3,
          remoteVersion: 4,
          updateAvailable: true,
          remoteMissing: false,
          localMissing: false,
          locallyEdited: false,
          error: null,
        },
      ],
    });
    community.updateCommunityImport.mockResolvedValue({ kind: "saved", reference: { scope: "repo", key: "review" }, importedVersion: 4, localSha256: "b".repeat(64) });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update nyx/review" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(1));
    expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false });
    expect(screen.queryByRole("heading", { name: "Overwrite local copy?" })).toBeNull();
  });

  it("offers only the user's own playbooks to publish", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    expect(within(dialog).getByText("These are playbooks you've made locally.")).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Review Repository" })).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Review Global" })).toBeTruthy();
    expect(within(dialog).queryByRole("radio", { name: "Review Bundled" })).toBeNull();
  });

  it("searches the user's own playbooks and reports no matches", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    const search = within(dialog).getByLabelText("Search your playbooks");
    fireEvent.change(search, { target: { value: "global" } });
    expect(within(dialog).queryByRole("radio", { name: "Review Repository" })).toBeNull();
    expect(within(dialog).getByRole("radio", { name: "Review Global" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "nothing" } });
    expect(within(dialog).getByText('No playbooks match "nothing".')).toBeTruthy();
  });

  it("will not confirm a pick the search has filtered out", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Review Repository" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toHaveProperty("disabled", false);
    fireEvent.change(within(dialog).getByLabelText("Search your playbooks"), { target: { value: "global" } });
    expect(confirm).toHaveProperty("disabled", true);
  });

  it("asks for a local playbook first when the user has made none", async () => {
    stored = [entry("bundled")];
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Bundled" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    expect(within(dialog).getByText("You haven't created a playbook yet. Create one in Local before publishing.")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Search your playbooks")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", true);
  });
});
