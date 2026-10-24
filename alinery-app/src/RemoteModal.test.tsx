import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "./confirm";
import * as ipc from "./ipc";
import { RemoteModal, type RemoteModalEntry } from "./RemoteModal";
import type * as IpcFixtures from "./test/mockIpc";
import type { RemoteHostView, RemoteSharingView } from "./types";

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
    remoteSharing: vi.fn(),
    remoteSetSharing: vi.fn(),
    remoteSshAliases: vi.fn(),
    remoteDescribeDestination: vi.fn(),
    remoteDiscardHost: vi.fn(),
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
  sharing_reviewed: true,
  erased_sign_ins: [],
};
const offline: RemoteHostView = { ...host, host_id: "gpu-d4e5f6", label: "gpu", destination: "me@gpu", state: "idle" };
const sharing = (over: Partial<RemoteSharingView> = {}): RemoteSharingView => ({
  reviewed: false,
  shared: [],
  keys: ["anthropic"],
  sign_ins: [],
  custom_providers: false,
  grok: false,
  hosted: false,
  hosted_expires_at: null,
  erased_sign_ins: [],
  ...over,
});
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
  vi.mocked(ipc.remoteSshAliases).mockResolvedValue([]);
  vi.mocked(ipc.remoteDiscardHost).mockResolvedValue();
  vi.mocked(ipc.remoteListDir).mockImplementation(async (_id, path) =>
    path === "/home/me"
      ? listing(path, [
          ["proj", true],
          ["notes", false],
        ])
      : listing(path, []),
  );
});

function mount(props: { entry?: RemoteModalEntry; hosts?: RemoteHostView[]; knownRepos?: string[]; onOpened?: (key: string) => void; onClose?: () => void } = {}) {
  const onOpened = props.onOpened ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <>
      <RemoteModal entry={props.entry ?? { kind: "hosts" }} hosts={props.hosts ?? [host]} knownRepos={props.knownRepos ?? []} onOpened={onOpened} onClose={onClose} />
      <ConfirmHost />
    </>,
  );
  return { onOpened, onClose };
}

async function setUpViaDestination(text = "ssh -p 2222 me@box") {
  fireEvent.click(screen.getByRole("button", { name: "Set up a new remote…" }));
  fireEvent.change(await screen.findByLabelText("SSH destination"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));
}

describe("RemoteModal hosts", () => {
  it("with no remotes offers only setting one up", async () => {
    mount({ hosts: [] });
    expect(screen.getByText("No remotes set up")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Remote hosts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up a remote" }));
    expect(await screen.findByLabelText("SSH destination")).toBeTruthy();
  });

  it("lists the configured hosts with their state and repo counts", () => {
    mount({ hosts: [host, offline], knownRepos: ["/Users/me/local", "alinery+ssh://box-a1b2c3/srv/a", "alinery+ssh://box-a1b2c3/srv/b"] });
    const list = screen.getByRole("list", { name: "Remote hosts" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0].textContent).toContain("Connected");
    expect(rows[0].textContent).toContain("2 repositories");
    expect(rows[1].textContent).toContain("Not connected");
    expect(rows[1].textContent).toContain("0 repositories");
  });

  it("opens a connected host's folders without connecting again", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Open a folder" }));
    await screen.findByRole("list", { name: "Folders" });
    expect(ipc.remoteConnect).not.toHaveBeenCalled();
    expect(ipc.remoteListDir).toHaveBeenCalledWith("box-a1b2c3", "/home/me", false);
  });

  it("connects a host that is not connected, then shows its folders", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([{ ...offline, home: "/home/me", state: "connected" }]);
    mount({ hosts: [offline] });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("list", { name: "Folders" });
    expect(ipc.remoteConnect).toHaveBeenCalledWith("gpu-d4e5f6", false);
  });

  it("returns to the list with the reason when a known host will not connect, and keeps the host", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValue("ssh could not connect to the host");
    mount({ hosts: [offline] });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not connect");
    expect(screen.getByRole("list", { name: "Remote hosts" })).toBeTruthy();
    expect(ipc.remoteDiscardHost).not.toHaveBeenCalled();
  });

  it("sends a host whose setup was not finished to its credentials", async () => {
    const unfinished = { ...host, sharing_reviewed: false };
    vi.mocked(ipc.remoteSharing).mockResolvedValue(sharing());
    mount({ hosts: [unfinished] });
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByText("API keys")).toBeTruthy();
    expect(ipc.remoteConnect).not.toHaveBeenCalled();
  });
});

