import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelInput } from "./shared";

const ipcSpies = vi.hoisted(() => ({
  readModelFavorites: vi.fn(),
  setModelFavorite: vi.fn(),
  listHarnessModels: vi.fn(),
  listHarnessModelsForRepo: vi.fn(),
}));
const toastSpies = vi.hoisted(() => ({
  show: vi.fn(),
  error: vi.fn(),
}));

// Vitest hoists this factory before static imports, so load the typed mock seam inside it.
vi.mock("./ipc", async () => {
  const { mockIpc } = await import("./test/mockIpc");
  return mockIpc(ipcSpies);
});
vi.mock("./toast", () => ({
  toast: Object.assign(toastSpies.show, { error: toastSpies.error }),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderModelInput(overrides: Partial<React.ComponentProps<typeof ModelInput>> = {}) {
  const props: React.ComponentProps<typeof ModelInput> = {
    harness: "omp",
    value: "",
    onChange: vi.fn(),
    onCommit: vi.fn(),
    ...overrides,
  };
  return { ...render(<ModelInput {...props} />), props };
}

async function openModels() {
  fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
  return screen.findByRole("list", { name: "Models" });
}

beforeEach(() => {
  ipcSpies.readModelFavorites.mockReset().mockResolvedValue([]);
  ipcSpies.setModelFavorite.mockReset().mockResolvedValue([]);
  ipcSpies.listHarnessModels.mockReset().mockResolvedValue(["opus", "sonnet"]);
  ipcSpies.listHarnessModelsForRepo.mockReset().mockResolvedValue(["opus", "sonnet"]);
  toastSpies.show.mockReset();
  toastSpies.error.mockReset();
  const storedModels = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storedModels.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storedModels.set(key, value)),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ModelInput remembered model", () => {
  it("can leave an empty value blank when prefill is disabled", async () => {
    localStorage.setItem("alinery.lastmodel./r:omp", "gpt-5");
    const { props } = renderModelInput({
      harness: "omp",
      repoPath: "/r",
      prefillRemembered: false,
    });

    await act(async () => Promise.resolve());
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

describe("ModelInput favorites", () => {
  it("waits for favorites before exposing discovery and opens with favorites first", async () => {
    const favoriteRead = deferred<string[]>();
    const discovery = deferred<string[]>();
    ipcSpies.readModelFavorites.mockReturnValue(favoriteRead.promise);
    ipcSpies.listHarnessModels.mockReturnValue(discovery.promise);
    const { props } = renderModelInput();

    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    await act(async () => discovery.resolve(["opus", "sonnet", "haiku"]));

    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh model list" }) as HTMLButtonElement).disabled).toBe(true);
    expect(props.onChange).not.toHaveBeenCalled();

    await act(async () => favoriteRead.resolve(["sonnet"]));

    const list = await screen.findByRole("list", { name: "Models" });
    expect([...list.querySelectorAll(".rtt")].map((node) => node.textContent)).toEqual(["sonnet", "opus", "haiku"]);
    expect((screen.getByRole("button", { name: "Refresh model list" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("waits for a rejected favorite read and then opens in discovery order without a toast", async () => {
    const favoriteRead = deferred<string[]>();
    const discovery = deferred<string[]>();
    ipcSpies.readModelFavorites.mockReturnValue(favoriteRead.promise);
    ipcSpies.listHarnessModels.mockReturnValue(discovery.promise);
    renderModelInput();

    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    await act(async () => discovery.resolve(["opus", "sonnet"]));
    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();

    await act(async () => favoriteRead.reject(new Error("read failed")));

    const list = await screen.findByRole("list", { name: "Models" });
    expect([...list.querySelectorAll(".rtt")].map((node) => node.textContent)).toEqual(["opus", "sonnet"]);
    expect(toastSpies.show).not.toHaveBeenCalled();
    expect(toastSpies.error).not.toHaveBeenCalled();
  });

  it("ignores obsolete discovery after a repository change", async () => {
    const obsolete = deferred<string[]>();
    const current = deferred<string[]>();
    ipcSpies.listHarnessModelsForRepo.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);

    const view = renderModelInput({ harness: "omp", repoPath: "/repo-a" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    expect((screen.getByRole("button", { name: "Refresh model list" }) as HTMLButtonElement).disabled).toBe(true);

    view.rerender(<ModelInput {...view.props} repoPath="/repo-b" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh model list" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));

    await act(async () => obsolete.resolve(["obsolete-model"]));
    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();
    expect((screen.getByRole("button", { name: "Refresh model list" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => current.resolve(["current-model"]));
    expect(await screen.findByText("current-model")).toBeDefined();
    expect(screen.queryByText("obsolete-model")).toBeNull();
  });

  it("renders filter-first stable ordering, duplicates, and no unavailable rows", async () => {
    ipcSpies.readModelFavorites.mockResolvedValue(["anthropic-sonnet", "claude-sonnet", "missing"]);
    ipcSpies.listHarnessModels.mockResolvedValue(["claude-opus", "claude-sonnet", "anthropic-sonnet", "claude-sonnet", "haiku"]);
    const { props } = renderModelInput();

    const list = await openModels();
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove anthropic-sonnet from favorites" })).toBeDefined());
    const names = () => [...list.querySelectorAll(".rtt")].map((node) => node.textContent);
    expect(names()).toEqual(["claude-sonnet", "anthropic-sonnet", "claude-sonnet", "claude-opus", "haiku"]);
    expect(screen.getAllByText("claude-sonnet")).toHaveLength(2);
    expect(screen.queryByText("missing")).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Filter models" }), { target: { value: "opus" } });
    expect(names()).toEqual(["claude-opus"]);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Filter models" }), { key: "Enter" });
    expect(props.onChange).toHaveBeenCalledWith("claude-opus");
    expect(props.onCommit).toHaveBeenCalledWith("claude-opus");
  });

  it("keeps duplicate rows hoverable and selectable by mouse", async () => {
    ipcSpies.listHarnessModels.mockResolvedValue(["opus", "sonnet", "sonnet"]);
    const { props } = renderModelInput();

    await openModels();
    const sonnetButtons = await screen.findAllByRole("button", { name: "Select sonnet" });
    const secondSonnetRow = sonnetButtons[1].closest("li");
    fireEvent.mouseEnter(secondSonnetRow as HTMLElement);
    expect(secondSonnetRow?.classList.contains("sel")).toBe(true);

    fireEvent.click(sonnetButtons[1]);
    expect(props.onChange).toHaveBeenCalledWith("sonnet");
    expect(props.onCommit).toHaveBeenCalledWith("sonnet");
    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();
  });

  it("keeps search arrow, Enter, and Escape behavior", async () => {
    ipcSpies.listHarnessModels.mockResolvedValue(["opus", "sonnet"]);
    const { props } = renderModelInput();

    await openModels();
    const search = screen.getByRole("textbox", { name: "Filter models" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Select sonnet" }).closest("li")?.classList.contains("sel")).toBe(true);
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Select opus" }).closest("li")?.classList.contains("sel")).toBe(true);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onChange).toHaveBeenCalledWith("sonnet");
    expect(props.onCommit).toHaveBeenCalledWith("sonnet");

    await openModels();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Filter models" }), { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();
  });

  it("toggles only favorite membership and uses the canonical response after pending", async () => {
    const mutation = deferred<string[]>();
    ipcSpies.readModelFavorites.mockResolvedValue(["sonnet"]);
    ipcSpies.listHarnessModels.mockResolvedValue(["opus", "opus", "sonnet", "haiku"]);
    ipcSpies.setModelFavorite.mockReturnValue(mutation.promise);
    localStorage.setItem("alinery.lastmodel.omp", "remembered-model");
    const { props } = renderModelInput({ value: "selected-model" });

    await openModels();
    const addButtons = await screen.findAllByRole("button", { name: "Add opus to favorites" });
    const removeSonnet = screen.getByRole("button", { name: "Remove sonnet from favorites" });
    expect(addButtons).toHaveLength(2);
    expect(addButtons[0].getAttribute("title")).toBe("Add opus to favorites");
    expect(addButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(addButtons[0].textContent).toBe("☆");
    expect(removeSonnet.getAttribute("title")).toBe("Remove sonnet from favorites");
    expect(removeSonnet.getAttribute("aria-pressed")).toBe("true");
    expect(removeSonnet.textContent).toBe("★");
    const selectionButton = screen.getAllByRole("button", { name: "Select opus" })[0];
    expect(selectionButton.closest("li")).toBe(addButtons[0].closest("li"));
    expect(selectionButton.getAttribute("aria-label")).not.toBe(addButtons[0].getAttribute("aria-label"));
    expect(screen.getAllByRole("button", { name: /favorites$/ }).every((button) => button.closest('[role="option"]') === null)).toBe(true);

    fireEvent.click(addButtons[0]);
    expect(ipcSpies.setModelFavorite).toHaveBeenCalledWith("omp", "opus", true);
    expect(screen.getAllByRole("button", { name: "Add opus to favorites" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect((removeSonnet as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole("button", { name: "Add opus to favorites" })[0].textContent).toBe("☆");
    expect(screen.getByRole("list", { name: "Models" })).toBeDefined();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
    expect(localStorage.getItem("alinery.lastmodel.omp")).toBe("remembered-model");
    expect(ipcSpies.listHarnessModels).toHaveBeenCalledTimes(1);

    await act(async () => mutation.resolve(["sonnet", "opus", "haiku"]));
    const removeOpus = await screen.findAllByRole("button", { name: "Remove opus from favorites" });
    expect(removeOpus).toHaveLength(2);
    expect(removeOpus.every((button) => button.getAttribute("aria-pressed") === "true" && !button.hasAttribute("disabled"))).toBe(true);
    expect(await screen.findByRole("button", { name: "Remove haiku from favorites" })).toBeDefined();
  });

  it.each([" ", "Enter"])("keeps native keyboard %s favorite activation isolated from selection", async (key) => {
    ipcSpies.listHarnessModels.mockResolvedValue(["opus"]);
    ipcSpies.setModelFavorite.mockResolvedValue(["opus"]);
    const { props } = renderModelInput({ value: "selected-model" });

    await openModels();
    const selectionButton = await screen.findByRole("button", { name: "Select opus" });
    const favoriteButton = screen.getByRole("button", { name: "Add opus to favorites" });
    expect(selectionButton.tabIndex).toBe(0);
    expect(favoriteButton.tabIndex).toBe(0);
    expect(favoriteButton.getAttribute("type")).toBe("button");
    // jsdom does not perform native Tab traversal or synthesize a button click
    // from Space/Enter, so mirror those browser defaults around the real button.
    selectionButton.focus();
    fireEvent.keyDown(selectionButton, { key: "Tab" });
    favoriteButton.focus();
    expect(document.activeElement).toBe(favoriteButton);

    fireEvent.keyDown(favoriteButton, { key });
    fireEvent.keyUp(favoriteButton, { key });
    fireEvent.click(favoriteButton, { detail: 0 });

    await waitFor(() => expect(ipcSpies.setModelFavorite).toHaveBeenCalledWith("omp", "opus", true));
    expect(screen.getByRole("list", { name: "Models" })).toBeDefined();
    expect(props.onChange).not.toHaveBeenCalled();
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it.each([
    { favorites: [] as string[], model: "opus", label: "Add opus to favorites" },
    { favorites: ["opus"], model: "opus", label: "Remove opus from favorites" },
  ])("retains membership and reports context when $label fails", async ({ favorites, model, label }) => {
    ipcSpies.readModelFavorites.mockResolvedValue(favorites);
    ipcSpies.listHarnessModels.mockResolvedValue([model]);
    ipcSpies.setModelFavorite.mockRejectedValue(new Error("disk full"));
    renderModelInput({ value: "selected-model" });

    await openModels();
    const button = await screen.findByRole("button", { name: label });
    fireEvent.click(button);
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalledWith(expect.stringContaining(model)));
    expect(toastSpies.error).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps empty and failed discovery closed without synthesizing saved favorites", async () => {
    ipcSpies.readModelFavorites.mockResolvedValue(["missing"]);
    ipcSpies.listHarnessModels.mockResolvedValue([]);
    const view = renderModelInput();

    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    await waitFor(() => expect(toastSpies.show).toHaveBeenCalledWith("No models found"));
    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();
    expect(screen.queryByText("missing")).toBeNull();

    ipcSpies.listHarnessModelsForRepo.mockRejectedValue(new Error("discovery failed"));
    view.rerender(<ModelInput {...view.props} repoPath="/repo" />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh model list" }));
    await waitFor(() => expect(ipcSpies.listHarnessModelsForRepo).toHaveBeenCalledWith("/repo", "omp"));
    expect(screen.queryByRole("list", { name: "Models" })).toBeNull();
    expect(screen.queryByText("missing")).toBeNull();
  });
});
