import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../confirm";
import type { NormalizedPlaybook, PlaybookCatalog, PlaybookRef, SavePlaybookRequest, ScopedPlaybook } from "../types";
import type * as Shared from "../shared";
import type * as IpcFixtures from "../test/mockIpc";
import { Playbooks } from "./Playbooks";

const mocks = vi.hoisted(() => ({ listPlaybookCatalog: vi.fn(), readPlaybook: vi.fn(), validatePlaybookSource: vi.fn(), renderPlaybookSource: vi.fn(), savePlaybookSource: vi.fn(), deletePlaybookSource: vi.fn(), readConfigForRepo: vi.fn(), readGlobalSettings: vi.fn() }));
vi.mock("../ipc", async () => {
  // ConfirmHost imports the shared window surface before static IPC helpers initialize.
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc(mocks);
});
vi.mock("../shared", async () => {
  const actual = await vi.importActual<typeof Shared>("../shared");
  return { ...actual, ModelInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input value={value} onChange={(e) => onChange(e.target.value)} /> };
});

const definition: NormalizedPlaybook = { version: 2, key: "review", title: "Review", description: "Review work", default_model: "default-model", default_harness: "omp", preamble: "Keep this prose.\n", section_order: ["inspect"], step: [{ key: "inspect", title: "Inspect", short: "Inspect", is_coding_step: false, auto_advance_default: false, inputs: [{ path: "ticket.md", mode: "single" }], outputs: [{ path: "findings.md" }], model: "", harness: "", prompt: "Read assigned inputs.\n" }] };
let stored: ScopedPlaybook[];
const identity = (ref: PlaybookRef) => `${ref.scope}/${ref.key}`;
const entry = (scope: PlaybookRef["scope"]): ScopedPlaybook => ({ source: { reference: { scope, key: "review" }, path: scope === "bundled" ? null : `/${scope}/review/playbook.md` }, definition: structuredClone(definition), source_text: JSON.stringify(definition), modified_at_ms: scope === "bundled" ? null : 1234 });

beforeEach(() => {
  vi.clearAllMocks();
  stored = [entry("bundled"), entry("global"), entry("repo")];
  mocks.listPlaybookCatalog.mockImplementation(async (): Promise<PlaybookCatalog> => ({ candidates: stored.map((item) => ({ source: item.source, title: item.definition.title, description: item.definition.description, modified_at_ms: item.modified_at_ms, diagnostics: [] })), picker_preferences: { order: [], entries: [] }, diagnostics: [] }));
  mocks.readPlaybook.mockImplementation(async (ref: PlaybookRef) => structuredClone(stored.find((item) => identity(item.source.reference) === identity(ref))));
  mocks.validatePlaybookSource.mockImplementation(async (source: string) => {
    try { return { definition: JSON.parse(source), diagnostics: [] }; }
    catch { return { definition: null, diagnostics: [{ code: "overlapping_outputs", message: "inspect and build overlap findings.md", line: 12, field: "step.outputs", severity: "error" }] }; }
  });
  mocks.renderPlaybookSource.mockImplementation(async (value: NormalizedPlaybook) => JSON.stringify(value));
  mocks.savePlaybookSource.mockImplementation(async (request: SavePlaybookRequest) => {
    const index = stored.findIndex((item) => identity(item.source.reference) === identity(request.target));
    if (index >= 0 && !request.overwrite) throw { kind: "conflict" };
    const saved = { source: { reference: request.target, path: `/library/${request.target.key}/playbook.md` }, definition: JSON.parse(request.source), source_text: request.source, modified_at_ms: 2345 };
    if (index >= 0) stored[index] = saved; else stored.push(saved);
    return saved;
  });
  mocks.deletePlaybookSource.mockImplementation(async (reference: PlaybookRef) => { stored = stored.filter((item) => identity(item.source.reference) !== identity(reference)); });
  mocks.readConfigForRepo.mockResolvedValue({ defaults: { model: "product-model" } });
  mocks.readGlobalSettings.mockResolvedValue({ defaults: { model: "product-model" } });
});
afterEach(cleanup);

async function openRepo() {
  const rows = await screen.findAllByRole("button", { name: "Review" });
  fireEvent.click(rows[2]);
  await screen.findByRole("region", { name: "Playbook editor" });
}

describe("canonical playbook management", () => {
  it("invalid edit preserves stored definition and retains the buffer with diagnostics", async () => {
    render(<><Playbooks repoPath="/repo" /><ConfirmHost /></>);
    await openRepo();
    fireEvent.change(screen.getByLabelText("Playbook source"), { target: { value: "invalid edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    expect(await screen.findByText("inspect and build overlap findings.md", { exact: false })).toBeTruthy();
    expect((screen.getByLabelText("Playbook source") as HTMLTextAreaElement).value).toBe("invalid edit");
    expect(stored[2].source_text).toBe(JSON.stringify(definition));
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Playbook source") as HTMLTextAreaElement).value).toBe("invalid edit");
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await openRepo();
    expect((screen.getByLabelText("Playbook source") as HTMLTextAreaElement).value).toBe(JSON.stringify(definition));
  });

  it("copy, overwrite and deletion affect only the explicitly selected writable identity", async () => {
    render(<><Playbooks repoPath="/repo" /><ConfirmHost /></>);
    fireEvent.click((await screen.findAllByRole("button", { name: "Review" }))[0]);
    await screen.findByRole("region", { name: "Playbook editor" });
    fireEvent.change(screen.getByLabelText("Save scope"), { target: { value: "repo" } });
    fireEvent.change(screen.getByLabelText("Save key"), { target: { value: "review-copy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    await waitFor(() => expect(stored.some((item) => identity(item.source.reference) === "repo/review-copy")).toBe(true));
    fireEvent.change(screen.getByLabelText("Save key"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    fireEvent.click(await screen.findByText("Cancel", { selector: "button" }));
    expect(stored.find((item) => identity(item.source.reference) === "repo/review")?.source_text).toBe(JSON.stringify(definition));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save definition" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "repo/review" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete definition" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(stored.map((item) => identity(item.source.reference))).toEqual(["bundled/review", "global/review", "repo/review-copy"]));
  });

  it("form edits round trip through canonical source and retain inherited choices", async () => {
    render(<><Playbooks repoPath="/repo" /><ConfirmHost /></>);
    await openRepo();
    fireEvent.click(screen.getByRole("button", { name: "Edit form" }));
    const fieldset = await screen.findByRole("group", { name: "Inspect" });
    fireEvent.change(within(fieldset).getByLabelText("Step model"), { target: { value: "worker-model" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit source" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(fieldset).getByLabelText("Coding step"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit source" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    const roundTrip = JSON.parse((screen.getByLabelText("Playbook source") as HTMLTextAreaElement).value) as NormalizedPlaybook;
    expect(roundTrip.step[0]).toMatchObject({ model: "worker-model", harness: "", is_coding_step: true });
    expect(roundTrip.preamble).toBe(definition.preamble);
    expect(roundTrip.step[0].prompt).toBe(definition.step[0].prompt);
    fireEvent.click(screen.getByRole("button", { name: "Save definition" }));
    fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(stored[2].definition.step[0].model).toBe("worker-model"));
  });
});
