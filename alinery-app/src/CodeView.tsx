import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { useMemo } from "react";

// ponytail: toml highlights as ini, tsx/jsx as their base language; add a grammar when one reads badly.
for (const [name, lang] of Object.entries({ bash, css, diff, go, javascript, json, markdown, python, rust, sql, typescript, xml, yaml, ini })) hljs.registerLanguage(name, lang);

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  rs: "rust",
  toml: "ini",
  ini: "ini",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  css: "css",
  html: "xml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

/** The highlight.js language for a file name, from its extension; undefined for plain text. */
export function languageFor(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 || dot < path.lastIndexOf("/") ? undefined : BY_EXTENSION[path.slice(dot + 1).toLowerCase()];
}

/** A read-only source file: highlighted by extension, with a line-number gutter. */
export function CodeView({ path, text }: { path: string; text: string }) {
  const language = languageFor(path);
  const html = useMemo(() => (language ? hljs.highlight(text, { language, ignoreIllegals: true }).value : undefined), [language, text]);
  const lineCount = text === "" ? 1 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return (
    <div className="codeview">
      <pre className="codeview-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
      </pre>
      {/* hljs escapes the source; its output is spans only. */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output */}
      <pre className="codeview-code">{html === undefined ? <code>{text}</code> : <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />}</pre>
    </div>
  );
}
