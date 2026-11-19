import { selectorsOverlap } from "./PlaybookGraph";
import type { ArtifactOccurrence, ExecutionRecord, SessionMeta, TaskExecutionState } from "./types";

export function lineageSessionIntent(state: TaskExecutionState | undefined, session: SessionMeta): "history" | "attach" {
  const past = Object.values(state?.executions ?? {}).some(
    (e) => e.previous_session_ids.includes(session.id) || (e.owner_session_id === session.id && e.lifecycle === "completed" && e.shutdown_confirmed),
  );
  return past || session.archived || session.ended_at != null ? "history" : "attach";
}

function boundInputs(execution: ExecutionRecord, occurrences: Record<string, ArtifactOccurrence>) {
  const inputs: ArtifactOccurrence[] = [];
  for (const id of new Set(Object.values(execution.candidate.inputs).flat())) {
    if (occurrences[id]) inputs.push(occurrences[id]);
  }
  return inputs;
}

export function hasPendingOutput(record: ExecutionRecord, path: string) {
  return !record.receipt_id && record.outputs.some((output) => selectorsOverlap(output.relative_path, path));
}

/** One hop in the actual run, using the exact occurrences each step consumed (including collection members). */
export function executionLineage(state: TaskExecutionState, execution: ExecutionRecord) {
  const records = Object.values(state.executions ?? {});
  const occurrences = state.occurrences ?? {};
  const inputs = boundInputs(execution, occurrences);
  const parentIds = new Set(execution.parent_execution_ids);
  for (const occurrence of inputs) {
    if (occurrence.producer_execution_id) parentIds.add(occurrence.producer_execution_id);
  }
  const published = Object.values(occurrences).filter((item) => item.producer_execution_id === execution.id);
  const publishedIds = new Set(published.map((item) => item.id));
  const successors = records.filter(
    (other) =>
      other.id !== execution.id &&
      (other.parent_execution_ids.includes(execution.id) || Object.values(other.candidate.inputs).some((ids) => ids.some((id) => publishedIds.has(id)))),
  );
  return { parents: records.filter((other) => other.id !== execution.id && parentIds.has(other.id)), successors, inputs, published };
}

/** Follow actual bindings on either side of the file, including split and joined runs. */
export function artifactLineage(state: TaskExecutionState | undefined, path: string, artifactPaths: string[] = []) {
  const records = Object.values(state?.executions ?? {});
  const occurrences = state?.occurrences ?? {};
  const allOccurrences = Object.values(occurrences);
  const matching = allOccurrences.filter((item) => item.relative_path === path);
  const ids = new Set(matching.map((item) => item.id));
  const producerIds = new Set(matching.map((item) => item.producer_execution_id));
  const producers = records.filter((record) => producerIds.has(record.id));
  const assigned = matching.length ? [] : records.filter((record) => hasPendingOutput(record, path));
  const consumers = records.filter((record) => Object.values(record.candidate.inputs).some((group) => group.some((id) => ids.has(id))));

  const producerInputs = new Set((matching.length ? producers : assigned).flatMap((record) => boundInputs(record, occurrences).map((item) => item.relative_path)));
  const consumerIds = new Set(consumers.map((record) => record.id));
  const published = new Set(allOccurrences.filter((item) => item.producer_execution_id && consumerIds.has(item.producer_execution_id)).map((item) => item.relative_path));
  const consumerOutputs = Array.from(published, (path) => ({ path, assigned: false }));
  for (const path of new Set(artifactPaths)) {
    if (!published.has(path) && consumers.some((record) => hasPendingOutput(record, path))) consumerOutputs.push({ path, assigned: true });
  }
  return { producers, consumers, assigned, producerInputs: [...producerInputs], consumerOutputs };
}
