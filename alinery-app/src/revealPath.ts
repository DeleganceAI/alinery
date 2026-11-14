import * as ipc from "./ipc";
import { isRemoteRepo } from "./remoteRepo";
import { toast } from "./toast";

// A remote repo's files are on another machine, so the OS file manager here cannot show them.
// App tells this module which repo is active; for a remote one the host's path is copied instead.
let activeRepo = "";

export function setRevealRepo(repo: string) {
  activeRepo = repo;
}

export const filesAreRemote = () => isRemoteRepo(activeRepo);

/** Button text for the action `revealPath` will take. */
export const revealActionLabel = () => (filesAreRemote() ? "Copy path on host" : "Show in folder");

/** Show a file in the file manager, or for a remote repo copy its path on the host. */
export async function revealPath(path: string): Promise<void> {
  if (!filesAreRemote()) {
    await ipc.revealItemInDir(path);
    return;
  }
  await navigator.clipboard.writeText(path);
  toast("Copied the path on the host", "success");
}
