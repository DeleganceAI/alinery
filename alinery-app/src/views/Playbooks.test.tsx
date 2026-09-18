import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../confirm";
import type * as IpcFixtures from "../test/mockIpc";
import type { NormalizedPlaybook, PlaybookCatalog, PlaybookRef, SavePlaybookRequest, ScopedPlaybook } from "../types";
import { Playbooks } from "./Playbooks";

const mocks = vi.hoisted(() => ({
  listPlaybookCatalog: vi.fn(),
  readPlaybook: vi.fn(),
  validatePlaybookSource: vi.fn(),
  renderPlaybookSource: vi.fn(),
  savePlaybookSource: vi.fn(),
  deletePlaybookSource: vi.fn(),
}));
vi.mock("../ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc(mocks);
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
const identity = (ref: PlaybookRef) => `${ref.scope}/${ref.key}`;
const entry = (scope: PlaybookRef["scope"]): ScopedPlaybook => ({
  source: { reference: { scope, key: "review" }, path: scope === "bundled" ? null : `/${scope}/review/playbook.md` },
  definition: structuredClone(definition),
  source_text: JSON.stringify(definition),
  modified_at_ms: scope === "bundled" ? null : 1234,
});

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
  mocks.listPlaybookCatalog.mockImplementation(
    async (): Promise<PlaybookCatalog> => ({
      candidates: stored.map((item) => ({
        source: item.source,
        title: item.definition.title,
        description: item.definition.description,
        modified_at_ms: item.modified_at_ms,
        diagnostics: [],
      })),
      picker_preferences: { order: [], entries: [] },
      diagnostics: [],
    }),
  );
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

describe("graph-first playbook management", () => {
  it("keeps the saved graph through mode switches and updates it only after persistence", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    expect(screen.queryByLabelText("Playbook source")).toBeNull();
    const next = { ...definition, step: [{ ...definition.step[0], title: "Revised inspection", prompt: "New prompt" }] };
    const draft = JSON.stringify(next);
    edit(draft);
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByText("Showing saved version · Unsaved changes in editor.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Revised inspection/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", draft);
    await overwrite();
    await screen.findByText("Definition saved.");
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("button", { name: /Revised inspection/ })).toBeTruthy();
    expect(stored[2].source_text).toBe(draft);
  });

  it("invalid source retains its draft, diagnostics and previous saved graph", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" />
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
        <Playbooks repoPath="/repo" />
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
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("region", { name: "Review graph" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Not saved graph" })).toBeNull();
  });

  it("bundled source is read-only and copying creates a distinct writable identity", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" />
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
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.queryByRole("region", { name: "Review graph" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await screen.findByText("Definition saved.");
    expect(stored.map((item) => identity(item.source.reference))).toEqual(["bundled/review", "global/review", "repo/review", "repo/review-copy"]);
    fireEvent.click(screen.getByRole("button", { name: "Delete definition" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(stored).toHaveLength(3));
    expect(stored[0].source_text).toBe(JSON.stringify(definition));
  });

  it("cancelled discard protects selection and close restores library focus only after discard", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    edit("unsaved buffer");
    fireEvent.click(screen.getByRole("button", { name: "Review Global" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Playbook source")).toHaveProperty("value", "unsaved buffer");
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Playbook details" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText("Search playbooks"));
  });

  it("repository changes retain draft ownership even when save finishes in another repository", async () => {
    const view = render(
      <>
        <Playbooks repoPath="/repo-a" />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    edit(JSON.stringify({ ...definition, description: "Draft in A" }));
    view.rerender(
      <>
        <Playbooks repoPath="/repo-b" />
        <ConfirmHost />
      </>,
    );
    expect(screen.getByText(/This definition belongs to \/repo-a/)).toBeTruthy();
    await overwrite();
    await screen.findByText("Definition saved.");
    expect(mocks.savePlaybookSource).toHaveBeenCalledWith(expect.anything(), "/repo-a");
    expect(screen.getByRole("button", { name: "Review Repository" }).getAttribute("aria-current")).toBeNull();
  });

  it("filters all scopes without discarding selection and preserves pasted source on cancelled overwrite", async () => {
    render(
      <>
        <Playbooks repoPath="/repo" />
        <ConfirmHost />
      </>,
    );
    await openRepo();
    fireEvent.change(screen.getByLabelText("Search playbooks"), { target: { value: "bundled/review" } });
    expect(within(screen.getByRole("list", { name: "Playbook library" })).getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Review graph" })).toBeTruthy();
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
    render(<Playbooks repoPath="/repo" />);
    await openRepo();
    const divider = screen.getByRole("separator", { name: "Resize graph and description" });
    fireEvent.keyDown(divider, { key: "Home" });
    const chosen = divider.getAttribute("aria-valuenow");
    fireEvent.click(screen.getByRole("button", { name: "Editor" }));
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("separator", { name: "Resize graph and description" }).getAttribute("aria-valuenow")).toBe(chosen);
    fireEvent.click(screen.getByRole("button", { name: "Review Bundled" }));
    await screen.findByRole("button", { name: "Make a copy to edit" });
    expect(screen.getByRole("separator", { name: "Resize graph and description" }).getAttribute("aria-valuenow")).toBe(chosen);
  });
});
