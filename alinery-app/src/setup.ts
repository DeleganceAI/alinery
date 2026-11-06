// What the setup screen decides without touching the DOM: when it shows, the ssh destination its fields make, and what to tell
// the user for each reason a host is refused.

import { isRemoteRepo, parseRemoteRepo } from "./remoteRepo";
import type { AppConfig, HostRefusal, RemoteHostView } from "./types";

/** Prefix of a refused host's message; the rest is a `HostRefusal` as JSON (`HOST_REFUSED` in remote.rs). */
export const HOST_REFUSED = "host-refused";

/** The refusal inside a failed connect or test, or null when the message is any other failure. */
export function parseRefusal(message: string): HostRefusal | null {
  const at = message.indexOf(`${HOST_REFUSED}: `);
  if (at < 0) return null;
  try {
    const found = JSON.parse(message.slice(at + HOST_REFUSED.length + 2)) as Partial<HostRefusal>;
    if (typeof found.kind !== "string" || typeof found.message !== "string") return null;
    return { kind: found.kind, message: found.message, missing_tools: found.missing_tools ?? [], fix: found.fix ?? null };
  } catch {
    return null;
  }
}

/** The fix for a refusal, in words the user can act on before anything is installed on the host. */
export function refusalAdvice(refusal: HostRefusal): { title: string; fix: string; command: string | null } {
  const tools = refusal.missing_tools.join(", ");
  switch (refusal.kind) {
    case "missing_tools":
      return {
        title: `The host is missing ${tools}`,
        fix: `Install ${refusal.missing_tools.length === 1 ? "it" : "them"} on that host with its package manager, then test the connection again. Nothing has been installed there.`,
        command: null,
      };
    case "stops_processes":
      return {
        title: "The host stops your processes when you log out",
        fix: "Run this on the host once, so sessions keep running after you disconnect, then test the connection again.",
        command: refusal.fix,
      };
    case "not_linux":
      return { title: "This host is not Linux", fix: "Remote repositories need a Linux machine. Pick another host.", command: null };
    case "unsupported_cpu":
      return { title: "This host's CPU is not supported", fix: "Remote hosts must be x64 or arm64 Linux machines.", command: null };
    case "no_glibc":
      return { title: "This host has no glibc", fix: "Musl systems such as Alpine are not supported. Use a glibc-based distribution.", command: null };
    case "old_glibc":
      return { title: "This host's glibc is too old", fix: `${refusal.message}. Update the host's operating system, or pick another host.`, command: null };
    case "large_pages":
      return { title: "This arm64 host uses 64 KiB pages", fix: "Hosts with a 64 KiB page size are not supported. Pick another host.", command: null };
    case "no_runtime":
      return { title: "This build has no runtime for the host", fix: `${refusal.message}. Install an Alinery build that bundles it.`, command: null };
  }
}

/** The text `remote_add_host` parses back into ssh arguments. An empty field adds no flag, so `~/.ssh/config` stays in charge. */
export function sshDestination({ host, port, key }: { host: string; port: string; key: string }): string {
  const quote = (value: string) => (/^[\w@%+=:,./~-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`);
  const words: string[] = [];
  if (port.trim()) words.push("-p", port.trim());
  if (key.trim()) words.push("-i", quote(key.trim()));
  words.push(quote(host.trim()));
  return words.join(" ");
}

/**
 * Whether the setup screen replaces the board. With no repo open there is nothing to show. With one open, only when every
 * known repo lives on a remote host and the host it is open on has been given up on (`gave_up`): a local known repo always counts, because the
 * shell can start its daemon, and a host that is connecting, retrying or between a dropped link and its retry is not given up on.
 */
export function shouldShowSetup(cfg: Pick<AppConfig, "active_repo" | "known_repos">, hosts: Pick<RemoteHostView, "host_id" | "gave_up">[]): boolean {
  if (!cfg.active_repo) return true;
  if (cfg.known_repos.length === 0) return true;
  if (!cfg.known_repos.every(isRemoteRepo)) return false;
  const active = parseRemoteRepo(cfg.active_repo);
  return Boolean(active && hosts.some((host) => host.host_id === active.hostId && host.gave_up));
}
