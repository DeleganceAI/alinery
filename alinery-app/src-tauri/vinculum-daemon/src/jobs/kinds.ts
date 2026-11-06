// What the runner (daemon side) and the child (its own process) both need to agree on: a kind's name
// on the command line, and how a result line becomes the Job entity's result.
import { fromJson, type JsonObject } from "@bufbuild/protobuf";
import { BackupResultSchema, type Job, JobKind, PurgeResultSchema, StorageInfoSchema } from "alinery-proto/alinery/v1/entities_pb";

const NAMES: ReadonlyMap<JobKind, string> = new Map([
  [JobKind.STORAGE_SCAN, "storage-scan"],
  [JobKind.BACKUP, "backup"],
  [JobKind.PURGE, "purge"],
  [JobKind.IMPORT, "import"],
]);

export function kindName(kind: JobKind): string {
  const name = NAMES.get(kind);
  if (!name) throw new Error(`unknown job kind ${kind}`);
  return name;
}

/** The entity's `result` for a result line. A kind without a result message yet (S4.10 adds import) leaves it unset. */
export function resultOf(kind: JobKind, json: unknown): Job["result"] {
  if (kind === JobKind.STORAGE_SCAN) return { case: "storage", value: fromJson(StorageInfoSchema, json as JsonObject) };
  if (kind === JobKind.BACKUP) return { case: "backup", value: fromJson(BackupResultSchema, json as JsonObject) };
  if (kind === JobKind.PURGE) return { case: "purge", value: fromJson(PurgeResultSchema, json as JsonObject) };
  return { case: undefined };
}

/** The command that runs a kind: this binary with `--job <kind>` (O7 a). Under `bun run` the script
 * comes first; in a `bun build --compile` binary the entry is the binary itself. */
export function jobCommand(kind: JobKind): string[] {
  const compiled = import.meta.url.includes("/$bunfs/");
  return [process.execPath, ...(compiled ? [] : [Bun.main]), "--job", kindName(kind)];
}
