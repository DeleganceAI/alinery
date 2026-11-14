import { describe, expect, it } from "vitest";
import { parseRefusal, refusalAdvice, shouldShowSetup, sshDestination } from "./setup";
import type { HostRefusal, RefusalKind } from "./types";

const remote = "alinery+ssh://box-a1b2c3/srv/app";
// A host is only given up on when the shell says so: `failed` alone also shows for the moment before a dropped link is retried.
const host = (id: string, gaveUp: boolean) => ({ host_id: id, gave_up: gaveUp });

describe("when the setup screen replaces the board", () => {
  it("shows with no repo open, and with no repo known", () => {
    expect(shouldShowSetup({ active_repo: "", known_repos: [] }, [])).toBe(true);
    expect(shouldShowSetup({ active_repo: "", known_repos: ["/a"] }, [])).toBe(true);
    expect(shouldShowSetup({ active_repo: "/a", known_repos: [] }, [])).toBe(true);
  });

  it("does not show for a local repo, which the shell can always start a daemon for", () => {
    expect(shouldShowSetup({ active_repo: "/a", known_repos: ["/a"] }, [])).toBe(false);
    // A local repo counts even when the open one is on a host that has failed.
    expect(shouldShowSetup({ active_repo: remote, known_repos: ["/a", remote] }, [host("box-a1b2c3", true)])).toBe(false);
  });

  it("shows when every known repo is remote and the open one's host was given up on", () => {
    const cfg = { active_repo: remote, known_repos: [remote, "alinery+ssh://other-111111/x"] };
    expect(shouldShowSetup(cfg, [host("box-a1b2c3", true)])).toBe(true);
  });

  it("does not show for a host that is not given up on, including a failed one about to be retried", () => {
    const cfg = { active_repo: remote, known_repos: [remote] };
    expect(shouldShowSetup(cfg, [host("box-a1b2c3", false)])).toBe(false);
    expect(shouldShowSetup(cfg, [host("other-111111", true)])).toBe(false);
    expect(shouldShowSetup(cfg, [])).toBe(false);
  });
});

describe("the ssh destination the fields make", () => {
  it("adds a flag only for a field that is filled in", () => {
    expect(sshDestination({ host: "me@box", port: "", key: "" })).toBe("me@box");
    expect(sshDestination({ host: " devbox ", port: " 2222 ", key: "" })).toBe("-p 2222 devbox");
    expect(sshDestination({ host: "me@box", port: "2222", key: "~/.ssh/id_ed25519" })).toBe("-p 2222 -i ~/.ssh/id_ed25519 me@box");
  });

  it("quotes a key path with spaces so it stays one word", () => {
    expect(sshDestination({ host: "me@box", port: "", key: "/Users/me/My Keys/id" })).toBe('-i "/Users/me/My Keys/id" me@box');
  });
});

describe("refusals", () => {
  const refusal = (over: Partial<HostRefusal>): HostRefusal => ({ kind: "missing_tools", message: "m", missing_tools: [], fix: null, ...over });

  it("reads the kind, the tools and the fix out of a failed connect's message", () => {
    const json = JSON.stringify(refusal({ missing_tools: ["git", "zip"], message: "the host is missing git, zip" }));
    expect(parseRefusal(`host-refused: ${json}`)).toEqual(refusal({ missing_tools: ["git", "zip"], message: "the host is missing git, zip" }));
    expect(parseRefusal("ssh authentication failed")).toBeNull();
    expect(parseRefusal("host-refused: {not json")).toBeNull();
  });

  const kinds: Record<RefusalKind, Partial<HostRefusal>> = {
    unsupported_os: { message: "FreeBSD hosts are not supported" },
    unsupported_cpu: { message: "unsupported CPU architecture: riscv64" },
    no_glibc: { message: "no glibc" },
    old_glibc: { message: "the host's glibc 2.17 is older than the required 2.28" },
    old_macos: { message: "the host's macOS 12.7 is older than the required 13.0" },
    large_pages: { message: "arm64 hosts with 64 KiB pages are not supported" },
    missing_tools: { missing_tools: ["git", "tar"] },
    no_runtime: { message: "this build of Alinery does not bundle a runtime for x" },
    stops_processes: { fix: "loginctl enable-linger ada" },
  };

  it.each(Object.entries(kinds) as [RefusalKind, Partial<HostRefusal>][])("gives %s a title and a fix", (kind, over) => {
    const advice = refusalAdvice(refusal({ kind, ...over }));
    expect(advice.title.length).toBeGreaterThan(5);
    expect(advice.fix.length).toBeGreaterThan(10);
  });

  it("names every missing tool, and hands over the command that stops the host killing sessions", () => {
    expect(refusalAdvice(refusal({ missing_tools: ["git", "tar"] })).title).toBe("The host is missing git, tar");
    expect(refusalAdvice(refusal({ missing_tools: ["git"] })).fix).toContain("Install it");
    expect(refusalAdvice(refusal({ missing_tools: ["git"] })).command).toBeNull();
    // A Mac with only the /usr/bin/git stub gets the command that installs the Command Line Tools.
    const mac = refusalAdvice(refusal({ missing_tools: ["git"], fix: "xcode-select --install" }));
    expect([mac.command, mac.fix]).toEqual(["xcode-select --install", expect.stringContaining("Command Line Tools")]);
    expect(refusalAdvice(refusal({ kind: "stops_processes", fix: "loginctl enable-linger ada" })).command).toBe("loginctl enable-linger ada");
  });
});
