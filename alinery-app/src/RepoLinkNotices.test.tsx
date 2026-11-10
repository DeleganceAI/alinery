import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { RepoLinkNotices } from "./shared";

vi.mock("./ipc", async () => (await import("./test/mockIpc")).mockIpc());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const down = (repo: string) => ({ [repo]: { loaded: true, reachable: false, stale: true } });

describe("RepoLinkNotices", () => {
  it("offers Reconnect: a local repo reattaches its daemon", () => {
    render(<RepoLinkNotices repos={down("/repo-a")} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(ipc.setActiveRepo).toHaveBeenCalledWith("/repo-a");
  });

  it("offers Reconnect: a remote repo reconnects its host", () => {
    render(<RepoLinkNotices repos={down("alinery+ssh://box-1/srv/app")} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(ipc.remoteConnect).toHaveBeenCalledWith("box-1", false);
  });

  it("shows nothing for a repo that answers", () => {
    render(<RepoLinkNotices repos={{ "/repo-a": { loaded: true, reachable: true, stale: false } }} />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });
});
