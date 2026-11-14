import { create } from "@bufbuild/protobuf";
import { type Entity, EntitySchema } from "alinery-proto/alinery/v1/entities_pb";
import { describe, expect, it } from "vitest";
import { liveDrawerShellsOf } from "./chat";

const session = (key: string, s: { harness: string; process?: string; archived?: boolean; created: number }): Entity =>
  create(EntitySchema, {
    key,
    value: {
      case: "session",
      value: {
        id: key.split("/").pop(),
        harness: s.harness,
        archived: s.archived ?? false,
        created: BigInt(s.created),
        ...(s.process ? { status: { process: s.process } } : {}),
      },
    },
  });

describe("liveDrawerShellsOf (#184)", () => {
  it("keeps task-less Terminal sessions that are starting or alive, oldest first", () => {
    const rows = [
      session("session/_/newer", { harness: "no-harness", process: "alive", created: 20 }),
      session("session/_/older", { harness: "no-harness", process: "starting", created: 10 }),
      session("session/_/exited", { harness: "no-harness", process: "exited", created: 5 }),
      session("session/_/never", { harness: "no-harness", created: 6 }),
      session("session/_/archived", { harness: "no-harness", process: "alive", archived: true, created: 7 }),
      session("session/_/chat", { harness: "vinculum", process: "alive", created: 8 }),
      session("session/task/in-task", { harness: "no-harness", process: "alive", created: 9 }),
    ];
    expect(liveDrawerShellsOf(rows).map((s) => s.id)).toEqual(["older", "newer"]);
  });
});
