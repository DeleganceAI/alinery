import { describe, expect, it } from "vitest";
import { buildRenderedDiff, diffLineKind, diffLineParts, diffStatusForNode, hashText, isDiffCodeBlock, takeChars } from "./diff";

const node = (start: number, end: number) => ({ position: { start: { line: start }, end: { line: end } } });

describe("isDiffCodeBlock", () => {
  it("trusts an explicit language tag", () => {
    expect(isDiffCodeBlock("language-diff", "anything at all")).toBe(true);
    expect(isDiffCodeBlock("hljs language-patch", "anything at all")).toBe(true);
  });

  it("recognises a git diff by its header", () => {
    expect(isDiffCodeBlock(undefined, "diff --git a/x b/x\nindex 1..2 100644\n")).toBe(true);
  });

  it("requires the whole ---/+++/@@ triple, not just one of them", () => {
    const full = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
    expect(isDiffCodeBlock(undefined, full)).toBe(true);
    // `---` alone is a markdown horizontal rule or a YAML front-matter fence. Treating it
    // as a diff would render ordinary prose as a patch.
    expect(isDiffCodeBlock(undefined, "---\ntitle: a document\n---")).toBe(false);
    expect(isDiffCodeBlock(undefined, "--- a/x\n+++ b/x")).toBe(false);
  });

  it("does not treat a plain code block as a diff", () => {
    expect(isDiffCodeBlock("language-ts", "const x = 1;\n")).toBe(false);
    expect(isDiffCodeBlock(undefined, "")).toBe(false);
  });
});

describe("diffLineKind", () => {
  it("classifies additions and removals", () => {
    expect(diffLineKind("+added")).toBe("addition");
    expect(diffLineKind("-removed")).toBe("removal");
    expect(diffLineKind(" context")).toBe("context");
    expect(diffLineKind("@@ -1,2 +1,3 @@")).toBe("hunk");
  });

  // The whole reason diffLineKind is not a one-liner: a unified diff's file headers start
  // with the same characters as its content lines. Getting this wrong counts every patch's
  // header as one added and one removed line.
  it("reads +++/--- as file headers, never as a one-character add or remove", () => {
    expect(diffLineKind("+++ b/src/main.rs")).toBe("file");
    expect(diffLineKind("--- a/src/main.rs")).toBe("file");
    expect(diffLineKind("diff --git a/x b/x")).toBe("file");
    expect(diffLineKind("index 83db48f..bf269f4 100644")).toBe("file");
  });

  it("still classifies ++ and -- as content, since only the triple is a header", () => {
    expect(diffLineKind("++x")).toBe("addition");
    expect(diffLineKind("--x")).toBe("removal");
  });
});

describe("diffLineParts", () => {
  it("splits the marker off content lines", () => {
    expect(diffLineParts("+added")).toEqual({ marker: "+", body: "added" });
    expect(diffLineParts("-gone")).toEqual({ marker: "-", body: "gone" });
    expect(diffLineParts(" kept")).toEqual({ marker: " ", body: "kept" });
  });

  it("leaves headers whole", () => {
    expect(diffLineParts("+++ b/x")).toEqual({ marker: "", body: "+++ b/x" });
    expect(diffLineParts("@@ -1 +1 @@")).toEqual({ marker: "", body: "@@ -1 +1 @@" });
  });

  it("handles an empty line without slicing off a character that is not there", () => {
    expect(diffLineParts("")).toEqual({ marker: "", body: "" });
  });
});

describe("buildRenderedDiff", () => {
  it("drops file headers, hunk headers and the no-newline marker", () => {
    const text = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "-old line", "\\ No newline at end of file", "+new line"].join("\n");
    const { markdown, statusByLine } = buildRenderedDiff(text, undefined);
    expect(markdown.split("\n").filter((l) => l.trim())).toEqual(["old line", "new line"]);
    expect(statusByLine.get(1)).toBe("removal");
  });

  it("separates a run of removals from a run of additions", () => {
    const { markdown } = buildRenderedDiff("-one\n-two\n+three", undefined);
    // Without the inserted blank, "two" and "three" render as one markdown paragraph.
    expect(markdown).toBe("one\ntwo\n\nthree");
  });

  it("does not break a table by inserting a blank between its rows", () => {
    const text = ["+| a | b |", "+| - | - |", "-| 1 | 2 |"].join("\n");
    const { markdown } = buildRenderedDiff(text, undefined);
    expect(markdown).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
  });

  it("does not double up an existing blank line", () => {
    const { markdown } = buildRenderedDiff("-one\n\n+two", undefined);
    expect(markdown).toBe("one\n\ntwo");
  });

  it("handles CRLF input", () => {
    const { markdown, statusByLine } = buildRenderedDiff("+added\r\n-removed\r\n", undefined);
    expect(markdown.split("\n").filter((l) => l.trim())).toEqual(["added", "removed"]);
    expect(statusByLine.get(1)).toBe("addition");
  });

  it("maps rendered lines back to source lines when the node has a position", () => {
    const { sourceLineByLine } = buildRenderedDiff("+a\n+b", node(10, 12));
    // startLine + index + 1: the fence line itself is not content.
    expect(sourceLineByLine.get(1)).toBe(11);
    expect(sourceLineByLine.get(2)).toBe(12);
  });

  it("reports source line 0 when there is no position to map to", () => {
    const { sourceLineByLine } = buildRenderedDiff("+a", undefined);
    expect(sourceLineByLine.get(1)).toBe(0);
  });

  it("tolerates an empty diff", () => {
    expect(buildRenderedDiff("", undefined).markdown).toBe("");
  });
});

describe("diffStatusForNode", () => {
  const diff = buildRenderedDiff("-gone\n+added", undefined);

  it("reports mixed when the range covers both", () => {
    expect(diffStatusForNode(node(1, 3), diff)).toBe("mixed");
  });

  it("reports a single status when the range covers one kind", () => {
    expect(diffStatusForNode(node(1, 1), diff)).toBe("removal");
    expect(diffStatusForNode(node(3, 3), diff)).toBe("addition");
  });

  it("falls back to context without a usable position", () => {
    expect(diffStatusForNode(undefined, diff)).toBe("context");
    expect(diffStatusForNode(node(0, 0), diff)).toBe("context");
  });
});

describe("hashText", () => {
  it("is stable and fixed width", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
    expect(hashText("hello")).toHaveLength(8);
    expect(hashText("")).toHaveLength(8);
  });

  it("distinguishes different text", () => {
    expect(hashText("a")).not.toBe(hashText("b"));
  });

  // Comment anchors are keyed on this hash. Iterating code points rather than UTF-16
  // units keeps a surrogate pair from being hashed as two lone halves.
  it("hashes astral characters as single code points", () => {
    expect(hashText("🎉")).toHaveLength(8);
    expect(hashText("🎉")).not.toBe(hashText("🎈"));
  });
});

describe("takeChars", () => {
  it("truncates to a count of code points", () => {
    expect(takeChars("abcdef", 3)).toBe("abc");
    expect(takeChars("abc", 10)).toBe("abc");
    expect(takeChars("", 5)).toBe("");
  });

  // `"🎉🎉".slice(0, 1)` yields half a surrogate pair and renders as U+FFFD.
  it("never cuts an astral character in half", () => {
    expect(takeChars("🎉🎉🎉", 2)).toBe("🎉🎉");
    expect([...takeChars("🎉🎉🎉", 1)]).toHaveLength(1);
  });
});
