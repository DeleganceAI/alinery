// A remote repo is a `known_repos` entry of the form `alinery+ssh://<host-id>/<absolute path>`.
// Mirrors RepoRef in src-tauri/src/paths.rs.

const SCHEME = "alinery+ssh://";

/** Prefix of a failed connect's message on first contact with a host (SshFailure in remote.rs). */
export const HOST_KEY_UNKNOWN = "host-key-unknown";

export type RemoteRepo = { hostId: string; path: string };

export function parseRemoteRepo(key: string): RemoteRepo | null {
  if (!key.startsWith(SCHEME)) return null;
  const rest = key.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { hostId: rest.slice(0, slash), path: rest.slice(slash) };
}

export const isRemoteRepo = (key: string) => parseRemoteRepo(key) !== null;

/** `host-id:/path` for a remote repo, the plain path for a local one. */
export function repoDisplayPath(key: string): string {
  const remote = parseRemoteRepo(key);
  return remote ? `${remote.hostId}:${remote.path}` : key;
}

/** The parent of an absolute POSIX path, or the path itself at the root. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}
