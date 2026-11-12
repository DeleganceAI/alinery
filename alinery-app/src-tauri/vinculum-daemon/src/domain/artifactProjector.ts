// A task's artifact rows (plan S4.5): the list, the attachments, the review comments, the drafts, the pending marks and the
// tree, all derived from files, all committed to the store as `<kind>/<slug>/...` rows. One task is recomputed whole and
// diffed against the keys it owned, so a file that vanished, or a comment that left its file, leaves the store too (the
// store drops an unchanged put, so recomputing is cheap on the wire). The feed says which tasks to redo; an RPC that wrote a
// file calls `project` itself, so its reply's cursor already covers what it changed.
import { create } from "@bufbuild/protobuf";
import { type Entity, EntitySchema, type ArtifactTreeNode } from "alinery-proto/alinery/v1/entities_pb";
import { ScopeSchema } from "alinery-proto/alinery/v1/sync_pb";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DomainError } from "../platform/lock.ts";
import type { Store } from "../sync/store.ts";
import { listDrafts, loadComments, pendingStatus, repoCommentsDir, repoCommentTargets, repoTargetFile } from "./artifactComments.ts";
import { type ArtifactItem, type ExecutionRecords, listArtifacts } from "./artifactList.ts";
import { buildTree, loadRelationships, type ResolvedNode, readTaskRelationships } from "./artifactTree.ts";
import { alineryDir, artifactsDir, readTaskChecked, safeComponent, sessionsDir, taskDir, tasksDir } from "./taskFiles.ts";
import type { TaskRecord } from "./taskFiles.ts";

const KINDS = ["artifact", "attachment", "comment", "comment_draft", "review_pending", "artifact_tree"] as const;
const own = (slug: string) => (key: string) => KINDS.some((k) => key.startsWith(`${k}/${slug}/`));

/** The paths under a task whose change can change one of its rows (or its neighbours' trees). */
const WATCHED = /^tasks\/([^/]+)\/(?:artifacts(?:\/.*)?|artifact-comment-drafts\.json|repo-comments(?:\/.*)?|execution\.json|playbook\.md|task\.md|sessions\/[^/]+\.meta\.json)$/;
export const projectedSlug = (rel: string): string | undefined => WATCHED.exec(rel)?.[1];

const millis = (n: number | null) => (n === null ? undefined : BigInt(n));

function artifactRow(slug: string, item: ArtifactItem, position: number): Entity {
  return create(EntitySchema, {
    key: `artifact/${slug}/${item.name}`,
    value: {
      case: "artifact",
      value: {
        slug,
        name: item.name,
        modifiedAtMs: millis(item.modified_at_ms),
        playbookStep: item.playbook_step,
        sessionId: item.session_id,
        handoffs: item.handoffs.map((h) => ({
          version: h.version,
          direction: h.direction,
          sourceRepoPath: h.source_repo_path,
          targetRepoPath: h.target_repo_path,
          sourceTask: h.source_task,
          sourceSession: h.source_session,
          sourceArtifact: h.source_artifact,
          targetTask: h.target_task,
          targetArtifact: h.target_artifact,
          targetSession: h.target_session,
          targetPhase: h.target_phase,
          createdAtMs: BigInt(h.created_at_ms),
        })),
        executionId: item.execution_id ?? undefined,
        stepKey: item.step_key ?? undefined,
        logicalPath: item.logical_path ?? undefined,
        depth: millis(item.depth),
        discriminator: millis(item.discriminator),
        accepted: item.accepted ?? undefined,
        position,
      },
    },
  });
}

function treeNode(alinery: string, n: ResolvedNode): ArtifactTreeNode {
  return {
    $typeName: "alinery.v1.ArtifactTreeNode",
    id: n.node.id,
    kind: n.node.kind,
    label: n.node.label,
    ownerTaskSlug: n.node.owner_task_slug,
    source: n.node.source,
    children: n.children.map((c) => treeNode(alinery, c)),
    revealPath: n.node.kind === "attachment" && n.path !== undefined ? relative(alinery, n.path) : "",
  };
}

