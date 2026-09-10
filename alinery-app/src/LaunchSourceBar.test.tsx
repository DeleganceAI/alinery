import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LaunchSourceBar } from "./LaunchSourceBar";

const UNKNOWN_SOURCE_ERROR = "ERROR: launch path unknown — development launcher did not provide provenance";

describe("LaunchSourceBar", () => {
  it("renders the complete source path verbatim as visible text", () => {
    const sourceRoot = "/Users/example/Alinery source worktrees/日本語/task-one";
    const html = renderToStaticMarkup(<LaunchSourceBar sourceRoot={sourceRoot} />);

    expect(html).toContain("ALINERY SOURCE");
    expect(html).toContain(sourceRoot);
    expect(html).not.toContain(`title="${sourceRoot}"`);
  });

  it("keeps the bar and exposes an alert when launch provenance is missing", () => {
    const html = renderToStaticMarkup(<LaunchSourceBar sourceRoot="" />);

    expect(html).toContain("ALINERY SOURCE");
    expect(html).toContain(UNKNOWN_SOURCE_ERROR);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("title=");
  });
});
