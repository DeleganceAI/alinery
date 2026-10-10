import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDevelopmentProductName, TopBar } from "./shared";
import type { AppConfig, OmpUpdateStatus, UpdateStatus } from "./types";

vi.mock("./WindowChrome", () => ({ WindowControls: () => null }));
vi.mock("./AccountMenu", () => ({
  AccountMenu: ({ onOpenNotifications, onOpenSettings }: { onOpenNotifications: () => void; onOpenSettings: () => void }) => (
    <>
      <button type="button" onClick={onOpenNotifications}>
        Account menu notifications
      </button>
      <button type="button" onClick={onOpenSettings}>
        Account menu
      </button>
    </>
  ),
}));

const appConfig = { active_repo: "/tmp/repo", known_repos: ["/tmp/repo"] } as AppConfig;
const callbacks = {
  onSwitch: vi.fn(),
  onSwitchGrid: vi.fn(),
  onSelectRepo: vi.fn(),
  onRemoveRepo: vi.fn(),
  onAddRepo: vi.fn(),
  onBrand: vi.fn(),
  onSearch: vi.fn(),
  onCreate: vi.fn(),
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
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("TopBar navigation", () => {
  const tabLabels = () => Array.from(document.querySelectorAll("nav.tabs .tab")).map((tab) => tab.firstChild?.textContent);

  it("leads with every custom grid, then Tasks, Sessions, Kanban and Chat, and has no Notifications tab", () => {
    render(
      <TopBar
        active="list"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        showOriginalKanban
        showChat
        gridViews={[
          { id: "planning", name: "Planning", slot: 1 },
          { id: "triage", name: "Triage", slot: 2 },
        ]}
        {...callbacks}
      />,
    );
    expect(tabLabels()).toEqual(["Planning", "Triage", "Tasks", "Sessions", "Kanban", "Chat", "Playbooks"]);
    // Two Grid views push everything else right: ⌘1 and ⌘2 are the grids, ⌘5 is Kanban, ⌘6 is Chat.
    expect(Array.from(document.querySelectorAll("nav.tabs .k")).map((badge) => badge.textContent)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  });

  it("hides the Chat tab unless the experimental flag is on", () => {
    const { unmount } = render(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} showOriginalKanban {...callbacks} />);
    expect(tabLabels()).not.toContain("Chat");
    unmount();
    render(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} showOriginalKanban showChat {...callbacks} />);
    expect(tabLabels()).toContain("Chat");
  });

  it("opens Notifications and Settings from the account menu", () => {
    render(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu notifications" }));
    expect(callbacks.onSwitch).toHaveBeenCalledWith("notifications");
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(callbacks.onSwitch).toHaveBeenCalledWith("settings");
  });

  it("opens the playbook library from a task destination", () => {
    render(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Playbooks" }));
    expect(callbacks.onSwitch).toHaveBeenCalledWith("playbooks");
  });

  it("opens the chosen configured grid rather than the currently active grid", () => {
    render(
      <TopBar
        active="grid"
        activeGridViewId="planning"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        gridViews={[
          { id: "planning", name: "Planning", slot: 1 },
          { id: "triage", name: "Triage", slot: 2 },
        ]}
        {...callbacks}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Triage/ }));
    expect(callbacks.onSwitchGrid).toHaveBeenCalledWith("triage");
  });

  it("keeps search and creation independently actionable", () => {
    render(<TopBar active="playbooks" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(callbacks.onSearch).toHaveBeenCalledOnce();
    expect(callbacks.onCreate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(callbacks.onCreate).toHaveBeenCalledOnce();
  });
});

describe("update actions", () => {
  const update: UpdateStatus = {
    current: "0.10.0",
    available: { version: "0.11.0", url: "", sha256: "", size: 0, protocol_version: 2, published_at: "" },
    checked_at: 1,
  };
  const ompUpdate: OmpUpdateStatus = {
    installed: "18.1.10",
    available: { version: "v18.2.0", asset_url: "https://example.test/omp" },
    checked_at: 1,
    binary_path: "/Applications/Alinery.omp/omp",
    config_dir: "/tmp/cfg/omp/config/agent",
  };

  it("keeps the OMP and application upgrades independent", () => {
    const onUpgrade = vi.fn();
    const onOmpUpdateClick = vi.fn();
    render(
      <TopBar
        active="kanban"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        update={update}
        ompUpdate={ompUpdate}
        onUpgrade={onUpgrade}
        onOmpUpdateClick={onOmpUpdateClick}
        {...callbacks}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "OMP update v18.2.0" }));
    expect(onOmpUpdateClick).toHaveBeenCalledOnce();
    expect(onUpgrade).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade to 0.11.0" }));
    expect(onUpgrade).toHaveBeenCalledOnce();
    expect(onOmpUpdateClick).toHaveBeenCalledOnce();
  });
});

describe("effective product identity", () => {
  it.each([
    ["Alinery Dev", true],
    ["Alinery", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("classifies %j as development = %s", (name, expected) => {
    expect(isDevelopmentProductName(name)).toBe(expected);
  });
});
