import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTabPill } from "./tabMotion";

describe("useTabPill", () => {
  const observers: Array<{ cb: ResizeObserverCallback }> = [];

  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function Probe({ active, instant }: { active: string; instant: boolean }) {
    const ref = useRef<HTMLElement>(null);
    useTabPill(ref, active, instant);
    return (
      <nav ref={ref} className="tabs">
        <button type="button" className="tab" data-tab="kanban" />
        <button type="button" className="tab" data-tab="list" />
      </nav>
    );
  }

  function mockBoxes() {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: ResizeObserverCallback;
        constructor(cb: ResizeObserverCallback) {
          this.cb = cb;
          observers.push({ cb });
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.tab === "list") return { left: 80, width: 40, top: 0, right: 120, bottom: 28, height: 28, x: 80, y: 0, toJSON() {} };
      if (this.classList.contains("tabs")) return { left: 0, width: 200, top: 0, right: 200, bottom: 28, height: 28, x: 0, y: 0, toJSON() {} };
      return { left: 0, width: 40, top: 0, right: 40, bottom: 28, height: 28, x: 0, y: 0, toJSON() {} };
    });
  }

  it("does not snap the pill when ResizeObserver delivers its first observation after a pointer switch", () => {
    mockBoxes();
    const { container } = render(<Probe active="list" instant={false} />);
    const nav = container.querySelector("nav");
    expect(nav?.classList.contains("instant")).toBe(false);
    observers[0].cb([] as unknown as ResizeObserverEntry[], observers[0] as unknown as ResizeObserver);
    expect(nav?.classList.contains("instant")).toBe(false);
  });
});
