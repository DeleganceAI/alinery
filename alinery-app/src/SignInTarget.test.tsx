import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { SignInTarget } from "./SignInTarget";
import type * as IpcFixtures from "./test/mockIpc";
import type { AppConfig, RemoteHostView } from "./types";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc({ readAppConfig: vi.fn(), remoteHosts: vi.fn() });
});

const config = (active_repo: string) => ({ active_repo, known_repos: [active_repo], mcp_enabled: true }) as AppConfig;
const host = { host_id: "box-a1b2c3", label: "Build box" } as RemoteHostView;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("SignInTarget", () => {
  it("names the host when the open repository lives on one", async () => {
    vi.mocked(ipc.readAppConfig).mockResolvedValue(config("alinery+ssh://box-a1b2c3/home/me/proj"));
    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    render(<SignInTarget />);
    expect((await screen.findByText(/stored on that host, not on this Mac/)).textContent).toContain("Build box");
  });

  it("says nothing for a repository on this Mac", async () => {
    vi.mocked(ipc.readAppConfig).mockResolvedValue(config("/Users/me/proj"));
    render(<SignInTarget />);
    await waitFor(() => expect(ipc.readAppConfig).toHaveBeenCalled());
    expect(screen.queryByText(/stored on that host/)).toBeNull();
    expect(ipc.remoteHosts).not.toHaveBeenCalled();
  });
});
