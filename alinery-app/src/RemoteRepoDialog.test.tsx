import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "./confirm";
import * as ipc from "./ipc";
import { RemoteRepoDialog } from "./RemoteRepoDialog";
import type * as IpcFixtures from "./test/mockIpc";
import type { RemoteHostView } from "./types";

vi.mock("./ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("./test/mockIpc");
  return mockIpc({
    remoteHosts: vi.fn(),
    remoteAddHost: vi.fn(),
    remoteConnect: vi.fn(),
    remoteListDir: vi.fn(),
    remoteClassify: vi.fn(),
    remoteInit: vi.fn(),
    remoteAddRepo: vi.fn(),
  });
});

const host: RemoteHostView = {
  host_id: "box-a1b2c3",
  label: "box",
  destination: "-p 2222 me@box",
  state: "connected",
  phase: "",
  error: null,
  home: "/home/me",
  platform: "Linux x86_64",
};
const listing = (path: string, names: Array<[string, boolean]>) => ({
  path,
  entries: names.map(([name, git]) => ({ name, git, symlink: false })),
  truncated: false,
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
beforeEach(() => {
  vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
  vi.mocked(ipc.remoteAddHost).mockResolvedValue(host);
  vi.mocked(ipc.remoteConnect).mockResolvedValue();
  vi.mocked(ipc.remoteListDir).mockImplementation(async (_id, path) =>
    path === "/home/me"
      ? listing(path, [
          ["proj", true],
          ["notes", false],
        ])
      : listing(path, []),
  );
});

function mount(props: { hostId?: string; onOpened?: (key: string) => void; onClose?: () => void } = {}) {
  const onOpened = props.onOpened ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <>
      <RemoteRepoDialog hostId={props.hostId} hosts={[host]} onOpened={onOpened} onClose={onClose} />
      <ConfirmHost />
    </>,
  );
  return { onOpened, onClose };
}

async function connectViaDestination() {
  fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "ssh -p 2222 me@box" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByRole("list", { name: "Folders" });
}

describe("RemoteRepoDialog", () => {
  it("adds the destination, connects, and lists the host's home folder", async () => {
    mount();
    await connectViaDestination();

    expect(ipc.remoteAddHost).toHaveBeenCalledWith("ssh -p 2222 me@box");
    expect(ipc.remoteConnect).toHaveBeenCalledWith("box-a1b2c3", false);
    expect(ipc.remoteListDir).toHaveBeenCalledWith("box-a1b2c3", "/home/me", false);
    const folders = screen.getByRole("list", { name: "Folders" });
    expect(within(folders).getByText("proj")).toBeTruthy();
    expect(within(folders).getByText("git")).toBeTruthy();
    expect(within(folders).getByText("notes")).toBeTruthy();
  });

  it("reconnects a known host without asking for a destination", async () => {
    mount({ hostId: "box-a1b2c3" });
    await screen.findByRole("list", { name: "Folders" });
    expect(ipc.remoteAddHost).not.toHaveBeenCalled();
    expect(ipc.remoteConnect).toHaveBeenCalledWith("box-a1b2c3", false);
  });

  it("asks before trusting a first-seen host key, and connects with trust only after yes", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValueOnce("host-key-unknown: this host's key is not in known_hosts yet").mockResolvedValue();
    mount();
    fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "me@box" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(ipc.remoteConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Trust and connect" }));

    await screen.findByRole("list", { name: "Folders" });
    expect(vi.mocked(ipc.remoteConnect).mock.calls).toEqual([
      ["box-a1b2c3", false],
      ["box-a1b2c3", true],
    ]);
  });

  it("returns to the destination with the reason when the host refuses", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValue("ssh authentication failed. Alinery connects without prompts");
    mount();
    fireEvent.change(screen.getByLabelText("SSH destination"), { target: { value: "me@box" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain("authentication failed");
    expect(screen.getByLabelText("SSH destination")).toBeTruthy();
  });

  it("browses into a folder and up again", async () => {
    mount();
    await connectViaDestination();
    fireEvent.click(screen.getByRole("button", { name: /proj/ }));
    await waitFor(() => expect(ipc.remoteListDir).toHaveBeenLastCalledWith("box-a1b2c3", "/home/me/proj", false));
    fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
    await waitFor(() => expect(ipc.remoteListDir).toHaveBeenLastCalledWith("box-a1b2c3", "/home/me", false));
  });

  it("opens a git checkout and hands back its key", async () => {
    vi.mocked(ipc.remoteClassify).mockResolvedValue({ kind: "checkout", root: "/home/me" });
    vi.mocked(ipc.remoteAddRepo).mockResolvedValue("alinery+ssh://box-a1b2c3/home/me");
    const { onOpened, onClose } = mount();
    await connectViaDestination();
    fireEvent.click(screen.getByRole("button", { name: "Open this folder" }));

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/home/me"));
    expect(ipc.remoteInit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("initializes Git only after confirming, and not when cancelled", async () => {
    vi.mocked(ipc.remoteClassify).mockResolvedValue({ kind: "absent", path: "/home/me" });
    vi.mocked(ipc.remoteInit).mockResolvedValue({ kind: "initialized", root: "/home/me" });
    vi.mocked(ipc.remoteAddRepo).mockResolvedValue("alinery+ssh://box-a1b2c3/home/me");
    const { onOpened } = mount();
    await connectViaDestination();

    fireEvent.click(screen.getByRole("button", { name: "Open this folder" }));
    // The confirm's default focus is its safe choice (Cancel), so that is the autofocus button.
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(confirm.querySelector<HTMLElement>("[data-autofocus]") as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(ipc.remoteInit).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open this folder" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Initialize Git" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/home/me"));
    expect(ipc.remoteInit).toHaveBeenCalledWith("box-a1b2c3", "/home/me");
  });

  it("shows why a folder cannot be opened", async () => {
    vi.mocked(ipc.remoteClassify).mockResolvedValue({ kind: "refused", message: "That folder is inside a larger repository" });
    const { onOpened } = mount();
    await connectViaDestination();
    fireEvent.click(screen.getByRole("button", { name: "Open this folder" }));
    expect((await screen.findByRole("alert")).textContent).toContain("larger repository");
    expect(onOpened).not.toHaveBeenCalled();
  });
});
