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
    remoteConnect: vi.fn(),
    remoteSharing: vi.fn(),
    remoteSetSharing: vi.fn(),
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

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
beforeEach(() => {
  vi.mocked(ipc.remoteHosts).mockResolvedValue([host]);
  vi.mocked(ipc.remoteConnect).mockResolvedValue();
});

function mount(props: { entry?: RemoteModalEntry; hosts?: RemoteHostView[]; onOpened?: (key: string) => void; onClose?: () => void } = {}) {
  const onOpened = props.onOpened ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <>
      <RemoteModal entry={props.entry ?? entry} hosts={props.hosts ?? [host]} onOpened={onOpened} onClose={onClose} />
      <ConfirmHost />
    </>,
  );
  return { onOpened, onClose };
}

const entry: RemoteModalEntry = { kind: "reconnect", hostId: "box-a1b2c3", repoKey: "alinery+ssh://box-a1b2c3/srv/app" };

describe("RemoteModal reconnect", () => {
  it("reconnects the host and opens the repo that was chosen, without browsing", async () => {
    const { onOpened, onClose } = mount({ entry, hosts: [{ ...host, state: "idle" }] });
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/srv/app"));
    expect(ipc.remoteConnect).toHaveBeenCalledWith("box-a1b2c3", false);
    expect(onClose).toHaveBeenCalled();
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

  it("shows the reason when the host will not come back, and tries again on request", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValueOnce("ssh could not connect to the host").mockResolvedValue();
    const { onOpened } = mount({ entry, hosts: [{ ...host, state: "idle" }] });
    expect((await screen.findByText(/could not connect/)).textContent).toBeTruthy();
    expect(onOpened).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith("alinery+ssh://box-a1b2c3/srv/app"));
  });

  it("asks before trusting a first-seen host key, and connects with trust only after yes", async () => {
    vi.mocked(ipc.remoteConnect).mockRejectedValueOnce("host-key-unknown: this host's key is not in known_hosts yet").mockResolvedValue();
    const { onOpened } = mount({ entry, hosts: [{ ...host, state: "idle" }] });
    const dialog = await screen.findByRole("alertdialog");
    expect(ipc.remoteConnect).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Trust and connect" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(vi.mocked(ipc.remoteConnect).mock.calls).toEqual([
      ["box-a1b2c3", false],
      ["box-a1b2c3", true],
    ]);
  });

  it("shows a refused host with the fix for its reason", async () => {
    const refusal = { kind: "missing_tools", message: "the host is missing git", missing_tools: ["git"], fix: null };
    vi.mocked(ipc.remoteConnect).mockRejectedValue(`host-refused: ${JSON.stringify(refusal)}`);
    mount({ entry, hosts: [{ ...host, state: "idle" }] });
    const notice = (await screen.findByText(/with its package manager/)).parentElement as HTMLElement;
    expect(notice.textContent).toContain("The host is missing git.");
  });
});
