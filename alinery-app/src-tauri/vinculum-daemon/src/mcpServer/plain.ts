// A protobuf message as the plain JSON object `alinery-mcp` has always answered with: the proto's own (snake_case) field names, 64-bit
// numbers as numbers (every one the tools carry is far under 2^53), an unset optional or message as null, and `google.protobuf` values
// (Struct, Value) as the JSON they hold. The daemon's entities were built from the Rust structs these replies serialized, so the names agree.
import { type DescField, type DescMessage, type Message, toJson } from "@bufbuild/protobuf";

type Row = Record<string, unknown>;

const JSON_VALUE = new Set(["google.protobuf.Struct", "google.protobuf.Value", "google.protobuf.ListValue"]);

function scalar(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}

function one(field: DescField, value: unknown): unknown {
  if (value === undefined) return null;
  const kind = field.fieldKind === "list" ? field.listKind : field.fieldKind === "map" ? field.mapKind : field.fieldKind;
  const message = field.fieldKind === "message" || field.fieldKind === "list" || field.fieldKind === "map" ? field.message : undefined;
  // A generated type hands Struct, Value and ListValue over either as the JSON they hold or as a message, depending on the file; the
  // other well-known types (Timestamp, Duration) always need `toJson`.
  if (kind === "message" && message) {
    if (JSON_VALUE.has(message.typeName)) return (value as Partial<Message>).$typeName ? toJson(message, value as Message) : value;
    return message.typeName.startsWith("google.protobuf.") ? toJson(message, value as Message) : plain(message, value as Message);
  }
  return scalar(value);
}

export function plain(schema: DescMessage, message: unknown): Row {
  const out: Row = {};
  const source = message as Row;
  for (const field of schema.fields) {
    if (field.oneof) {
      const chosen = source[field.oneof.localName] as { case?: string; value?: unknown } | undefined;
      if (chosen?.case !== field.localName) continue;
      out[field.name] = one(field, chosen.value);
      continue;
    }
    const value = source[field.localName];
    if (field.fieldKind === "list") out[field.name] = ((value as unknown[] | undefined) ?? []).map((item) => one(field, item));
    else if (field.fieldKind === "map") out[field.name] = Object.fromEntries(Object.entries((value as Row | undefined) ?? {}).map(([k, v]) => [k, one(field, v)]));
    else out[field.name] = one(field, value);
  }
  return out;
}
