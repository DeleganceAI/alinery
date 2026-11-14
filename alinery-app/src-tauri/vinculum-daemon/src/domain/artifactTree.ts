// The artifact tree of a task (plan S4.5): its own artifacts and attachments, the parent's artifacts as context, the
// active child's, and the snapshots of finished sub-tasks. Ports alinery-core `artifact_tree.rs`. A node is named by an
// id (a hash of where it sits for this viewer), never by a path: `resolveNode` turns an id back into a file and refuses
// anything that is not a regular file below the root it was found under.
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { compareArtifactPaths, RELATED_TASKS_MARKDOWN, resolveArtifactDirectory, resolveArtifactPath } from "./artifactFiles.ts";
import { artifactsDir, readTask, safeComponent, tasksDir, type TaskRecord } from "./taskFiles.ts";
import { existsSync } from "node:fs";

export type TreeKind = "owned" | "attachment" | "subtask_folder" | "referenced";
export type TreeSource = "owned" | "parent_context" | "active_child" | "snapshot";
export type TreeNode = { id: string; kind: TreeKind; label: string; owner_task_slug: string; source: TreeSource; children: TreeNode[] };
/** A node with what only the daemon knows: the file it stands for and the root that file must stay inside. */
export type ResolvedNode = { node: TreeNode; path?: string; containmentRoot?: string; children: ResolvedNode[] };

// Rust's Debug names, which the id hashes.
const KIND: Record<TreeKind, string> = { owned: "Owned", attachment: "Attachment", subtask_folder: "SubtaskFolder", referenced: "Referenced" };
const SOURCE: Record<TreeSource, string> = { owned: "Owned", parent_context: "ParentContext", active_child: "ActiveChild", snapshot: "Snapshot" };

const treeError = (detail: string) => new DomainError("invalid_argument", `artifact tree error: ${detail}`);

/** `node_id`: FNV-1a over where the node sits for this viewer, `artifact-` and 16 hex digits. */
function nodeId(viewing: string, owner: string, kind: TreeKind, source: TreeSource, key: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(`${viewing}\0${owner}\0${KIND[kind]}\0${SOURCE[source]}\0${key}`, "utf8")) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `artifact-${hash.toString(16).padStart(16, "0")}`;
}

function safeName(path: string): string {
  const name = basename(path);
  if (safeComponent(name) !== name) throw treeError(`unsafe path component '${name}'`);
  return name;
}

function checkedEntries(dir: string): string[] {
  resolveArtifactDirectory(dir, "");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .sort(compareArtifactPaths);
}

function folder(viewing: string, owner: string, label: string, source: TreeSource, key: string, children: ResolvedNode[]): ResolvedNode {
  return { node: { id: nodeId(viewing, owner, "subtask_folder", source, key), kind: "subtask_folder", label, owner_task_slug: owner, source, children: children.map((c) => c.node) }, children };
}

function recordFile(viewing: string, owner: string, path: string, root: string, source: TreeSource, kind: TreeKind, key: string): ResolvedNode {
  const label = safeName(path);
  resolveArtifactPath(root, relative(root, path));
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw treeError(`${path} is not a regular file`);
  return { node: { id: nodeId(viewing, owner, kind, source, key), kind, label, owner_task_slug: owner, source, children: [] }, path, containmentRoot: root, children: [] };
}

function attachmentFolder(viewing: string, owner: string, dir: string, root: string, source: TreeSource, key: string): ResolvedNode | undefined {
  const children = checkedEntries(dir).map((path) => recordFile(viewing, owner, path, root, source, "attachment", `${key}/${safeName(path)}`));
  return children.length === 0 ? undefined : folder(viewing, owner, "Attachments", source, key, children);
}

function snapshotFolder(viewing: string, path: string, key: string): ResolvedNode {
  const child = safeName(path);
  return folder(viewing, child, child, "snapshot", key, ownedNodes(viewing, child, path, "snapshot", true, key, true));
}

