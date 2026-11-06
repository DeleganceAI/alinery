// The file parsers that feed the store (plan 2.2.8, feed 2). A parser owns a family of paths under
// `.alinery/`: `match` recognises one by its path relative to `.alinery/` (forward slashes), `key` names
// the row it feeds (so a missing file can delete it), and `parse` reads the file. `null` means "no row":
// the file is missing or unreadable as this kind, and the key is deleted.
import type { Entity } from "alinery-proto/alinery/v1/entities_pb";
import { sessionMeta } from "./sessionMeta.ts";
import { task } from "./task.ts";
import { touch } from "./touch.ts";

export type Parser = {
  match: RegExp;
  key(m: RegExpMatchArray): string;
  parse(absPath: string, m: RegExpMatchArray): Promise<Entity | null>;
};

export const parsers: Parser[] = [sessionMeta, task, touch];

/** The parser that owns `rel`, with its key. A path no parser matches is dropped (S0.4 rules). */
export function route(rel: string): { parser: Parser; key: string; m: RegExpMatchArray } | undefined {
  for (const parser of parsers) {
    const m = rel.match(parser.match);
    if (m) return { parser, key: parser.key(m), m };
  }
  return undefined;
}
