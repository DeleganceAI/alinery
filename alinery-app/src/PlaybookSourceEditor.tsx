import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import "./PlaybookSourceEditor.css";

type PlaybookSourceEditorProps = {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
};

function highlightTokens(line: string, toml: boolean): ReactNode[] {
  const pattern = toml ? /#[^\r\n]*|"(?:\\.|[^"\\])*"|'[^']*'|\b(?:true|false)\b|\b\d+(?:\.\d+)?\b|[\w.-]+(?=\s*=)/g : /`[^`]+`|\[[^\]]+\]\([^)]*\)|\*\*[^*]+\*\*|__[^_]+__/g;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > offset) parts.push(line.slice(offset, match.index));
    const text = match[0];
    const token = toml
      ? text.startsWith("#")
        ? "comment"
        : /^["']/.test(text)
          ? "string"
          : /^(?:true|false|\d)/.test(text)
            ? "literal"
            : "key"
      : text.startsWith("`")
        ? "string"
        : text.startsWith("[")
          ? "key"
          : "emphasis";
    parts.push(
      <span className={`playbook-source-${token}`} key={match.index}>
        {text}
      </span>,
    );
    offset = match.index + text.length;
  }
  if (offset < line.length) parts.push(line.slice(offset));
  return parts;
}

// Only the decorative layer is tokenized. The textarea always receives and emits raw source.
function highlightSource(value: string) {
  const lines = value.split(/\r\n|\r|\n/);
  let frontmatter = lines[0] === "+++";
  let fence = "";
  let offset = 0;
  const highlighted = lines.map((line, index) => {
    const lineOffset = offset;
    offset += line.length + 1;
    let token = "";
    let content: ReactNode = line;
    if (frontmatter && line === "+++") {
      token = "delimiter";
      if (index > 0) frontmatter = false;
    } else if (frontmatter) {
      if (/^\s*\[.+\]\s*(?:#.*)?$/.test(line)) token = "key";
      else content = highlightTokens(line, true);
    } else {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
        fence = fence ? "" : marker;
        token = "delimiter";
      } else if (fence) token = "string";
      else if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) token = "key";
      else if (/^\s*<!--/.test(line)) token = "comment";
      else content = highlightTokens(line, false);
    }
    return (
      <span className={`playbook-source-line${token ? ` playbook-source-${token}` : ""}`} key={lineOffset}>
        {line ? content : "\u200b"}
      </span>
    );
  });
  return { highlighted, numbers: lines.map((_, index) => index + 1) };
}
// A textarea exposes LF even for CRLF source. Splice only the edited range so
// untouched bytes (including mixed line endings) are not silently rewritten.
function applySourceEdit(source: string, next: string): string {
  if (!source.includes("\r")) return next;
  const normalized = source.replace(/\r\n?/g, "\n");
  let start = 0;
  while (start < normalized.length && start < next.length && normalized[start] === next[start]) start++;
  let end = normalized.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && normalized[end - 1] === next[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  let rawStart = 0;
  let rawEnd = source.length;
  for (let raw = 0, position = 0; position <= end; position++, raw++) {
    if (position === start) rawStart = raw;
    if (position === end) {
      rawEnd = raw;
      break;
    }
    if (source[raw] === "\r" && source[raw + 1] === "\n") raw++;
  }
  const newline = source.match(/\r\n?|\n/)?.[0] || "\n";
  return source.slice(0, rawStart) + next.slice(start, nextEnd).replace(/\n/g, newline) + source.slice(rawEnd);
}

export function PlaybookSourceEditor({ value, onChange, readOnly = false, disabled = false }: PlaybookSourceEditorProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const { highlighted, numbers } = useMemo(() => highlightSource(value), [value]);

  const syncScroll = () => {
    const textarea = input.current;
    if (!textarea || !overlay.current || !code.current || !gutter.current) return;
    code.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
    gutter.current.style.transform = `translateY(${-textarea.scrollTop}px)`;
  };

  const syncLayout = () => {
    const textarea = input.current;
    const highlightedCode = code.current;
    const lineNumbers = gutter.current;
    if (!textarea || !overlay.current || !highlightedCode || !lineNumbers) return;
    overlay.current.style.width = `${textarea.clientWidth}px`;
    overlay.current.style.height = `${textarea.clientHeight}px`;
    // A logical line may occupy several visual rows. Read all heights before
    // updating the gutter so wrapping never adds or renumbers source lines.
    const heights = Array.from(highlightedCode.children, (line) => line.getBoundingClientRect().height);
    for (let index = 0; index < heights.length; index++) {
      (lineNumbers.children[index] as HTMLElement).style.height = `${heights[index]}px`;
    }
    syncScroll();
  };

  useLayoutEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const observer = new ResizeObserver(syncLayout);
    observer.observe(textarea);
    if (code.current) observer.observe(code.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(syncLayout, [value]);

  return (
    <div className="playbook-source-editor" data-disabled={disabled || undefined}>
      <div className="playbook-source-gutter" aria-hidden="true">
        <pre ref={gutter}>
          {numbers.map((number) => (
            <span className="playbook-source-line" key={number}>
              {number}
            </span>
          ))}
        </pre>
      </div>
      <div className="playbook-source-document">
        <div className="playbook-source-overlay" ref={overlay} aria-hidden="true">
          <pre ref={code}>{highlighted}</pre>
        </div>
        <textarea
          ref={input}
          aria-label="Playbook source"
          value={value}
          onChange={(event) => onChange(applySourceEdit(value, event.currentTarget.value))}
          onScroll={syncScroll}
          readOnly={readOnly}
          disabled={disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="soft"
        />
      </div>
    </div>
  );
}