export class ArtifactProjector {
  private readonly owned = new Map<string, Set<string>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private links: Map<string, TaskRecord> | undefined;
  private readonly prints = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly repo: string,
    /** The retained execution state of an engine-v2 task, or undefined when there is none (`getTaskExecution`). */
    private readonly execution: (slug: string) => ExecutionRecords | undefined,
    private readonly log: (line: string) => void = console.error,
    private readonly debounceMs = 50,
  ) {}

  /** The feed re-read `rel`: redo the task it belongs to soon. */
  changed(rel: string): void {
    const slug = projectedSlug(rel);
    if (!slug) return;
    if (rel.endsWith("/task.md")) this.links = undefined;
    this.dirty.add(slug);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      const slugs = [...this.dirty];
      this.dirty.clear();
      for (const s of slugs) this.project(s);
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private relations() {
    return (this.links ??= loadRelationships(this.repo));
  }

  /**
   * Recomputes a task's rows, and the trees of its parent and active child (which show its files). A part that cannot be read
   * (a link in the artifacts directory, a refused relationship) keeps its previous rows rather than emptying the board.
   */
  project(slug: string): void {
    if (safeComponent(slug) !== slug) return;
    let task: TaskRecord | undefined;
    try {
      task = readTaskChecked(this.repo, slug);
    } catch (e) {
      if (e instanceof DomainError && e.code === "not_found") task = undefined;
      else return this.log(`artifacts ${slug}: ${(e as Error).message}`);
    }
    if (!task) {
      this.forget(slug);
      return;
    }
    const puts: Entity[] = [];
    const keep = new Set<string>();
    const add = (e: Entity) => (puts.push(e), keep.add(e.key));
    // Parts the task could not be read for keep the rows they had: those keys are retained rather than deleted.
    const retain = (prefix: string) => {
      for (const key of this.owned.get(slug) ?? []) if (key.startsWith(prefix)) keep.add(key);
    };
    try {
      const items = listArtifacts(this.repo, slug, this.execution);
      let a = 0;
      let t = 0;
      for (const item of items) {
        if (item.attachment) {
          add(create(EntitySchema, { key: `attachment/${slug}/${item.name}`, value: { case: "attachment", value: { slug, name: item.name, modifiedAtMs: millis(item.modified_at_ms), position: t++ } } }));
        } else add(artifactRow(slug, item, a++));
      }
      // Comments on worktree files (`repo:<path>`) are rows like an artifact's; their targets come from repo-comments/.
      let repoTargets: string[] = [];
      try {
        repoTargets = repoCommentTargets(this.repo, slug);
      } catch (e) {
        this.log(`repo comments ${slug}: ${(e as Error).message}`);
      }
      for (const item of [...items.filter((i) => !i.attachment), ...repoTargets.map((name) => ({ name }))]) {
        try {
          for (const c of loadComments(this.repo, slug, item.name)) {
            add(create(EntitySchema, { key: `comment/${slug}/${item.name}/${c.id}`, value: { case: "comment", value: { slug, id: c.id, artifact: c.artifact, anchorId: c.anchor_id, anchorKind: c.anchor_kind, anchorLabel: c.anchor_label, anchorExcerpt: c.anchor_excerpt, lineStart: c.line_start, lineEnd: c.line_end, body: c.body, createdAtMs: BigInt(c.created_at_ms) } } }));
          }
        } catch (e) {
          this.log(`comments ${slug}/${item.name}: ${(e as Error).message}`);
          retain(`comment/${slug}/${item.name}/`);
        }
        try {
          const pending = pendingStatus(this.repo, slug, item.name);
          if (pending) add(create(EntitySchema, { key: `review_pending/${slug}/${item.name}`, value: { case: "reviewPending", value: { slug, artifact: pending.artifact, review: pending.review } } }));
        } catch (e) {
          this.log(`review pending ${slug}/${item.name}: ${(e as Error).message}`);
          retain(`review_pending/${slug}/${item.name}`);
        }
      }
    } catch (e) {
      this.log(`artifacts ${slug}: ${(e as Error).message}`);
      retain(`artifact/${slug}/`);
      retain(`attachment/${slug}/`);
      retain(`comment/${slug}/`);
      retain(`review_pending/${slug}/`);
    }
    try {
      for (const d of listDrafts(this.repo, slug)) {
        add(create(EntitySchema, { key: `comment_draft/${slug}/${d.artifact}/${d.anchor_id}`, value: { case: "commentDraft", value: { slug, artifact: d.artifact, anchorId: d.anchor_id, anchorKind: d.anchor_kind, anchorLabel: d.anchor_label, anchorExcerpt: d.anchor_excerpt, lineStart: d.line_start, lineEnd: d.line_end, body: d.body, artifactHash: d.artifact_hash, updatedAtMs: BigInt(d.updated_at_ms), stale: d.stale } } }));
      }
    } catch (e) {
      this.log(`comment drafts ${slug}: ${(e as Error).message}`);
      retain(`comment_draft/${slug}/`);
    }
    const trees = new Set([slug]);
    try {
      const { parent, child } = readTaskRelationships(this.repo, slug, this.relations());
      for (const s of [parent, child]) if (s) trees.add(s);
    } catch (e) {
      this.log(`artifact tree ${slug}: ${(e as Error).message}`);
      this.links = undefined;
    }
    const treeKeys = new Set<string>();
    for (const viewing of trees) {
      const key = `artifact_tree/${viewing}/${viewing}`;
      try {
        const nodes = buildTree(this.repo, viewing, this.relations()).map((n) => treeNode(alineryDir(this.repo), n));
        this.store.commit([create(EntitySchema, { key, value: { case: "artifactTree", value: { slug: viewing, nodes } } })]);
        this.adopt(viewing, [key]);
      } catch (e) {
        this.log(`artifact tree ${viewing}: ${(e as Error).message}`);
        this.links = undefined;
      }
      treeKeys.add(key);
    }
    for (const key of treeKeys) if (key.startsWith(`artifact_tree/${slug}/`)) keep.add(key);
    const before = this.owned.get(slug) ?? new Set<string>();
    const drops = [...before].filter((k) => !keep.has(k) && own(slug)(k));
    this.store.commit(puts, drops);
    this.owned.set(slug, new Set([...keep].filter((k) => own(slug)(k))));
  }

  /** A tree of another task, committed while this one was projected, is that task's row. */
  private adopt(slug: string, keys: string[]) {
    const set = this.owned.get(slug) ?? new Set<string>();
    for (const k of keys) set.add(k);
    this.owned.set(slug, set);
  }

  /** The task is gone: every row it owned goes. */
  private forget(slug: string) {
    const keys = [...(this.owned.get(slug) ?? [])];
    this.owned.delete(slug);
    this.prints.delete(slug);
    this.links = undefined;
    // Rows may exist that this process never projected (a restart before the first pass); drop by key prefix too.
    const stored = [...this.store.rowsMatching(create(ScopeSchema, { kind: { case: "task", value: { slug } } }))].map((e) => e.key).filter(own(slug));
    this.store.commit([], [...new Set([...keys, ...stored])]);
  }

  /** What the 30 s pass compares: the names, sizes and times the rows derive from, with no file read. */
  private fingerprint(slug: string): string {
    const parts: string[] = [];
    const walk = (dir: string, prefix: string) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (st.isDirectory()) walk(path, `${prefix}${name}/`);
          else parts.push(`${prefix}${name}:${st.mtimeMs}:${st.size}`);
        } catch {
          parts.push(`${prefix}${name}:?`);
        }
      }
    };
    walk(artifactsDir(this.repo, slug), "a/");
    walk(sessionsDir(this.repo, slug), "s/");
    walk(repoCommentsDir(this.repo, slug), "r/");
    // A worktree file is outside every watch: its stamp here lets the 30 s pass clear a pending review the agent answered.
    for (const target of repoCommentTargets(this.repo, slug)) {
      try {
        const st = statSync(repoTargetFile(this.repo, slug, target) as string);
        parts.push(`w/${target}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`w/${target}:-`);
      }
    }
    for (const f of ["artifact-comment-drafts.json", "execution.json", "playbook.md", "task.md"]) {
      try {
        const st = statSync(join(taskDir(this.repo, slug), f));
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${f}:-`);
      }
    }
    return parts.join("|");
  }

  /**
   * Start-up and the 30 s pass: every task whose files changed since its last pass (or all of them, the first time).
   * Yields between tasks, so a repository of thousands does not hold the loop. Returns how many tasks it redid.
   */
  async pass(): Promise<number> {
    const dir = tasksDir(this.repo);
    const slugs = existsSync(dir) ? readdirSync(dir).filter((n) => safeComponent(n) === n) : [];
    this.links = undefined;
    let redone = 0;
    for (const [i, slug] of slugs.entries()) {
      const print = this.fingerprint(slug);
      if (this.prints.get(slug) !== print) {
        this.prints.set(slug, print);
        this.project(slug);
        redone++;
      }
      if (i % 25 === 24) await new Promise((r) => setImmediate(r));
    }
    for (const slug of [...this.owned.keys()]) if (!slugs.includes(slug) && this.owned.get(slug)?.size) this.forget(slug);
    return redone;
  }
}