function ownedNodes(viewing: string, owner: string, root: string, source: TreeSource, referenced: boolean, keyPrefix: string, namespaceRoot: boolean): ResolvedNode[] {
  const nodes: ResolvedNode[] = [];
  for (const path of checkedEntries(root)) {
    const label = safeName(path);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new DomainError("permission_denied", `artifact tree error: symlink rejected: ${path}`);
    const key = `${keyPrefix}/${label}`;
    if (st.isFile() && label === RELATED_TASKS_MARKDOWN) continue;
    if (st.isFile()) nodes.push(recordFile(viewing, owner, path, root, source, referenced ? "referenced" : "owned", key));
    else if (st.isDirectory() && namespaceRoot && label === "attachments") {
      const attachments = attachmentFolder(viewing, owner, path, root, source, key);
      if (attachments) nodes.push(attachments);
    } else if (st.isDirectory() && namespaceRoot && label === "subtasks") {
      for (const snapshot of checkedEntries(path)) nodes.push(snapshotFolder(viewing, snapshot, `${key}/${safeName(snapshot)}`));
    } else if (st.isDirectory()) nodes.push(folder(viewing, owner, label, source, key, ownedNodes(viewing, owner, path, source, referenced, key, false)));
    else throw treeError(`not a regular file or directory: ${path}`);
  }
  return nodes.sort((a, b) => compareArtifactPaths(a.node.label, b.node.label) || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
}

// ---- relationships -----------------------------------------------------------------------------------------

const relationshipError = (message: string) => new DomainError("failed_precondition", `relationship corruption: ${message}`);
const field = (task: TaskRecord, key: string) => (typeof task[key] === "string" ? (task[key] as string) : "");

/** `validate_task_relationship_fields` over every task of the repository. */
function validateRelationships(tasks: TaskRecord[]): Map<string, TaskRecord> {
  const bySlug = new Map<string, TaskRecord>();
  for (const task of tasks) {
    if (task.slug === "" || safeComponent(task.slug) !== task.slug) throw relationshipError(`invalid task slug '${task.slug}'`);
    if (bySlug.has(task.slug)) throw relationshipError(`duplicate task slug '${task.slug}'`);
    bySlug.set(task.slug, task);
  }
  for (const task of tasks) {
    const slug = task.slug;
    const parent = field(task, "parent_task");
    const child = field(task, "active_subtask");
    if (parent === slug || child === slug) throw relationshipError(`task '${slug}' links to itself`);
    if (parent !== "") {
      const p = bySlug.get(parent);
      if (!p) throw relationshipError(`task '${slug}' names missing parent '${parent}'`);
      if (task.archived === true) {
        if (field(p, "active_subtask") === slug) throw relationshipError(`archived task '${slug}' is still active on parent '${parent}'`);
      } else if (field(p, "active_subtask") !== slug) throw relationshipError(`task '${slug}' names parent '${parent}', but that parent names active child '${field(p, "active_subtask")}'`);
    }
    if (child !== "") {
      const c = bySlug.get(child);
      if (!c) throw relationshipError(`task '${slug}' names missing active child '${child}'`);
      if (c.archived === true) throw relationshipError(`task '${slug}' names archived active child '${child}'`);
      if (field(c, "parent_task") !== slug) throw relationshipError(`task '${slug}' names active child '${child}', but that child names parent '${field(c, "parent_task")}'`);
    }
  }
  for (const task of tasks) {
    for (const next of ["active_subtask", "parent_task"]) {
      const seen = new Set<string>();
      let cursor: TaskRecord = task;
      while (field(cursor, next) !== "") {
        if (seen.has(cursor.slug)) throw relationshipError(`cycle reaches '${cursor.slug}'`);
        seen.add(cursor.slug);
        cursor = bySlug.get(field(cursor, next)) as TaskRecord;
      }
    }
  }
  return bySlug;
}

/** The whole repository's task links, checked: every task by slug, or the refusal for a link that does not hold. */
export function loadRelationships(repo: string): Map<string, TaskRecord> {
  const dir = tasksDir(repo);
  const tasks: TaskRecord[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!existsSync(join(dir, name, "task.md")) || !lstatSync(join(dir, name, "task.md")).isFile()) continue;
      const task = readTask(repo, name);
      if (!task) throw relationshipError(`cannot parse task '${name}'`);
      if (task.slug !== name) throw relationshipError(`task directory '${name}' contains slug '${task.slug}'`);
      tasks.push(task);
    }
  }
  return validateRelationships(tasks);
}

