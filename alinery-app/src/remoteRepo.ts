// A remote repo is a `known_repos` entry of the form `alinery+ssh://<host-id>/<absolute path>`.
// Mirrors RepoRef in src-tauri/src/paths.rs.

const SCHEME = "alinery+ssh://";

/** Prefix of a failed connect's message on first contact with a host (SshFailure in remote.rs). */
export const HOST_KEY_UNKNOWN = "host-key-unknown";

/** What the connect shows while it runs, in order. Mirrors the phases `connect_inner` reports in remote.rs. */
export const SETUP_PHASES = ["Connecting", "Checking the host", "Installing the runtime", "Starting the repo service", "Syncing settings"];

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

/** Which machine a repo key lives on: "" for this one, the host id for a remote repo. */
export const machineOf = (key: string) => parseRemoteRepo(key)?.hostId ?? "";

/** Files can be linked or copied between repos only when they are on one machine. */
export const sameMachine = (left: string, right: string) => machineOf(left) === machineOf(right);

/**
 * A task's related list stores the other repo as a path on the task's own machine, because the
 * files are linked there. This is that path for `target`, or null when `target` is elsewhere.
 */
export function relatedStoredPath(own: string, target: string): string | null {
  if (!sameMachine(own, target)) return null;
  return parseRemoteRepo(target)?.path ?? target;
}

/** The repo key a stored related path stands for, for a task in repo `own`. */
export function relatedRepoKey(own: string, stored: string): string {
  const remote = parseRemoteRepo(own);
  return remote ? `${SCHEME}${remote.hostId}${stored}` : stored;
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

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  xai: "xAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  mistral: "Mistral",
};

/** A provider id as a readable name: a known one by its brand, any other with its words capitalized. */
export function providerLabel(id: string): string {
  return (
    PROVIDER_NAMES[id] ??
    id
      .split(/[-_]/)
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/** How long a token that stops working at `expiresAt` (unix seconds) has left, as "for about 90 days (until Jan 21, 2027)". */
export function tokenLifetime(expiresAt: number, now = Date.now()): string {
  const until = new Date(expiresAt * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const days = Math.round((expiresAt * 1000 - now) / 86_400_000);
  if (days < 1) return `for less than a day (until ${until})`;
  return `for about ${days} ${days === 1 ? "day" : "days"} (until ${until})`;
}
