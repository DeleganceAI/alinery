import type { ArtifactOccurrence, ExecutionRecord, TaskExecutionState } from "./types";

/** One hop in the actual run, using the exact occurrences each step consumed (including collection members). */
export function executionLineage(state: TaskExecutionState, execution: ExecutionRecord) {
  const records = Object.values(state.executions ?? {});
  const occurrences = state.occurrences ?? {};
  const inputs: ArtifactOccurrence[] = [];
  const parentIds = new Set(execution.parent_execution_ids);
  for (const id of new Set(Object.values(execution.candidate.inputs).flat())) {
    const occurrence = occurrences[id];
    if (!occurrence) continue;
    inputs.push(occurrence);
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
