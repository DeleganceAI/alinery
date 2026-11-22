import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type * as IpcFixtures from "./test/mockIpc";

vi.mock("./ipc", async () => (await vi.importActual<typeof IpcFixtures>("./test/mockIpc")).mockIpc());
const state = vi.hoisted(() => ({ total: null as number | null }));
vi.mock("./sync/hooks", () => ({
  REPO_SCOPE: {},
  useScope: () => ({}),
  useEntity: () => (state.total === null ? undefined : { value: { case: "teamComments", value: { total: state.total } } }),
}));
const info = vi.hoisted(() => vi.fn());
vi.mock("./toast", () => ({ toast: { info } }));

import { TeamCommentsNotice } from "./TeamCommentsNotice";

afterEach(() => {
  cleanup();
  info.mockClear();
});

it("takes the first count as the baseline, then says which repository got new comments", () => {
  state.total = 3;
  const view = render(<TeamCommentsNotice repo="/Users/me/motivore" />);
  expect(info).not.toHaveBeenCalled();
  state.total = 4;
  view.rerender(<TeamCommentsNotice repo="/Users/me/motivore" />);
  expect(info).toHaveBeenCalledWith("motivore got new comments");
  view.rerender(<TeamCommentsNotice repo="/Users/me/motivore" />);
  expect(info).toHaveBeenCalledTimes(1);
});

it("does not announce a daemon restart, which counts from zero again", () => {
  state.total = 5;
  const view = render(<TeamCommentsNotice repo="/Users/me/motivore" />);
  state.total = 0;
  view.rerender(<TeamCommentsNotice repo="/Users/me/motivore" />);
  expect(info).not.toHaveBeenCalled();
});

it("starts over for another repository", () => {
  state.total = 2;
  const view = render(<TeamCommentsNotice repo="/Users/me/motivore" />);
  state.total = 9;
  view.rerender(<TeamCommentsNotice repo="/Users/me/other" />);
  expect(info).not.toHaveBeenCalled();
});
