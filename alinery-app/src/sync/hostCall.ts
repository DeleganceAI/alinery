// What the services that talk to "the host's daemon" share (the agent directory, the providers): which daemon a call without a
// repository means, and the error a failed call becomes.
import { Code, ConnectError } from "@connectrpc/connect";
import * as ipc from "../ipc";
import { isRemoteRepo } from "../remoteRepo";
import { NoLibraryHost } from "./playbooks";

export async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const err = ConnectError.from(e);
    throw new Error(err.code === Code.Unavailable && err.rawMessage === "" ? "the daemon is not reachable" : err.rawMessage);
  }
}

/** The repository whose host's daemon a call without a repository means: the active one, else the first local one the app knows. */
export async function agentHost(repo?: string): Promise<string> {
  if (repo) return repo;
  const config = await ipc.readAppConfig();
  const host = config.active_repo || config.known_repos.find((known) => !isRemoteRepo(known));
  if (!host) throw new NoLibraryHost();
  return host;
}
