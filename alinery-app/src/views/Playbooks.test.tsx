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
  accountCancelSignIn: vi.fn(),
  listCommunityImports: vi.fn(),
  listCommunityPlaybooks: vi.fn(),
  communityDownloadStatus: vi.fn(),
  importCommunityPlaybook: vi.fn(),
  updateCommunityImport: vi.fn(),
  previewCommunityPlaybook: vi.fn(),
  publishCommunityPlaybook: vi.fn(),
  listMyCommunityPlaybooks: vi.fn(),
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
        diagnostics: [
          { code: "overlapping_outputs", message: "inspect output findings-*.md overlaps build output findings-summary.md", line: 12, field: "step.outputs", severity: "error" },
        ],
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
  community.accountCancelSignIn.mockResolvedValue(undefined);
  community.listCommunityImports.mockResolvedValue({ imports: [] });
  community.listCommunityPlaybooks.mockReset();
  community.communityDownloadStatus.mockReset();
  community.importCommunityPlaybook.mockReset();
  community.updateCommunityImport.mockReset();
  community.publishCommunityPlaybook.mockReset();
  community.listMyCommunityPlaybooks.mockResolvedValue({ kind: "loaded", playbooks: [], truncated: false });
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
/** A promise the test resolves by hand. The class form holds the resolver because the app
 *  targets ES2020 — `Promise.withResolvers` is not available here. */
class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }
  resolve(value: T): void {
    this.#resolve(value);
  }
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
    fireEvent.click(await screen.findByRole("button", { name: "Keep Save key" }));
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

