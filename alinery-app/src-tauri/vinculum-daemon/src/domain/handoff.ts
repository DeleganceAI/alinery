// Review handoff (plan S4.5), the two halves `send_review_handoff_for_repos` did in one process. The target's daemon installs
// the evidence artifact and the inbound record and creates the session; the source's daemon writes the outbound record. Each
// daemon owns its own repository, so the client carries the artifact's text one way and the record back (the plan, S4.5).
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomic } from "../platform/fs.ts";
import { DomainError } from "../platform/lock.ts";
import { artifactFilePath, validateArtifactFilename } from "./artifactFiles.ts";
import type { HandoffRecord } from "./artifactList.ts";

export const MAX_HANDOFF_SLOTS = 999;

/** `split_artifact_filename`'s stem (its extension, if any, is the last dot of the file name, and a leading dot is no extension). */
function stemOf(name: string): string {
  validateArtifactFilename(name);
  const slash = name.lastIndexOf("/");
  const file = name.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 && dot < file.length - 1 ? name.slice(0, slash + 1) + file.slice(0, dot) : name;
}

/** `next_review_handoff_artifact_name`: the first `review-handoff-NNN.md` the target does not have. */
export function nextReviewHandoffArtifactName(repo: string, slug: string): string {
  for (let i = 1; i <= MAX_HANDOFF_SLOTS; i++) {
    const name = `review-handoff-${String(i).padStart(3, "0")}.md`;
    if (!existsSync(artifactFilePath(repo, slug, name))) return name;
  }
  throw new DomainError("failed_precondition", "too many review handoff artifacts");
}

/** `artifact_record_sidecar_name`: the inbound record sits at `<stem>.handoff.json`, outbound ones at `<stem>.handoff-NNN.json`. */
export function recordSidecarName(artifact: string, direction: "inbound" | "outbound", index = 0): string {
  const stem = stemOf(artifact);
  if (direction === "inbound") return `${stem}.handoff.json`;
  if (index <= 0) throw new DomainError("invalid_argument", "outbound handoff sidecar index must be non-zero");
  return `${stem}.handoff-${String(index).padStart(3, "0")}.json`;
}

/** `next_outbound_handoff_sidecar_name`. */
export function nextOutboundSidecarName(repo: string, slug: string, artifact: string): string {
  for (let i = 1; i <= MAX_HANDOFF_SLOTS; i++) {
    const name = recordSidecarName(artifact, "outbound", i);
    if (!existsSync(artifactFilePath(repo, slug, name))) return name;
  }
  throw new DomainError("failed_precondition", `too many outbound handoff records for ${artifact}`);
}

/** The text the target keeps as evidence: where it came from, then the source artifact as it was. */
export function evidenceMarkdown(sourceRepoPath: string, sourceSlug: string, sourceArtifact: string, sourceText: string): string {
  return `# Review handoff\n\nSource repository: ${sourceRepoPath}\nSource task: ${sourceSlug}\nSource artifact: ${sourceArtifact}\n\n${sourceText}`;
}

/** The prompt addition that points the target session at its evidence file. */
export const evidencePrompt = (promptExtra: string, evidencePath: string) =>
  `${promptExtra}\n\nRead the review handoff evidence at ${evidencePath}. It is context, not an engine input occurrence; preserve the assigned execution paths and completion policy.`;

/** `serde_json::to_vec_pretty` of a `ReviewHandoffRecord`: two-space indent, fields in declaration order. */
export const recordJson = (record: HandoffRecord) =>
  JSON.stringify(
    {
      version: record.version,
      direction: record.direction,
      source_repo_path: record.source_repo_path,
      target_repo_path: record.target_repo_path,
      source_task: record.source_task,
      source_session: record.source_session,
      source_artifact: record.source_artifact,
      target_task: record.target_task,
      target_artifact: record.target_artifact,
      target_session: record.target_session,
      target_phase: record.target_phase,
      created_at_ms: record.created_at_ms,
    },
    null,
    2,
  );

/** Writes one file below a task's artifacts, atomically. */
export function writeArtifactFile(repo: string, slug: string, name: string, text: string): string {
  const path = artifactFilePath(repo, slug, name);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, text);
  return path;
}
