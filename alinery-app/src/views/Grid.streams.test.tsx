// The grid on the real repo streams (a fake daemon behind the real replicas), where Grid.test.tsx states rows directly.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonTransport } from "../daemon/transport";
import { mockIpc } from "../test/mockIpc";
import { sessionDaemon } from "../test/sessionDaemon";
import { Grid } from "./Grid";

vi.mock("../daemon/transport", () => ({ daemonTransport: vi.fn() }));
vi.mock("../WindowChrome", () => ({ WindowControls: () => null }));
let daemon = sessionDaemon();
vi.mock("../ipc", () =>
  mockIpc({
    listKanbanColumns: async () => [],
    listTaskPullRequests: async () => ({}),
  }),
);

const steps = [
  { key: "research", title: "Research" },
  { key: "implementation", title: "Implementation" },
];
const board = (currentPhase: string, currentStepTitle: string) => ({ playbookTitle: "SuperDevelop", playbookSteps: steps, currentPhase, currentStepTitle });
const props = { allRepos: true, onOpen: () => {}, registerNav: () => {}, storageKey: "streams", initialPreset: "kanban" as const };
const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
  daemon = sessionDaemon();
  vi.mocked(daemonTransport).mockImplementation((repo) => daemon.transport(repo));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("grid on repo streams", () => {
  it("moves a card to its new step on a task delta, with no poll", async () => {
    daemon.showTask("/repo-a", "build", { name: "Build API", board: board("research", "Research") });
    render(<Grid repoPaths={["/repo-a"]} {...props} />);
    await settle();
    expect(screen.getByRole("button", { name: /^Build API, repo-a, SuperDevelop, Research/ })).toBeDefined();

    daemon.showTask("/repo-a", "build", { name: "Build API", board: board("implementation", "Implementation") });
    await settle();
    expect(screen.getByRole("button", { name: /^Build API, repo-a, SuperDevelop, Implementation/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Build API, repo-a, SuperDevelop, Research/ })).toBeNull();
  });

  it("shows the repo that went down as stale while the other repo stays live", async () => {
    daemon.showTask("/repo-a", "build", { name: "Build API", board: board("research", "Research") });
    daemon.showTask("/repo-b", "review", { name: "Review queue", board: board("research", "Research") });
    render(<Grid repoPaths={["/repo-a", "/repo-b"]} {...props} />);
    await settle();
    expect(screen.queryByText(/daemon not connected/)).toBeNull();

    daemon.drop("/repo-b");
    await settle();
    expect(screen.getByText("repo-b: daemon not connected, showing the last known tasks")).toBeDefined();
    expect(screen.getByRole("button", { name: /^Review queue, repo-b/ })).toBeDefined();

    daemon.showTask("/repo-a", "build", { name: "Build API", board: board("implementation", "Implementation") });
    await settle();
    expect(screen.getByRole("button", { name: /^Build API, repo-a, SuperDevelop, Implementation/ })).toBeDefined();
    expect(screen.queryByText(/repo-a: /)).toBeNull();
  });

  it("shows only the banner for a repo whose daemon cannot be used", async () => {
    daemon.showTask("/repo-a", "build", { name: "Build API", board: board("research", "Research") });
    daemon.drop("/repo-a");
    render(<Grid repoPaths={["/repo-a"]} {...props} />);
    await settle();
    expect(screen.getByText("repo-a: no daemon connection")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Build API/ })).toBeNull();
  });
});