describe("RemoteModal setup", () => {
  it("sets up a host from a destination: connect, choose credentials, pick a folder", async () => {
    const fresh = { ...host, sharing_reviewed: false };
    vi.mocked(ipc.remoteAddHost).mockResolvedValue(fresh);
    vi.mocked(ipc.remoteHosts).mockResolvedValue([fresh]);
    vi.mocked(ipc.remoteSharing).mockResolvedValue(sharing());
    vi.mocked(ipc.remoteSetSharing).mockResolvedValue(sharing({ reviewed: true }));
    mount();
    await setUpViaDestination();

    expect(ipc.remoteAddHost).toHaveBeenCalledWith("ssh -p 2222 me@box", undefined);
    expect(await screen.findByText("API keys")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
    expect(screen.getByRole("list", { name: "Setup steps" }).querySelector("[aria-current='step']")?.textContent).toContain("Access");

    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("list", { name: "Folders" });
    expect(ipc.remoteSetSharing).toHaveBeenCalledWith("box-a1b2c3", []);
    expect(screen.getByRole("list", { name: "Setup steps" }).querySelector("[aria-current='step']")?.textContent).toContain("First repo");
  });

  it("keeps the host when the first folder is skipped", async () => {
    const fresh = { ...host, sharing_reviewed: false };
    vi.mocked(ipc.remoteAddHost).mockResolvedValue(fresh);
    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    const { onClose, onOpened } = mount();
    await setUpViaDestination();
    await screen.findByRole("list", { name: "Folders" });
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onClose).toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
    expect(ipc.remoteDiscardHost).not.toHaveBeenCalled();
  });

  it("offers the aliases in the SSH config and says where one resolves to", async () => {
    vi.mocked(ipc.remoteSshAliases).mockResolvedValue(["dagent", "work_box"]);
    vi.mocked(ipc.remoteDescribeDestination).mockResolvedValue({ hostname: "dagent.example.com", user: "me", port: 22, jump: null });
    mount({ hosts: [] });
    fireEvent.click(screen.getByRole("button", { name: "Set up a remote" }));

    const list = await screen.findByRole("list", { name: "SSH config hosts" });
    fireEvent.click(within(list).getByRole("button", { name: "dagent" }));
    expect((screen.getByLabelText("SSH destination") as HTMLInputElement).value).toBe("dagent");
    expect((await screen.findByText(/dagent connects to me@dagent.example.com, port 22/)).textContent).toBeTruthy();
    expect(within(list).getByRole("button", { name: "dagent" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Agent box" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));
    await waitFor(() => expect(ipc.remoteAddHost).toHaveBeenCalledWith("dagent", "Agent box"));
  });

  it("filters a long alias list", async () => {
    vi.mocked(ipc.remoteSshAliases).mockResolvedValue(Array.from({ length: 12 }, (_, index) => `host-${index}`));
    mount({ hosts: [] });
    fireEvent.click(screen.getByRole("button", { name: "Set up a remote" }));
    fireEvent.change(await screen.findByLabelText("Filter SSH config hosts"), { target: { value: "host-11" } });
    const list = screen.getByRole("list", { name: "SSH config hosts" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["host-11"]);
  });

  it("leaves no host behind when the first setup fails, and returns to the form with the reason", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValue("ssh authentication failed. Alinery connects without prompts");
    mount();
    await setUpViaDestination("me@box");
    expect((await screen.findByRole("alert")).textContent).toContain("authentication failed");
    expect(ipc.remoteDiscardHost).toHaveBeenCalledWith("box-a1b2c3");
    expect((screen.getByLabelText("SSH destination") as HTMLInputElement).value).toBe("me@box");
  });

  it("asks before trusting a first-seen host key, and connects with trust only after yes", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValueOnce("host-key-unknown: this host's key is not in known_hosts yet").mockResolvedValue();
    mount();
    await setUpViaDestination("me@box");

    const dialog = await screen.findByRole("alertdialog");
    expect(ipc.remoteConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Trust and connect" }));
    await screen.findByRole("list", { name: "Folders" });
    expect(vi.mocked(ipc.remoteConnect).mock.calls).toEqual([
      ["box-a1b2c3", false],
      ["box-a1b2c3", true],
    ]);
    expect(ipc.remoteDiscardHost).not.toHaveBeenCalled();
  });

  it("refuses a destination the backend rejects without connecting", async () => {
    vi.mocked(ipc.remoteAddHost).mockRejectedValue("ssh option -R is not allowed");
    mount({ hosts: [] });
    fireEvent.click(screen.getByRole("button", { name: "Set up a remote" }));
    fireEvent.change(await screen.findByLabelText("SSH destination"), { target: { value: "ssh -R 1:x:2 me@box" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not allowed");
    expect(ipc.remoteConnect).not.toHaveBeenCalled();
  });
});

describe("RemoteModal reconnect", () => {
  const entry: RemoteModalEntry = { kind: "reconnect", hostId: "box-a1b2c3", repoKey: "alinery+ssh://box-a1b2c3/srv/app" };

  it("reconnects the host and opens the repo that was chosen, without browsing", async () => {
    const { onOpened, onClose } = mount({ entry, hosts: [{ ...host, state: "idle" }] });
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/srv/app"));
    expect(ipc.remoteConnect).toHaveBeenCalledWith("box-a1b2c3", false);
    expect(onClose).toHaveBeenCalled();
    expect(ipc.remoteListDir).not.toHaveBeenCalled();
  });

  it("tells the user which sign-ins were removed before opening the repo", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([{ ...host, erased_sign_ins: ["openai-codex"] }]);
    vi.mocked(ipc.remoteSharing).mockResolvedValue(sharing({ reviewed: true, erased_sign_ins: ["openai-codex"] }));
    vi.mocked(ipc.remoteSetSharing).mockResolvedValue(sharing({ reviewed: true }));
    const { onOpened } = mount({ entry, hosts: [{ ...host, state: "idle" }] });

    expect((await screen.findByText(/were removed from this host/)).textContent).toContain("OpenAI Codex");
    expect(onOpened).not.toHaveBeenCalled();
    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/srv/app"));
  });

  it("falls back to the host list with the reason when the host will not come back", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValue("ssh could not connect to the host");
    const { onOpened } = mount({ entry, hosts: [{ ...host, state: "idle" }] });
    expect((await screen.findByRole("alert")).textContent).toContain("could not connect");
    expect(onOpened).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Remote hosts" })).toBeTruthy();
  });
});

describe("RemoteModal folders", () => {
  async function browse() {
    fireEvent.click(screen.getByRole("button", { name: "Open a folder" }));
    await screen.findByRole("list", { name: "Folders" });
  }

  it("lists the home folder, then browses into a folder and up again", async () => {
    mount();
    await browse();
    const folders = screen.getByRole("list", { name: "Folders" });
    expect(within(folders).getByText("proj")).toBeTruthy();
    expect(within(folders).getByText("git")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /proj/ }));
    await waitFor(() => expect(ipc.remoteListDir).toHaveBeenLastCalledWith("box-a1b2c3", "/home/me/proj", false));
    fireEvent.click(screen.getByRole("button", { name: "Parent folder" }));
    await waitFor(() => expect(ipc.remoteListDir).toHaveBeenLastCalledWith("box-a1b2c3", "/home/me", false));
  });

  it("opens a git checkout and hands back its key", async () => {
    vi.mocked(ipc.remoteClassify).mockResolvedValue({ kind: "checkout", root: "/home/me" });
    vi.mocked(ipc.remoteAddRepo).mockResolvedValue("alinery+ssh://box-a1b2c3/home/me");
    const { onOpened, onClose } = mount();
    await browse();
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
    await browse();

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

  it("shows why a folder cannot be opened, and goes back to the host list", async () => {
    vi.mocked(ipc.remoteClassify).mockResolvedValue({ kind: "refused", message: "That folder is inside a larger repository" });
    const { onOpened } = mount();
    await browse();
    fireEvent.click(screen.getByRole("button", { name: "Open this folder" }));
    expect((await screen.findByRole("alert")).textContent).toContain("larger repository");
    expect(onOpened).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("list", { name: "Remote hosts" })).toBeTruthy();
  });
});
