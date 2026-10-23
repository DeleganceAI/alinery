import { describe, expect, it } from "vitest";
import { isRemoteRepo, joinPath, parentPath, parseRemoteRepo, repoDisplayPath } from "./remoteRepo";

describe("remote repo keys", () => {
  it("parses a host id and an absolute path, and nothing else", () => {
    expect(parseRemoteRepo("alinery+ssh://devbox-a1b2c3/home/me/my repo")).toEqual({ hostId: "devbox-a1b2c3", path: "/home/me/my repo" });
    for (const bad of ["/Users/me/repo", "alinery+ssh://", "alinery+ssh://host", "alinery+ssh://host/", "alinery+ssh:///path"]) {
      expect(parseRemoteRepo(bad)).toBeNull();
    }
    expect(isRemoteRepo("alinery+ssh://h-1/x")).toBe(true);
    expect(isRemoteRepo("/Users/me/repo")).toBe(false);
  });

  it("shows the host with the path for a remote repo only", () => {
    expect(repoDisplayPath("alinery+ssh://devbox-a1b2c3/srv/app")).toBe("devbox-a1b2c3:/srv/app");
    expect(repoDisplayPath("/Users/me/repo")).toBe("/Users/me/repo");
  });

  it("walks POSIX paths", () => {
    expect(parentPath("/home/me/proj")).toBe("/home/me");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/home/me/")).toBe("/home");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("/home/me/", "proj")).toBe("/home/me/proj");
  });
});
