import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./shared", () => ({ repoName: (repo: string) => repo }));

import { DaemonConflictBanner, HostGuardWarning } from "./DaemonConflictBanner";
import type { DaemonConflict } from "./types";

const warning =
  "OMP sessions are unavailable because Alinery could not validate its executable path. Use the confirmed Restart daemon / Stop all sessions action in Settings → Chat to restore OMP host protection. Terminal sessions remain available.";

describe("HostGuardWarning", () => {
  it("renders nothing when host protection is complete", () => {
    expect(renderToStaticMarkup(<HostGuardWarning visible={false} />)).toBe("");
  });

  it("renders the persistent non-actionable warning when protection is incomplete", () => {
    const html = renderToStaticMarkup(<HostGuardWarning visible />);

    expect(html).toContain('role="alert"');
    expect(html).toContain(warning);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });
});

describe("DaemonConflictBanner", () => {
  const conflict: DaemonConflict = {
    repo: "/repo",
    reason: "ownership",
    detail: "Could not inspect owner lock: permission denied",
    daemon_protocol: null,
    app_protocol: 1,
    daemon_app_config_identity: null,
    app_config_identity: null,
    live_sessions: 0,
  };

  it("shows uncertain ownership diagnostics without offering a destructive action", () => {
    const html = renderToStaticMarkup(<DaemonConflictBanner conflict={conflict} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(conflict.detail);
    expect(html).not.toContain("<button");
  });

  it.each(["protocol", "app_config"] as const)("offers no takeover for a %s conflict even with live sessions", (reason) => {
    const html = renderToStaticMarkup(<DaemonConflictBanner conflict={{ ...conflict, reason, live_sessions: 2 }} />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("<button");
  });

  it("clears when project ownership is available", () => {
    expect(renderToStaticMarkup(<DaemonConflictBanner conflict={null} />)).toBe("");
  });
});
