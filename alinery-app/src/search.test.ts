import { describe, expect, it } from "vitest";
import { type SearchDocument, searchDocuments } from "./search";

const documents: SearchDocument[] = [
  { id: "action:settings", kind: "action", title: "Open Settings", detail: "", searchText: "settings" },
  { id: "task:search", kind: "task", title: "Build unified search", detail: "alinery · feature/search", searchText: "superdevelop implementation" },
  { id: "session:search", kind: "session", title: "Build unified search", detail: "alinery · Research · Claude", searchText: "s123 claude opus" },
  { id: "task:architecture", kind: "task", title: "Architecture", detail: "alinery", searchText: "Requests land on the API and enqueue jobs" },
];

describe("searchDocuments", () => {
  it("shows actions before a query", () => {
    expect(searchDocuments("", documents).map((document) => document.id)).toEqual(["action:settings"]);
  });

  it("matches multiword task metadata", () => {
    expect(searchDocuments("enqueue jobs", documents).map((document) => document.id)).toEqual(["task:architecture"]);
  });

  it("matches session metadata", () => {
    expect(searchDocuments("s123 opus", documents).map((document) => document.id)).toEqual(["session:search"]);
  });

  it("ranks exact titles before metadata matches", () => {
    const exact: SearchDocument = { id: "task:exact", kind: "task", title: "alinery", detail: "", searchText: "" };
    expect(searchDocuments("alinery", [...documents, exact])[0].id).toBe("task:exact");
  });
});
