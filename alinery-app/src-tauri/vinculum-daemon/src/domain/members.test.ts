import { expect, test } from "bun:test";
import { Members } from "./members.ts";

test("pending requests are published, expire after ten minutes, and are bounded", () => {
  let now = 0;
  const published: string[][] = [];
  const members = new Members((pending) => published.push(pending.map((p) => p.label)), () => now);
  const a = members.request("a\u0007 on Mac");
  expect(published.at(-1)).toEqual(["a  on Mac"]);
  members.decide(a.id, true);
  expect(published.at(-1)).toEqual([]); // approved, waiting only for the asker to collect
  members.request("b");
  now = 10 * 60_000 + 1;
  members.prune();
  expect(published.at(-1)).toEqual([]);
  expect(members.collect(a.id, a.secret).state).toBe("denied"); // never collected in time
  for (let i = 0; i < 20; i++) members.request(`x${i}`);
  expect(() => members.request("one too many")).toThrow("too many");
});

test("only a collected token is a member's, and a decided request cannot be decided again", () => {
  const members = new Members();
  const r = members.request("jon");
  expect(members.decide(r.id, false)).toBe(true);
  expect(members.decide(r.id, true)).toBe(false);
  const s = members.request("pat");
  members.decide(s.id, true);
  const { token } = members.collect(s.id, s.secret);
  expect(members.has(token)).toBe(true);
  expect(members.has("f".repeat(64))).toBe(false);
});
