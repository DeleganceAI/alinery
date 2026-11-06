import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost } from "../confirm";
import * as ipc from "../ipc";
import type * as IpcFixtures from "../test/mockIpc";
import type { AppConfig, RemoteHostView, RemoteSharingView } from "../types";
import { useRemoteHosts } from "../useRemoteHosts";
import { SetupScreen } from "./SetupScreen";

vi.mock("../ipc", async () => {
  const { mockIpc } = await vi.importActual<typeof IpcFixtures>("../test/mockIpc");
  return mockIpc({
    pickRepoDialog: vi.fn(),
    classifyPickedFolder: vi.fn(),
    initPickedFolder: vi.fn(),
    remoteHosts: vi.fn(),
    remoteAddHost: vi.fn(),
    remoteTestHost: vi.fn(),
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
  gave_up: false,
  phase: "",
  error: null,
  home: "/home/me",
  platform: "Linux x86_64",
  sharing_reviewed: true,
  erased_sign_ins: [],
};
const idle: RemoteHostView = { ...host, state: "idle" };
const config = (over: Partial<AppConfig> = {}): AppConfig => ({ active_repo: "", known_repos: [], mcp_enabled: true, appearance: {} as AppConfig["appearance"], ...over });
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
const listing = (path: string, names: Array<[string, boolean]>) => ({ path, entries: names.map(([name, git]) => ({ name, git, symlink: false })), truncated: false });

type Props = Partial<React.ComponentProps<typeof SetupScreen>>;

/** The real hook feeds the screen its hosts, as the app does, so a connect that changes `remoteHosts` shows up after a refresh. */
function Harness(props: Props) {
  const { hosts, refresh } = useRemoteHosts(true, 3_600_000);
  return <SetupScreen appConfig={config()} hosts={hosts} repoError="" refreshHosts={refresh} onOpen={async () => true} onRemoveRepo={vi.fn()} {...props} />;
}

function mount(props: Props = {}) {
  const onOpen = props.onOpen ?? vi.fn(async () => true);
  render(
    <>
      <Harness {...props} onOpen={onOpen} />
      <ConfirmHost />
    </>,
  );
  return { onOpen: vi.mocked(onOpen) };
}

beforeEach(() => {
  vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
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
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name) });

describe("the host choice", () => {
  it("lists This computer first and selected, with its folder choice and nothing about a host", () => {
    mount();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((item) => item.textContent)).toEqual(["This computer", "SSH"]);
    expect(tab("This computer").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Choose folder…" })).toBeTruthy();
    expect(screen.queryByLabelText("SSH host")).toBeNull();
    expect((screen.getByRole("button", { name: "Open repository" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens on the SSH tab when asked, and says there are no hosts yet", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([]);
    mount({ initialTab: "ssh" });
    const select = screen.getByLabelText("SSH host") as HTMLSelectElement;
    expect(
      within(select)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["No SSH hosts yet", "Add SSH connection…"]);
  });

  it("lists the saved hosts above the Add row", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([host, { ...idle, host_id: "gpu-d4e5f6", label: "gpu", destination: "me@gpu" }]);
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: "gpu (me@gpu)" });
    const options = within(screen.getByLabelText("SSH host")).getAllByRole("option");
    expect(options[options.length - 1].textContent).toBe("Add SSH connection…");
    expect(options.slice(1, -1).map((option) => option.textContent)).toEqual(["box (-p 2222 me@box)", "gpu (me@gpu)"]);
  });
});

describe("this computer", () => {
  async function choose(path: string) {
    vi.mocked(ipc.pickRepoDialog).mockResolvedValue(path);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByText(path);
  }

  it("picks a folder, classifies it, then starts the daemon, in that order", async () => {
    vi.mocked(ipc.classifyPickedFolder).mockResolvedValue({ kind: "checkout", root: "/canonical" });
    const { onOpen } = mount();
    await choose("/raw");
    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/canonical", false));
    expect(vi.mocked(ipc.pickRepoDialog).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(ipc.classifyPickedFolder).mock.invocationCallOrder[0]);
    expect(vi.mocked(ipc.classifyPickedFolder).mock.invocationCallOrder[0]).toBeLessThan(onOpen.mock.invocationCallOrder[0]);
    expect(ipc.remoteClassify).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Opening the repository")).toBeTruthy();
    expect(screen.getByText(/Starting the daemon/)).toBeTruthy();
    expect(screen.getByText("Preparing the repository")).toBeTruthy();
  });

  it("initializes Git only after confirming", async () => {
    vi.mocked(ipc.classifyPickedFolder).mockResolvedValue({ kind: "absent", path: "/canon" });
    vi.mocked(ipc.initPickedFolder).mockResolvedValue({ kind: "initialized", root: "/inited" });
    const { onOpen } = mount();
    await choose("/raw");
    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Initialize Git?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Initialize Git" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/inited", false));
    expect(ipc.initPickedFolder).toHaveBeenCalledWith("/canon");
  });

  it("goes back to the choice when initialize is cancelled, and when the folder is refused", async () => {
    vi.mocked(ipc.classifyPickedFolder)
      .mockResolvedValueOnce({ kind: "absent", path: "/canon" })
      .mockResolvedValue({ kind: "refused", message: "That folder is inside a larger repository" });
    const { onOpen } = mount();
    await choose("/raw");
    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(dialog.querySelector<HTMLElement>("[data-autofocus]") as HTMLElement);
    await waitFor(() => expect((screen.getByRole("button", { name: "Open repository" }) as HTMLButtonElement).disabled).toBe(false));
    expect(ipc.initPickedFolder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    expect((await screen.findByText(/larger repository/)).textContent).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a known repository straight away, without a folder", async () => {
    const { onOpen } = mount({ appConfig: config({ known_repos: ["/Users/dev/project", "alinery+ssh://box-a1b2c3/srv/app"] }) });
    const list = screen.getByRole("list", { name: "Your repositories" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByTitle("/Users/dev/project"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/Users/dev/project", false));
    expect(ipc.classifyPickedFolder).not.toHaveBeenCalled();
  });

  it("returns to the choice, with the reason, when the repository does not open", async () => {
    vi.mocked(ipc.classifyPickedFolder).mockResolvedValue({ kind: "checkout", root: "/canonical" });
    const { onOpen } = mount({ onOpen: vi.fn(async () => false), repoError: "project is closing" });
    await choose("/raw");
    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(await screen.findByText(/Couldn't open the repository/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Open repository" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("can be cancelled when it is a dialog over the board", () => {
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("an ssh host", () => {
  const choose = (id: string) => fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: id } });
  const dirOf = () => screen.findByRole("list", { name: "Folders" });

  it("connects, lists the host's folders, classifies the pick, adds the repo, then starts the daemon, in that order", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([idle]);
    vi.mocked(ipc.remoteClassify).mockResolvedValue({ kind: "checkout", root: "/home/me" });
    vi.mocked(ipc.remoteAddRepo).mockResolvedValue("alinery+ssh://box-a1b2c3/home/me");
    const { onOpen } = mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: /box/ });
    choose(idle.host_id);
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();

    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    fireEvent.click(screen.getByRole("button", { name: "Connect to box" }));
    const folders = await dirOf();
    expect(await within(folders).findByText("proj")).toBeTruthy();
    expect(within(folders).getByText("git")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open repository" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/home/me", true));
    const order = [ipc.remoteConnect, ipc.remoteListDir, ipc.remoteClassify, ipc.remoteAddRepo, onOpen].map((fn) => vi.mocked(fn).mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ipc.classifyPickedFolder).not.toHaveBeenCalled();
    expect(ipc.remoteAddRepo).toHaveBeenCalledWith("box-a1b2c3", "/home/me");
  });

  it("names the phases the shell reports while it connects", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([idle]);
    let finish: () => void = () => {};
    vi.mocked(ipc.remoteConnect).mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: /box/ });
    choose(idle.host_id);
    vi.mocked(ipc.remoteHosts).mockResolvedValue([{ ...idle, state: "connecting", phase: "Installing the runtime" }]);
    fireEvent.click(screen.getByRole("button", { name: "Connect to box" }));
    const progress = await screen.findByRole("list", { name: "Setup progress" });
    await waitFor(() => expect(progress.querySelector("[aria-current='step']")?.textContent).toContain("Installing the runtime"), { timeout: 3000 });
    expect(Array.from(progress.querySelectorAll("li")).map((item) => item.textContent?.replace(/[…·]/g, ""))).toEqual([
      "Connecting",
      "Checking the host",
      "Installing the runtime",
      "Starting the repo service",
      "Syncing settings",
    ]);
    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    finish();
    await dirOf();
  });

  it("asks which credentials the host may use before it lists folders", async () => {
    const fresh = { ...host, sharing_reviewed: true };
    const unreviewed = { ...fresh, sharing_reviewed: false };
    vi.mocked(ipc.remoteHosts).mockResolvedValue([{ ...idle, sharing_reviewed: false }]);
    vi.mocked(ipc.remoteSharing).mockResolvedValue(sharing());
    vi.mocked(ipc.remoteSetSharing).mockResolvedValue(sharing({ reviewed: true }));
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: /box/ });
    choose(idle.host_id);
    vi.mocked(ipc.remoteHosts).mockResolvedValue([unreviewed]);
    fireEvent.click(screen.getByRole("button", { name: "Connect to box" }));
    expect(await screen.findByText("API keys")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Folders" })).toBeNull();
    vi.mocked(ipc.remoteHosts).mockResolvedValue([fresh]);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await dirOf();
    expect(ipc.remoteSetSharing).toHaveBeenCalledWith("box-a1b2c3", []);
  });

  it("asks before trusting a first-seen host key, and connects with trust only after yes", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([idle]);
    vi.mocked(ipc.remoteConnect).mockRejectedValueOnce("host-key-unknown: this host's key is not in known_hosts yet").mockResolvedValue();
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: /box/ });
    choose(idle.host_id);
    vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
    fireEvent.click(screen.getByRole("button", { name: "Connect to box" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(ipc.remoteConnect).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Trust and connect" }));
    await dirOf();
    expect(vi.mocked(ipc.remoteConnect).mock.calls).toEqual([
      ["box-a1b2c3", false],
      ["box-a1b2c3", true],
    ]);
  });

  it("discards a host added here when its first connect fails, and shows the fix for a refusal", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([]);
    vi.mocked(ipc.remoteAddHost).mockResolvedValue(idle);
    const refusal = { kind: "missing_tools", message: "the host is missing git", missing_tools: ["git"], fix: null };
    vi.mocked(ipc.remoteConnect).mockRejectedValue(`host-refused: ${JSON.stringify(refusal)}`);
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: "No SSH hosts yet" });
    choose("__add__");
    const dialog = await screen.findByRole("dialog", { name: "Add SSH connection" });
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "me@box" } });
    vi.mocked(ipc.remoteHosts).mockResolvedValue([idle]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add SSH connection" }));
    await screen.findByRole("button", { name: "Connect to box" });
    fireEvent.click(screen.getByRole("button", { name: "Connect to box" }));
    expect((await screen.findByText(/The host is missing git/)).textContent).toBeTruthy();
    expect(ipc.remoteDiscardHost).toHaveBeenCalledWith("box-a1b2c3");
  });

  it("keeps a host that was listed before when connecting to it fails", async () => {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([idle]);
    vi.mocked(ipc.remoteConnect).mockRejectedValue("ssh authentication failed");
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: /box/ });
    choose(idle.host_id);
    fireEvent.click(screen.getByRole("button", { name: "Connect to box" }));
    expect((await screen.findByText(/authentication failed/)).textContent).toBeTruthy();
    expect(ipc.remoteDiscardHost).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect to box" })).toBeTruthy();
  });
});

