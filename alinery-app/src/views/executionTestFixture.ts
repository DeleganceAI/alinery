import type { ExecutionRecord, TaskExecutionReply } from "../types";

export function executionRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "execution-a",
    binding_key: "binding-a",
    candidate: {
      step_key: "worker",
      context_id: "root",
      inputs: { "request.md": ["input-a"] },
      complete_collection_id: null,
      each_collection_id: null,
      each_member_id: null,
      manual: false,
    },
    outputs: [{ selector: "result.md", relative_path: "research/2-result-10.md", discriminator: 10 }],
    parent_execution_ids: [],
    depth: 2,
    owner_session_id: "owner-a",
    previous_session_ids: [],
    launch: { harness: "omp", model: "authored-model" },
    is_coding_step: false,
    start_requested: true,
    lifecycle: "running",
    permission: { kind: "locked" },
    receipt_id: null,
    exit_code: null,
    shutdown_confirmed: false,
    error: null,
    ...overrides,
  };
}

export function executionReply(records: ExecutionRecord[] = [executionRecord()]): TaskExecutionReply {
  return {
    live: { status: "available" },
    definition: {
      version: 2,
      key: "retained",
      title: "Retained playbook",
      description: "Task-owned source",
      default_model: "authored-model",
      default_harness: "omp",
      preamble: "",
      section_order: ["worker"],
      step: [
        {
          key: "worker",
          title: "Retained worker",
          short: "",
          inputs: [{ path: "request.md", mode: "single" }],
          outputs: [{ path: "result.md" }],
          model: "",
          harness: "",
          is_coding_step: false,
          auto_advance_default: false,
          prompt: "Use the exact assigned request, not the newest filename.",
        },
      ],
    },
    state: {
      version: 1,
      revision: 1,
      creation: "ready",
      creation_error: null,
      owning_lane: "test-lane",
      definition_identity: "fixed-source",
      reference: { scope: "repo", key: "retained" },
      max_live_sessions: 3,
      enabled_steps: [],
      launch_defaults: { harness: "omp", model: "" },
      contexts: {},
      collections: {},
      executions: Object.fromEntries(records.map((record) => [record.id, record])),
      occurrences: {
        "input-a": {
          id: "input-a",
          producer_execution_id: null,
          selector: "request.md",
          logical_path: "request.md",
          relative_path: "research/1-request-2.md",
          depth: 1,
          discriminator: 2,
          context_id: "root",
          collection_ids: [],
        },
      },
    },
  };
}

export function partiallyPublishedExecution(ownerSessionId = "owner-a"): TaskExecutionReply {
  const reply = executionReply([
    executionRecord({
      owner_session_id: ownerSessionId,
      lifecycle: "finishing",
      receipt_id: "receipt-a",
      outputs: [
        { selector: "resolution-options.md", relative_path: "2-resolution-options-10.md", discriminator: 10 },
        { selector: "selected-fix.md", relative_path: "2-selected-fix-11.md", discriminator: 11 },
        { selector: "papers/*.md", relative_path: "papers/2-*-12.md", discriminator: 12 },
        { selector: "notes/*.md", relative_path: "notes/2-*-13.md", discriminator: 13 },
      ],
    }),
  ]);
  for (const [id, producer, selector, relativePath] of [
    ["options", "execution-a", "resolution-options.md", "2-resolution-options-10.md"],
    ["paper-a", "execution-a", "papers/*.md", "papers/2-a-12.md"],
    ["paper-b", "execution-a", "papers/*.md", "papers/2-b-12.md"],
    ["other-fix", "execution-b", "selected-fix.md", "2-selected-fix-20.md"],
    ["other-note", "execution-b", "notes/*.md", "notes/2-other-21.md"],
  ]) {
    reply.state.occurrences[id] = {
      ...reply.state.occurrences["input-a"],
      id,
      producer_execution_id: producer,
      selector,
      logical_path: selector,
      relative_path: relativePath,
    };
  }
  return reply;
}
