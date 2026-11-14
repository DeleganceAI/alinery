import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import { isHostOnboarded, markHostOnboarded, migrateLegacyOnboarding, withHostOnboarded } from "./onboarding";
import type { AppConfig } from "./types";

const LEGACY = "alinery.onboardingCompleted.v1";
const REMOTE = "alinery+ssh://devbox-a1b2c3/home/me/repo";
const config = (extra: Partial<AppConfig> = {}): AppConfig =>
  ({
    active_repo: "/repo",
    known_repos: ["/repo", REMOTE],
    mcp_enabled: true,
    remote_hosts: { "devbox-a1b2c3": { label: "devbox", ssh_args: ["me@box"], onboarded: false } },
    ...extra,
  }) as AppConfig;

let setMark: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setMark = vi.spyOn(ipc, "setHostOnboarded").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the per-host onboarded mark", () => {
  it("reads this computer's mark for a local repo and the host's mark for a remote one", () => {
    const cfg = config({ local_onboarded: true });
    expect(isHostOnboarded(cfg, "/repo")).toBe(true);
    expect(isHostOnboarded(cfg, "")).toBe(true);
    expect(isHostOnboarded(cfg, REMOTE)).toBe(false);
    const both = withHostOnboarded(cfg, REMOTE);
    expect(isHostOnboarded(both, REMOTE)).toBe(true);
    expect(isHostOnboarded(config(), "/repo")).toBe(false);
  });

  it("marks the host of the repo and drops the saved step", async () => {
    window.localStorage.setItem("alinery.onboardingStep.v1", "models");
    await markHostOnboarded(REMOTE);
    expect(setMark).toHaveBeenCalledWith("devbox-a1b2c3", true);
    expect(window.localStorage.getItem("alinery.onboardingStep.v1")).toBeNull();
    await markHostOnboarded("/repo");
    expect(setMark).toHaveBeenLastCalledWith("local", true);
  });
});

describe("the one-time move of the old localStorage flag", () => {
  it("hands the flag to this computer's mark once, then the key is gone", async () => {
    window.localStorage.setItem(LEGACY, "1");
    const moved = await migrateLegacyOnboarding(config());
    expect(setMark).toHaveBeenCalledExactlyOnceWith("local", true);
    expect(moved.local_onboarded).toBe(true);
    expect(window.localStorage.getItem(LEGACY)).toBeNull();

    const again = await migrateLegacyOnboarding(config());
    expect(setMark).toHaveBeenCalledTimes(1);
    expect(again.local_onboarded).toBeUndefined();
  });

  it("changes nothing without the flag", async () => {
    const cfg = config();
    expect(await migrateLegacyOnboarding(cfg)).toBe(cfg);
    expect(setMark).not.toHaveBeenCalled();
  });

  it("keeps the key for the next launch when the shell refuses", async () => {
    window.localStorage.setItem(LEGACY, "1");
    setMark.mockRejectedValueOnce(new Error("disk full"));
    const moved = await migrateLegacyOnboarding(config());
    expect(moved.local_onboarded).toBe(true);
    expect(window.localStorage.getItem(LEGACY)).toBe("1");
  });
});
