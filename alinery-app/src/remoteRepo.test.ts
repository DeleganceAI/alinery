import { describe, expect, it } from "vitest";
import { isRemoteRepo, joinPath, parentPath, parseRemoteRepo, relatedRepoKey, relatedStoredPath, repoDisplayPath, sameMachine } from "./remoteRepo";

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

describe("repos on one machine", () => {
  const a = "alinery+ssh://box-a1b2c3/srv/a";
  const b = "alinery+ssh://box-a1b2c3/srv/b";
  const elsewhere = "alinery+ssh://other-00aa11/srv/a";

  it("treats local repos as one machine and each host as its own", () => {
    expect(sameMachine("/Users/me/a", "/Users/me/b")).toBe(true);
    expect(sameMachine(a, b)).toBe(true);
    expect(sameMachine(a, elsewhere)).toBe(false);
    expect(sameMachine(a, "/Users/me/a")).toBe(false);
  });

  it("stores a related repo as a path on the task's own machine, and only for that machine", () => {
    expect(relatedStoredPath("/Users/me/a", "/Users/me/b")).toBe("/Users/me/b");
    expect(relatedStoredPath(a, b)).toBe("/srv/b");
    expect(relatedStoredPath(a, elsewhere)).toBeNull();
    expect(relatedStoredPath(a, "/Users/me/b")).toBeNull();
    expect(relatedStoredPath("/Users/me/a", b)).toBeNull();
  });

  it("turns a stored related path back into the repo key the board uses", () => {
    expect(relatedRepoKey(a, "/srv/b")).toBe(b);
    expect(relatedRepoKey("/Users/me/a", "/Users/me/b")).toBe("/Users/me/b");
    expect(relatedRepoKey(a, relatedStoredPath(a, b) ?? "")).toBe(b);
  });
});
