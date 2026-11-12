import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CodeView, languageFor } from "./CodeView";

afterEach(cleanup);

it("picks the language from the extension, plain text otherwise", () => {
  expect(languageFor("src/a.tsx")).toBe("typescript");
  expect(languageFor("Cargo.TOML")).toBe("ini");
  expect(languageFor("Makefile")).toBeUndefined();
  expect(languageFor("dir.v2/README")).toBeUndefined();
});

it("highlights a known language and numbers every line", () => {
  const { container } = render(<CodeView path="a.ts" text={"const a = 1;\n// two\n"} />);
  expect(container.querySelector(".codeview-gutter")?.textContent).toBe("1\n2");
  expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
  expect(container.querySelector(".hljs-comment")?.textContent).toBe("// two");
});

it("shows unknown files as escaped plain text", () => {
  const { container } = render(<CodeView path="notes" text="<b>x</b>" />);
  expect(container.querySelector("b")).toBeNull();
  expect(container.querySelector(".codeview-code")?.textContent).toBe("<b>x</b>");
});
