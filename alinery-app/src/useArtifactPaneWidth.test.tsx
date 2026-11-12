import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_VIEWER_WIDTH_MAX, ARTIFACT_VIEWER_WIDTH_MIN, clampArtifactViewerWidth, DEFAULT_APPEARANCE } from "./appearance";
import { PaneResizer } from "./PaneResizer";
import { mockIpc } from "./test/mockIpc";
import type { AppearancePrefs } from "./types";
import { useArtifactPaneWidth } from "./useArtifactPaneWidth";

vi.mock("./ipc", () =>
  mockIpc({
    writeAppearance: vi.fn(async (appearance: AppearancePrefs) => ({
      active_repo: "",
      known_repos: [],
      mcp_enabled: true,
      appearance,
    })),
  }),
);

import * as ipc from "./ipc";

afterEach(cleanup);

beforeEach(() => {
  vi.mocked(ipc.writeAppearance).mockClear();
});

function Probe({ appearance, onAppearanceChange, side }: { appearance: AppearancePrefs; onAppearanceChange: (next: AppearancePrefs) => void; side?: "left" | "right" }) {
  const [width, resizerProps] = useArtifactPaneWidth(appearance, onAppearanceChange, side);
  return (
    <div>
      <div data-testid="width">{width}</div>
      <div className="artifact-resizer" {...resizerProps} />
    </div>
  );
}

const appearanceAt = (artifact_viewer_width: number): AppearancePrefs => ({ ...DEFAULT_APPEARANCE, artifact_viewer_width });

function CollapsibleProbe() {
  const [width, props, collapse] = useArtifactPaneWidth(appearanceAt(480), vi.fn());
  return (
    <div>
      <div data-testid="width">{width}</div>
      <div data-testid="collapsed">{String(collapse.collapsed)}</div>
      <PaneResizer props={props} collapse={collapse} />
    </div>
  );
}

