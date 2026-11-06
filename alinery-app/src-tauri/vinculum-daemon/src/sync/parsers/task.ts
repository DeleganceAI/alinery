// Ports `read_task_checked` (alinery-core board.rs): `task.md` is a TOML file that serde reads into
// `Task`. Serde's rules are kept: five fields are required, a wrong type refuses the whole file, unknown
// keys are ignored (except inside `playbook_ref`), and absent fields take their defaults. A file Rust
// refuses is no row, which is how the board treats it now (it used to fail the whole board). The
// derived `board` and `activity` fields are not in the file; `domain/board.ts` fills them in.
import { create } from "@bufbuild/protobuf";
import { type Entity, EntitySchema, TaskSchema } from "alinery-proto/alinery/v1/entities_pb";
import { readFile } from "node:fs/promises";
import type { Parser } from "./index.ts";
import { bool, obj, present, Refuse, refuse, req, str, strings, tomlParse, u32, u64 } from "./serde.ts";

const SCOPES = new Set(["bundled", "global", "repo"]);

/** The entity for one task.md's text; undefined when serde would refuse it. `slug` is the directory name, which keys the row. */
export function parseTask(text: string, dir: string): Entity | undefined {
  try {
    const o = obj(tomlParse(text));
    const ref = present(o, "playbook_ref") ? obj(o.playbook_ref) : undefined;
    if (ref && (Object.keys(ref).some((k) => k !== "scope" && k !== "key") || !SCOPES.has(req(ref, "scope")))) refuse();
    const launch = present(o, "launch_defaults") ? obj(o.launch_defaults) : {};
    const hasLaunch = present(o, "launch_defaults");
    const stepModels = present(o, "step_models") ? obj(o.step_models) : {};
    const related = present(o, "related_tasks") ? o.related_tasks : [];
    if (!Array.isArray(related)) refuse();
    return create(EntitySchema, {
      key: taskKey(dir),
      value: {
        case: "task",
        value: create(TaskSchema, {
          name: req(o, "name"),
          slug: req(o, "slug"),
          requestedSlug: str(o, "requested_slug"),
          branch: req(o, "branch"),
          worktree: req(o, "worktree"),
          hasWorktree: bool(o, "has_worktree", true),
          created: u64(o, "created"),
          archived: bool(o, "archived"),
          prUrl: str(o, "pr_url"),
          linearId: str(o, "linear_id"),
          githubIssue: str(o, "github_issue"),
          playbook: str(o, "playbook"),
          engineVersion: u32(o, "engine_version", 0),
          playbookRef: ref ? { scope: req(ref, "scope"), key: req(ref, "key") } : undefined,
          maxLiveSessions: u32(o, "max_live_sessions", 10),
          launchDefaults: hasLaunch ? { harness: req(launch, "harness"), model: req(launch, "model") } : undefined,
          autoAdvance: present(o, "auto_advance") ? strings(o.auto_advance) : [],
          autoApproveAll: bool(o, "auto_approve_all"),
          stepModels: Object.fromEntries(Object.entries(stepModels).map(([k, v]) => [k, typeof v === "string" ? v : refuse()])),
          parentTask: str(o, "parent_task"),
          activeSubtask: str(o, "active_subtask"),
          subtaskOutcome: str(o, "subtask_outcome"),
          draft: bool(o, "draft"),
          draftBaseRef: present(o, "draft_base_ref") ? str(o, "draft_base_ref") : undefined,
          relatedTasks: related.map((r) => {
            const t = obj(r);
            return { repoPath: req(t, "repo_path"), slug: req(t, "slug"), name: str(t, "name") };
          }),
          telemetryId: str(o, "telemetry_id"),
        }),
      },
    });
  } catch (e) {
    if (e instanceof Refuse) return undefined;
    throw e;
  }
}

export const taskKey = (slug: string) => `task/${slug}/${slug}`;

export const task: Parser = {
  match: /^tasks\/([^/]+)\/task\.md$/,
  key: (m) => taskKey(m[1]),
  parse: async (abs, m) => {
    try {
      return parseTask(await readFile(abs, "utf8"), m[1]) ?? null;
    } catch {
      return null; // unreadable: no row, as for a malformed file
    }
  },
};
