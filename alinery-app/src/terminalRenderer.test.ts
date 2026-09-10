import { describe, expect, it, vi } from "vitest";
import { attachGpuRenderer, type GpuRendererAddon, type GpuRendererTerminal } from "./terminalRenderer";

function fakeAddon(overrides: Partial<GpuRendererAddon> = {}): GpuRendererAddon {
  return {
    dispose: vi.fn(),
    onContextLoss: vi.fn(),
    ...overrides,
  };
}

describe("attachGpuRenderer", () => {
  it("loads the WebGL addon and reports webgl", () => {
    const addon = fakeAddon();
    const loadAddon = vi.fn();
    const term: GpuRendererTerminal = { loadAddon };

    expect(attachGpuRenderer(term, () => addon)).toBe("webgl");
    expect(loadAddon).toHaveBeenCalledWith(addon);
    expect(addon.onContextLoss).toHaveBeenCalledTimes(1);
  });

  it("falls back to DOM when the addon cannot be constructed", () => {
    const loadAddon = vi.fn();
    const term: GpuRendererTerminal = { loadAddon };

    expect(
      attachGpuRenderer(term, () => {
        throw new Error("WebGL2 unavailable");
      }),
    ).toBe("dom");
    expect(loadAddon).not.toHaveBeenCalled();
  });

  it("falls back to DOM and disposes when loadAddon rejects the context", () => {
    const addon = fakeAddon();
    const term: GpuRendererTerminal = {
      loadAddon: () => {
        throw new Error("getContext returned null");
      },
    };

    expect(attachGpuRenderer(term, () => addon)).toBe("dom");
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the addon on WebGL context loss so xterm can return to DOM", () => {
    let lost: (() => void) | undefined;
    const addon = fakeAddon({
      onContextLoss: (listener) => {
        lost = listener;
      },
    });
    attachGpuRenderer({ loadAddon: () => {} }, () => addon);

    expect(lost).toBeTypeOf("function");
    lost?.();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("swallows dispose errors on context loss so a racing unmount cannot throw", () => {
    let lost: (() => void) | undefined;
    const addon = fakeAddon({
      dispose: () => {
        throw new Error("already disposed");
      },
      onContextLoss: (listener) => {
        lost = listener;
      },
    });
    attachGpuRenderer({ loadAddon: () => {} }, () => addon);
    expect(() => lost?.()).not.toThrow();
  });
});
