// What serde does with a TOML table, shared by the parsers of files Rust also reads (task.md, config.toml,
// app.toml). Five rules: a wrong type refuses the whole file, a missing field takes its default, unknown
// keys are ignored, an integer must fit its Rust type, and a field named `required` has no default.
export type Obj = Record<string, unknown>;
export class Refuse extends Error {}
export const refuse = (): never => {
  throw new Refuse();
};

export const present = (o: Obj, k: string) => o[k] !== undefined;
export const str = (o: Obj, k: string, fallback = ""): string => (present(o, k) ? (typeof o[k] === "string" ? (o[k] as string) : refuse()) : fallback);
export const req = (o: Obj, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : refuse());
export const bool = (o: Obj, k: string, fallback = false): boolean => (present(o, k) ? (typeof o[k] === "boolean" ? (o[k] as boolean) : refuse()) : fallback);
export const uint = (v: unknown, max: number): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : refuse());
export const u64 = (o: Obj, k: string): bigint => (typeof o[k] === "bigint" && (o[k] as bigint) >= 0n && (o[k] as bigint) < 2n ** 64n ? (o[k] as bigint) : BigInt(uint(o[k], Number.MAX_SAFE_INTEGER)));
export const u32 = (o: Obj, k: string, fallback: number): number => (present(o, k) ? uint(o[k], 2 ** 32 - 1) : fallback);
export const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : refuse());
export const strings = (v: unknown): string[] => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : refuse());

export const tomlParse = (text: string): unknown => {
  try {
    return Bun.TOML.parse(text);
  } catch {
    return refuse();
  }
};

