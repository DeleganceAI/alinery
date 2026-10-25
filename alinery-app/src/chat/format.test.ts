import { describe, expect, it } from "vitest";
import { formatChatStamp, formatTinyTime } from "./format";

const at = Date.parse("2026-09-05T12:11:00Z");

describe("formatChatStamp", () => {
  it("formats date and time together by default", () => {
    expect(formatChatStamp(at)).toMatch(/Sep 5 \d{2}:\d{2}/);
    expect(formatTinyTime(at)).toBe(formatChatStamp(at, { date: true, time: true }));
  });

  it("can show date or time alone, or neither", () => {
    expect(formatChatStamp(at, { date: true, time: false })).toBe("Sep 5");
    expect(formatChatStamp(at, { date: false, time: true })).toMatch(/^\d{2}:\d{2}$/);
    expect(formatChatStamp(at, { date: false, time: false })).toBe("");
  });
});
