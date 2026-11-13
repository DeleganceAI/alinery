import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../confirm";
import * as ipc from "../ipc";
import type * as IpcFixtures from "../test/mockIpc";
import { fakeSettings } from "../test/settingsHooks";
import type { NormalizedPlaybook, PickerPreference, PickerPreferences, PlaybookCatalog, PlaybookRef, SavePlaybookRequest, ScopedPlaybook } from "../types";

vi.mock("../sync/settings", async (actual) => (await import("../test/settingsHooks")).settingsHooks(await actual()));

import { sha256Hex } from "../playbookLibrary";
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
  return mockIpc({ ...community });
});
// The registry and the import rules are the repository's daemon (sync/community); the network half stays on `ipc`.
vi.mock("../sync/community", () => community);
// The playbook library is the daemon's PlaybookService (sync/playbooks), not ipc.
vi.mock("../sync/playbooks", async (actual) => ({ ...(await actual<typeof import("../sync/playbooks")>()), ...mocks }));
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
  community.communityDownloadStatus.mockResolvedValue({ rows: [] });
  community.importCommunityPlaybook.mockReset();
  community.updateCommunityImport.mockReset();
  community.publishCommunityPlaybook.mockReset();
  community.listMyCommunityPlaybooks.mockResolvedValue({ kind: "loaded", playbooks: [], truncated: false });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A library row's main button; its list item is named by the playbook's `scope/key`. */
async function rowButton(id: string) {
  return within(await screen.findByRole("listitem", { name: id })).getAllByRole("button")[0];
}
/** A click selects a row for the inspector; a double-click opens it. */
async function openRow(id: string) {
  fireEvent.doubleClick(await rowButton(id));
}
/** Opens repo/review on its Graph view, where the definition tests read the saved steps. */
async function openRepo() {
  await openRow("repo/review");
  fireEvent.click(await screen.findByRole("button", { name: "Graph" }));
  await screen.findByRole("region", { name: "Review graph" });
}
function edit(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "Source" }));
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
  return within(screen.getByRole("list", { name: "Playbook library" }))
    .queryAllByRole("listitem")
    .map((row) => row.getAttribute("aria-label"));
}

const railButton = (name: string | RegExp) => within(screen.getByRole("navigation", { name: "Library views" })).getByRole("button", { name });
const inspector = () => screen.getByRole("complementary", { name: "Inspector" });
async function inspect(id: string) {
  fireEvent.click(await rowButton(id));
  return inspector();
}

