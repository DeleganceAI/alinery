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

  it("renders models tab with current and role table", () => {
    const empty = renderToStaticMarkup(<ChatModelDialog {...base} models={[]} />);
    expect(empty).toContain("No models match");
    const html = renderToStaticMarkup(<ChatModelDialog {...base} />);
    expect(html).toContain("xai/grok-4.6");
    expect(html).toContain("current");
    expect(html).toContain("smol");
    expect(html).toContain("Role assignments apply");
  });

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
    expect(html).toContain("signed in");
    expect(html).toContain("Baseten");
    expect(html).toContain("openrouter");
    expect(html).toContain("Terminal /login");
    expect(html).toContain("ready via env");
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
    const html = renderToStaticMarkup(<ChatModelDialog {...base} favorites={["xai/grok-4.6"]} onToggleFavorite={vi.fn()} preselect="nope-nope" />);
    expect(html).toContain("No models match");
    expect(html).not.toContain(">xai/grok-4.6<");
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
    expect(accounts).toContain("ready");
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
      source: "fixture",
    };
    const accounts = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" hosted={hosted} />);
    expect(accounts).toContain("Sign in");
    const unpaid = renderToStaticMarkup(<ChatModelDialog {...base} tab="accounts" hosted={{ ...hosted, upsell: "get-credits" }} />);
    expect(unpaid).toContain("Get credits");
    const models = renderToStaticMarkup(<ChatModelDialog {...base} hosted={hosted} />);
    expect(models).toContain("alinery/Qwen3.6-35B-A3B");
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
      source: "fixture",
    };
    render(<ChatModelDialog {...base} hosted={hosted} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" })[0]);
    const values = [...screen.getByLabelText(/Assign/).querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value);
    expect(values).toContain("xai/grok-4.6");
    expect(values.some((value) => value.startsWith("alinery/"))).toBe(false);

    cleanup();
    render(<ChatModelDialog {...base} hosted={{ ...hosted, ready: true, upsell: null, source: "live" }} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" })[0]);
    const readyValues = [...screen.getByLabelText(/Assign/).querySelectorAll("option")].map((option) => (option as HTMLOptionElement).value);
    expect(readyValues).toContain("alinery/Qwen3.6-35B-A3B");
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
