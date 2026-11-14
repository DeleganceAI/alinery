// Turn a folder the user picked into a repository root, on this computer or on a host: classify it, and offer to initialize Git
// when it is not a checkout. The only caller of the classify and init commands.

import { askConfirm } from "./confirm";
import * as ipc from "./ipc";

export type FolderOutcome = { kind: "root"; root: string } | { kind: "refused"; message: string } | { kind: "cancelled" };

/** `hostId` is null for this computer. Throws only when the shell fails; a folder that cannot be a repo comes back as `refused`. */
export async function openFolderAsRepo(hostId: string | null, path: string): Promise<FolderOutcome> {
  const classified = hostId === null ? await ipc.classifyPickedFolder(path) : await ipc.remoteClassify(hostId, path);
  if (classified.kind === "checkout") return { kind: "root", root: classified.root };
  if (classified.kind === "refused") return { kind: "refused", message: classified.message };
  const choice = await askConfirm({
    title: "Initialize Git?",
    body: `${classified.path} is not a Git repository. Initialize Git in this folder${hostId === null ? "" : " on the remote host"} before opening it? Cancel leaves the folder unchanged.`,
    choices: [
      { key: "init", label: "Initialize Git" },
      { key: "cancel", label: "Cancel", tone: "ghost" },
    ],
  });
  if (choice !== "init") return { kind: "cancelled" };
  const initialized = hostId === null ? await ipc.initPickedFolder(classified.path) : await ipc.remoteInit(hostId, classified.path);
  return { kind: "root", root: initialized.root };
}
