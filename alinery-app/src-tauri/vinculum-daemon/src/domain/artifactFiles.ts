// A task's artifact files (plan S4.5): the path rules and the scan every artifact reader shares, ported from alinery-core
// `shared.rs` (`validate_artifact_filename`, `resolve_artifact_path`, `owned_artifact_names`, `compare_artifact_paths`). A
// name is relative to `tasks/<slug>/artifacts/`; `attachments/` and `subtasks/` are namespaces the ordinary scan never
// enters; a symlink anywhere on the way is refused, so nothing outside the artifacts directory is reachable by a name.
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { artifactsDir, safeComponent } from "./taskFiles.ts";

export const RELATED_TASKS_MARKDOWN = "related-tasks.md";

const refuse = (message: string) => new DomainError("invalid_argument", message);

/** `validate_relative_artifact_path`: forward slashes only, no empty, `.` or `..` part, no NUL, colon or backslash. */
export function validateRelativeArtifactPath(name: string): void {
  if (name === "" || /[\\\0:]/.test(name) || name.split("/").some((part) => part === "" || part === "." || part === "..")) throw refuse(`invalid artifact path: ${name}`);
}

/** `validate_artifact_filename`: a relative path outside the two reserved namespaces. */
export function validateArtifactFilename(name: string): string {
  validateRelativeArtifactPath(name);
  const first = name.split("/")[0];
  if (first === "attachments" || first === "subtasks") throw refuse(`reserved artifact namespace: ${name}`);
  return name;
}

/**
 * `resolve_artifact_entry`: the path of `relative` below the trusted `root`, with every component inspected and none
 * followed. A missing component is allowed (an output reservation); a link or a component of the wrong kind is not.
 */
export function resolveArtifactEntry(root: string, relative: string, directory: boolean): string {
  if (relative !== "") validateRelativeArtifactPath(relative);
  else if (!directory) throw refuse("empty artifact path");
  const inspect = (path: string, isDirectory: boolean) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw refuse(`inspect ${path}: ${(error as Error).message}`);
    }
    if (st.isSymbolicLink()) throw new DomainError("permission_denied", `symlink rejected: ${path}`);
    if (!(isDirectory ? st.isDirectory() : st.isFile())) throw refuse(`not a regular ${isDirectory ? "directory" : "file"}: ${path}`);
  };
  inspect(root, true);
  let path = root;
  const parts = relative.split("/").filter((part) => part !== "");
  parts.forEach((part, i) => {
    path = join(path, part);
    inspect(path, directory || i < parts.length - 1);
  });
  return path;
}

export const resolveArtifactPath = (root: string, relative: string) => resolveArtifactEntry(root, relative, false);
export const resolveArtifactDirectory = (root: string, relative: string) => resolveArtifactEntry(root, relative, true);

/** `artifact_file_path`: the file a name stands for in a task, checked. */
export function artifactFilePath(repo: string, slug: string, name: string): string {
  if (safeComponent(slug) !== slug) throw refuse(`invalid task slug: ${slug}`);
  validateArtifactFilename(name);
  return resolveArtifactPath(repo, `.alinery/tasks/${slug}/artifacts/${name}`);
}

/** `compare_artifact_paths`: digit runs compare by magnitude, everything else by UTF-8 byte; the last tie-break is the raw bytes. */
export function compareArtifactPaths(left: string, right: string): number {
  const l = Buffer.from(left);
  const r = Buffer.from(right);
  const digit = (b: number) => b >= 0x30 && b <= 0x39;
  let a = 0;
  let b = 0;
  while (a < l.length && b < r.length) {
    if (digit(l[a]) && digit(r[b])) {
      let an = a;
      while (an < l.length && digit(l[an])) an++;
      let bn = b;
      while (bn < r.length && digit(r[bn])) bn++;
      let av = a;
      while (av < an && l[av] === 0x30) av++;
      let bv = b;
      while (bv < bn && r[bv] === 0x30) bv++;
      const byLength = an - av - (bn - bv);
      if (byLength !== 0) return byLength < 0 ? -1 : 1;
      const order = Buffer.compare(l.subarray(av, an), r.subarray(bv, bn));
      if (order !== 0) return order;
      a = an;
      b = bn;
    } else {
      if (l[a] !== r[b]) return l[a] < r[b] ? -1 : 1;
      a++;
      b++;
    }
  }
  const rest = l.length - a - (r.length - b);
  if (rest !== 0) return rest < 0 ? -1 : 1;
  return Buffer.compare(l, r);
}

/** `is_handoff_sidecar_name`. */
export const isHandoffSidecarName = (name: string) => (name.endsWith(".handoff.json") || (name.includes(".handoff-") && name.endsWith(".json"))) && !name.endsWith(".comments.json");

/** `is_visible_artifact_name`: what a person sees as an artifact. */
export const isVisibleArtifactName = (name: string) => name !== RELATED_TASKS_MARKDOWN && !name.endsWith(".comments.json") && !isHandoffSidecarName(name);

/** `owned_artifact_names`: every file below the task's artifacts directory outside the two namespaces, newest name first. */
export function ownedArtifactNames(repo: string, slug: string): string[] {
  if (safeComponent(slug) !== slug) throw refuse(`invalid task slug: ${slug}`);
  const root = resolveArtifactDirectory(repo, `.alinery/tasks/${slug}/artifacts`);
  const out: string[] = [];
  const collect = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const name = path.slice(root.length + 1);
      const first = name.split("/")[0];
      if (first === "attachments" || first === "subtasks") continue;
      if (lstatSync(path).isDirectory()) collect(resolveArtifactDirectory(root, name));
      else {
        resolveArtifactPath(root, name);
        out.push(name);
      }
    }
  };
  collect(root);
  return out.sort((a, b) => compareArtifactPaths(b, a));
}

/** `visible_artifact_names`. */
export const visibleArtifactNames = (repo: string, slug: string) => ownedArtifactNames(repo, slug).filter(isVisibleArtifactName);

/** `artifact_text_hash`: FNV-1a over the UTF-8 bytes, 16 hex digits. Detects a changed file for the stale marks; not a trust boundary. */
export function artifactTextHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}

export { artifactsDir };