export type Relationships = { parent?: string; child?: string };

/** `read_task_relationships`: the viewing task's parent and active child, after the whole repository's links check out. */
export function readTaskRelationships(repo: string, slug: string, known?: Map<string, TaskRecord>): Relationships {
  const task = (known ?? loadRelationships(repo)).get(slug);
  if (!task) throw new DomainError("not_found", `no such task: ${slug}`);
  return { parent: field(task, "parent_task") || undefined, child: field(task, "active_subtask") || undefined };
}

// ---- the tree ----------------------------------------------------------------------------------------------

/** `known`: the links as `loadRelationships` read them, when a caller builds many trees from one read. */
export function buildTree(repo: string, viewing: string, known?: Map<string, TaskRecord>): ResolvedNode[] {
  if (safeComponent(viewing) !== viewing) throw treeError("invalid viewing task slug");
  const ownRoot = resolveArtifactDirectory(repo, `.alinery/tasks/${viewing}/artifacts`);
  const { parent, child } = readTaskRelationships(repo, viewing, known);
  const nodes = ownedNodes(viewing, viewing, ownRoot, "owned", false, "owned", true);
  if (parent) {
    const root = resolveArtifactDirectory(repo, `.alinery/tasks/${parent}/artifacts`);
    nodes.push(folder(viewing, parent, "Parent context", "parent_context", "Parent context", ownedNodes(viewing, parent, root, "parent_context", true, "parent-context", true)));
  }
  if (child) {
    const root = resolveArtifactDirectory(repo, `.alinery/tasks/${child}/artifacts`);
    nodes.push(folder(viewing, child, child, "active_child", child, ownedNodes(viewing, child, root, "active_child", true, "active-child", true)));
  }
  nodes.sort((a, b) => compareArtifactPaths(a.node.label, b.node.label) || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  const ids = new Set<string>();
  const collect = (node: TreeNode) => {
    if (ids.has(node.id)) throw treeError("node identity collision");
    ids.add(node.id);
    node.children.forEach(collect);
  };
  for (const n of nodes) collect(n.node);
  return nodes;
}

const findNode = (nodes: ResolvedNode[], id: string): ResolvedNode | undefined => {
  for (const n of nodes) {
    if (n.node.id === id) return n;
    const inner = findNode(n.children, id);
    if (inner) return inner;
  }
  return undefined;
};

/** `resolve_file`: the node an id names and the canonical file behind it. A link, or a file that left its root, is refused. */
export function resolveNode(repo: string, viewing: string, id: string): { node: TreeNode; path: string } {
  if (!id.startsWith("artifact-") || id.length !== 25) throw treeError("unknown node identity");
  const record = findNode(buildTree(repo, viewing), id);
  if (!record) throw new DomainError("not_found", "artifact tree error: unknown node identity");
  if (record.path === undefined) throw treeError("node is not an openable file");
  if (record.containmentRoot === undefined) throw treeError("node has no containment root");
  const st = lstatSync(record.path);
  if (st.isSymbolicLink() || !st.isFile()) throw new DomainError("permission_denied", "artifact tree error: node is no longer a regular file");
  const checked = resolveArtifactPath(repo, relative(repo, record.path));
  const root = realpathSync(record.containmentRoot);
  const path = realpathSync(checked);
  if (path !== root && !path.startsWith(`${root}/`)) throw new DomainError("permission_denied", "artifact tree error: node escapes its artifact root");
  return { node: record.node, path };
}

export function listTree(repo: string, viewing: string): TreeNode[] {
  return buildTree(repo, viewing).map((n) => n.node);
}

export function readNode(repo: string, viewing: string, id: string): string {
  const { node, path } = resolveNode(repo, viewing, id);
  if (node.kind === "attachment") throw treeError("attachments must be revealed, not read as artifact content");
  return readFileSync(path, "utf8");
}

export function nodePath(repo: string, viewing: string, id: string): string {
  const { node, path } = resolveNode(repo, viewing, id);
  if (node.kind !== "attachment") throw treeError("only attachments have revealable paths");
  return path;
}

export { artifactsDir };
