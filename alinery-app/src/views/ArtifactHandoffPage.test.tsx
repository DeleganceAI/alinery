import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactHandoffPage, type ArtifactHandoffPageProps } from "./ArtifactHandoffPage";

afterEach(cleanup);
const validPreview = { assessment: { terminality: "nonterminal" as const, destinations: [{ step_key: "review", title: "Review draft" }], reasons: [] }, diagnostics: [] };
function setup(overrides: Partial<ArtifactHandoffPageProps> = {}) {
  const props: ArtifactHandoffPageProps = {
    stepTitle: "Write report",
    outputs: [
      { selector: "report.md", relative_path: "report.2.md", discriminator: 2 },
      { selector: "notes/*.md", relative_path: "notes/*.2.md", discriminator: 2 },
    ],
    destinations: [{ step_key: "possible", title: "Possible only" }],
    busy: false,
    error: "",
    onPreview: vi.fn().mockResolvedValue(validPreview),
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<ArtifactHandoffPage {...props} />);
  return props;
}
const editor = () => screen.getByLabelText("Content for report.2.md");
const continueButton = () => screen.getByRole("button", { name: "Continue" });
async function check() {
  fireEvent.click(screen.getByRole("button", { name: "Check artifacts" }));
  await screen.findByText("Artifacts are valid. Ready to continue.");
}

describe("ArtifactHandoffPage", () => {
  it("previews pasted content at the assigned physical path and requires another check after edits", async () => {
    const props = setup();
    fireEvent.change(editor(), { target: { value: "# Report" } });
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    await check();
    expect(props.onPreview).toHaveBeenCalledWith([{ relative_path: "report.2.md", content: "# Report" }]);
    expect(screen.getByText(/Review draft/)).not.toBeNull();
    expect(screen.queryByText(/Possible only/)).toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(editor(), { target: { value: "# Revised" } });
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(props.onSubmit).not.toHaveBeenCalled();
    await check();
    fireEvent.click(continueButton());
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith([{ relative_path: "report.2.md", content: "# Revised" }]));
  });

  it("blocks invalid outputs and unresolved routing without discarding drafts", async () => {
    const props = setup({
      onPreview: vi
        .fn()
        .mockResolvedValue({ assessment: { destinations: [], terminality: "unresolved", reasons: [{ message: "No route is ready" }] }, diagnostics: ["Report must not be empty"] }),
    });
    fireEvent.change(editor(), { target: { value: "draft to repair" } });
    fireEvent.click(screen.getByRole("button", { name: "Check artifacts" }));
    await screen.findByText("Report must not be empty");
    expect(screen.getByText("No route is ready")).not.toBeNull();
    expect((editor() as HTMLTextAreaElement).value).toBe("draft to repair");
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("preserves edits on preview and submission failures and on cancelled confirmation", async () => {
    const onPreview = vi.fn().mockRejectedValueOnce(new Error("Preview failed")).mockResolvedValue(validPreview);
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("Owner changed")).mockResolvedValue(undefined);
    setup({ onPreview, onSubmit });
    fireEvent.change(editor(), { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Check artifacts" }));
    await screen.findByRole("alert");
    expect((editor() as HTMLTextAreaElement).value).toBe("keep this draft");
    await check();
    fireEvent.click(continueButton());
    await screen.findByText("Error: Owner changed");
    expect((editor() as HTMLTextAreaElement).value).toBe("keep this draft");
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    await check();
    fireEvent.click(continueButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect((editor() as HTMLTextAreaElement).value).toBe("keep this draft");
  });

  it("uploads into an explicitly assigned path and allows editing uploaded text", async () => {
    const props = setup();
    const file = new File(["# Uploaded"], "unrelated-name.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => "# Uploaded" });
    fireEvent.change(screen.getByLabelText("Upload file for report.2.md"), { target: { files: [file] } });
    await waitFor(() => expect((editor() as HTMLTextAreaElement).value).toBe("# Uploaded"));
    fireEvent.change(editor(), { target: { value: "# Uploaded and edited" } });
    await check();
    expect(props.onPreview).toHaveBeenCalledWith([{ relative_path: "report.2.md", content: "# Uploaded and edited" }]);
  });

  it("requires concrete safe family members and permits removing all members", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add member to notes/*.md" }));
    const path = screen.getByLabelText("Concrete path for notes/*.md member 1");
    fireEvent.change(path, { target: { value: "notes/../escape.2.md" } });
    expect((screen.getByRole("button", { name: "Check artifacts" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(path, { target: { value: "notes/first.2.md" } });
    fireEvent.change(screen.getByLabelText("Content for notes/*.md member 1"), { target: { value: "# Note" } });
    await check();
    expect(props.onPreview).toHaveBeenLastCalledWith([{ relative_path: "notes/first.2.md", content: "# Note" }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove notes/*.md member 1" }));
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    await check();
    expect(props.onPreview).toHaveBeenLastCalledWith([]);
  });

  it("ignores a preview that finishes after the draft changes", async () => {
    // The app targets ES2020, where Promise.withResolvers is unavailable.
    let resolve!: (result: typeof validPreview) => void;
    setup({
      onPreview: vi.fn(
        () =>
          new Promise<typeof validPreview>((done) => {
            resolve = done;
          }),
      ),
    });
    fireEvent.change(editor(), { target: { value: "old draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Check artifacts" }));
    fireEvent.change(editor(), { target: { value: "new draft" } });
    await act(async () => resolve(validPreview));
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Artifacts are valid. Ready to continue.")).toBeNull();
    expect((editor() as HTMLTextAreaElement).value).toBe("new draft");
  });

  it("allows a validated handoff waiting for other inputs without promising a destination", async () => {
    setup({
      onPreview: vi
        .fn()
        .mockResolvedValue({ assessment: { terminality: "nonterminal", destinations: [], reasons: [{ message: "Waiting for the other review" }] }, diagnostics: [] }),
    });
    await check();
    expect(screen.getByText("Waiting for the other review")).not.toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a terminal result without claiming possible steps will start", async () => {
    setup({ onPreview: vi.fn().mockResolvedValue({ assessment: { terminality: "terminal", destinations: [], reasons: [] }, diagnostics: [] }) });
    await check();
    expect(screen.queryByText(/Possible only/)).toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
