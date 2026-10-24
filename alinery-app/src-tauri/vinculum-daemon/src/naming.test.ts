import { expect, test } from "bun:test";
import { chatTitleBucket, cleanChatTitle } from "./naming.ts";

test("chatTitleBucket titles after the first message, then at every tenth", () => {
  const buckets = [0, 1, 2, 9, 10, 19, 20, 31].map((count) => chatTitleBucket(count));
  expect(buckets).toEqual([0, 1, 1, 1, 10, 10, 20, 30]);
});

test("cleanChatTitle strips quoting, prefix, markdown, and trailing punctuation", () => {
  const cases: Array<[string, string]> = [
    ['"Fix login bug"', "Fix login bug"],
    ["'Fix login bug'", "Fix login bug"],
    ["Title: Fix login bug", "Fix login bug"],
    ["TITLE:   Fix login bug", "Fix login bug"],
    ["**Fix login bug**", "Fix login bug"],
    ["# Fix login bug", "Fix login bug"],
    ["`Fix login bug`", "Fix login bug"],
    ["Fix login bug.", "Fix login bug"],
    ["  Fix   the\tlogin bug  ", "Fix the login bug"],
  ];
  for (const [reply, expected] of cases) expect(cleanChatTitle(reply)).toBe(expected);
});

test("cleanChatTitle keeps only the first non-empty line", () => {
  expect(cleanChatTitle("\n  \nFix login bug\nThis thread is about a login bug.")).toBe("Fix login bug");
});

test("cleanChatTitle cuts a long title to 40 characters on a word edge", () => {
  const title = cleanChatTitle("Refactoring the authentication middleware for session tokens");
  expect(title).toBe("Refactoring the authentication");
  expect(title.length).toBeLessThanOrEqual(40);
});

test("cleanChatTitle keeps a word that ends exactly at the 40-character limit", () => {
  expect(cleanChatTitle("Investigating the intermittent websocket crash")).toBe("Investigating the intermittent websocket");
});

test("cleanChatTitle hard-cuts a long title that has no usable word edge", () => {
  expect(cleanChatTitle("x".repeat(60))).toBe("x".repeat(40));
  expect(cleanChatTitle(`Hi ${"x".repeat(60)}`)).toBe(`Hi ${"x".repeat(37)}`);
});

test("cleanChatTitle returns an empty string when nothing is left", () => {
  for (const reply of ["", "   \n  ", '""', "Title:"]) expect(cleanChatTitle(reply)).toBe("");
});
