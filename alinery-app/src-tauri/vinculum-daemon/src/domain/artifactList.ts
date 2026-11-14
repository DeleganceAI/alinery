// The artifact list of a task (plan S4.5): one row per visible artifact with the step, session, handoffs and execution
// that explain it, and one per attachment. Ports `list_artifacts_with_metadata_for`, `list_artifacts_with_execution_metadata`
// and `board::artifacts_with_metadata` (alinery-core shared.rs, board.rs). The order is part of the answer: the rows of an
// execution-driven task come step by step, newest depth first, then the files no execution claims, then the attachments.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "../platform/lock.ts";
import { parseSessionMeta } from "../sync/parsers/sessionMeta.ts";
import { artifactFilePath, compareArtifactPaths, isHandoffSidecarName, isVisibleArtifactName, ownedArtifactNames, resolveArtifactDirectory, resolveArtifactPath } from "./artifactFiles.ts";
import { sessionsDir, readTaskChecked } from "./taskFiles.ts";

/** `ReviewHandoffRecord`: the sidecar a handoff leaves beside the artifact it moved. */
export type HandoffRecord = {
  version: number;
  direction: string;
  source_repo_path: string;
  target_repo_path: string;
  source_task: string;
  source_session: string;
  source_artifact: string;
  target_task: string;
  target_artifact: string;
  target_session: string;
  target_phase: string;
  created_at_ms: number;
};

export type ArtifactItem = {
  name: string;
  modified_at_ms: number | null;
  playbook_step: string;
  session_id: string;
  handoffs: HandoffRecord[];
  attachment: boolean;
  execution_id: string | null;
  step_key: string | null;
  logical_path: string | null;
  depth: number | null;
  discriminator: number | null;
  accepted: boolean | null;
};

/** What the list needs of the retained execution state (the Rust-shaped `executions` and `occurrences` maps). */
export type ExecutionRecords = {
  executions?: Record<string, ExecutionRecord>;
  occurrences?: Record<string, OccurrenceRecord>;
};
type ExecutionRecord = {
  id: string;
  candidate: { step_key: string };
  outputs: { selector: string; relative_path: string; discriminator: number }[];
  depth: number;
  owner_session_id: string;
  receipt_id: string | null;
};
type OccurrenceRecord = { producer_execution_id: string | null; relative_path: string; logical_path: string };

const blank = (name: string): ArtifactItem => ({
  name,
  modified_at_ms: null,
  playbook_step: "",
  session_id: "",
  handoffs: [],
  attachment: false,
  execution_id: null,
  step_key: null,
  logical_path: null,
  depth: null,
  discriminator: null,
  accepted: null,
});

const mtime = (path: string): number | null => {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return null;
  }
};

/** serde's read of a `ReviewHandoffRecord`: a record that does not fit is no record, and the file is skipped. */
export function parseHandoffRecord(raw: string): HandoffRecord | undefined {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return undefined;
    const text = (k: string, optional = false) => (typeof o[k] === "string" ? (o[k] as string) : optional && o[k] === undefined ? "" : undefined);
    const uint = (k: string) => (typeof o[k] === "number" && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : undefined);
    const fields = {
      version: uint("version"),
      direction: text("direction"),
      source_repo_path: text("source_repo_path", true),
      target_repo_path: text("target_repo_path", true),
      source_task: text("source_task"),
      source_session: text("source_session"),
      source_artifact: text("source_artifact"),
      target_task: text("target_task"),
      target_artifact: text("target_artifact"),
      target_session: text("target_session"),
      target_phase: text("target_phase"),
      created_at_ms: uint("created_at_ms"),
    };
    if (Object.values(fields).some((v) => v === undefined)) return undefined;
    return fields as HandoffRecord;
  } catch {
    return undefined;
  }
}

function attachmentItems(repo: string, slug: string): ArtifactItem[] {
  const directory = resolveArtifactDirectory(repo, `.alinery/tasks/${slug}/artifacts/attachments`);
  if (!existsSync(directory)) return [];
  const out: ArtifactItem[] = [];
  for (const name of readdirSync(directory)) {
    resolveArtifactPath(repo, `.alinery/tasks/${slug}/artifacts/attachments/${name}`);
    out.push({ ...blank(name), modified_at_ms: mtime(join(directory, name)), attachment: true });
  }
  // Newest first; the name settles a tie. `None` sorts before any time in Rust's Option order, so it comes last here.
  return out.sort((a, b) => (b.modified_at_ms ?? -1) - (a.modified_at_ms ?? -1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `list_artifacts_with_metadata_for`: the visible artifacts and the attachments, with the step of the session that wrote each. */
export function listArtifactsPlain(repo: string, slug: string): ArtifactItem[] {
  const names = ownedArtifactNames(repo, slug);
  const records: HandoffRecord[] = [];
  for (const name of names.filter(isHandoffSidecarName)) {
    const record = parseHandoffRecord(readFileSync(artifactFilePath(repo, slug, name), "utf8"));
    if (record) records.push(record);
  }
  records.sort((a, b) => a.created_at_ms - b.created_at_ms);
  const items = names.filter(isVisibleArtifactName).map((name) => ({ ...blank(name), modified_at_ms: mtime(artifactFilePath(repo, slug, name)) }));
  const dir = sessionsDir(repo, slug);
  const metas = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".meta.json")) : [];
  for (const file of metas) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const entity = parseSessionMeta(text, slug, file.slice(0, -".meta.json".length));
    if (entity?.value.case !== "session") continue;
    const meta = entity.value.value;
    if (!meta.artifact) continue;
    const item = items.find((i) => i.name === meta.artifact);
    if (item) {
      item.playbook_step = meta.phase;
      item.session_id = meta.id;
    }
  }
  for (const item of items) {
    item.handoffs = records.filter((r) => (r.direction === "outbound" && r.source_task === slug && r.source_artifact === item.name) || (r.direction === "inbound" && r.target_task === slug && r.target_artifact === item.name));
  }
  return [...items, ...attachmentItems(repo, slug)];
}

