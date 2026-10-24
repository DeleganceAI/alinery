import { expect, test } from "bun:test";
import { rememberSessionEnv, sessionByToolEnv, soleConversationOwner } from "./sessionLookup.ts";

type Row = { id: string; conversationId: string };

const rows: Row[] = [
  { id: "baseline", conversationId: "1" },
  { id: "solution-space", conversationId: "1" },
];

function lookup(env: unknown) {
  return sessionByToolEnv(env, "1", (id) => rows.find((row) => row.id === id), rows);
}

test("a shared conversation id is not a session", () => {
  expect(soleConversationOwner(rows, "1")).toBeUndefined();
  expect(lookup(undefined)?.id).toBeUndefined();
});

test("the environment stamp selects the session whose tool is running", () => {
  const baseline = {};
  const solution = {};
  rememberSessionEnv(baseline, "baseline");
  rememberSessionEnv(solution, "solution-space");
  expect(lookup(baseline)?.id).toBe("baseline");
  expect(lookup(solution)?.id).toBe("solution-space");
});

test("one live conversation id still resolves without a stamp", () => {
  const only = [{ id: "only", conversationId: "1" }];
  expect(sessionByToolEnv(undefined, "1", (id) => only.find((row) => row.id === id), only)?.id).toBe("only");
});
