import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
