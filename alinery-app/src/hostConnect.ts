// Connect a saved ssh host: one place for the phase polling and the first-contact host key prompt, used by the setup screen and by
// the reconnect dialog.

import { askConfirm } from "./confirm";
import * as ipc from "./ipc";
import { HOST_KEY_UNKNOWN, SETUP_PHASES } from "./remoteRepo";
import type { RemoteHostView } from "./types";

/**
 * Connect `hostId` and return its refreshed row. `onPhase` hears each phase the shell reports, in `SETUP_PHASES` order. A host
 * key not seen before asks the user once and retries with trust only on yes. A failure throws an Error carrying the reason.
 */
export async function connectHost(hostId: string, destination: string, onPhase: (phase: string) => void, alive: () => boolean = () => true): Promise<RemoteHostView> {
  let trust = false;
  for (;;) {
    onPhase(SETUP_PHASES[0]);
    const poll = setInterval(() => {
      void ipc.remoteHosts().then((list) => {
        const mine = list.find((host) => host.host_id === hostId);
        if (alive() && mine?.state === "connecting" && mine.phase) onPhase(mine.phase);
      });
    }, 500);
    try {
      await ipc.remoteConnect(hostId, trust);
      const connected = (await ipc.remoteHosts()).find((host) => host.host_id === hostId);
      if (!connected) throw new Error("the host is no longer in the list");
      return connected;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (trust || !message.includes(HOST_KEY_UNKNOWN)) throw new Error(message.replace(`${HOST_KEY_UNKNOWN}: `, ""));
      const choice = await askConfirm({
        title: "Trust this host?",
        body: `${destination} has not been seen before. Its key will be added to your known hosts, and later connections must match it. Only continue if you expect to be connecting to this machine.`,
        choices: [
          { key: "trust", label: "Trust and connect" },
          { key: "cancel", label: "Cancel", tone: "ghost" },
        ],
      });
      if (choice !== "trust") throw new Error("The host was not trusted, so nothing was connected.");
      trust = true;
    } finally {
      clearInterval(poll);
    }
  }
}
