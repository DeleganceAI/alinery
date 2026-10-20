/**
 * The harness boundary.
 *
 * A Harness is whatever runs an agent for one execution: Pi Durable, OMP, or a
 * fake used in tests. The engine never touches processes, PTYs or sockets. It
 * calls the five methods below and reads back a deliberately small status
 * vocabulary.
 *
 * Division of labour:
 *
 *   Harness knows   is the process alive, is the agent mid-turn, did it exit.
 *   Engine knows    what the execution is for, which input occurrences it was
 *                   bound to, whether completion is permitted, whether its
 *                   outputs were accepted, and whether successors may launch.
 *
 * Richer execution states (reserved, finishing, done, failed, ambiguous) are
 * derived by the engine from harness status plus its own event log. They are
 * not the harness's business.
 */

/**
 * Opaque handle returned by start(). The engine persists it so that a restarted
 * engine can ask a durable harness about a session it did not start in this
 * process.
 */
export type SessionId = string;

/** Everything a harness needs to launch one execution's agent. */
export interface Launch {
  /** The engine's execution id. Useful for the harness's own logs and naming. */
  executionId: string;

  /** Step key, for display. The prompt already carries the instructions. */
  step: string;

  /** Working directory for the agent: the task's repo checkout or worktree. */
  cwd: string;

  /**
   * Fully rendered instructions: the step prompt followed by the engine's
   * assignment block (exact input paths to read, exact output paths or
   * patterns to write, and how to request completion).
   */
  prompt: string;

  /** Model name, already resolved from step and playbook defaults. */
  model: string;

  /** Input slot (logical role or selector) to the absolute paths bound to it. Same facts as the prompt, structured. */
  inputs: Record<string, string[]>;

  /** Output role to its assigned absolute path, or absolute pattern for a wildcard family. */
  outputs: Record<string, string>;

  /**
   * The one tool the engine exposes to the agent.
   *
   * The harness registers it under a stable tool name (the current product
   * uses `alinery_phase_complete`), forwards the agent's call here, and
   * returns the reply verbatim. The engine, not the harness, decides what the
   * reply is: it validates the assigned outputs against the filesystem and the
   * human gate. Calling this again after acceptance returns the same receipt.
   */
  requestCompletion: () => Promise<CompletionReply>;
}

export type CompletionReply =
  /** Outputs validated and durably recorded. Agent should finish without starting more work. */
  | { kind: 'accepted'; published: string[] }
  /** The human gate is closed. Session stays interactive; agent waits for direction. */
  | { kind: 'permission-required' }
  /**
   * Something assigned was present but invalid (empty file, a directory), or
   * nothing valid was published at all. Nothing was recorded. Fix and call again.
   */
  | { kind: 'rejected'; problems: string[] };

/**
 * What a harness can truthfully report about a session. Only facts about the
 * process and the agent loop. Nothing here means "done" in the playbook sense;
 * only an accepted completion followed by `exited` means that.
 */
export type SessionStatus =
  /** start() returned but the process is not yet confirmed alive. */
  | { kind: 'starting' }
  /** Agent is mid-turn: generating or running tools. */
  | { kind: 'running' }
  /**
   * Agent's turn ended and it is waiting for input. It may be asking the human
   * a question, or it may believe it is finished without having requested
   * completion. The engine decides what idle means for this execution.
   */
  | { kind: 'idle' }
  /** Process has exited. Terminal until resumed. */
  | { kind: 'exited'; exitCode: number | null }
  /** Harness could not start the process or lost it abnormally. Terminal until resumed. */
  | { kind: 'failed'; reason: string }
  /**
   * Harness has no record of this id, for example because it restarted and
   * the session is gone. The engine treats this as failed: a human must look.
   * The engine never guesses that an unknown session has stopped.
   */
  | { kind: 'unknown' };

export interface Harness {
  /**
   * Launch an agent. Resolves once the harness has a session id, not when the
   * agent finishes. A rejected promise means the launch itself failed and the
   * engine records the execution as failed.
   */
  start(launch: Launch): Promise<SessionId>;

  /**
   * Continue a session that stopped: exited early, crashed, or was lost. A
   * durable harness resumes the same conversation and returns the same id; a
   * harness that cannot may start fresh from `launch` and return a new id.
   * Only ever called by an explicit human action through the engine. Never
   * automatic.
   */
  resume(id: SessionId, launch: Launch): Promise<SessionId>;

  /**
   * Current status. Must be callable at any time, including for ids minted by
   * a previous engine process. The engine polls this on every tick for live
   * sessions.
   */
  // ponytail: polling on tick, matching the product's 5 s poller; add a push
  // subscription only if polling measurably hurts.
  status(id: SessionId): Promise<SessionStatus>;

  /**
   * Deliver a message into a live session: human steering, or the engine's
   * "you may wrap up now" after the gate opens.
   */
  send(id: SessionId, text: string): Promise<void>;

  /**
   * Ask the agent to finish and resolve when exit is confirmed. Called by the
   * engine only after accepted completion, or by an explicit human action.
   * Capacity, coding ownership and successor launches are released only after
   * this resolves. The harness must not report exit before output is drained.
   * Must be idempotent: a restarted engine may ask again.
   */
  stop(id: SessionId): Promise<void>;
}