/** `ArtifactSelector`: a safe relative `.md` path whose file name holds at most one `*`. */
export class ArtifactSelector {
  private constructor(
    readonly directory: string,
    readonly prefix: string,
    readonly suffix: string,
    readonly wildcard: boolean,
  ) {}

  static parse(path: string): ArtifactSelector {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what is refused
    if (path === "" || !path.endsWith(".md") || /[\\:?[\]]/.test(path) || /[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new DomainError("invalid_argument", "expected a safe relative .md path with at most one filename wildcard");
    const parts = path.split("/");
    parts.forEach((part, i) => {
      if (part === "" || part === "." || part === ".." || (i < parts.length - 1 && part.includes("*"))) throw new DomainError("invalid_argument", "empty, dot, parent and wildcard directory components are forbidden");
    });
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash);
    const filename = slash < 0 ? path : path.slice(slash + 1);
    const star = filename.indexOf("*");
    if (star < 0) return new ArtifactSelector(directory, filename, "", false);
    const suffix = filename.slice(star + 1);
    if (suffix.includes("*")) throw new DomainError("invalid_argument", "at most one wildcard is permitted");
    return new ArtifactSelector(directory, filename.slice(0, star), suffix, true);
  }

  matches(path: string): boolean {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash);
    const filename = slash < 0 ? path : path.slice(slash + 1);
    if (directory !== this.directory) return false;
    if (!this.wildcard) return filename === this.prefix;
    return Buffer.byteLength(filename) >= Buffer.byteLength(this.prefix) + Buffer.byteLength(this.suffix) && filename.startsWith(this.prefix) && filename.endsWith(this.suffix);
  }
}

/** `list_artifacts_with_execution_metadata`: the execution state says which step owns each file, and which files are still to come. */
export function listArtifactsWithExecution(repo: string, slug: string, state: ExecutionRecords): ArtifactItem[] {
  const all = listArtifactsPlain(repo, slug);
  const items = all.filter((i) => !i.attachment);
  const attachments = all.filter((i) => i.attachment);
  const ids = <T>(map: Record<string, T> | undefined) => Object.keys(map ?? {}).sort().map((id) => (map as Record<string, T>)[id]);
  const occurrences = new Map<string, OccurrenceRecord>();
  for (const occurrence of ids(state.occurrences)) occurrences.set(occurrence.relative_path, occurrence);
  for (const occurrence of ids(state.occurrences)) {
    if (occurrence.producer_execution_id !== null && occurrence.producer_execution_id !== undefined && !items.some((i) => i.name === occurrence.relative_path)) items.push(blank(occurrence.relative_path));
  }
  for (const record of ids(state.executions)) {
    for (const assignment of record.outputs) {
      if ((record.receipt_id === null || record.receipt_id === undefined) && !items.some((i) => i.name === assignment.relative_path)) items.push(blank(assignment.relative_path));
      const selector = ArtifactSelector.parse(assignment.relative_path);
      for (const item of items.filter((i) => !i.attachment && selector.matches(i.name))) {
        item.execution_id = record.id;
        item.step_key = record.candidate.step_key;
        item.playbook_step = record.candidate.step_key;
        item.session_id = record.owner_session_id;
        item.depth = record.depth;
        item.discriminator = assignment.discriminator;
        const occurrence = occurrences.get(item.name);
        const owned = occurrence !== undefined && occurrence.producer_execution_id === record.id ? occurrence : undefined;
        item.accepted = owned !== undefined;
        item.logical_path = owned?.logical_path ?? assignment.selector;
      }
    }
  }
  const driven = (i: ArtifactItem) => i.depth !== null && i.discriminator !== null;
  items.sort((left, right) => {
    if (driven(left) && driven(right)) return (right.depth as number) - (left.depth as number) || (right.discriminator as number) - (left.discriminator as number) || compareArtifactPaths(right.name, left.name);
    if (driven(left)) return -1;
    if (driven(right)) return 1;
    return compareArtifactPaths(right.name, left.name);
  });
  return [...items, ...attachments];
}

/** `board::artifacts_with_metadata`. `execution` answers the retained state of an engine-v2 task, or undefined when there is none. */
export function listArtifacts(repo: string, slug: string, execution: (slug: string) => ExecutionRecords | undefined): ArtifactItem[] {
  const task = readTaskChecked(repo, slug);
  if (Number(task.engine_version ?? 0) >= 2) {
    const state = execution(slug);
    if (!state) throw new DomainError("failed_precondition", "task execution state unavailable");
    return listArtifactsWithExecution(repo, slug, state);
  }
  return listArtifactsPlain(repo, slug);
}
