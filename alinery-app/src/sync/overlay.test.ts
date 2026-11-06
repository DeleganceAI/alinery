import { create } from "@bufbuild/protobuf";
import { type Cursor, CursorSchema } from "alinery-proto/alinery/v1/common_pb";
import { expect, it } from "vitest";
import { Overlay } from "./overlay";

const at = (seq: number, epoch = "e1"): Cursor => create(CursorSchema, { epoch, seq: BigInt(seq) });

it("shows the new value at once, before the write has been answered", () => {
  const o = new Overlay<string>();
  o.show("new");
  expect(o.read("old", at(1))).toBe("new");
});

it("keeps the new value until the replica has passed the write's cursor", () => {
  const o = new Overlay<string>();
  o.show("new");
  o.applied(at(5));
  expect(o.read("old", at(4))).toBe("new");
  expect(o.read("old", undefined)).toBe("new");
  expect(o.pending).toBe(true);
  expect(o.read("row", at(5))).toBe("row");
  expect(o.pending).toBe(false);
  expect(o.read("row", at(4))).toBe("row"); // dropped for good
});

it("rolls back on an error", () => {
  const o = new Overlay<string>();
  o.show("new");
  o.drop();
  expect(o.read("old", at(1))).toBe("old");
});

it("a restarted daemon (another epoch) ends the layer: its cursor cannot be compared", () => {
  const o = new Overlay<string>();
  o.show("new");
  o.applied(at(50, "e1"));
  expect(o.read("row", at(1, "e2"))).toBe("row");
});

it("an unanswered write holds the layer however far the replica moves", () => {
  const o = new Overlay<string>();
  o.show("new");
  expect(o.read("row", at(999))).toBe("new");
});

it("of two writes in flight the later cursor decides, whichever answer arrives last", () => {
  const o = new Overlay<string>();
  o.show("second");
  o.applied(at(8));
  o.applied(at(5));
  expect(o.read("row", at(6))).toBe("second");
  expect(o.read("row", at(8))).toBe("row");
});