describe("playbook library", () => {
  it("counts each origin on the rail and filters the one list by view", async () => {
    stored[0] = entry("bundled", { key: "superdevelop", title: "SuperDevelop" });
    preferencesByRepo.set("/repo", { order: [], entries: [preference("repo")] });
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await rowButton("repo/review");
    expect(railButton("All 3")).toBeTruthy();
    fireEvent.click(railButton("Starred 1"));
    expect(libraryOrder()).toEqual(["repo/review"]);
    fireEvent.click(railButton("Alinery 1"));
    expect(libraryOrder()).toEqual(["bundled/superdevelop"]);
    fireEvent.click(railButton("Mine 2"));
    expect(libraryOrder()).toEqual(["global/review", "repo/review"]);
    expect(railButton("Mine 2").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(railButton("All 3"));
    expect(libraryOrder()).toHaveLength(3);
    // Nothing needs attention, so no signal is on the rail.
    expect(screen.queryByText("Signals")).toBeNull();
  });

  it("names each row by origin, range and status", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const bundled = await screen.findByRole("listitem", { name: "bundled/review" });
    expect(bundled.textContent).toContain("Alinery");
    expect(bundled.textContent).toContain("All repos");
    expect(bundled.textContent).toContain("Built in");
    const repo = screen.getByRole("listitem", { name: "repo/review" });
    expect(repo.textContent).toContain("Mine");
    expect(repo.textContent).toContain("This repo");
    // Signed out, so whether it is published is unknown.
    expect(repo.textContent).toContain("Yours");
  });

  it("searches titles, descriptions, keys and scoped identities across every source", async () => {
    stored = stored.map((item) => entry(item.source.reference.scope, { title: "Release checklist", description: "Audit deployment gates" }));
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await rowButton("repo/review");
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
    expect(libraryOrder()).toEqual([]);
    expect(screen.getByText("No matching playbooks.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    expect(libraryOrder()).toEqual(["bundled/review", "global/review", "repo/review"]);
  });

  it("selects a row into the inspector, and opens it on double-click or Enter", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const panel = await inspect("global/review");
    expect(within(panel).getByText("mine / review")).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Review ring" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Create task" }));
    expect(onCreateTask).toHaveBeenLastCalledWith({ scope: "global", key: "review" });
    fireEvent.keyDown(await rowButton("global/review"), { key: "Enter" });
    await screen.findByRole("region", { name: "Playbook details" });
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(within(await screen.findByRole("complementary", { name: "Inspector" })).getByRole("button", { name: "Open" }));
    await screen.findByRole("region", { name: "Playbook details" });
  });

  it("keeps the ring, the readout and the step chips on the step you last pointed at", async () => {
    stored[2] = entry("repo", {
      step: [
        { ...definition.step[0], key: "plan", title: "Plan", outputs: [{ path: "plan.md" }] },
        { ...definition.step[0], key: "build", title: "Build", auto_advance_default: true, inputs: [{ path: "plan.md", mode: "single" }], prompt: "Build the plan.\n" },
      ],
    });
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const panel = await inspect("repo/review");
    const ring = await within(panel).findByRole("region", { name: "Review ring" });
    await waitFor(() => expect(ring.textContent).toContain("2 steps"));
    fireEvent.mouseEnter(within(ring).getByRole("button", { name: "Build" }));
    fireEvent.mouseLeave(within(ring).getByRole("button", { name: "Build" }));
    expect(ring.textContent).toContain("Step 2 of 2");
    const chips = within(panel).getByRole("group", { name: "Steps" });
    expect(within(chips).getByRole("button", { name: "2 · Build" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(chips).getByRole("button", { name: "1 · Plan" }));
    expect(ring.textContent).toContain("Step 1 of 2");
    expect(ring.textContent).toContain("Waits for you");
  });

  it("opens on the ring with its legend, and Back restores the view, scroll and search focus", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await rowButton("repo/review");
    fireEvent.click(railButton("Mine 2"));
    fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "review" } });
    const library = screen.getByRole("region", { name: "Mine" });
    library.scrollTop = 312;
    fireEvent.scroll(library);
    await openRow("global/review");
    await screen.findByRole("region", { name: "Playbook details" });
    const ring = screen.getByRole("region", { name: "Review ring" });
    expect(ring.textContent).toContain("Review");
    expect(screen.getByText("What it reads")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ring" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("navigation", { name: "Library views" })).toBeNull();
    expect(screen.queryByLabelText("Search playbooks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", JSON.stringify(definition));
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Mine" }).scrollTop).toBe(312);
      expect(document.activeElement).toBe(screen.getByLabelText("Search playbooks"));
    });
    expect(screen.getByLabelText("Search playbooks")).toHaveProperty("value", "review");
    expect(libraryOrder()).toEqual(["global/review", "repo/review"]);
  });

  it("filters stars from the rail and changes them from the row without opening a playbook", async () => {
    preferencesByRepo.set("/repo", { order: [], entries: [preference("global")] });
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await rowButton("repo/review");
    fireEvent.click(railButton("Starred 1"));
    expect(libraryOrder()).toEqual(["global/review"]);
    fireEvent.click(screen.getByRole("button", { name: "Star playbook: global/review" }));
    await waitFor(() => expect(libraryOrder()).toEqual([]));
    expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull();
    fireEvent.click(railButton("All 3"));
    expect(screen.getByRole("button", { name: "Star playbook: global/review" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Star playbook: repo/review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Star playbook: repo/review" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(railButton("Starred 1"));
    expect(libraryOrder()).toEqual(["repo/review"]);
  });

  it("copies a built-in from the inspector without opening it first", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const panel = await inspect("bundled/review");
    expect(within(panel).getByText("Ships with Alinery")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Copy to edit" }));
    expect(await screen.findByLabelText("Save key")).toHaveProperty("value", "review-copy");
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", JSON.stringify(definition));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("readOnly", false);
  });

  it("shows a catalog failure and retries the library", async () => {
    mocks.listPlaybookCatalog.mockRejectedValueOnce(new Error("Catalog unavailable"));
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await screen.findByText("Catalog unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry library" }));
    expect(await rowButton("repo/review")).toBeTruthy();
    expect(mocks.listPlaybookCatalog).toHaveBeenLastCalledWith("/repo");
  });

  it("explains stars and downloads need a repository", async () => {
    stored = [entry("bundled", { key: "one-shot", title: "One shot" }), entry("global")];
    render(<Playbooks onCreateTask={onCreateTask} />);
    await rowButton("bundled/one-shot");
    expect(screen.getByText("Select a repository to see its playbooks, downloads and stars.")).toBeTruthy();
    expect(railButton("Starred 0")).toBeTruthy();
    expect(railButton("Downloaded 0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Star playbook: global/review" })).toHaveProperty("disabled", true);
  });
});

