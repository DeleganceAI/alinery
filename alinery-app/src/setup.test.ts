import { describe, expect, it } from "vitest";
import { parseRefusal, refusalAdvice, shouldShowSetup, sshDestination } from "./setup";
import type { HostRefusal, RefusalKind } from "./types";

const remote = "alinery+ssh://box-a1b2c3/srv/app";
const state = (id: string, value: "idle" | "connecting" | "reconnecting" | "connected" | "failed") => ({ host_id: id, state: value });

describe("when the setup screen replaces the board", () => {
  it("shows with no repo open, and with no repo known", () => {
    expect(shouldShowSetup({ active_repo: "", known_repos: [] }, [])).toBe(true);
    expect(shouldShowSetup({ active_repo: "", known_repos: ["/a"] }, [])).toBe(true);
    expect(shouldShowSetup({ active_repo: "/a", known_repos: [] }, [])).toBe(true);
  });

  it("does not show for a local repo, which the shell can always start a daemon for", () => {
    expect(shouldShowSetup({ active_repo: "/a", known_repos: ["/a"] }, [])).toBe(false);
    // A local repo counts even when the open one is on a host that has failed.
    expect(shouldShowSetup({ active_repo: remote, known_repos: ["/a", remote] }, [state("box-a1b2c3", "failed")])).toBe(false);
  });

  it("shows when every known repo is remote and the open one's host has failed", () => {
    const cfg = { active_repo: remote, known_repos: [remote, "alinery+ssh://other-111111/x"] };
    expect(shouldShowSetup(cfg, [state("box-a1b2c3", "failed")])).toBe(true);
  });

  it("gives a host that is connecting, retrying or connected the benefit of the doubt", () => {
    const cfg = { active_repo: remote, known_repos: [remote] };
    for (const value of ["idle", "connecting", "reconnecting", "connected"] as const) {
      expect(shouldShowSetup(cfg, [state("box-a1b2c3", value)])).toBe(false);
    }
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
    not_linux: { message: "Darwin hosts are not supported yet" },
    unsupported_cpu: { message: "unsupported CPU architecture: riscv64" },
    no_glibc: { message: "no glibc" },
    old_glibc: { message: "the host's glibc 2.17 is older than the required 2.28" },
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
    expect(refusalAdvice(refusal({ kind: "stops_processes", fix: "loginctl enable-linger ada" })).command).toBe("loginctl enable-linger ada");
  });
});
