import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { ChatMcpDialog } from "./ChatMcpDialog";
import { ChatModelDialog } from "./ChatModelDialog";
import { ChatToolsDialog } from "./ChatToolsDialog";

vi.mock("../ipc", () => mockIpc({ getCurrentWindow: (() => ({ listen: async () => () => undefined })) as never }));

describe("ChatModelDialog", () => {
  const base = {
    tab: "models" as const,
    models: [{ provider: "xai", id: "grok-4.6" }],
    current: "xai/grok-4.6",
    loginProviders: [],
    modelRoles: {},
    onTabChange: vi.fn(),
    onApplyModel: vi.fn(),
    onLogin: vi.fn(),
    onHatchTerminalLogin: vi.fn(),
    onAssignRole: vi.fn(),
    onClose: vi.fn(),
  };

  afterEach(cleanup);

  it("renders Accounts with Advanced collapsed for env-only providers", () => {
    const html = renderToStaticMarkup(
      <ChatModelDialog
        {...base}
        tab="accounts"
        setup
        loginProviders={[{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }]}
        models={[
          { provider: "anthropic", id: "claude" },
          { provider: "openrouter", id: "auto" },
        ]}
      />,
    );
    expect(html).toContain("Set up your providers");
    expect(html).toContain("Anthropic");
    expect(html).toContain("Advanced");
    expect(html).not.toContain("openrouter");
  });

  it("lists Advanced rows when expanded: env-only and RPC-incompatible", () => {
    const html = renderToStaticMarkup(
      <ChatModelDialog
        {...base}
        tab="accounts"
        defaultAdvancedOpen
        loginProviders={[
          { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
          { id: "baseten", name: "Baseten", available: true, authenticated: false },
        ]}
        models={[{ provider: "openrouter", id: "auto" }]}
      />,
    );
    expect(html).toContain("Anthropic");
    expect(html).toContain("Signed in");
    expect(html).toContain("Baseten");
    expect(html).toContain("openrouter");
    expect(html).toContain("Terminal /login");
    expect(html).toContain("Ready via env");
  });

  it("filters Accounts by name or provider id, case-insensitively, and Esc clears before closing", () => {
    render(
      <ChatModelDialog
        {...base}
        tab="accounts"
        loginProviders={[
          { id: "anthropic", name: "Anthropic", available: true, authenticated: false },
          { id: "openai-codex", name: "ChatGPT", available: true, authenticated: true },
        ]}
        models={[{ provider: "openrouter", id: "auto" }]}
      />,
    );
    const search = screen.getByRole("textbox", { name: "Search providers" }) as HTMLInputElement;
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: "ANTH" } });
    expect(screen.getByRole("button", { name: /Anthropic/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ChatGPT/ })).toBeNull();

    fireEvent.change(search, { target: { value: "codex" } });
    expect(screen.getByRole("button", { name: /ChatGPT/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Anthropic/ })).toBeNull();

    // Advanced rows are searchable while collapsed, and the footer toggle steps aside meanwhile.
    fireEvent.change(search, { target: { value: "router" } });
    expect(screen.getByRole("button", { name: /openrouter/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Advanced" })).toBeNull();

    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No providers match “zzz”")).toBeTruthy();

    // Escape clears the filter even after focus leaves the search field.
    const close = screen.getByTitle("Cancel");
    close.focus();
    expect(fireEvent.keyDown(close, { key: "Escape" })).toBe(false);
    expect(search.value).toBe("");
    expect(screen.getByRole("button", { name: /Anthropic/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ChatGPT/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Advanced" })).toBeTruthy();
    // Empty: Esc is left alone, so the dialog's cancel closes it as before.
    expect(fireEvent.keyDown(search, { key: "Escape" })).toBe(true);
  });

  it("filters Models with the same search field and empty line", () => {
    render(
      <ChatModelDialog
        {...base}
        models={[
          { provider: "xai", id: "grok-4.6" },
          { provider: "anthropic", id: "claude-opus" },
        ]}
      />,
    );
    const search = screen.getByRole("textbox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "OPUS" } });
    expect(screen.getByRole("button", { name: /anthropic\/claude-opus/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /xai\/grok-4\.6/ })).toBeNull();
    fireEvent.change(search, { target: { value: "nothing" } });
    expect(screen.queryByRole("button", { name: /anthropic\/claude-opus/ })).toBeNull();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.getByRole("button", { name: /xai\/grok-4\.6/ })).toBeTruthy();
  });

  it("switches tabs with arrow keys and focuses the search with ⌘F", () => {
    const onTabChange = vi.fn();
    render(<ChatModelDialog {...base} tab="accounts" onTabChange={onTabChange} />);
    const accounts = screen.getByRole("tab", { name: "Accounts" });
    accounts.focus();
    fireEvent.keyDown(accounts, { key: "ArrowRight" });
    expect(onTabChange).toHaveBeenCalledWith("models");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Models" }));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search providers" }));
  });

  it("shows Connecting… instead of ready-empty copy while the catalogue is connecting", () => {
    const connecting = { catalogueStatus: "connecting" as const };
    const models = renderToStaticMarkup(<ChatModelDialog {...base} models={[]} {...connecting} />);
    expect(models).toContain("Connecting…");
    expect(models).not.toContain("No models match");
    const accounts = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" models={[]} loginProviders={[]} {...connecting} />);
    expect(accounts).toContain("Connecting…");
    expect(accounts).not.toContain("No Chat-capable providers yet.");
  });

  it("does not list favourites when the catalogue is empty", () => {
    const html = renderToStaticMarkup(<ChatModelDialog {...base} models={[]} favorites={["xai/grok-4.6"]} onToggleFavorite={vi.fn()} />);
    expect(html).toContain("No models match");
    expect(html).not.toContain("chat-model-item");
  });

  it("does not list a starred model the query does not match", () => {
    render(<ChatModelDialog {...base} favorites={["xai/grok-4.6"]} onToggleFavorite={vi.fn()} preselect="nope-nope" />);
    expect(screen.queryByRole("button", { name: /xai\/grok-4.6/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still lists a starred model the query matches", () => {
    const html = renderToStaticMarkup(<ChatModelDialog {...base} favorites={["xai/grok-4.6"]} onToggleFavorite={vi.fn()} preselect="grok" />);
    expect(html).toContain("xai/grok-4.6");
    expect(html).not.toContain("No models match");
  });

  it("pins Alinery at the top of Accounts and lists hosted models with a cost band", () => {
    const hosted = {
      provider: "alinery",
      defaultModel: "alinery/Qwen3.6-35B-A3B",
      baseUrl: "https://inference.alinery.ai/v1",
      plansUrl: "https://accounts.alinery.ai/plans",
      models: [{ id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B", contextWindow: 1, maxTokens: 1, price: 2 }],
      ready: true,
      upsell: null,
      source: "live",
    };
    const accounts = renderToStaticMarkup(
      <ChatModelDialog
        {...base}
        tab="accounts"
        hosted={hosted}
        models={[{ provider: "anthropic", id: "claude" }]}
        loginProviders={[{ id: "anthropic", name: "Anthropic", available: true, authenticated: false }]}
      />,
    );
    expect(accounts.indexOf("Alinery")).toBeGreaterThan(-1);
    expect(accounts.indexOf("Alinery")).toBeLessThan(accounts.indexOf("Anthropic"));
    expect(accounts).toContain("Ready");
    expect(accounts).not.toContain("Advanced");

    const models = renderToStaticMarkup(<ChatModelDialog {...base} hosted={hosted} />);
    expect(models).toContain("alinery/Qwen3.6-35B-A3B");
    expect(models).toContain("cost 2 of 5");
    expect(models).toContain("xai/grok-4.6");
  });

  it("upsells unsigned hosted models instead of applying them", () => {
    const hosted = {
      provider: "alinery",
      defaultModel: "alinery/Qwen3.6-35B-A3B",
      baseUrl: "https://inference.alinery.ai/v1",
      plansUrl: "https://accounts.alinery.ai/plans",
      models: [{ id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B", contextWindow: 1, maxTokens: 1, price: 1 }],
      ready: false,
      upsell: "sign-in" as const,
      source: "live",
    };
    const accounts = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" hosted={hosted} />);
    expect(accounts).toContain("Sign in");
    const unpaid = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" hosted={{ ...hosted, upsell: "subscribe" }} />);
    expect(unpaid).toContain("Subscribe");
    const buy = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" hosted={{ ...hosted, upsell: "buy-credits" }} />);
    expect(buy).toContain("Buy credits");
    const balanced = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" hosted={{ ...hosted, ready: true, upsell: null, balanceCents: 1300 }} />);
    expect(balanced).toContain("$13.00");
    const models = renderToStaticMarkup(<ChatModelDialog {...base} hosted={hosted} />);
    expect(models).toContain("alinery/Qwen3.6-35B-A3B");
  });

  it("keeps unpaid hosted model clicks in the dialog instead of opening billing", () => {
    const hosted = {
      provider: "alinery",
      defaultModel: "alinery/Qwen3.6-35B-A3B",
      baseUrl: "https://inference.alinery.ai/v1",
      plansUrl: "https://accounts.alinery.ai/plans",
      models: [{ id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B", contextWindow: 1, maxTokens: 1, price: 1 }],
      ready: false,
      upsell: "subscribe" as const,
      source: "live",
    };
    const onTabChange = vi.fn();
    const onSubscribe = vi.fn();
    const onApplyModel = vi.fn();
    render(<ChatModelDialog {...base} hosted={hosted} onTabChange={onTabChange} onSubscribe={onSubscribe} onApplyModel={onApplyModel} />);
    fireEvent.click(screen.getByRole("button", { name: /alinery\/Qwen3.6-35B-A3B/i }));
    expect(onApplyModel).not.toHaveBeenCalled();
    expect(onSubscribe).not.toHaveBeenCalled();
    expect(onTabChange).toHaveBeenCalledWith("accounts");
  });

  it("omits hosted models from role assignment until ready", () => {
    const hosted = {
      provider: "alinery",
      defaultModel: "alinery/Qwen3.6-35B-A3B",
      baseUrl: "https://inference.alinery.ai/v1",
      plansUrl: "https://accounts.alinery.ai/plans",
      models: [{ id: "Qwen3.6-35B-A3B", name: "Qwen3.6-35B-A3B", contextWindow: 1, maxTokens: 1, price: 1 }],
      ready: false,
      upsell: "sign-in" as const,
      source: "live",
    };
    render(<ChatModelDialog {...base} hosted={hosted} />);
    fireEvent.click(screen.getByText("Role defaults"));
    const values = [...screen.getByLabelText("Model for default").querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value);
    expect(values).toContain("xai/grok-4.6");
    expect(values.some((value) => value.startsWith("alinery/"))).toBe(false);

    cleanup();
    render(<ChatModelDialog {...base} hosted={{ ...hosted, ready: true, upsell: null, source: "live" }} />);
    fireEvent.click(screen.getByText("Role defaults"));
    const readyValues = [...screen.getByLabelText("Model for default").querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value);
    expect(readyValues).toContain("alinery/Qwen3.6-35B-A3B");
  });

  it("preserves unavailable role assignments and permits replacing or clearing them", () => {
    const onAssignRole = vi.fn();
    render(<ChatModelDialog {...base} modelRoles={{ default: "old/private" }} onAssignRole={onAssignRole} />);
    fireEvent.click(screen.getByText("Role defaults"));
    const select = screen.getByLabelText("Model for default") as HTMLSelectElement;
    expect(select.value).toBe("old/private");
    fireEvent.change(select, { target: { value: "xai/grok-4.6" } });
    expect(onAssignRole).toHaveBeenLastCalledWith("default", "xai/grok-4.6");
    fireEvent.change(select, { target: { value: "" } });
    expect(onAssignRole).toHaveBeenLastCalledWith("default", null);
  });

  it("keeps diagnostics collapsed without blocking model selection", () => {
    const error = `project ownership unavailable: ${"project owner is still running (/repo/.alinery/owner.lock); ".repeat(30)}`;
    const onApplyModel = vi.fn();
    render(<ChatModelDialog {...base} error={error} onApplyModel={onApplyModel} />);
    const details = screen.getByText("Technical details").closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain(error);
    expect(screen.getByRole("alert").textContent).not.toContain(".lock");
    fireEvent.click(screen.getByRole("button", { name: /xai\/grok-4.6/ }));
    expect(onApplyModel).toHaveBeenCalledWith("xai", "grok-4.6");
  });
});

describe("ChatToolsDialog", () => {
  it("lists dumpTools names", () => {
    const html = renderToStaticMarkup(<ChatToolsDialog tools={[{ name: "read", description: "Read a file" }]} onClose={vi.fn()} />);
    expect(html).toContain("read");
    expect(html).toContain("Read a file");
  });
});

describe("ChatMcpDialog", () => {
  it("shows the empty sentence", () => {
    const html = renderToStaticMarkup(<ChatMcpDialog rows={[]} empty onPrompt={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("No MCP servers configured");
  });
});
