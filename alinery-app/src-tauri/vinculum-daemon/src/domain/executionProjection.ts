// How the playbook engine's State shows in execution.json's Rust-shaped `executions` and `occurrences`
// maps and in the execution entity: one projection, used by the daemon's save and by the entity builder.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parsePlaybookMd } from "playbook-engine/src/playbook-md.ts";
import type { Playbook, Step } from "playbook-engine/src/playbook.ts";
import { type Execution, occurrences, type State } from "playbook-engine/src/state.ts";

function lifecycle(execution: Execution): string {
  if (execution.status === "reserved") return "queued";
  if (execution.status === "finishing") return "finishing";
  if (execution.status === "done") return "completed";
  if (execution.status === "failed") return "failed";
  return "running";
}

/** A closed gate stays locked until this execution is permitted. Auto-approve-all opens it without rewriting the snapshot. */
export function completionPermission(execution: Pick<Execution, "id" | "sessionId" | "permitted" | "automatic">, autoApproveAll: boolean): Record<string, unknown> {
  if (execution.permitted) return { kind: "human_granted", execution_id: execution.id, session_id: execution.sessionId ?? "" };
  if (execution.automatic === false && !autoApproveAll) return { kind: "locked" };
  return { kind: "automatic" };
}

export function projectExecution(execution: Execution, autoApproveAll = false, project?: { steps: Step[]; artifactsDir: string }): Record<string, unknown> {
  return {
    id: execution.id,
    binding_key: execution.id,
    candidate: {
      step_key: execution.step,
      context_id: "root",
      inputs: execution.inputs,
      complete_collection_id: null,
      each_collection_id: null,
      each_member_id: null,
      manual: false,
    },
    outputs: project ? projectOutputs(execution, project.steps, project.artifactsDir) : [],
    parent_execution_ids: [],
    depth: execution.depth,
    owner_session_id: execution.sessionId ?? "",
    previous_session_ids: [],
    launch: { harness: "omp", model: "" },
    is_coding_step: false,
    start_requested: true,
    lifecycle: lifecycle(execution),
    permission: completionPermission(execution, autoApproveAll),
    receipt_id: execution.receipt ? execution.id : null,
    exit_code: null,
    shutdown_confirmed: execution.status === "done" || execution.status === "failed",
    error: execution.failure,
  };
}

/** Path under the task artifacts directory, or undefined when the file lives elsewhere. The graph opens this string. */
function artifactRelative(artifactsDir: string, filePath: string): string | undefined {
  if (!artifactsDir || !filePath) return undefined;
  const rel = relative(artifactsDir, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split("\\").join("/");
}

function projectOutputs(execution: Execution, steps: Step[], artifactsDir: string): Record<string, unknown>[] {
  const step = steps.find((item) => item.key === execution.step);
  if (!step) return [];
  const dir = artifactRelative(artifactsDir, execution.outDir) ?? "";
  return step.outputs.map((output) => {
    const row: Record<string, unknown> = {
      selector: output.path,
      relative_path: dir ? `${dir}/${output.path}` : output.path,
      discriminator: 0,
    };
    if (output.required) row.required = true;
    return row;
  });
}

export function projectOccurrences(state: State, artifactsDir: string): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const occurrence of occurrences(state)) {
    const producer = occurrence.producer ? state.executions.get(occurrence.producer) : undefined;
    projected[occurrence.id] = {
      id: occurrence.id,
      producer_execution_id: occurrence.producer,
      selector: occurrence.role,
      logical_path: occurrence.role,
      relative_path: artifactRelative(artifactsDir, occurrence.path) ?? occurrence.role,
      depth: producer?.depth ?? 0,
      discriminator: 0,
      context_id: "root",
      collection_ids: [],
    };
  }
  return projected;
}

export function projectionContext(repo: string, slug: string): { steps: Step[]; artifactsDir: string } {
  const artifactsDir = join(repo, ".alinery", "tasks", slug, "artifacts");
  try {
    const parsed = parsePlaybookMd(readFileSync(join(repo, ".alinery", "tasks", slug, "playbook.md"), "utf8"));
    return { steps: parsed.playbook?.steps ?? [], artifactsDir };
  } catch {
    return { steps: [], artifactsDir };
  }
}

export function taskAutoApproveAll(repo: string, slug: string): boolean {
  const path = join(repo, ".alinery", "tasks", slug, "execution.json");
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { auto_approve_all?: unknown };
    return state.auto_approve_all === true;
  } catch {
    return false;
  }
}
