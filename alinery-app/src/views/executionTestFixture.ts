import type { ExecutionRecord, TaskExecutionReply } from "../types";

export function executionRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "execution-a", binding_key: "binding-a",
    candidate: { step_key: "worker", context_id: "root", inputs: { "request.md": ["input-a"] }, complete_collection_id: null, each_collection_id: null, each_member_id: null, manual: false },
    outputs: [{ selector: "result.md", relative_path: "research/2-result-10.md", discriminator: 10 }],
    parent_execution_ids: [], depth: 2, owner_session_id: "owner-a", previous_session_ids: [],
    launch: { harness: "omp", model: "authored-model" }, is_coding_step: false, start_requested: true,
    lifecycle: "running", permission: { kind: "locked" }, receipt_id: null, exit_code: null,
    shutdown_confirmed: false, error: null, ...overrides,
  };
}

export function executionReply(records: ExecutionRecord[] = [executionRecord()]): TaskExecutionReply {
  return {
    definition: {
      version: 2, key: "retained", title: "Retained playbook", description: "Task-owned source", default_model: "authored-model", default_harness: "omp", preamble: "", section_order: ["worker"],
      step: [{ key: "worker", title: "Retained worker", short: "", inputs: [{ path: "request.md", mode: "single" }], outputs: [{ path: "result.md" }], model: "", harness: "", is_coding_step: false, auto_advance_default: false, prompt: "Use the exact assigned request, not the newest filename." }],
    },
    state: {
      version: 1, revision: 1, creation: "ready", creation_error: null, owning_lane: "test-lane", definition_identity: "fixed-source", reference: { scope: "repo", key: "retained" }, max_live_sessions: 3, enabled_steps: [], launch_defaults: { harness: "omp", model: "" }, contexts: {}, collections: {},
      executions: Object.fromEntries(records.map((record) => [record.id, record])),
      occurrences: { "input-a": { id: "input-a", producer_execution_id: null, selector: "request.md", logical_path: "request.md", relative_path: "research/1-request-2.md", depth: 1, discriminator: 2, context_id: "root", collection_ids: [] } },
    },
  };
}
