import type { ArtifactOccurrence, ExecutionRecord, SessionDisplayMeta, SessionMeta, TaskExecutionState } from "./types";

export type RunGraphNode = { key: string; session: SessionDisplayMeta; execution?: ExecutionRecord } | { key: string; label: string; detail: string };
export type RunGraphConnection = { from: string; to: string; artifacts: ArtifactOccurrence[]; resumed: boolean };

export function buildTaskRunGraph(sessions: SessionMeta[], state: TaskExecutionState | null) {
  const nodes = new Map<string, RunGraphNode>();
  const connections = new Map<string, RunGraphConnection>();
  const sessionKey = (id: string) => `session:${id}`;
  const orderedSessions = [...sessions].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id));
  for (const session of orderedSessions) nodes.set(sessionKey(session.id), { key: sessionKey(session.id), session });
  const connect = (from: string, to: string, artifact?: ArtifactOccurrence) => {
    const key = JSON.stringify([from, to]);
    let connection = connections.get(key);
    if (!connection) {
      connection = { from, to, artifacts: [], resumed: false };
      connections.set(key, connection);
    }
    if (artifact) connection.artifacts.push(artifact);
    else connection.resumed = true;
  };

  const consumers = new Map<string, Set<string>>();
  if (state) {
    for (const execution of Object.values(state.executions)) {
      const attempts = [execution.owner_session_id, ...execution.previous_session_ids];
      for (const id of attempts) {
        const node = nodes.get(sessionKey(id));
        if (node && "session" in node) node.execution = execution;
      }
      // Complete/wildcard bindings already contain their exact accepted members.
      // Expanding collections here would add occurrences this execution never consumed.
      for (const occurrenceId of new Set(Object.values(execution.candidate.inputs).flat())) {
        let targets = consumers.get(occurrenceId);
        if (!targets) {
          targets = new Set();
          consumers.set(occurrenceId, targets);
        }
        for (const id of attempts) targets.add(sessionKey(id));
      }
    }
    for (const occurrence of Object.values(state.occurrences)) {
      const producer = occurrence.producer_execution_id ? state.executions[occurrence.producer_execution_id] : undefined;
      let from = producer ? sessionKey(producer.owner_session_id) : "";
      if (!nodes.has(from)) {
        from = `source:${occurrence.id}`;
        nodes.set(from, {
          key: from,
          label: occurrence.producer_execution_id ? "Producer not shown" : "Seed input",
          detail: producer ? `Session ${producer.owner_session_id}` : occurrence.producer_execution_id ? `Execution ${occurrence.producer_execution_id}` : "External artifact",
        });
      }
      const targets = consumers.get(occurrence.id);
      const visibleTargets = [...(targets ?? [])].filter((key) => nodes.has(key));
      if (visibleTargets.length) {
        for (const to of visibleTargets) connect(from, to, occurrence);
      } else {
        const to = `artifact:${occurrence.id}`;
        nodes.set(to, { key: to, label: "Published artifact", detail: targets?.size ? "Consumer not shown" : "Not yet consumed" });
        connect(from, to, occurrence);
      }
    }
  }
  for (const session of orderedSessions) {
    if (session.resume_of && nodes.has(sessionKey(session.resume_of))) connect(sessionKey(session.resume_of), sessionKey(session.id));
  }
  return { nodes, connections: [...connections.values()] };
}

export function occurrenceLabel(occurrence: ArtifactOccurrence) {
  return `${occurrence.relative_path} · ${occurrence.id}`;
}