describe("new playbook key choice", () => {
  const source = `+++
version = 2
key = "solution-exploration"
title = "Solution Exploration"
description = ""
default_model = ""
default_harness = ""
[[step]]
key = "run"
title = "Run"
short = ""
is_coding_step = false
auto_advance_default = false
inputs = [{path = "ticket.md", mode = "single"}]
outputs = [{path = "result.md"}]
model = ""
harness = ""
+++
Preamble
<!-- alinery:step run -->
Read {{TICKET_FILE}}.
`;
  const parsed: NormalizedPlaybook = {
    version: 2,
    key: "solution-exploration",
    title: "Solution Exploration",
    description: "",
    default_model: "",
    default_harness: "",
    preamble: "Preamble\n",
    section_order: ["run"],
    step: [
      {
        key: "run",
        title: "Run",
        short: "",
        is_coding_step: false,
        auto_advance_default: false,
        inputs: [{ path: "ticket.md", mode: "single" }],
        outputs: [{ path: "result.md" }],
        model: "",
        harness: "",
        prompt: "Read {{TICKET_FILE}}.\n",
      },
    ],
  };
  const destinationSource = source.replace('key = "solution-exploration"', 'key = "new-playbook"');
  const fileSource = source.replace('key = "solution-exploration"', 'key = "imported-original"');
  const fixtures = new Map([
    [source, parsed],
    [destinationSource, { ...parsed, key: "new-playbook" }],
    [fileSource, { ...parsed, key: "imported-original" }],
  ]);

  beforeEach(() => {
    // These explicit IPC responses are not a TOML parser. The same source is checked
    // with the real core parser separately; unrelated suite fixtures remain JSON.
    const validate = mocks.validatePlaybookSource.getMockImplementation();
    const renderSource = mocks.renderPlaybookSource.getMockImplementation();
    const save = mocks.savePlaybookSource.getMockImplementation();
    if (!validate || !renderSource || !save) throw new Error("Missing base IPC fixtures");
    mocks.validatePlaybookSource.mockImplementation(async (text: string) =>
      fixtures.has(text) ? { definition: structuredClone(fixtures.get(text)), diagnostics: [] } : validate(text),
    );
    mocks.renderPlaybookSource.mockImplementation(async (value: NormalizedPlaybook) => {
      for (const [text, fixture] of fixtures) {
        if (JSON.stringify(value) === JSON.stringify(fixture)) return text;
      }
      return renderSource(value);
    });
    mocks.savePlaybookSource.mockImplementation(async (request: SavePlaybookRequest) => {
      const fixture = fixtures.get(request.source);
      if (!fixture) return save(request);
      if (fixture.key !== request.target.key) throw new Error("Document and library key disagree");
      const saved = await save({ ...request, source: JSON.stringify(fixture) });
      saved.source_text = request.source;
      return saved;
    });
  });

  function mount(host = true) {
    return render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        {host && <ConfirmHost />}
      </>,
    );
  }
  async function newDraft(host = true) {
    mount(host);
    fireEvent.click(screen.getByRole("button", { name: "New playbook" }));
    await screen.findByLabelText("Save key");
    await waitFor(() => expect(screen.getByLabelText("Playbook source")).toHaveProperty("disabled", false));
    edit(source);
  }
  async function keyDialog() {
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    return screen.findByRole("alertdialog", { name: "Choose playbook key" });
  }
  async function retainedDraft(key = "new-playbook", scope = "repo") {
    await waitFor(() => expect(screen.getByLabelText("Playbook source")).toHaveProperty("disabled", false));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", source);
    expect(screen.getByLabelText("Save key")).toHaveProperty("value", key);
    expect(screen.getByLabelText("Save scope")).toHaveProperty("value", scope);
  }
  async function installed(scope: PlaybookRef["scope"], key: string, text: string) {
    const create = await screen.findByRole("button", { name: "Create task from this playbook" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", text);
    fireEvent.click(create);
    expect(onCreateTask).toHaveBeenLastCalledWith({ scope, key });
    expect(stored.find((item) => identity(item.source.reference) === `${scope}/${key}`)?.definition.key).toBe(key);
  }

  it("waits for an explicit choice, then installs the document identity", async () => {
    await newDraft();
    const dialog = await keyDialog();
    expect(dialog.textContent).toContain("solution-exploration");
    expect(dialog.textContent).toContain("new-playbook");
    expect(dialog.textContent).toMatch(/repository/i);
    expect(dialog.textContent).toContain("/repo");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByText("Cancel", { selector: "button" })));
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Save key").matches(":disabled")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Use document key" }));
    await installed("repo", "solution-exploration", source);
  });

  it("keeps an acknowledged Save key in Global scope", async () => {
    await newDraft();
    const originals = structuredClone(stored);
    fireEvent.change(screen.getByLabelText("Save scope"), { target: { value: "global" } });
    const dialog = await keyDialog();
    expect(dialog.textContent).toMatch(/global/i);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep Save key" }));
    await installed("global", "new-playbook", destinationSource);
    expect(stored.slice(0, originals.length)).toEqual(originals);
  });

  it.each(["Cancel", "close", "cancel event"] as const)("retains the draft on %s and asks again on retry", async (dismissal) => {
    await newDraft();
    const dialog = await keyDialog();
    if (dismissal === "Cancel") fireEvent.click(within(dialog).getByText("Cancel", { selector: "button" }));
    else if (dismissal === "close") fireEvent.click(within(dialog).getByLabelText("Cancel"));
    else fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
    await retainedDraft();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    const retry = await keyDialog();
    fireEvent.click(within(retry).getByText("Cancel", { selector: "button" }));
    await retainedDraft();
  });

  it("does not save a mismatch without a confirmation host", async () => {
    await newDraft(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save definition" })));
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    await retainedDraft();
  });

  it("checks the chosen document target for overwrite and preserves a cancelled paste", async () => {
    stored.push(entry("repo", { ...parsed, title: "Original target" }));
    const before = structuredClone(stored);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste source" }));
    await screen.findByLabelText("Save key");
    edit(source);
    const choice = await keyDialog();
    expect(within(choice).getByRole("status").textContent).toContain("repo/solution-exploration");
    fireEvent.click(within(choice).getByRole("button", { name: "Overwrite existing playbook" }));
    const collision = await screen.findByRole("alertdialog", { name: "Overwrite repo/solution-exploration?" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    fireEvent.click(within(collision).getByText("Cancel", { selector: "button" }));
    await retainedDraft("imported-playbook");
    expect(stored).toEqual(before);
    fireEvent.click(within(await keyDialog()).getByRole("button", { name: "Overwrite existing playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await installed("repo", "solution-exploration", source);
    expect(stored.filter((item) => item.definition.key !== parsed.key)).toEqual(before.filter((item) => item.definition.key !== parsed.key));
  });

  it("imports a file then saves a changed document key globally without overwriting its repository peer", async () => {
    stored.push(entry("repo", parsed));
    const original = structuredClone(stored);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const file = new File([fileSource], "playbook.md", { type: "text/markdown" });
    // jsdom has no File.text(); the browser file-read boundary returns these bytes.
    Object.defineProperty(file, "text", { value: async () => fileSource });
    fireEvent.change(screen.getByLabelText("Import local file"), { target: { files: [file] } });
    await screen.findByLabelText("Save key");
    expect(screen.getByLabelText("Save key")).toHaveProperty("value", "imported-original");
    edit(source);
    fireEvent.change(screen.getByLabelText("Save scope"), { target: { value: "global" } });
    const choice = await keyDialog();
    expect(within(choice).queryByRole("status")).toBeNull();
    fireEvent.click(within(choice).getByRole("button", { name: "Use document key" }));
    await installed("global", "solution-exploration", source);
    expect(stored.slice(0, original.length)).toEqual(original);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("warns about a conflicting Save key before choosing and still requires overwrite", async () => {
    await newDraft();
    stored.push(entry("global", { ...parsed, key: "new-playbook", title: "Existing destination" }), entry("repo", parsed));
    const before = structuredClone(stored);
    fireEvent.change(screen.getByLabelText("Save scope"), { target: { value: "global" } });
    const choice = await keyDialog();
    const warning = within(choice).getByRole("status");
    expect(warning.textContent).toContain("global/new-playbook");
    expect(warning.textContent).not.toContain("repo/solution-exploration");
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    fireEvent.click(within(choice).getByRole("button", { name: "Overwrite existing playbook" }));
    const collision = await screen.findByRole("alertdialog", { name: "Overwrite global/new-playbook?" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    fireEvent.click(within(collision).getByText("Cancel", { selector: "button" }));
    await retainedDraft("new-playbook", "global");
    expect(stored).toEqual(before);
    fireEvent.click(within(await keyDialog()).getByRole("button", { name: "Overwrite existing playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await installed("global", "new-playbook", destinationSource);
    expect(stored.filter((item) => identity(item.source.reference) !== "global/new-playbook")).toEqual(
      before.filter((item) => identity(item.source.reference) !== "global/new-playbook"),
    );
  });

  it("rechecks for a conflict created while the key choice is open", async () => {
    await newDraft();
    const choice = await keyDialog();
    expect(within(choice).queryByRole("status")).toBeNull();
    stored.push(entry("repo", parsed));
    fireEvent.click(within(choice).getByRole("button", { name: "Use document key" }));
    const collision = await screen.findByRole("alertdialog", { name: "Overwrite repo/solution-exploration?" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    fireEvent.click(within(collision).getByText("Cancel", { selector: "button" }));
    await retainedDraft();
  });

  it("retains the draft when checking key conflicts fails", async () => {
    await newDraft();
    mocks.listPlaybookCatalog.mockRejectedValueOnce("Cannot check existing keys");
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await screen.findByText("Cannot check existing keys");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    await retainedDraft();
  });

  it("retains the draft after a chosen document key encounters a storage conflict", async () => {
    await newDraft();
    const before = structuredClone(stored);
    mocks.savePlaybookSource.mockRejectedValueOnce({
      kind: "conflict",
      source: { reference: { scope: "repo", key: parsed.key }, path: `/repo/.alinery/playbooks/${parsed.key}/playbook.md` },
    });
    fireEvent.click(within(await keyDialog()).getByRole("button", { name: "Use document key" }));
    await screen.findByText(/conflict/, { selector: ".inline-status-msg" });
    await retainedDraft();
    expect(stored).toEqual(before);
    fireEvent.click(within(await keyDialog()).getByText("Cancel", { selector: "button" }));
    await retainedDraft();
  });

  it("retains the draft when rendering the acknowledged destination fails", async () => {
    await newDraft();
    mocks.renderPlaybookSource.mockRejectedValueOnce("Cannot render definition");
    fireEvent.click(within(await keyDialog()).getByRole("button", { name: "Keep Save key" }));
    await screen.findByText("Cannot render definition");
    await retainedDraft();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
  });

  it("saves matching new keys without asking for a key choice", async () => {
    await newDraft();
    fireEvent.change(screen.getByLabelText("Save key"), { target: { value: parsed.key } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await installed("repo", parsed.key, source);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("keeps explicit validation separate and refuses invalid source before any choice", async () => {
    await newDraft();
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText("Definition is valid. Not saved.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    edit("+++ invalid unfinished source");
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await screen.findByRole("list", { name: "Validation diagnostics" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", "+++ invalid unfinished source");
  });

  it("rejects a saved-entry rename rather than offering the new-draft key choice", async () => {
    mount();
    await openRepo();
    const before = structuredClone(stored);
    edit(source);
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await screen.findByText(/Use Make a copy to save under another key/);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(stored).toEqual(before);
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", source);
  });

  it("still requires overwrite authorization when a saved copy chooses its original document key", async () => {
    mount();
    await openRepo();
    const before = structuredClone(stored);
    fireEvent.click(screen.getByRole("button", { name: "Make a copy" }));
    await screen.findByLabelText("Save key");
    expect(screen.getByLabelText("Save key")).toHaveProperty("value", "review-copy");
    fireEvent.click(within(await keyDialog()).getByRole("button", { name: "Overwrite existing playbook" }));
    const collision = await screen.findByRole("alertdialog", { name: "Overwrite repo/review?" });
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    fireEvent.click(within(collision).getByText("Cancel", { selector: "button" }));
    await waitFor(() => expect(screen.getByLabelText("Playbook source")).toHaveProperty("disabled", false));
    expect(screen.getByLabelText("Save key")).toHaveProperty("value", "review-copy");
    expect(stored).toEqual(before);
  });

  it("keeps an unsaved draft in its captured repository after the visible repository changes", async () => {
    const libraries: Record<string, ScopedPlaybook[]> = {
      "/repo-a": [entry("repo", { key: "only-a", title: "Only A" })],
      "/repo-b": [entry("repo", { key: "only-b", title: "Only B" })],
    };
    mocks.listPlaybookCatalog.mockImplementation(async (owner: string) => ({
      candidates: libraries[owner].map((item) => ({
        source: item.source,
        title: item.definition.title,
        description: item.definition.description,
        modified_at_ms: item.modified_at_ms,
        diagnostics: [],
      })),
      picker_preferences: { order: [], entries: [] },
      diagnostics: [],
    }));
    mocks.savePlaybookSource.mockImplementation(async (request: SavePlaybookRequest, owner: string) => {
      const value = fixtures.get(request.source);
      if (!value || value.key !== request.target.key || request.target.scope !== "repo") throw new Error("Unexpected save");
      const saved = { ...entry("repo", value), source_text: request.source };
      libraries[owner].push(saved);
      return saved;
    });
    const view = render(
      <>
        <Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "New playbook" }));
    await screen.findByLabelText("Save key");
    edit(source);
    view.rerender(
      <>
        <Playbooks repoPath="/repo-b" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    const dialog = await keyDialog();
    expect(dialog.textContent).toContain("/repo-a");
    expect(dialog.textContent).not.toContain("/repo-b");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use document key" }));
    const create = await screen.findByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    await waitFor(() => expect(screen.getByLabelText("Playbook source")).toHaveProperty("disabled", false));
    expect(libraries["/repo-a"].map((item) => item.definition.key)).toEqual(["only-a", "solution-exploration"]);
    expect(libraries["/repo-b"].map((item) => item.definition.key)).toEqual(["only-b"]);
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", source);
    fireEvent.click(screen.getByRole("button", { name: "Back to playbooks" }));
    expect(await screen.findByRole("button", { name: "Only B Repository" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Solution Exploration Repository" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Only A Repository" })).toBeNull();
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

async function openRowPublish(buttonName: string) {
  await openCommunity();
  fireEvent.click(screen.getByRole("button", { name: "My Playbooks" }));
  fireEvent.click(await screen.findByRole("button", { name: buttonName }));
  return screen.findByRole("dialog", { name: "Publish playbook" });
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
    expect(within(tabs).getByRole("tab", { name: "Local" }).classList.contains("on")).toBe(true);
    expect(within(tabs).getByRole("tab", { name: "Community" }).getAttribute("aria-selected")).toBe("false");
    expect(within(tabs).getByRole("tab", { name: "Community" }).classList.contains("on")).toBe(false);
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
    expect(screen.queryByRole("columnheader", { name: "Author" })).toBeNull();
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
    expect(within(table).getAllByText("review", { selector: ".playbooks-identity small" }).length).toBe(2);
    expect(within(table).getAllByText("Review", { selector: ".playbooks-identity span" }).length).toBe(2);
    expect(within(table).queryByText("nyx/review")).toBeNull();
    expect(within(table).getByRole("button", { name: "Download nyx/review" })).toBeTruthy();
    expect(within(table).getByRole("button", { name: "Download ada/review" })).toBeTruthy();
    expect(within(table).queryByRole("columnheader", { name: "Author" })).toBeNull();
    expect(community.listMyCommunityPlaybooks).not.toHaveBeenCalled();
  });

  it("opens sign up for a signed-out import and does not download", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Download nyx/review" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    expect(within(dialog).getByRole("button", { name: "SIGN UP" })).toBeTruthy();
    expect(within(dialog).getByText("To View, Download, or Publish playbooks you need an account. Sign up for free now.")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Download update nyx/review" }));
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
    expect(within(table).getByText("review", { selector: ".playbooks-identity small" })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Download update nyx/review" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(1));
    expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false });
    fireEvent.click(await screen.findByText("Cancel", { selector: "button.btn" }));
    expect(community.updateCommunityImport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Download update nyx/review" }));
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
    expect(screen.getByRole("tab", { name: "Community" }).classList.contains("on")).toBe(true);
    expect(screen.getByRole("tab", { name: "Local" }).classList.contains("on")).toBe(false);
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
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "My Playbooks" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish Repository review" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.publishCommunityPlaybook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Publish playbook" })).toBeNull();
  });

  it("keeps publish confirm disabled until the share box is checked", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const dialog = await openRowPublish("Publish Repository review");
    expect(within(dialog).getByText("review")).toBeTruthy();
    expect(within(dialog).getByText("Review")).toBeTruthy();
    expect(within(dialog).getByText("Not published → 1")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    expect(confirm).toHaveProperty("disabled", false);
  });

  it("publishes the row reference without a label, title, key, or version", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.publishCommunityPlaybook.mockResolvedValue({ kind: "saved", id: NYX_ID, label: "nyx", playbookKey: "review", title: "Review", description: "", version: 1 });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const dialog = await openRowPublish("Publish Repository review");
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

  it("shows the current and next version before a force update", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listMyCommunityPlaybooks.mockResolvedValue({ kind: "loaded", playbooks: [publication(NYX_ID, "nyx", 3)], truncated: false });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const dialog = await openRowPublish("Update Repository review");
    expect(within(dialog).getByText("review")).toBeTruthy();
    expect(within(dialog).getByText("Review")).toBeTruthy();
    expect(within(dialog).getByText("3 → 4")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", true);
  });

  it("retries label_required only after a valid slug", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "label_required" });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const dialog = await openRowPublish("Publish Global review");
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
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "label_required" });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const dialog = await openRowPublish("Publish Repository review");
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
    expect(within(table).getByRole("button", { name: "Download nyx/review" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Download update nyx/review" })).toHaveProperty("disabled", false);
    expect(screen.queryByRole("button", { name: "Preview ada/review" })).toBeNull();
    expect(screen.getByRole("button", { name: "Downloaded ada/review" })).toHaveProperty("disabled", true);
  });

  it("does not let a post-action reload from the previous repository land", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    const imported = new Deferred<unknown>();
    community.importCommunityPlaybook.mockImplementationOnce(() => imported.promise);
    const lateReload = new Deferred<unknown>();
    let repoLoads = 0;
    community.listCommunityImports.mockImplementation((args: { repoPath: string }) => {
      if (args.repoPath !== "/repo") return Promise.resolve({ imports: [] });
      repoLoads += 1;
      // The first load is this repo's mount read; the next is the one the import triggers.
      if (repoLoads === 1) return Promise.resolve({ imports: [] });
      return lateReload.promise;
    });
    const { rerender } = render(
      <>
        <Playbooks repoPath="/repo" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Download nyx/review" }));
    rerender(
      <>
        <Playbooks repoPath="/other" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await act(async () => imported.resolve({ kind: "saved", reference: { scope: "repo", key: "review" }, importedVersion: 1, localSha256: "a".repeat(64) }));
    // The other repository has no import of this publication, and its own load has finished.
    await act(async () => lateReload.resolve({ imports: [{ id: NYX_ID, label: "nyx", playbookKey: "review", localKey: "review", importedVersion: 1 }] }));
    expect(within(table).getByRole("button", { name: "Download nyx/review" })).toBeTruthy();
    expect(within(table).queryByText("Downloaded")).toBeNull();
  });

  it("does not offer load more with a cursor that belongs to another query", async () => {
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: "page-1-cursor" });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    expect(await screen.findByRole("button", { name: "Load more" })).toBeTruthy();
    vi.useFakeTimers();
    try {
      community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(ADA_ID, "ada")], nextCursor: "page-2-cursor" });
      fireEvent.change(screen.getByLabelText("Search community playbooks"), { target: { value: "ada" } });
      // The debounce has not fired: the cursor on screen was minted by the empty query.
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    expect(community.listCommunityPlaybooks).toHaveBeenLastCalledWith({ q: "ada" });
    expect(await screen.findByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("cancels the pairing this dialog started when it is dismissed", async () => {
    const signIn = new Deferred<unknown>();
    community.accountSignIn.mockImplementationOnce(() => signIn.promise);
    community.accountRefresh.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const table = await openCommunity();
    fireEvent.click(within(table).getByRole("button", { name: "Download nyx/review" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(dialog).getByRole("button", { name: "SIGN UP" }));
    await waitFor(() => expect(community.accountSignIn).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole("button", { name: "SIGN UP" })).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(community.accountCancelSignIn).toHaveBeenCalledTimes(1));
    // The cancelled pairing completing late must not continue the import it was opened for.
    await act(async () => signIn.resolve({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false }));
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Sign up" })).toBeNull();
  });

  it("keeps the publish dialog and its label field across reauthentication", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "needs_account" }).mockResolvedValueOnce({ kind: "label_required" });
    community.accountSignIn.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.accountRefresh.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    const publish = await openRowPublish("Publish Repository review");
    fireEvent.click(within(publish).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(publish).getByRole("button", { name: "Confirm" }));
    const signup = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(signup).getByRole("button", { name: "SIGN UP" }));
    expect(await within(publish).findByLabelText("Public label")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Publish playbook" })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Download update nyx/review" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(1));
    expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false });
    expect(screen.queryByRole("heading", { name: "Overwrite local copy?" })).toBeNull();
  });

  it("asks to sign in before listing published playbooks", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "My Playbooks" }));
    expect(await screen.findByText("Sign in to see playbooks you published.")).toBeTruthy();
    expect(community.listMyCommunityPlaybooks).not.toHaveBeenCalled();
  });

  it("stacks the key over the playbook name and keeps download update an icon button", async () => {
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({
      playbooks: [publication(NYX_ID, "nyx", 4), publication(ADA_ID, "ada")],
      nextCursor: null,
    });
    community.listCommunityImports.mockResolvedValue({
      imports: [{ id: NYX_ID, label: "nyx", playbookKey: "review", localKey: "review", importedVersion: 3 }],
    });
    community.listMyCommunityPlaybooks.mockResolvedValue({
      kind: "loaded",
      playbooks: [publication(NYX_ID, "nyx", 4)],
      truncated: false,
    });
    community.updateCommunityImport.mockResolvedValue({ kind: "saved", reference: { scope: "repo", key: "review" }, importedVersion: 4, localSha256: "a".repeat(64) });
    renderLibrary();
    const table = await openCommunity();
    expect(within(table).queryByRole("columnheader", { name: "Author" })).toBeNull();
    const identity = within(table).getAllByText("review", { selector: ".playbooks-identity small" })[0]?.parentElement;
    expect(identity?.textContent).toContain("Review");
    const update = within(table).getByRole("button", { name: "Download update nyx/review" });
    expect(update.textContent).toBe("");
    fireEvent.click(update);
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false }));
  });

  it("lists published and unpublished playbooks and pushes the saved local file", async () => {
    stored.push(entry("repo", { key: "notes", title: "Notes" }));
    community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listMyCommunityPlaybooks.mockResolvedValue({
      kind: "loaded",
      playbooks: [publication(NYX_ID, "nyx", 2)],
      truncated: false,
    });
    community.publishCommunityPlaybook.mockResolvedValue({
      kind: "saved",
      id: NYX_ID,
      label: "nyx",
      playbookKey: "review",
      title: "Review",
      description: "",
      version: 3,
    });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "My Playbooks" }));
    const table = await screen.findByRole("table", { name: "Community playbooks" });
    expect(within(table).getByRole("columnheader", { name: "Local" })).toBeTruthy();
    expect(within(table).getByText("Not published")).toBeTruthy();
    const publishNotes = within(table).getByRole("button", { name: "Publish Repository notes" });
    expect(publishNotes.textContent).toBe("Publish");
    expect(within(table).queryByRole("button", { name: "Update Bundled review" })).toBeNull();
    fireEvent.click(within(table).getByRole("button", { name: "Update Repository review" }));
    const dialog = await screen.findByRole("dialog", { name: "Publish playbook" });
    expect(within(dialog).getByText("2 → 3")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(1));
    expect(community.publishCommunityPlaybook).toHaveBeenCalledWith({ reference: { scope: "repo", key: "review" }, repoPath: "/repo" });
  });

  it("shows a placeholder when a community list has no rows", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    community.communityDownloadStatus.mockResolvedValue({ rows: [] });
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    expect(await screen.findByText("No playbooks found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Downloaded" }));
    expect(await screen.findByText("No playbooks found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "My Playbooks" }));
    expect(screen.queryByText("No playbooks found")).toBeNull();
  });

  it("opens My Playbooks and explains that publish is on this list", async () => {
    renderLibrary();
    await screen.findByRole("button", { name: "Review Repository" });
    await openCommunity();
    fireEvent.click(screen.getByRole("button", { name: "Publish playbook" }));
    expect(screen.getByRole("button", { name: "My Playbooks" }).getAttribute("aria-pressed")).toBe("true");
    const dialog = await screen.findByRole("dialog", { name: "Publish a playbook" });
    expect(within(dialog).getByText("You can publish any playbook you've made here.")).toBeTruthy();
    fireEvent.click(dialog.querySelector("button.btn") as HTMLButtonElement);
    expect(screen.queryByRole("dialog", { name: "Publish a playbook" })).toBeNull();
    expect(screen.getByRole("button", { name: "My Playbooks" }).getAttribute("aria-pressed")).toBe("true");
  });
});
