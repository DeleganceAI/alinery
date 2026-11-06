// The conformance cases of the session domains (plan S4.4): the Rust reference wrote `expected.json` for each case under
// `conformance/{session_name,history,chat}/<case>/` (alinery-core/tests/conformance.rs), and the daemon's code must give the
// same answers over a copy of the same `input/`.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../sync/store.ts";
import { ChatPublisher, chatKey, rootChats } from "./chat.ts";
import { readHistory, readOmpWindow } from "./history.ts";
import { namePathOf, setSessionName } from "./sessionOps.ts";

const ROOT = resolve(import.meta.dir, "../../../conformance");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const cases = (domain: string) => readdirSync(join(ROOT, domain));

/** A scratch copy of the case's input, and its command. */
function scratchOf(domain: string, name: string): { repo: string; command: any; expected: any } {
  const repo = mkdtempSync(join(tmpdir(), `conf-${domain}-`));
  dirs.push(repo);
  cpSync(join(ROOT, domain, name, "input"), repo, { recursive: true });
  return { repo, command: read(join(ROOT, domain, name, "command.json")), expected: read(join(ROOT, domain, name, "expected.json")) };
}

const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};

for (const name of cases("session_name")) {
  test(`session_name/${name} equals Rust's set_session_name`, async () => {
    const { repo, command, expected } = scratchOf("session_name", name);
    const steps: unknown[] = [];
    for (const step of command.steps) {
      try {
        const out = await setSessionName(repo, command.slug, step.id ?? command.id, step.name, step.source);
        steps.push({ status: out.status, name: out.value.name, source: out.value.source });
      } catch {
        steps.push({ error: true });
      }
    }
    let stored: string | null = null;
    try {
      stored = read(namePathOf(repo, command.slug, command.id)).name;
    } catch {}
    expect({ steps, stored }).toEqual(expected);
  });
}

for (const name of cases("history")) {
  test(`history/${name} equals Rust's windows and journal pages`, () => {
    const { repo, command, expected } = scratchOf("history", name);
    const attempt = <T>(f: () => T) => {
      try {
        return f();
      } catch {
        return { error: true };
      }
    };
    const reads = command.reads.map((r: any) =>
      attempt(() => {
        const h = readHistory(repo, command.slug, r.id ?? command.id, r.offset, r.limit);
        return { data: h.data.toString(), length: h.length, next_offset: h.nextOffset, eof: h.eof };
      }),
    );
    let previousStart: number | undefined;
    const windows = command.windows.map((w: any) =>
      attempt(() => {
        const out = readOmpWindow(repo, command.slug, w.id ?? command.id, w.end === "previous_start" ? previousStart : (w.end ?? undefined), w.want ?? undefined);
        previousStart = out.start;
        return { data: out.data.toString(), start: out.start, end: out.end, length: out.length };
      }),
    );
    expect({ reads, windows }).toEqual(expected);
  });
}

for (const name of cases("chat")) {
  test(`chat/${name} is the rail list_chat_threads_in makes`, async () => {
    const { repo, command, expected } = scratchOf("chat", name);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const store = new Store();
    await new ChatPublisher(store, repo).refreshAll();
    const out: Record<string, unknown[]> = {};
    for (const include of command.include_archived as boolean[]) {
      const threads = rootChats(repo)
        .filter((m) => store.get(chatKey(String(m.id)))?.value.case === "chatThread")
        .filter((m) => !(store.get(chatKey(String(m.id)))?.value.value as { superseded: boolean }).superseded)
        .filter((m) => include || !m.archived)
        .map((m) => {
          const row = store.get(chatKey(String(m.id)))?.value.value as { branchLabel: string; checkout: boolean };
          let threadName: string | null = null;
          try {
            threadName = read(namePathOf(repo, "", String(m.id))).name;
          } catch {}
          return {
            id: m.id,
            name: threadName,
            branch_label: row.branchLabel,
            checkout: row.checkout,
            archived: Boolean(m.archived),
            pinned: Boolean(m.pinned),
            created: Number(m.created),
          };
        })
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created - a.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(({ created: _created, ...row }) => row);
      out[`include_archived_${include}`] = threads;
    }
    expect(out).toEqual(expected);
  });
}