describe("Add SSH connection", () => {
  async function openDialog() {
    vi.mocked(ipc.remoteHosts).mockResolvedValue([]);
    mount({ initialTab: "ssh" });
    await screen.findByRole("option", { name: "No SSH hosts yet" });
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "__add__" } });
    return screen.findByRole("dialog", { name: "Add SSH connection" });
  }

  it("saves the host with the flags its filled fields make, and comes back with it selected", async () => {
    vi.mocked(ipc.remoteAddHost).mockResolvedValue(idle);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Agent box" } });
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "me@box" } });
    fireEvent.change(within(dialog).getByLabelText("SSH port"), { target: { value: "2222" } });
    fireEvent.change(within(dialog).getByLabelText("SSH key"), { target: { value: "~/.ssh/k" } });
    vi.mocked(ipc.remoteHosts).mockResolvedValue([idle]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add SSH connection" }));
    await waitFor(() => expect(ipc.remoteAddHost).toHaveBeenCalledWith("-p 2222 -i ~/.ssh/k me@box", "Agent box"));
    await screen.findByRole("button", { name: "Connect to box" });
    expect((screen.getByLabelText("SSH host") as HTMLSelectElement).value).toBe("box-a1b2c3");
    expect(ipc.remoteConnect).not.toHaveBeenCalled();
  });

  it("an empty field adds no flag", async () => {
    vi.mocked(ipc.remoteAddHost).mockResolvedValue(idle);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "devbox" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add SSH connection" }));
    await waitFor(() => expect(ipc.remoteAddHost).toHaveBeenCalledWith("devbox", undefined));
  });

  it("offers the aliases in the SSH config and says where one resolves to", async () => {
    vi.mocked(ipc.remoteSshAliases).mockResolvedValue(["dagent", "work_box"]);
    vi.mocked(ipc.remoteDescribeDestination).mockResolvedValue({ hostname: "dagent.example.com", user: "me", port: 22, jump: null });
    const dialog = await openDialog();
    await waitFor(() => expect(dialog.querySelectorAll("datalist option")).toHaveLength(2));
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "dagent" } });
    expect((await within(dialog).findByText(/dagent connects to me@dagent.example.com, port 22/)).textContent).toBeTruthy();
  });

  it("tests an unsaved host, and saving stays possible after a refusal", async () => {
    const refusal = { kind: "stops_processes", message: "this host stops your processes", missing_tools: [], fix: "loginctl enable-linger ada" };
    vi.mocked(ipc.remoteTestHost).mockRejectedValue(`host-refused: ${JSON.stringify(refusal)}`);
    const dialog = await openDialog();
    const add = within(dialog).getByRole("button", { name: "Add SSH connection" }) as HTMLButtonElement;
    const test = within(dialog).getByRole("button", { name: "Test connection" }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(add.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "me@box" } });
    fireEvent.change(within(dialog).getByLabelText("SSH port"), { target: { value: "2222" } });
    fireEvent.click(test);
    expect((await within(dialog).findByText("loginctl enable-linger ada")).textContent).toBeTruthy();
    expect(ipc.remoteTestHost).toHaveBeenCalledWith("-p 2222 me@box", false);
    expect(ipc.remoteAddHost).not.toHaveBeenCalled();
    expect(add.disabled).toBe(false);
  });

  it("reports a host that passes the test without installing anything", async () => {
    vi.mocked(ipc.remoteTestHost).mockResolvedValue({ platform: "Linux x86_64", glibc: "2.36" });
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "me@box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect((await within(dialog).findByText(/Reachable: Linux x86_64, glibc 2.36/)).textContent).toContain("Nothing was installed");
  });

  it("asks before trusting a first-seen host key when testing", async () => {
    vi.mocked(ipc.remoteTestHost).mockRejectedValueOnce("host-key-unknown: this host's key is not in known_hosts yet").mockResolvedValue({ platform: "Linux arm64", glibc: null });
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "me@box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Trust and test" }));
    await within(dialog).findByText(/Reachable: Linux arm64/);
    expect(vi.mocked(ipc.remoteTestHost).mock.calls).toEqual([
      ["me@box", false],
      ["me@box", true],
    ]);
  });

  it.each([
    ["not_linux", "This host is not Linux"],
    ["unsupported_cpu", "This host's CPU is not supported"],
    ["no_glibc", "This host has no glibc"],
    ["old_glibc", "This host's glibc is too old"],
    ["large_pages", "This arm64 host uses 64 KiB pages"],
    ["missing_tools", "The host is missing git, zip"],
    ["no_runtime", "This build has no runtime for the host"],
    ["stops_processes", "The host stops your processes when you log out"],
  ])("a %s refusal reaches the dialog with its own fix", async (kind, title) => {
    const refusal = {
      kind,
      message: "reason",
      missing_tools: kind === "missing_tools" ? ["git", "zip"] : [],
      fix: kind === "stops_processes" ? "loginctl enable-linger ada" : null,
    };
    vi.mocked(ipc.remoteTestHost).mockRejectedValue(`host-refused: ${JSON.stringify(refusal)}`);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText("SSH host"), { target: { value: "me@box" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect((await within(dialog).findByText(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).textContent).toBeTruthy();
  });
});
