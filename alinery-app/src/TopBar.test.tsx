import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { isDevelopmentProductName, TopBar } from "./shared";
import type { AppConfig, OmpUpdateStatus, UpdateStatus } from "./types";

vi.mock("./WindowChrome", () => ({ WindowControls: () => null }));
vi.mock("./AccountMenu", () => ({
  AccountMenu: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button type="button" onClick={onOpenSettings}>
      Account menu
    </button>
  ),
}));

const appConfig = {
  active_repo: "/tmp/repo",
  known_repos: ["/tmp/repo"],
} as AppConfig;

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

describe("TopBar product identity", () => {
  it("puts Tasks first and omits Wiki", () => {
    const html = renderToStaticMarkup(
      <TopBar active="list" scope="active" appConfig={appConfig} isDev={false} showOriginalKanban gridViews={[{ id: "kanban-plus", name: "Kanban+", slot: 1 }]} {...callbacks} />,
    );

    expect(html.indexOf('>Tasks<span class="k">1</span>')).toBeLessThan(html.indexOf(">Kanban+"));
    expect(html.indexOf(">Kanban+")).toBeLessThan(html.indexOf('>Kanban<span class="k">3</span>'));
    expect(html).not.toContain(">Wiki</button>");
  });

  it("renders a sliding pill under the primary tabs", () => {
    const html = renderToStaticMarkup(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);

    expect(html).toContain('class="tabs"');
    expect(html).toContain('class="tab-indicator"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders top-level destinations in shortcut order and marks Notifications active", () => {
    const html = renderToStaticMarkup(
      <TopBar
        active="notifications"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        showOriginalKanban
        gridViews={[{ id: "kanban-plus", name: "Kanban+", slot: 1 }]}
        {...callbacks}
      />,
    );
    const labels = ['>Tasks<span class="k">1</span>', ">Kanban+", '>Kanban<span class="k">3</span>', '>Sessions<span class="k">7</span>', '>Notifications<span class="k">8</span>'];
    for (let index = 1; index < labels.length; index += 1) {
      expect(html.indexOf(labels[index - 1])).toBeLessThan(html.indexOf(labels[index]));
    }
    expect(html).toMatch(/class="tab on"[^>]*data-tab="notifications"/);
    expect(html).not.toContain(">Settings<span");
  });

  it("hints the search and new-task shortcuts without leaking them into the accessible name", () => {
    const html = renderToStaticMarkup(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);

    expect(html).toContain('<span class="k" aria-hidden="true">K</span>');
    expect(html).toContain('<span class="k" aria-hidden="true">N</span>');
  });

  it("renders an accessible DEV badge immediately after the brand mark in development", () => {
    const html = renderToStaticMarkup(<TopBar active="list" scope="active" appConfig={appConfig} isDev {...callbacks} />);

    expect(html).toContain('class="brand-mark"');
    expect(html).toMatch(/alt="Alinery"[\s\S]*>DEV</);
  });

  it("does not render a DEV badge in production", () => {
    const html = renderToStaticMarkup(<TopBar active="list" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);

    expect(html).not.toMatch(/>DEV</);
  });
});

describe("TopBar task views", () => {
  it("always renders Grid views without an experiment gate", () => {
    const html = renderToStaticMarkup(
      <TopBar
        active="grid"
        activeGridViewId="kanban-plus"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        gridViews={[{ id: "kanban-plus", name: "Kanban+", slot: 1 }]}
        {...callbacks}
      />,
    );

    expect(html).toContain(">Kanban+");
    expect(html).toContain('<span class="k">2</span>');
    expect(html).not.toContain(">Kanban<span");
  });

  it("renders configured Grid views with classic Kanban slotted at ⌘3", () => {
    const gridViews = [
      { id: "planning", name: "Planning", slot: 1 },
      { id: "triage", name: "Triage", slot: 2 },
    ];
    const html = renderToStaticMarkup(
      <TopBar active="grid" activeGridViewId="triage" scope="active" appConfig={appConfig} isDev={false} showOriginalKanban gridViews={gridViews} {...callbacks} />,
    );

    expect(html).toMatch(/aria-current="page"[^>]*data-tab="grid:triage"[^>]*>[\s\S]*Triage[\s\S]*<span class="k">4<\/span>/);
    expect(html.indexOf(">Tasks<span")).toBeLessThan(html.indexOf(">Planning<"));
    expect(html.indexOf(">Planning<")).toBeLessThan(html.indexOf(">Kanban<span"));
    expect(html.indexOf(">Kanban<span")).toBeLessThan(html.indexOf(">Triage<"));
    expect(html.indexOf(">Triage<")).toBeLessThan(html.indexOf(">Sessions<span"));
  });

  it("can hide only the original Kanban tab", () => {
    const html = renderToStaticMarkup(
      <TopBar
        active="grid"
        activeGridViewId="planning"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        showOriginalKanban={false}
        gridViews={[{ id: "planning", name: "Planning", slot: 1 }]}
        {...callbacks}
      />,
    );

    expect(html).not.toContain(">Kanban<span");
    expect(html).toContain(">Planning<");
  });
});

describe("upgrade button", () => {
  const withUpdate: UpdateStatus = {
    current: "0.10.0",
    available: { version: "0.11.0", url: "", sha256: "", size: 0, protocol_version: 2, published_at: "" },
    checked_at: 1,
  };

  it("renders nothing when no update prop is passed", () => {
    const html = renderToStaticMarkup(<TopBar active="kanban" scope="active" appConfig={appConfig} isDev={false} {...callbacks} />);

    expect(html).not.toContain("upgrade");
    expect(html).not.toMatch(/aria-label="Upgrade to/);
  });

  it("renders nothing when available is null", () => {
    const html = renderToStaticMarkup(
      <TopBar active="kanban" scope="active" appConfig={appConfig} isDev={false} update={{ current: "0.10.0", available: null, checked_at: 1 }} {...callbacks} />,
    );

    expect(html).not.toMatch(/aria-label="Upgrade to/);
  });

  it("renders the upgrade button and keeps the brand mark when an update is available", () => {
    const html = renderToStaticMarkup(<TopBar active="kanban" scope="active" appConfig={appConfig} isDev={false} update={withUpdate} {...callbacks} />);

    expect(html).toContain('aria-label="Upgrade to 0.11.0"');
    expect(html).toContain('class="brand-mark"');
  });

  it("shows both the DEV pill and the upgrade button in a dev build with an update", () => {
    const html = renderToStaticMarkup(<TopBar active="kanban" scope="active" appConfig={appConfig} isDev update={withUpdate} {...callbacks} />);

    expect(html).toMatch(/alt="Alinery"[\s\S]*>DEV</);
    expect(html).toContain('aria-label="Upgrade to 0.11.0"');
  });
});

describe("OMP update button", () => {
  const ompAvailable: OmpUpdateStatus = {
    installed: "18.1.10",
    available: { version: "v18.2.0", asset_url: "https://example.test/omp" },
    checked_at: 1,
    binary_path: "/Applications/Alinery.omp/omp",
    config_dir: "/tmp/cfg/omp/config/agent",
  };

  it("renders nothing when available is null", () => {
    const html = renderToStaticMarkup(
      <TopBar
        active="kanban"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        ompUpdate={{ installed: "18.1.10", available: null, checked_at: 1, binary_path: "", config_dir: "" }}
        {...callbacks}
      />,
    );
    expect(html).not.toMatch(/aria-label="OMP update/);
  });

  it("renders a distinct OMP button that does not fire onUpgrade", () => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
    const onUpgrade = vi.fn();
    const onOmpUpdateClick = vi.fn();
    const { container } = render(
      <TopBar
        active="kanban"
        scope="active"
        appConfig={appConfig}
        isDev={false}
        update={{
          current: "0.10.0",
          available: { version: "0.11.0", url: "", sha256: "", size: 0, protocol_version: 2, published_at: "" },
          checked_at: 1,
        }}
        ompUpdate={ompAvailable}
        onUpgrade={onUpgrade}
        onOmpUpdateClick={onOmpUpdateClick}
        {...callbacks}
      />,
    );
    const ompBtn = container.querySelector('button[aria-label="OMP update v18.2.0"]');
    expect(ompBtn).toBeTruthy();
    expect(ompBtn?.className).toContain("omp-update");
    expect(container.querySelector('button[aria-label="Upgrade to 0.11.0"]')).toBeTruthy();
    fireEvent.click(ompBtn as HTMLButtonElement);
    expect(onOmpUpdateClick).toHaveBeenCalledTimes(1);
    expect(onUpgrade).not.toHaveBeenCalled();
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
