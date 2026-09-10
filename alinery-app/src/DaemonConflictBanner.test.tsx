import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./shared", () => ({ repoName: (repo: string) => repo }));

import { HostGuardWarning } from "./DaemonConflictBanner";

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
