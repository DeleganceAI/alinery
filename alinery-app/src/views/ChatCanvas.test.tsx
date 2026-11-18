import { create } from "@bufbuild/protobuf";
import { cleanup, render, screen } from "@testing-library/react";
import { CanvasSchema } from "alinery-proto/alinery/v1/entities_pb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockIpc } from "../test/mockIpc";
import { ChatCanvas } from "./ChatCanvas";

vi.mock("../ipc", () => mockIpc());

const bodies = vi.hoisted(() => new Map<string, () => Promise<string>>());
vi.mock("../sync/chat", async (actual) => ({
  ...(await actual()),
  readCanvasPanel: vi.fn((_repo: string, _thread: string, panel: string) => bodies.get(panel)?.() ?? Promise.resolve("")),
  closeCanvasPanel: vi.fn(async () => {}),
}));

const canvas = (...panels: { id: string; kind: string; rev: bigint; title?: string }[]) => create(CanvasSchema, { panels, focus: "" });

beforeEach(() => {
  bodies.clear();
  // React logs what a boundary catches; keep the output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ChatCanvas", () => {
  it("shows a panel that throws while drawing as an error in its slot, and keeps the other panels", async () => {
    bodies.set("t", async () => "not json");
    bodies.set("m", async () => "# Still here");
    render(<ChatCanvas repo="/r" threadId="th" canvas={canvas({ id: "t", kind: "table", rev: 1n }, { id: "m", kind: "markdown", rev: 1n })} />);
    expect(await screen.findByText(/This panel could not be drawn/)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Still here" })).toBeTruthy();
    expect(screen.queryByText(/Something broke while drawing this screen/)).toBeNull();
  });

  it("keeps drawing the old body as its own kind while a new kind under the same id loads", async () => {
    bodies.set("p", async () => "# Plan");
    const { rerender } = render(<ChatCanvas repo="/r" threadId="th" canvas={canvas({ id: "p", kind: "markdown", rev: 1n })} />);
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();

    let release = (_: string) => {};
    bodies.set("p", () => new Promise((resolve) => (release = resolve)));
    rerender(<ChatCanvas repo="/r" threadId="th" canvas={canvas({ id: "p", kind: "table", rev: 2n })} />);
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.queryByText(/could not be drawn/)).toBeNull();

    release(JSON.stringify({ columns: ["name"], rows: [["ava"]] }));
    expect(await screen.findByText("ava")).toBeTruthy();
  });
});