describe("useArtifactPaneWidth", () => {
  it("snaps shut when dragged well past the minimum and reopens at the width it had", () => {
    render(<CollapsibleProbe />);
    const resizer = screen.getByRole("separator", { name: "Resize artifact pane" });
    // A right-side pane shrinks as the divider moves right: 480 - 300 is past the minimum, but not far enough to snap.
    fireEvent.pointerDown(resizer, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 720 });
    expect(screen.getByTestId("collapsed").textContent).toBe("false");
    fireEvent.pointerUp(window, { clientX: 720 });
    expect(screen.getByTestId("collapsed").textContent).toBe("false");

    fireEvent.pointerDown(resizer, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 900 });
    fireEvent.pointerUp(window, { clientX: 900 });
    expect(screen.getByTestId("collapsed").textContent).toBe("true");
    expect(ipc.writeAppearance).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show side panel" }));
    expect(screen.getByTestId("collapsed").textContent).toBe("false");
    expect(screen.getByTestId("width").textContent).toBe(String(ARTIFACT_VIEWER_WIDTH_MIN));
  });

  it("seeds from appearance and does not persist on mount", () => {
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={vi.fn()} />);
    expect(screen.getByTestId("width").textContent).toBe("480");
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
  });

  it("exposes the resize handle as a named separator", () => {
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={vi.fn()} />);
    const resizer = screen.getByRole("separator", { name: "Resize artifact pane" });
    expect(resizer.getAttribute("aria-orientation")).toBe("vertical");
    expect(resizer.getAttribute("aria-valuemin")).toBe(String(ARTIFACT_VIEWER_WIDTH_MIN));
    expect(resizer.getAttribute("aria-valuemax")).toBe(String(clampArtifactViewerWidth(ARTIFACT_VIEWER_WIDTH_MAX)));
    expect(resizer.getAttribute("aria-valuenow")).toBe("480");
    expect(resizer.getAttribute("tabindex")).toBe("0");
  });

  it("persists the next width after a real drag", () => {
    const onAppearanceChange = vi.fn();
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={onAppearanceChange} />);

    fireEvent.pointerDown(document.querySelector(".artifact-resizer") as Element, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window, { clientX: 400 });

    expect(screen.getByTestId("width").textContent).toBe("580");
    expect(onAppearanceChange).toHaveBeenCalledOnce();
    expect(vi.mocked(ipc.writeAppearance).mock.calls[0][0]).toEqual(appearanceAt(580));
  });

  it("grows a left-side pane when dragged or arrowed to the right", () => {
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={vi.fn()} side="left" />);
    const resizer = screen.getByRole("separator", { name: "Resize artifact pane" });

    fireEvent.pointerDown(resizer, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window, { clientX: 600 });
    expect(screen.getByTestId("width").textContent).toBe("580");

    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(screen.getByTestId("width").textContent).toBe("600");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(screen.getByTestId("width").textContent).toBe("580");
  });

  it("persists keyboard width changes through the appearance path", () => {
    const onAppearanceChange = vi.fn();
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={onAppearanceChange} />);
    const resizer = screen.getByRole("separator", { name: "Resize artifact pane" });

    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(screen.getByTestId("width").textContent).toBe("500");
    expect(onAppearanceChange).toHaveBeenLastCalledWith(appearanceAt(500));
    expect(vi.mocked(ipc.writeAppearance).mock.calls[vi.mocked(ipc.writeAppearance).mock.calls.length - 1][0]).toEqual(appearanceAt(500));

    fireEvent.keyDown(resizer, { key: "ArrowRight" });
    expect(screen.getByTestId("width").textContent).toBe("480");
    expect(onAppearanceChange).toHaveBeenLastCalledWith(appearanceAt(480));
    expect(vi.mocked(ipc.writeAppearance).mock.calls[vi.mocked(ipc.writeAppearance).mock.calls.length - 1][0]).toEqual(appearanceAt(480));
  });

  it("supports Home and End keyboard resizing", () => {
    const onAppearanceChange = vi.fn();
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={onAppearanceChange} />);
    const resizer = screen.getByRole("separator", { name: "Resize artifact pane" });

    fireEvent.keyDown(resizer, { key: "Home" });
    expect(screen.getByTestId("width").textContent).toBe(String(ARTIFACT_VIEWER_WIDTH_MIN));
    expect(onAppearanceChange).toHaveBeenLastCalledWith(appearanceAt(ARTIFACT_VIEWER_WIDTH_MIN));

    fireEvent.keyDown(resizer, { key: "End" });
    const max = clampArtifactViewerWidth(ARTIFACT_VIEWER_WIDTH_MAX);
    expect(screen.getByTestId("width").textContent).toBe(String(max));
    expect(onAppearanceChange).toHaveBeenLastCalledWith(appearanceAt(max));
  });

  it("does not persist a click that does not move the pane", () => {
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={vi.fn()} />);

    fireEvent.pointerDown(document.querySelector(".artifact-resizer") as Element, { clientX: 500 });
    fireEvent.pointerUp(window, { clientX: 500 });

    expect(screen.getByTestId("width").textContent).toBe("480");
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
  });

  it("seeds the stored width without a viewport cap", () => {
    render(<Probe appearance={appearanceAt(1200)} onAppearanceChange={vi.fn()} />);
    expect(screen.getByTestId("width").textContent).toBe("1200");
  });

  it("does not persist a click when stored width exceeds the viewport cap", () => {
    render(<Probe appearance={appearanceAt(1200)} onAppearanceChange={vi.fn()} />);
    fireEvent.pointerDown(document.querySelector(".artifact-resizer") as Element, { clientX: 500 });
    fireEvent.pointerUp(window, { clientX: 500 });
    expect(screen.getByTestId("width").textContent).toBe("1200");
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
  });

  it("drops armed listeners on pointercancel so a later click does not persist", () => {
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={vi.fn()} />);
    fireEvent.pointerDown(document.querySelector(".artifact-resizer") as Element, { clientX: 500 });
    fireEvent.pointerCancel(window, { clientX: 400 });
    vi.mocked(ipc.writeAppearance).mockClear();
    fireEvent.pointerUp(window, { clientX: 300 });
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
  });

  it("ignores events from pointers other than the one that started the drag", () => {
    const onAppearanceChange = vi.fn();
    render(<Probe appearance={appearanceAt(480)} onAppearanceChange={onAppearanceChange} />);
    const resizer = document.querySelector(".artifact-resizer") as Element;
    fireEvent.pointerDown(resizer, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 400, pointerId: 2 });
    fireEvent.pointerUp(window, { clientX: 400, pointerId: 2 });
    expect(screen.getByTestId("width").textContent).toBe("480");
    expect(ipc.writeAppearance).not.toHaveBeenCalled();

    fireEvent.pointerMove(window, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 400, pointerId: 1 });
    expect(screen.getByTestId("width").textContent).toBe("580");
    expect(onAppearanceChange).toHaveBeenCalledOnce();
    expect(ipc.writeAppearance).toHaveBeenCalledOnce();
  });

  it("drops an active drag on unmount without persisting", () => {
    const onAppearanceChange = vi.fn();
    const { unmount } = render(<Probe appearance={appearanceAt(480)} onAppearanceChange={onAppearanceChange} />);
    fireEvent.pointerDown(document.querySelector(".artifact-resizer") as Element, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 400 });
    unmount();
    fireEvent.pointerUp(window, { clientX: 400 });
    expect(ipc.writeAppearance).not.toHaveBeenCalled();
    expect(onAppearanceChange).not.toHaveBeenCalled();
  });
});
