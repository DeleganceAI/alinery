/** Session meta records the Vinculum agent as `vinculum`. `omp` is the registry key and a file the daemon has not rewritten yet. */
export function isVinculumHarness(key: string): boolean {
  return key === "vinculum" || key === "omp";
}

type RecoverableExecution = { owner_session_id: string; lifecycle: string; receipt_id: string | null };

/** A Vinculum step that stopped before acceptance. The conversation is still in the session file. */
export function sessionIsRecoverable(harness: string, sessionId: string, execution: RecoverableExecution | null | undefined): boolean {
  return isVinculumHarness(harness) && execution?.owner_session_id === sessionId && execution.lifecycle === "failed" && !execution.receipt_id;
}

/** Terminal word for a session that is not live. Null means the live status still applies. */
export function sessionTerminalLabel(harness: string, sessionId: string, execution: RecoverableExecution | null | undefined, ended: boolean): "Recoverable" | "Completed" | "Ready to advance" | "Exited" | null {
  if (execution && execution.owner_session_id !== sessionId) return ended ? "Exited" : null;
  if (sessionIsRecoverable(harness, sessionId, execution)) return "Recoverable";
  if (execution?.lifecycle === "finishing") return "Ready to advance";
  if (execution?.lifecycle === "completed" || execution?.receipt_id) return "Completed";
  if (ended) return "Exited";
  return null;
}
