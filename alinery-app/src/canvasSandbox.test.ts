import * as vega from "vega";
import { describe, expect, it } from "vitest";
import { CANVAS_SANDBOX, lockedLoader, withCanvasCsp } from "./canvasSandbox";

describe("canvas sandbox", () => {
  it("puts the CSP ahead of anything the agent wrote, and never grants same-origin", () => {
    const page = withCanvasCsp('<meta http-equiv="Content-Security-Policy" content="default-src *"><script>1</script>');
    expect(page.indexOf("default-src 'none'")).toBeLessThan(page.indexOf("default-src *"));
    expect(CANVAS_SANDBOX).not.toContain("allow-same-origin");
  });

  it("a chart's loader fetches nothing and links nowhere", async () => {
    const loader = lockedLoader(vega.loader());
    await expect(loader.load("https://example.com/data.json")).rejects.toThrow("loads no data");
    await expect(loader.http("https://example.com/x", {})).rejects.toThrow();
    await expect(loader.file("/etc/passwd")).rejects.toThrow();
    expect(await loader.sanitize("https://example.com", { context: "href" })).toEqual({ href: null });
  });
});