describe("creating a task from a saved playbook", () => {
  it("opens each scoped saved definition without persisting or changing its source", async () => {
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await rowButton("repo/review");
    expect(screen.queryByRole("button", { name: "Create task from this playbook" })).toBeNull();
    const initialStored = structuredClone(stored);
    for (const [scope, label] of [
      ["bundled", "Bundled"],
      ["global", "Global"],
      ["repo", "Repository"],
    ] as const) {
      await openRow(`${scope}/review`);
      await screen.findByRole("region", { name: "Playbook details" });
      const create = screen.getByRole("button", { name: "Create task from this playbook" });
      expect(create).toHaveProperty("disabled", false);
      fireEvent.click(create);
      expect(onCreateTask).toHaveBeenLastCalledWith({ scope, key: "review" });
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", initialStored[0].source_text);
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Library" }));
      await screen.findByRole("list", { name: "Playbook library" });
    }
    expect(onCreateTask).toHaveBeenCalledTimes(3);
    expect(stored).toEqual(initialStored);
    expect(mocks.savePlaybookSource).not.toHaveBeenCalled();
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
    expect(fakeSettings.writes).toEqual([]);
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
    await openRow("global/review");
    await screen.findByRole("region", { name: "Playbook details" });
    const create = screen.getByRole("button", { name: "Create task from this playbook" });
    expect(create).toHaveProperty("disabled", true);
    expect(create.getAttribute("title")).toMatch(/select a repository/i);
    fireEvent.click(create);
    expect(onCreateTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    view.rerender(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    await openRow("global/review");
    await screen.findByRole("region", { name: "Playbook details" });
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
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
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
    await openRow("bundled/review");
    await screen.findByRole("region", { name: "Playbook details" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    const cancel = await screen.findByText("Cancel", { selector: "button" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    expect(mocks.deletePlaybookSource).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Review ring" })).toBeTruthy();

    mocks.deletePlaybookSource.mockRejectedValueOnce("Disk is read-only");
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByText("Disk is read-only");
    expect(screen.getByRole("region", { name: "Review ring" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Playbook" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("list", { name: "Playbook library" });
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
    await openRow("bundled/review");
    await screen.findByRole("region", { name: "Playbook details" });
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", "unsaved buffer");
    expect(screen.queryByRole("list", { name: "Playbook library" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await rowButton("repo/review")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("separator", { name: "Resize graph and description" }).getAttribute("aria-valuenow")).toBe(chosen);
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    await openRow("bundled/review");
    await screen.findByRole("button", { name: "Make a copy to edit" });
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    expect(await rowButton("repo/only-b")).toBeTruthy();
    expect(screen.queryByRole("listitem", { name: "repo/solution-exploration" })).toBeNull();
    expect(screen.queryByRole("listitem", { name: "repo/only-a" })).toBeNull();
  });
});

describe("repository starred playbooks", () => {
  it("shows SuperDevelop starred on a fresh repository and remembers an explicit unstar", async () => {
    stored.push(entry("bundled", { key: "superdevelop", title: "SuperDevelop" }));
    const view = render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const star = await screen.findByRole("button", { name: "Star playbook: bundled/superdevelop" });
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
    fireEvent.click(star);
    await waitFor(() => expect(star.getAttribute("aria-pressed")).toBe("false"));
    expect(preferencesByRepo.get("/repo")?.entries).toEqual([expect.objectContaining({ reference: { scope: "bundled", key: "superdevelop" }, preferred: false })]);
    view.unmount();
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    expect((await screen.findByRole("button", { name: "Star playbook: bundled/superdevelop" })).getAttribute("aria-pressed")).toBe("false");
  });

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
    const checkbox = await screen.findByRole("button", { name: "Star playbook: repo/review" });
    fireEvent.click(checkbox);
    expect(mocks.savePlaybookPickerPreferences).not.toHaveBeenCalled();
    expect(preferencesByRepo.get("/repo")).toEqual(saved);
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert")).toBeDefined();
    expect(await rowButton("repo/review")).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
    await waitFor(() => expect(checkbox).toHaveProperty("disabled", false));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute("aria-pressed")).toBe("true"));
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
    const initialCheckbox = await screen.findByRole("button", { name: "Star playbook: global/review" });
    fireEvent.click(initialCheckbox);
    await waitFor(() => expect(initialCheckbox.getAttribute("aria-pressed")).toBe("true"));
    expect(preferencesByRepo.get("/repo")?.entries).toEqual([{ ...legacy, preferred: true }]);
    expect(mocks.savePlaybookPickerPreferences).toHaveBeenCalledWith(expect.anything(), "/repo");
    fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "repo/review" } });
    expect(screen.getByRole("listitem", { name: "repo/review" })).toBeTruthy();
    expect(preferencesByRepo.get("/repo")?.order).toEqual(order);
    view.unmount();
    render(<Playbooks repoPath="/repo" onCreateTask={onCreateTask} />);
    const checkbox = await screen.findByRole("button", { name: "Star playbook: global/review" });
    expect(checkbox.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute("aria-pressed")).toBe("false"));
    expect(screen.getByRole("listitem", { name: "global/review" })).toBeTruthy();
    expect(preferencesByRepo.get("/repo")?.entries).toEqual([legacy]);
    expect(preferencesByRepo.get("/repo")?.order).toEqual(order);
    expect(ipc.writeGlobalSettings).not.toHaveBeenCalled();
    expect(fakeSettings.writes).toEqual([]);
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
    const checkbox = await screen.findByRole("button", { name: "Star playbook: repo/review" });
    fireEvent.click(checkbox);
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Star playbook: global/review" })).toHaveProperty("disabled", true);
    await act(async () => rejectSave("Read-only repository"));
    await screen.findByText("Read-only repository");
    expect(checkbox.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.getAttribute("aria-pressed")).toBe("true"));
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
    fireEvent.click(await screen.findByRole("button", { name: "Star playbook: repo/review" }));
    view.rerender(<Playbooks repoPath="/repo-b" onCreateTask={onCreateTask} />);
    fireEvent.click(await screen.findByRole("button", { name: "Star playbook: global/review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Star playbook: global/review" }).getAttribute("aria-pressed")).toBe("true"));
    expect(mocks.savePlaybookPickerPreferences).toHaveBeenLastCalledWith(expect.anything(), "/repo-b");
    view.rerender(<Playbooks repoPath="/repo-a" onCreateTask={onCreateTask} />);
    await screen.findByRole("button", { name: "Star playbook: repo/review" });
    await act(async () => (outcome === "resolve" ? resolveSave() : rejectSave("Stale repository failure")));
    expect(screen.getByRole("button", { name: "Star playbook: repo/review" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Stale repository failure")).toBeNull();
    expect(screen.getByRole("button", { name: "Star playbook: repo/review" })).toHaveProperty("disabled", false);
  });

  it("does not allow preferences to mutate without an explicit repository", async () => {
    render(<Playbooks onCreateTask={onCreateTask} />);
    const checkbox = await screen.findByRole("button", { name: "Star playbook: repo/review" });
    expect(checkbox).toHaveProperty("disabled", true);
    expect(screen.getByText("Select a repository to see its playbooks, downloads and stars.")).toBeTruthy();
    expect(checkbox.getAttribute("aria-pressed")).toBe("false");
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

const signIn = () => community.accountStatus.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
const nyxImport = { id: NYX_ID, label: "nyx", playbookKey: "review", localKey: "review", importedVersion: 3 };
const downloadRow = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});
/** repo/review as a download of nyx's listing, in whatever state the community reports. */
function downloaded(overrides: Record<string, unknown> = {}) {
  community.listCommunityImports.mockResolvedValue({ imports: [nyxImport] });
  community.communityDownloadStatus.mockResolvedValue({ rows: [downloadRow(overrides)] });
}

async function openExplore() {
  fireEvent.click(railButton("Explore"));
  return screen.findByRole("list", { name: "Community playbooks" });
}

/** Publishes from the inspector of `id`, under the button the row's state offers. */
async function publishFrom(id: string, button: string | RegExp = "Publish") {
  const panel = await inspect(id);
  fireEvent.click(await within(panel).findByRole("button", { name: button }));
  return screen.findByRole("dialog", { name: "Publish playbook" });
}

describe("community playbooks", () => {
  it("keeps New playbook and Import local, and browses nothing until Explore", async () => {
    renderLibrary();
    await rowButton("repo/review");
    fireEvent.click(screen.getByRole("button", { name: "New playbook" }));
    await screen.findByLabelText("Save key");
    fireEvent.click(screen.getByRole("button", { name: "Library" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste source" }));
    await screen.findByLabelText("Save key");
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
    expect(community.publishCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("puts a download in the same library, named by its author", async () => {
    community.listCommunityImports.mockResolvedValue({ imports: [nyxImport] });
    renderLibrary();
    const row = await screen.findByRole("listitem", { name: "repo/review" });
    expect(row.textContent).toContain("@nyx");
    expect(row.textContent).toContain("This repo");
    expect(row.textContent).toContain("v3");
    expect(railButton("Downloaded 1")).toBeTruthy();
    expect(railButton("Mine 1")).toBeTruthy();
    expect(community.listCommunityImports).toHaveBeenCalledWith({ repoPath: "/repo" });
    expect(community.communityDownloadStatus).toHaveBeenCalledWith({ repoPath: "/repo" });
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
  });

  it("raises an update as a signal and puts it first", async () => {
    stored.push(entry("global", { key: "alpha", title: "Alpha" }));
    downloaded();
    renderLibrary();
    expect(await screen.findByText("Signals")).toBeTruthy();
    await waitFor(() => expect(libraryOrder()[0]).toBe("repo/review"));
    expect(screen.getByRole("listitem", { name: "repo/review" }).textContent).toContain("v3 → v4");
    fireEvent.click(railButton("Updates 1"));
    expect(libraryOrder()).toEqual(["repo/review"]);
  });

  it("opens sign up for a signed-out update and does not download", async () => {
    downloaded();
    renderLibrary();
    const panel = await inspect("repo/review");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update" }));
    await screen.findByRole("dialog", { name: "Sign up" });
    expect(community.updateCommunityImport).not.toHaveBeenCalled();
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
  });

  it("calls update once when the copy is unedited", async () => {
    signIn();
    downloaded();
    community.updateCommunityImport.mockResolvedValue({ kind: "saved", reference: { scope: "repo", key: "review" }, importedVersion: 4, localSha256: "b".repeat(64) });
    renderLibrary();
    const panel = await inspect("repo/review");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(1));
    expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false });
    expect(screen.queryByRole("heading", { name: "Overwrite local copy?" })).toBeNull();
    await waitFor(() => expect(community.communityDownloadStatus).toHaveBeenCalledTimes(2));
  });

  it("asks before overwriting an edited copy that has an update, and retries only after accept", async () => {
    signIn();
    downloaded({ locallyEdited: true });
    community.updateCommunityImport.mockResolvedValueOnce({ kind: "edited" });
    renderLibrary();
    const panel = await inspect("repo/review");
    expect(await within(panel).findByText("Edited · update waiting")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(1));
    expect(community.updateCommunityImport).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: false });
    fireEvent.click(await screen.findByText("Cancel", { selector: "button.btn" }));
    expect(community.updateCommunityImport).toHaveBeenCalledTimes(1);
    fireEvent.click(within(inspector()).getByRole("button", { name: "Update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(community.updateCommunityImport).toHaveBeenCalledTimes(2));
    expect(community.updateCommunityImport).toHaveBeenLastCalledWith({ id: NYX_ID, repoPath: "/repo", overwriteEdited: true });
  });

  it("asks before updating a copy the registry already knows is edited", async () => {
    signIn();
    community.listCommunityImports.mockResolvedValue({ imports: [{ ...nyxImport, locallyEdited: true }] });
    community.communityDownloadStatus.mockResolvedValue({ rows: [downloadRow({ locallyEdited: true })] });
    renderLibrary();
    const panel = await inspect("repo/review");
    fireEvent.click(await within(panel).findByRole("button", { name: "Update" }));
    await screen.findByRole("button", { name: "Overwrite" });
    expect(community.updateCommunityImport).not.toHaveBeenCalled();
  });

  it("offers preview beside update only when an update is available", async () => {
    signIn();
    stored.push(entry("repo", { key: "review-copy" }));
    community.listCommunityImports.mockResolvedValue({ imports: [nyxImport, { id: ADA_ID, label: "ada", playbookKey: "review", localKey: "review-copy", importedVersion: 4 }] });
    community.communityDownloadStatus.mockResolvedValue({
      rows: [downloadRow(), downloadRow({ id: ADA_ID, label: "ada", localKey: "review-copy", importedVersion: 4, updateAvailable: false })],
    });
    community.previewCommunityPlaybook.mockResolvedValue({ kind: "loaded", source: "+++" });
    renderLibrary();
    let panel = await inspect("repo/review");
    fireEvent.click(await within(panel).findByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("dialog", { name: "Preview nyx/review" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Preview nyx/review" })).getAllByRole("button", { name: "Close" })[0]);
    panel = await inspect("repo/review-copy");
    expect(await within(panel).findByText("v4 · current")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Preview" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("marks a withdrawn listing without offering an update", async () => {
    downloaded({ remoteMissing: true, updateAvailable: false, remoteVersion: null });
    renderLibrary();
    expect(await screen.findByRole("button", { name: "Withdrawn 1" })).toBeTruthy();
    const panel = await inspect("repo/review");
    expect(within(panel).getAllByText(/Withdrawn/).length).toBeGreaterThan(0);
    expect(within(panel).queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("lists community listings that share a key as separate cards", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx"), publication(ADA_ID, "ada")], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    const cards = await openExplore();
    await waitFor(() => expect(within(cards).getAllByRole("button", { name: "Review" })).toHaveLength(2));
    expect(cards.textContent).toContain("@nyx");
    expect(cards.textContent).toContain("@ada");
    expect(within(cards).getAllByText("Not in library")).toHaveLength(2);
    expect(within(inspector()).getByText("@nyx / review")).toBeTruthy();
    fireEvent.click(within(cards).getAllByRole("button", { name: "Review" })[1]);
    expect(within(inspector()).getByText("@ada / review")).toBeTruthy();
    expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({});
  });

  it("opens sign up for a signed-out download and does not download", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Download to this repo" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    expect(within(dialog).getByText("To View, Download, or Publish playbooks you need an account. Sign up for free now.")).toBeTruthy();
    expect(dialog.querySelector("input[type='password']")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("data-autofocus")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("downloads a listing and then shows it as in the library", async () => {
    signIn();
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.importCommunityPlaybook.mockResolvedValue({ kind: "saved", reference: { scope: "repo", key: "review" }, importedVersion: 3, localSha256: "a".repeat(64) });
    renderLibrary();
    await rowButton("repo/review");
    const cards = await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Download to this repo" }));
    community.listCommunityImports.mockResolvedValue({ imports: [nyxImport] });
    community.communityDownloadStatus.mockResolvedValue({ rows: [downloadRow({ updateAvailable: false, remoteVersion: 3 })] });
    await waitFor(() => expect(community.importCommunityPlaybook).toHaveBeenCalledWith({ id: NYX_ID, repoPath: "/repo", overwrite: false }));
    expect(await within(cards).findByText("v3 · current")).toBeTruthy();
  });

  it("switches to Explore when the search starts with @", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "@ada" } });
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    expect(railButton("Explore").getAttribute("aria-pressed")).toBe("true");
    expect(community.listCommunityPlaybooks).toHaveBeenLastCalledWith({ q: "ada" });
  });

  it("previews a listing from the inspector", async () => {
    signIn();
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.previewCommunityPlaybook.mockResolvedValue({ kind: "loaded", source: '+++\nversion = 2\nkey = "review"\n+++' });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview nyx/review" });
    expect(community.previewCommunityPlaybook).toHaveBeenCalledWith({ id: NYX_ID });
    expect(within(dialog).getByText(/key = "review"/)).toBeTruthy();
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("gates preview behind sign up when signed out", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Preview" }));
    await screen.findByRole("dialog", { name: "Sign up" });
    expect(community.previewCommunityPlaybook).not.toHaveBeenCalled();
  });

  it("shows a preview failure inside the dialog", async () => {
    signIn();
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.previewCommunityPlaybook.mockResolvedValue({ kind: "failed", message: "Playbook not found." });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog", { name: "Preview nyx/review" });
    expect(await within(dialog).findByText("Playbook not found.")).toBeTruthy();
  });

  it("sends the previous cursor from Load more", async () => {
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: "opaque,cursor" });
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(ADA_ID, "ada")], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({ cursor: "opaque,cursor" }));
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("sends the current query with Load more", async () => {
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: "opaque,cursor" });
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(ADA_ID, "ada")], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: " review " } });
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    expect(community.listCommunityPlaybooks).toHaveBeenCalledWith({ q: "review" });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(community.listCommunityPlaybooks).toHaveBeenLastCalledWith({ q: "review", cursor: "opaque,cursor" }));
  });

  it("does not send a query longer than 80 characters", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    vi.useFakeTimers();
    try {
      community.listCommunityPlaybooks.mockClear();
      fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: `  ${"q".repeat(81)}  ` } });
      await vi.advanceTimersByTimeAsync(300);
      expect(screen.getByText("Invalid query.")).toBeTruthy();
      expect(community.listCommunityPlaybooks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not offer load more with a cursor that belongs to another query", async () => {
    community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: "page-1-cursor" });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    expect(await screen.findByRole("button", { name: "Load more" })).toBeTruthy();
    vi.useFakeTimers();
    try {
      community.listCommunityPlaybooks.mockResolvedValueOnce({ playbooks: [publication(ADA_ID, "ada")], nextCursor: "page-2-cursor" });
      fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "ada" } });
      // The debounce has not fired: the cursor on screen was minted by the empty query.
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    expect(community.listCommunityPlaybooks).toHaveBeenLastCalledWith({ q: "ada" });
    expect(await screen.findByRole("button", { name: "Load more" })).toBeTruthy();
  });

  it("shows a placeholder when Explore has no rows", async () => {
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    expect(await screen.findByText("No playbooks found")).toBeTruthy();
  });

  it("does not let a post-action reload from the previous repository land", async () => {
    signIn();
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
    await rowButton("repo/review");
    const cards = await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Download to this repo" }));
    await waitFor(() => expect(community.importCommunityPlaybook).toHaveBeenCalledTimes(1));
    rerender(
      <>
        <Playbooks repoPath="/other" onCreateTask={onCreateTask} />
        <ConfirmHost />
      </>,
    );
    await act(async () => imported.resolve({ kind: "saved", reference: { scope: "repo", key: "review" }, importedVersion: 1, localSha256: "a".repeat(64) }));
    // The other repository has no import of this publication, and its own load has finished.
    await act(async () => lateReload.resolve({ imports: [nyxImport] }));
    expect(within(cards).getByText("Not in library")).toBeTruthy();
  });

  it("cancels the pairing this dialog started when it is dismissed", async () => {
    const pairing = new Deferred<unknown>();
    community.accountSignIn.mockImplementationOnce(() => pairing.promise);
    community.accountRefresh.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.listCommunityPlaybooks.mockResolvedValue({ playbooks: [publication(NYX_ID, "nyx")], nextCursor: null });
    renderLibrary();
    await rowButton("repo/review");
    await openExplore();
    fireEvent.click(await within(inspector()).findByRole("button", { name: "Download to this repo" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(dialog).getByRole("button", { name: "SIGN UP" }));
    await waitFor(() => expect(community.accountSignIn).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByRole("button", { name: "SIGN UP" })).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(community.accountCancelSignIn).toHaveBeenCalledTimes(1));
    // The cancelled pairing completing late must not continue the import it was opened for.
    await act(async () => pairing.resolve({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false }));
    expect(community.importCommunityPlaybook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Sign up" })).toBeNull();
  });

  it("asks a signed-out author to sign in before publishing", async () => {
    renderLibrary();
    const panel = await inspect("repo/review");
    expect(within(panel).getByText("Unknown until you sign in")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Sign in to publish" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(community.accountSignIn).not.toHaveBeenCalled();
    expect(community.publishCommunityPlaybook).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Publish playbook" })).toBeNull();
  });

  it("keeps publish confirm disabled until the share box is checked", async () => {
    signIn();
    renderLibrary();
    await rowButton("repo/review");
    await waitFor(() => expect(screen.getByRole("listitem", { name: "repo/review" }).textContent).toContain("Not published"));
    const dialog = await publishFrom("repo/review");
    expect(within(dialog).getByText("review")).toBeTruthy();
    expect(within(dialog).getByText("Review")).toBeTruthy();
    expect(within(dialog).getByText("Not published → 1")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    expect(confirm).toHaveProperty("disabled", false);
  });

  it("publishes the row reference without a label, title, key, or version", async () => {
    signIn();
    community.publishCommunityPlaybook.mockResolvedValue({ kind: "saved", id: NYX_ID, label: "nyx", playbookKey: "review", title: "Review", description: "", version: 1 });
    renderLibrary();
    const dialog = await publishFrom("repo/review");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(1));
    expect(community.publishCommunityPlaybook.mock.calls[0][0]).toEqual({ reference: { scope: "repo", key: "review" }, repoPath: "/repo" });
    await waitFor(() => expect(community.listMyCommunityPlaybooks).toHaveBeenCalledTimes(2));
  });

  it("raises saved changes after publishing as a signal and shows the next version", async () => {
    signIn();
    community.listMyCommunityPlaybooks.mockResolvedValue({ kind: "loaded", playbooks: [publication(NYX_ID, "nyx", 3)], truncated: false });
    renderLibrary();
    expect(await screen.findByRole("button", { name: "Not published 2" })).toBeTruthy();
    const dialog = await publishFrom("repo/review", "Publish v4");
    expect(within(dialog).getByText("3 → 4")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", true);
  });

  it("reads a playbook whose file matches its listing as live", async () => {
    signIn();
    const hash = await sha256Hex(stored[2].source_text);
    community.listMyCommunityPlaybooks.mockResolvedValue({ kind: "loaded", playbooks: [{ ...publication(NYX_ID, "nyx", 3), bodySha256: hash }], truncated: false });
    renderLibrary();
    const panel = await inspect("repo/review");
    expect(await within(panel).findByText("Live · v3")).toBeTruthy();
    expect(within(panel).getByText("matches", { exact: false })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /^Publish/ })).toBeNull();
  });

  it("retries label_required only after a valid slug", async () => {
    signIn();
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "label_required" });
    renderLibrary();
    const dialog = await publishFrom("global/review");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    const label = await within(dialog).findByLabelText("Public label");
    fireEvent.change(label, { target: { value: "No" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(1);
    fireEvent.change(label, { target: { value: "nyx" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(community.publishCommunityPlaybook).toHaveBeenCalledTimes(2));
    expect(community.publishCommunityPlaybook).toHaveBeenLastCalledWith({ reference: { scope: "global", key: "review" }, repoPath: "/repo", label: "nyx" });
  });

  it("disables confirm and states the rule while the public label is not a slug", async () => {
    signIn();
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "label_required" });
    renderLibrary();
    const dialog = await publishFrom("repo/review");
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

  it("keeps the publish dialog and its label field across reauthentication", async () => {
    signIn();
    community.publishCommunityPlaybook.mockResolvedValueOnce({ kind: "needs_account" }).mockResolvedValueOnce({ kind: "label_required" });
    community.accountSignIn.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    community.accountRefresh.mockResolvedValue({ signedIn: true, email: "a@example.com", plan: null, paid: false, unavailable: false });
    renderLibrary();
    const publish = await publishFrom("repo/review");
    fireEvent.click(within(publish).getByRole("checkbox", { name: "Confirm you can share this playbook." }));
    fireEvent.click(within(publish).getByRole("button", { name: "Confirm" }));
    const signup = await screen.findByRole("dialog", { name: "Sign up" });
    fireEvent.click(within(signup).getByRole("button", { name: "SIGN UP" }));
    expect(await within(publish).findByLabelText("Public label")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Publish playbook" })).toBeTruthy();
  });

  it("lists your listings, including one with no copy here, and downloads it", async () => {
    signIn();
    community.listMyCommunityPlaybooks.mockResolvedValue({
      kind: "loaded",
      playbooks: [publication(NYX_ID, "nyx", 2), { ...publication(ADA_ID, "nyx", 5), playbookKey: "notes", title: "Notes" }],
      truncated: false,
    });
    community.importCommunityPlaybook.mockResolvedValue({ kind: "saved", reference: { scope: "repo", key: "notes" }, importedVersion: 5, localSha256: "a".repeat(64) });
    renderLibrary();
    await rowButton("repo/review");
    fireEvent.click(await screen.findByRole("button", { name: "Your listings 3" }));
    expect(libraryOrder()).toEqual([`listing:${ADA_ID}`, "global/review", "repo/review"]);
    const panel = await inspect(`listing:${ADA_ID}`);
    expect(within(panel).getByText("Live · v5 · not here")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Download to this repo" }));
    await waitFor(() => expect(community.importCommunityPlaybook).toHaveBeenCalledWith({ id: ADA_ID, repoPath: "/repo", overwrite: false }));
  });

  it("asks to sign in before listing published playbooks", async () => {
    renderLibrary();
    await rowButton("repo/review");
    fireEvent.click(railButton("Your listings 0"));
    expect(await screen.findByText(/Sign in to see playbooks you published/)).toBeTruthy();
    expect(community.listMyCommunityPlaybooks).not.toHaveBeenCalled();
  });
});
