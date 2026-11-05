// The other end of the runner (plan 2.3.5): `main.ts` hands `--job <kind>` here before any daemon
// start-up. Params arrive as JSON on stdin; the child answers with JSON lines on stdout, one of
// {progress}, {result} or {error}. A kind that throws is an {error} line and exit code 1.
import { type StorageParams, scanStorage } from "./storage.ts";

export type Report = (progress: { done: number; total: number; label: string }) => void;
type Handler = (params: never, report: Report) => unknown | Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  "storage-scan": (params: StorageParams) => scanStorage(params),
};

const emit = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

export async function runJobChild(kind: string): Promise<number> {
  const handler = HANDLERS[kind];
  if (!handler) {
    emit({ error: `unknown job kind ${kind}` });
    return 1;
  }
  try {
    const params = JSON.parse((await Bun.stdin.text()) || "{}");
    emit({ result: await handler(params, (progress) => emit({ progress })) });
    return 0;
  } catch (e) {
    emit({ error: (e as Error).message });
    return 1;
  }
}
