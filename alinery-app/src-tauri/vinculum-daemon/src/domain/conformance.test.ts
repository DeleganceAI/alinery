// The conformance cases of the session domains (plan S4.4) and the artifact domains (S4.5): the Rust reference wrote
// `expected.json` for each case under `conformance/{session_name,history,chat,artifact_list,artifact_tree,artifact_comments}/<case>/`
// (alinery-core/tests/conformance.rs), and the daemon's code must give the same answers over a copy of the same `input/`.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getTaskExecution } from "../tasks.ts";
import { Store } from "../sync/store.ts";
import * as comments from "./artifactComments.ts";
import { listArtifacts } from "./artifactList.ts";
import { listTree, nodePath, readNode, type TreeNode } from "./artifactTree.ts";
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

// ---- artifacts (S4.5) ---------------------------------------------------------------------------------------------

/** `scrub` of alinery-core/tests/conformance.rs: the scratch path, comment ids, clocks and the hash of a markdown that carries ids. */
function scrubber(scratch: string) {
  const dirs = [realpathSync(scratch), scratch];
  const str = (text: string) => {
    let out = text;
    for (const dir of dirs) out = out.replaceAll(dir, "<REPO>");
    return out.replace(/(?<![A-Za-z0-9_])c\d{13}(?:_\d+)?(?![A-Za-z0-9_])/g, "cID");
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return str(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, k.endsWith("_ms") && k !== "modified_at_ms" ? 0 : k === "comments_hash" ? "HASH" : scrub(v)]),
      );
    }
    return value;
  };
  return { str, scrub };
}

const attempt = <T>(f: () => T): T | { error: true } => {
  try {
    return f();
  } catch {
    return { error: true };
  }
};

/** Every regular file below `dir` gets the case's fixed mtime (5000 ms unless `overrides` names it, relative to `.alinery/tasks`). */
function fixMtimes(tasks: string, dir: string, overrides: Record<string, number>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) fixMtimes(tasks, path, overrides);
    else {
      const seconds = (overrides[path.slice(tasks.length + 1)] ?? 5000) / 1000;
      utimesSync(path, seconds, seconds);
    }
  }
}

for (const name of cases("artifact_list")) {
  test(`artifact_list/${name} is the list board::artifacts_with_metadata makes`, () => {
    const { repo, command, expected } = scratchOf("artifact_list", name);
    const tasks = join(repo, ".alinery/tasks");
    fixMtimes(tasks, tasks, command.mtimes ?? {});
    const out = attempt(() => ({
      items: listArtifacts(repo, command.slug, (slug) => {
        const reply = getTaskExecution(repo, slug, "", "");
        return reply.error === undefined ? (reply.state as never) : undefined;
      }),
    }));
    expect(out).toEqual(expected);
  });
}

for (const name of cases("artifact_tree")) {
  test(`artifact_tree/${name} is the tree list_task_artifact_tree makes`, () => {
    const { repo, command, expected } = scratchOf("artifact_tree", name);
    const { str } = scrubber(repo);
    const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
    const out: Record<string, unknown> = {};
    for (const view of command.views as string[]) {
      const tree = attempt(() => listTree(repo, view));
      if (!Array.isArray(tree)) {
        out[view] = tree;
        continue;
      }
      const reads: Record<string, unknown> = {};
      const paths: Record<string, unknown> = {};
      for (const node of flat(tree)) {
        reads[node.id] = attempt(() => readNode(repo, view, node.id));
        paths[node.id] = attempt(() => str(nodePath(repo, view, node.id)));
      }
      const unknownRefused = "error" in attempt(() => readNode(repo, view, "artifact-0000000000000000"));
      out[view] = { tree, reads, paths, unknown_node_refused: unknownRefused };
    }
    expect(out).toEqual(expected);
  });
}

for (const name of cases("artifact_comments")) {
  test(`artifact_comments/${name} equals Rust's comment, draft and review files`, () => {
    const { repo, command, expected } = scratchOf("artifact_comments", name);
    const { scrub, str } = scrubber(repo);
    const slug = command.slug as string;
    const taskDir = join(repo, ".alinery/tasks", slug);
    const artifacts = join(taskDir, "artifacts");
    const prepared: (comments.PreparedAction | undefined)[] = [];
    const answers: unknown[] = [];
    const input = (step: any): comments.CommentInput => ({
      anchor_id: step.anchor_id ?? "",
      anchor_kind: step.anchor_kind ?? "",
      anchor_label: step.anchor_label ?? "",
      anchor_excerpt: step.anchor_excerpt ?? "",
      line_start: step.line_start ?? 0,
      line_end: step.line_end ?? 0,
      body: step.body ?? "",
    });
    for (const step of command.steps) {
      const artifact: string = step.artifact ?? "";
      let kept: comments.PreparedAction | undefined;
      const answer = attempt<unknown>(() => {
        switch (step.op) {
          case "list_comments":
            return { comments: comments.loadComments(repo, slug, artifact) };
          case "add":
            return { comments: comments.addComment(repo, slug, artifact, input(step)) };
          case "save_draft":
            comments.saveDraft(repo, slug, artifact, input(step));
            return {};
          case "delete_draft":
            comments.deleteDraft(repo, slug, artifact, step.anchor_id);
            return {};
          case "list_drafts":
            return { drafts: comments.listDrafts(repo, slug) };
          case "write":
            writeFileSync(join(artifacts, artifact), step.text);
            return {};
          case "pending_status":
            return { status: comments.pendingStatus(repo, slug, artifact) ?? null };
          case "archive":
            return { review: comments.archiveComments(repo, slug, artifact) };
          case "clear_pending":
            comments.clearPending(repo, slug, artifact);
            return {};
          case "prepare":
            kept = comments.prepareCommentsPrompt(repo, slug, step.artifacts);
            return kept;
          case "prepare_approval":
            kept = comments.prepareReviewApproval(repo, slug, artifact);
            return kept;
          case "finalize":
          case "finalize_tampered": {
            const provenance = prepared[step.from]?.provenance;
            if (provenance?.type !== "artifact_comments") throw new Error("no prepared comments at that step");
            if (step.op === "finalize_tampered") writeFileSync(join(artifacts, provenance.items[0].review), `${readFileSync(join(artifacts, provenance.items[0].review), "utf8")}tampered\n`);
            comments.finalizeComments(repo, slug, provenance.items);
            return {};
          }
          case "finalize_actions": {
            const actions = (step.from as number[]).flatMap((i) => prepared[i]?.provenance ?? []);
            comments.finalizeSessionMessageActions(repo, step.session, slug, actions);
            return {};
          }
          default:
            throw new Error(`unknown op ${step.op}`);
        }
      });
      prepared.push(kept);
      answers.push("error" in (answer as object) ? answer : scrub({ ok: answer }));
    }
    const files: Record<string, unknown> = {};
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) collect(path);
        else {
          const raw = readFileSync(path, "utf8");
          files[path.slice(taskDir.length + 1)] = path.endsWith(".json") ? scrub(JSON.parse(raw)) : str(raw);
        }
      }
    };
    collect(artifacts);
    try {
      files["artifact-comment-drafts.json"] = scrub(JSON.parse(readFileSync(join(taskDir, "artifact-comment-drafts.json"), "utf8")));
    } catch {}
    expect({ steps: answers, files }).toEqual(expected);
  });
}
