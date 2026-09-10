// Diff parsing and anchor identity for rendered artifacts.
//
// This was ~90 lines of unexported functions inside ArtifactMarkdown.tsx — the densest
// pure logic in the frontend, and the only part of it no test could reach. Pulled out
// here for the same reason confirm-focus.ts exists (see AGENTS.md): when logic worth
// testing lives inside a component, the cheap move is to make it React-free rather than
// to reach for a heavier renderer.
//
// Nothing here imports React or touches the DOM.

/** The subset of a remark AST node this module reads: 1-based source line numbers. */
export type MarkdownPositionNode = {
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
};

export type DiffLineKind = "addition" | "removal" | "hunk" | "file" | "context";
export type RenderedDiffStatus = "addition" | "removal" | "mixed" | "context";

export type RenderedDiff = {
  markdown: string;
  statusByLine: Map<number, DiffLineKind>;
  sourceLineByLine: Map<number, number>;
};

/** FNV-1a, 32-bit. Iterates code points, so it is stable across surrogate pairs. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Truncate by code point, not by UTF-16 unit, so an emoji is never cut in half. */
export function takeChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * A fenced block is a diff if it says so, or if it looks like one: either a `diff --git`
 * header, or the full `---` + `+++` + `@@` triple. The triple is required together —
 * a `---` on its own is a markdown horizontal rule or a YAML fence.
 */
export function isDiffCodeBlock(className: string | undefined, text: string): boolean {
  if (/\blanguage-(?:diff|patch)\b/.test(className ?? "")) return true;
  return /^diff --git /m.test(text) || (/^--- .+$/m.test(text) && /^\+\+\+ .+$/m.test(text) && /^@@/m.test(text));
}

/**
 * `+++`/`---` are file headers, not a one-line addition/removal — the length-3 check is
 * what keeps a unified diff's header out of the added/removed counts.
 */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+") && !line.startsWith("+++")) return "addition";
  if (line.startsWith("-") && !line.startsWith("---")) return "removal";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "file";
  return "context";
}

/** Split the leading +/-/space marker off, leaving the body to be rendered as markdown. */
export function diffLineParts(line: string): { marker: string; body: string } {
  if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")) || line.startsWith(" ")) {
    return { marker: line.slice(0, 1), body: line.slice(1) };
  }
  return { marker: "", body: line };
}

/**
 * Strip a diff down to renderable markdown, remembering what each rendered line came from.
 *
 * File headers, hunk headers and the `\ No newline at end of file` marker are dropped
 * entirely. A blank separator line is inserted when the add/remove status changes, so
 * consecutive additions render as one paragraph rather than running into the removals
 * next to them — but *not* across table rows or existing blank lines, where an inserted
 * blank would break the table or double the gap.
 */
export function buildRenderedDiff(text: string, node: MarkdownPositionNode | undefined): RenderedDiff {
  const startLine = node?.position?.start?.line ?? 0;
  const markdownLines: string[] = [];
  const statusByLine = new Map<number, DiffLineKind>();
  const sourceLineByLine = new Map<number, number>();

  let previousStatus: DiffLineKind | null = null;
  let previousWasTable = false;
  let previousWasBlank = true;

  text
    // `\r?` matters: the split below handles CRLF between lines, but this trailing-newline
    // strip ran first and only removed the "\n", leaving a lone "\r" glued to the final
    // line of any CRLF diff. That carriage return then flowed into the rendered markdown
    // and — worse — into hashText() for the comment anchor id, so the same artifact
    // produced different anchors depending on the line endings it was written with.
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const kind = diffLineKind(line);
      if (kind === "file" || kind === "hunk" || line.startsWith("\\ No newline at end of file")) return;
      const { body } = diffLineParts(line);
      const isBlank = body.trim().length === 0;
      const isTableLine = /^\s*\|.*\|\s*$/.test(body);
      if (!isBlank && !isTableLine && !previousWasBlank && !previousWasTable && previousStatus !== null && previousStatus !== kind) {
        markdownLines.push("");
      }
      markdownLines.push(body);
      const renderedLine = markdownLines.length;
      statusByLine.set(renderedLine, kind);
      sourceLineByLine.set(renderedLine, startLine > 0 ? startLine + index + 1 : 0);
      previousStatus = kind;
      previousWasTable = isTableLine;
      previousWasBlank = isBlank;
    });

  return { markdown: markdownLines.join("\n"), statusByLine, sourceLineByLine };
}

/** Reduce a node's line range to one status; both kinds present reads as "mixed". */
export function diffStatusForNode(node: MarkdownPositionNode | undefined, diff: RenderedDiff): RenderedDiffStatus {
  const start = node?.position?.start?.line ?? 0;
  const end = node?.position?.end?.line ?? 0;
  if (start <= 0 || end <= 0) return "context";

  let hasAddition = false;
  let hasRemoval = false;
  for (let line = start; line <= end; line += 1) {
    const status = diff.statusByLine.get(line);
    hasAddition ||= status === "addition";
    hasRemoval ||= status === "removal";
  }
  if (hasAddition && hasRemoval) return "mixed";
  if (hasAddition) return "addition";
  if (hasRemoval) return "removal";
  return "context";
}
