// OMP run-local extension for Alinery.
//
// Injected at session startup via --extension <path>. Registers OMP lifecycle
// callbacks and scoped completion, approval, and session-naming tools. Passive callbacks emit one
// normalized RunnerEvent with bounded, terminal-silent, fail-open delivery.
// Phase completion preserves typed daemon outcomes and requests ordinary OMP
// shutdown only after accepted completion.
//
// The module exports registerCallbacks() so the test suite can inject fake OMP
// API objects without launching OMP. The default export captures the transport
// environment once, removes it from OMP's process environment before tool
// subprocesses can inherit it, and registers the production emitters.
//
// Environment variables supplied by alineryd:
//   ALINERY_RUNNER_PATH              absolute path to the alinery-runner binary
//   ALINERY_SESSION_ID               Alinery session ID
//   ALINERY_DAEMON_SOCKET            Unix socket path
//   ALINERY_DAEMON_NAMESPACE         daemon socket namespace
//   ALINERY_EVENT_PROTOCOL_VERSION   runner event protocol version
//   ALINERY_EVENT_TOKEN              per-session secret token
//   ALINERY_HOST_EXECUTABLE          canonical host app executable (launch-only)
//   ALINERY_SESSION_NAMING          task-attached naming eligibility (launch-only)

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- OMP extension API types ----------
// Minimal surface of the OMP ExtensionAPI used by this extension.
// The full API is supplied at runtime by OMP's loader.

export interface OmpToolParameters {
  readonly [key: string]: unknown;
}

export interface OmpExtensionContext {
  readonly cwd: string;
  readonly hasUI?: boolean;
  readonly sessionManager: {
    getSessionId(): string;
  };
  shutdown(): void;
  readonly ui?: {
    confirm(title: string, message: string): Promise<boolean>;
    setEditorText?(text: string): void;
  };
}

export interface OmpAgentStartPayload {
  readonly type: "agent_start";
}

export interface OmpAgentEndPayload {
  readonly type: "agent_end";
  readonly willContinue?: boolean;
}

export interface OmpSessionStopPayload {
  readonly type: "session_stop";
  readonly session_id: string;
  readonly turn_id: number;
}

export interface OmpToolApprovalRequestedPayload {
  readonly toolCallId: string;
}

export interface OmpToolApprovalResolvedPayload {
  readonly toolCallId: string;
}

export interface OmpToolCallPayload {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Record<string, unknown>;
}

export interface OmpToolResultPayload {
  readonly toolName: string;
  readonly toolCallId: string;
}

export interface OmpToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpExtensionContext,
  ): Promise<{
    // Completion details preserve the daemon outcome, including receipt/diagnostics.
    content: readonly { readonly type: "text"; readonly text: string }[];
    details: Record<string, unknown>;
  }>;
}

export interface ToolCallEventResult {
  readonly block: true;
  readonly reason: string;
}

export interface OmpExtensionAPI {
  readonly zod: {
    readonly z: {
      object(shape: OmpToolParameters): unknown;
      string(): unknown;
    };
  };
  on(event: "session_start", handler: (payload: unknown, context: OmpExtensionContext) => void | Promise<void>): void;
  on(event: "before_agent_start", handler: (payload: { readonly systemPrompt: readonly string[] }) => { systemPrompt: string[] } | undefined): void;
  on(event: "agent_start", handler: (payload: OmpAgentStartPayload) => void | Promise<void>): void;
  on(event: "agent_end", handler: (payload: OmpAgentEndPayload) => void | Promise<void>): void;
  on(event: "session_stop", handler: (payload: OmpSessionStopPayload, context: OmpExtensionContext) => void | Promise<void>): void;
  on(event: "tool_approval_requested", handler: (payload: OmpToolApprovalRequestedPayload) => void | Promise<void>): void;
  on(event: "tool_approval_resolved", handler: (payload: OmpToolApprovalResolvedPayload) => void | Promise<void>): void;
  on(event: "tool_call", handler: (payload: OmpToolCallPayload, context: OmpExtensionContext) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>): void;
  on(event: "tool_result", handler: (payload: OmpToolResultPayload) => void | Promise<void>): void;
  registerTool(tool: OmpToolDefinition): void;
}

// ---------- RunnerEvent types (mirrors alinery-core) ----------

type RunnerEventBusy = {
  readonly type: "busy";
  readonly omp_turn_id?: number;
  readonly correlation_id?: string;
};
type RunnerEventIdle = {
  readonly type: "idle";
  readonly omp_turn_id?: number;
};
type RunnerEventWaitingForInput = {
  readonly type: "waiting_for_input";
  readonly correlation_id: string;
  readonly omp_turn_id?: number;
};
type RunnerEventWaitingForApproval = {
  readonly type: "waiting_for_approval";
  readonly correlation_id: string;
  readonly omp_turn_id?: number;
};
type RunnerEventPhaseCompleted = {
  readonly type: "phase_completed";
  readonly omp_session_id: string;
  readonly omp_turn_id?: number;
};
type RunnerEventAdapterError = {
  readonly type: "adapter_error";
  readonly detail: string;
};
type RunnerEventSessionName = {
  readonly type: "session_name_suggested";
  readonly name: string;
};

type RunnerEvent =
  | RunnerEventBusy
  | RunnerEventIdle
  | RunnerEventWaitingForInput
  | RunnerEventWaitingForApproval
  | RunnerEventPhaseCompleted
  | RunnerEventAdapterError
  | RunnerEventSessionName;

// ---------- emitter ----------

export type Emitter = (event: RunnerEvent) => Promise<void>;

export type CompletionOutcome =
  | { readonly status: "accepted"; readonly receipt_id: string }
  | { readonly status: "human_authorization_required" }
  | { readonly status: "invalid_outputs"; readonly diagnostics: readonly string[] }
  | { readonly status: "rejected"; readonly reason: string };

export type CompletionEmitter = (event: RunnerEventPhaseCompleted) => Promise<CompletionOutcome>;

export type SessionNameOutcome = {
  readonly status: "saved" | "unchanged";
  readonly value: { readonly name: string; readonly source: "auto" | "user" };
};
export type SessionNameEmitter = (event: RunnerEventSessionName) => Promise<SessionNameOutcome>;

interface RunnerConfig {
  readonly runnerPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly sessionNaming: boolean;
}

const RUNNER_ENV_NAMES = [
  "ALINERY_RUNNER_PATH",
  "ALINERY_SESSION_ID",
  "ALINERY_DAEMON_SOCKET",
  "ALINERY_DAEMON_NAMESPACE",
  "ALINERY_EVENT_PROTOCOL_VERSION",
  "ALINERY_EVENT_TOKEN",
] as const;

const HOST_ENV_NAME = "ALINERY_HOST_EXECUTABLE";
const PTY_PROMPT_ENV_NAME = "ALINERY_PTY_INITIAL_PROMPT";
const PROTECTED_PRODUCTION_SUFFIXES = ["/Alinery.app/Contents/MacOS/Alinery", "/alinery.app/Contents/MacOS/alinery"] as const;
export const HOST_GUARD_REASON =
  "Alinery blocks browser app.path from targeting the host or an installed Alinery app. Use ordinary browser mode, app.cdp_url, the browser relay, or native computer automation.";
const AT_PREFIXES = ["agent://", "artifact://", "skill://", "rule://", "security://", "mcp://"] as const;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const INTERNAL_URL_PREFIXES = ["agent://", "artifact://", "skill://", "rule://", "security://", "local://", "mcp://", "ssh://", "vault://"] as const;

export function captureProtectedHost(environment: Record<string, string | undefined> = process.env): string | undefined {
  const host = environment[HOST_ENV_NAME];
  delete environment[HOST_ENV_NAME];
  return host;
}

export function captureInitialPtyPrompt(environment: Record<string, string | undefined> = process.env): string | undefined {
  const prompt = environment[PTY_PROMPT_ENV_NAME];
  delete environment[PTY_PROMPT_ENV_NAME];
  return prompt || undefined;
}

function normalizeAtPrefix(filePath: string): string {
  if (!filePath.startsWith("@")) return filePath;
  const withoutAt = filePath.slice(1);
  if (
    withoutAt.startsWith("/") ||
    withoutAt === "~" ||
    withoutAt.startsWith("~/") ||
    path.win32.isAbsolute(withoutAt) ||
    AT_PREFIXES.some((prefix) => withoutAt.startsWith(prefix)) ||
    withoutAt.startsWith("local:")
  ) {
    return withoutAt;
  }
  return filePath;
}

function stripFileUrl(filePath: string): string {
  if (!filePath.toLowerCase().startsWith("file://")) return filePath;
  return fileURLToPath(filePath);
}

function expandTilde(filePath: string): string {
  const home = os.homedir();
  if (filePath === "~") return home;
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) return home + filePath.slice(1);
  if (filePath.startsWith("~")) return path.join(home, filePath.slice(1));
  return filePath;
}

export function resolveOmpAppPath(requestedPath: string, cwd: string): string {
  const deColoned = /^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(requestedPath) ? requestedPath.slice(1) : requestedPath;
  const normalized = stripFileUrl(normalizeAtPrefix(deColoned).replace(UNICODE_SPACES, " "));
  const expanded = expandTilde(normalized);
  if (INTERNAL_URL_PREFIXES.some((prefix) => expanded.startsWith(prefix))) {
    throw new Error("internal URL is not a filesystem path");
  }
  if (/^\/+$/.test(expanded)) return cwd;
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export async function classifyBrowserOpen(input: unknown, cwd: string, protectedHost: string | undefined): Promise<ToolCallEventResult | undefined> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  if (fields.action !== "open" || typeof fields.app !== "object" || fields.app === null || Array.isArray(fields.app)) return undefined;
  const app = fields.app as Record<string, unknown>;
  if (typeof app.cdp_url === "string" && app.cdp_url.length > 0) return undefined;
  if (typeof app.path !== "string") return undefined;

  try {
    const target = await realpath(resolveOmpAppPath(app.path, cwd));
    if (target === protectedHost || PROTECTED_PRODUCTION_SUFFIXES.some((suffix) => target.endsWith(suffix))) {
      return { block: true, reason: HOST_GUARD_REASON };
    }
  } catch {
    // Best-effort guard: OMP retains its own error behavior for unresolved paths.
  }
  return undefined;
}

/**
 * Capture the launch-only transport state, then remove it from OMP's environment
 * so repository commands and tool subprocesses cannot inherit the event token.
 */
export function captureRunnerConfig(environment: Record<string, string | undefined> = process.env): RunnerConfig | undefined {
  const captured: Record<string, string | undefined> = {};
  const sessionNaming = environment.ALINERY_SESSION_NAMING === "1";
  delete environment.ALINERY_SESSION_NAMING;
  for (const name of RUNNER_ENV_NAMES) {
    captured[name] = environment[name];
    delete environment[name];
  }

  // Empty string is a valid namespace (production); only missing env is disqualifying.
  const runnerPath = captured.ALINERY_RUNNER_PATH;
  const sessionId = captured.ALINERY_SESSION_ID;
  const daemonSocket = captured.ALINERY_DAEMON_SOCKET;
  const daemonNamespace = captured.ALINERY_DAEMON_NAMESPACE;
  const eventProtocolVersion = captured.ALINERY_EVENT_PROTOCOL_VERSION;
  const eventToken = captured.ALINERY_EVENT_TOKEN;
  if (
    runnerPath === undefined ||
    sessionId === undefined ||
    daemonSocket === undefined ||
    daemonNamespace === undefined ||
    eventProtocolVersion === undefined ||
    eventToken === undefined
  ) {
    return undefined;
  }

  return {
    runnerPath,
    sessionNaming,
    environment: {
      ALINERY_SESSION_ID: sessionId,
      ALINERY_DAEMON_SOCKET: daemonSocket,
      ALINERY_DAEMON_NAMESPACE: daemonNamespace,
      ALINERY_EVENT_PROTOCOL_VERSION: eventProtocolVersion,
      ALINERY_EVENT_TOKEN: eventToken,
    },
  };
}

/** Production lifecycle emitter. Delivery remains terminal-silent and fail-open. */
export function makeProductionEmitter(config: RunnerConfig | undefined): Emitter {
  return async (event: RunnerEvent): Promise<void> => {
    if (!config) return;

    try {
      await new Promise<void>((resolve) => {
        const child = spawn(config.runnerPath, ["emit"], {
          stdio: ["pipe", "ignore", "ignore"],
          env: config.environment,
        });
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          resolve();
        };
        const watchdog = setTimeout(() => {
          child.kill();
          finish();
        }, 500);
        child.on("error", finish);
        child.on("exit", finish);
        try {
          // @types/node declares this callback as `() => void`, but node really does invoke
          // it with a write error. Declaring the parameter optional keeps the runtime
          // behaviour and satisfies the narrower published signature.
          child.stdin?.end(JSON.stringify(event), "utf8", (error?: Error | null) => {
            if (!error) return;
            child.kill();
            finish();
          });
        } catch {
          child.kill();
          finish();
        }
      });
    } catch {
      // Passive lifecycle reporting never breaks or writes into OMP's TUI.
    }
  };
}

/** Shared acknowledged transport; passive callbacks deliberately remain fail-open. */
async function emitAcknowledged(config: RunnerConfig | undefined, event: RunnerEvent): Promise<{ result: Record<string, unknown>; code: number | null }> {
  if (!config) throw new Error("runner transport unavailable");
  // The packaged extension targets ES2022, before Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const child = spawn(config.runnerPath, ["emit", "--result"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: config.environment,
    });
    let settled = false;
    let output = "";
    let outputBytes = 0;
    const fail = (error: unknown = new Error("runner delivery failed")) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(error instanceof Error ? error : new Error("runner delivery failed"));
    };
    const watchdog = setTimeout(() => {
      child.kill();
      fail(new Error("runner acknowledgement timed out"));
    }, 6_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > 64 * 1024) {
        child.kill();
        fail(new Error("runner acknowledgement exceeds 64 KiB"));
        return;
      }
      output += chunk;
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      try {
        if (!output.endsWith("\n")) throw new Error("runner acknowledgement is truncated");
        const result: unknown = JSON.parse(output);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid runner acknowledgement");
        settled = true;
        clearTimeout(watchdog);
        resolve({ result: result as Record<string, unknown>, code });
      } catch {
        fail(new Error("invalid runner acknowledgement"));
      }
    });
    child.stdin?.on("error", fail);
    child.stdout?.on("error", fail);
    try {
      child.stdin?.end(JSON.stringify(event), "utf8", (error?: Error | null) => {
        if (!error) return;
        child.kill();
        fail(error);
      });
    } catch {
      child.kill();
      fail();
    }
  });
}

export function makeProductionCompletionEmitter(config: RunnerConfig | undefined): CompletionEmitter {
  return async (event) => {
    const { result } = await emitAcknowledged(config, event);
    if (result.status === "accepted" && typeof result.receipt_id === "string" && result.receipt_id.length > 0) {
      return { status: "accepted", receipt_id: result.receipt_id };
    }
    if (result.status === "human_authorization_required") return { status: "human_authorization_required" };
    if (result.status === "invalid_outputs" && Array.isArray(result.diagnostics) && result.diagnostics.every((item) => typeof item === "string")) {
      return { status: "invalid_outputs", diagnostics: result.diagnostics };
    }
    if (result.status === "rejected" && typeof result.reason === "string" && result.reason.length > 0) {
      return { status: "rejected", reason: result.reason };
    }
    throw new Error("runner delivery failed");
  };
}

export function makeProductionSessionNameEmitter(config: RunnerConfig | undefined): SessionNameEmitter {
  return async (event) => {
    const { result, code } = await emitAcknowledged(config, event).catch(() => {
      throw new Error("Session name delivery failed");
    });
    if (result.status === "rejected" && typeof result.reason === "string") {
      throw new Error(`Session name rejected: ${result.reason.slice(0, 300)}`);
    }
    if (code !== 0 || (result.status !== "saved" && result.status !== "unchanged") || Object.keys(result).some((key) => key !== "status" && key !== "value")) {
      throw new Error("Session name delivery failed");
    }
    const value = result.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session name acknowledgement");
    const record = value as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      !record.name.trim() ||
      (record.source !== "auto" && record.source !== "user") ||
      Object.keys(record).some((key) => key !== "name" && key !== "source")
    ) {
      throw new Error("Invalid session name acknowledgement");
    }
    return { status: result.status, value: { name: record.name, source: record.source } };
  };
}

// ---------- callback registration ----------

/**
 * Register Alinery lifecycle callbacks and completion, approval, and eligible naming tools.
 * Exported for testability: tests supply a fake api and emitter.
 */
export function registerCallbacks(
  api: OmpExtensionAPI,
  emit: Emitter,
  emitCompletion: CompletionEmitter,
  protectedHost: string | undefined,
  initialPtyPrompt?: string,
  emitSessionName?: SessionNameEmitter,
): void {
  let shutdownSessionId: string | undefined;
  let pendingPtyPrompt = initialPtyPrompt;
  if (emitSessionName) {
    let named = false;
    api.on("before_agent_start", (payload) =>
      named
        ? undefined
        : {
            systemPrompt: [
              ...payload.systemPrompt,
              "As one of your first useful actions, identify this session's requested work and call alinery_set_session_name with a concise purpose-specific phrase. Read assigned ticket/context first if necessary; defer if intent is unknown, but do not wait until the work is finished. Prefer fewer than 30 characters; never exceed 40. Do not use a generic workflow/type label.",
            ],
          },
    );
    api.registerTool({
      name: "alinery_set_session_name",
      label: "Name session",
      description: "Suggest this session's short work name. An existing name, including a human correction, is preserved.",
      parameters: api.zod.z.object({ name: api.zod.z.string() }),
      async execute(_toolCallId, input) {
        if (typeof input.name !== "string") throw new Error("Session name must be text");
        const outcome = await emitSessionName({ type: "session_name_suggested", name: input.name });
        named = true;
        return { content: [{ type: "text", text: `Session name: ${outcome.value.name}` }], details: { ...outcome } };
      },
    });
  }
  api.on("session_start", async (_payload, context) => {
    shutdownSessionId = undefined;
    if (pendingPtyPrompt !== undefined) {
      if (!context.ui?.setEditorText) {
        await safeEmit(emit, { type: "adapter_error", detail: "OMP PTY editor is unavailable for initial prompt delivery" });
        return;
      }
      context.ui.setEditorText(pendingPtyPrompt);
      pendingPtyPrompt = undefined;
    }
    // Acknowledge only after the initial editor text is ready for the daemon's Enter.
    await safeEmit(emit, { type: "idle" });
  });

  // OMP's agent lifecycle hooks do not expose turn ids. The normalized field is
  // optional, so these callbacks report only the fact OMP actually provides.
  api.on("agent_start", async (_payload: OmpAgentStartPayload) => {
    await safeEmit(emit, { type: "busy" });
  });

  api.on("agent_end", async (payload: OmpAgentEndPayload) => {
    await safeEmit(emit, { type: payload.willContinue ? "busy" : "idle" });
  });

  // session_stop settles agent state only; it never implies phase completion.
  api.on("session_stop", async (payload: OmpSessionStopPayload, context: OmpExtensionContext) => {
    if (payload.session_id !== context.sessionManager.getSessionId()) return;
    await safeEmit(emit, {
      type: "idle",
      omp_turn_id: payload.turn_id,
    });
  });

  api.on("tool_approval_requested", async (payload: OmpToolApprovalRequestedPayload) => {
    if (!payload.toolCallId) return;
    await safeEmit(emit, {
      type: "waiting_for_approval",
      correlation_id: payload.toolCallId,
    });
  });

  api.on("tool_approval_resolved", async (payload: OmpToolApprovalResolvedPayload) => {
    if (!payload.toolCallId) return;
    await safeEmit(emit, {
      type: "busy",
      correlation_id: payload.toolCallId,
    });
  });

  api.on("tool_call", async (payload: OmpToolCallPayload, context: OmpExtensionContext) => {
    if (payload.toolName === "ask" && payload.toolCallId) {
      await safeEmit(emit, {
        type: "waiting_for_input",
        correlation_id: payload.toolCallId,
      });
      return;
    }
    if (payload.toolName === "browser") {
      return classifyBrowserOpen(payload.input, context.cwd, protectedHost);
    }
  });

  api.on("tool_result", async (payload: OmpToolResultPayload) => {
    if (payload.toolName !== "ask" || !payload.toolCallId) return;
    await safeEmit(emit, {
      type: "busy",
      correlation_id: payload.toolCallId,
    });
  });

  // OMP 16.5 registers a complete ToolDefinition object. The empty zod object
  // prevents the model from supplying any alinery routing or artifact identity.
  api.registerTool({
    name: "alinery_phase_complete",
    label: "Complete Alinery Phase",
    description:
      "Signal that the current playbook phase is complete. " +
      "Finish every required output and handoff before calling. " +
      "If accepted, do no further work: ordinary OMP shutdown has been requested. " +
      "If authorization or output correction is required, keep the session open.",
    parameters: api.zod.z.object({}),
    async execute(toolCallId: string, _input: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, context: OmpExtensionContext) {
      const sessionId = context.sessionManager.getSessionId();
      if (!sessionId) {
        return completionToolResult(
          "delivery_failed",
          "Alinery could not confirm phase completion because the OMP session identity is unavailable. Retry after the session is ready.",
        );
      }

      let outcome: CompletionOutcome;
      try {
        outcome = await emitCompletion({
          type: "phase_completed",
          omp_session_id: sessionId,
        });
        if (outcome.status === "human_authorization_required") {
          const approval = await requestApproval(
            emit,
            toolCallId,
            context,
            "Allow this session to complete",
            "Allow this session to finish its current playbook step? Alinery will validate its required outputs before accepting completion. Deny keeps the session open.",
          );
          if (!approval.details.approved) {
            return completionToolResult(outcome.status, `${approval.content[0].text} Keep this session open.`);
          }
          // A UI response is not completion authority. Only the authenticated app can grant
          // permission; re-check with the daemon before requesting ordinary shutdown.
          outcome = await emitCompletion({ type: "phase_completed", omp_session_id: sessionId });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return completionToolResult("delivery_failed", `Alinery could not confirm phase completion: ${reason}. Retry after the Alinery daemon is available.`, { reason });
      }
      if (outcome.status === "accepted") {
        if (shutdownSessionId !== sessionId) {
          shutdownSessionId = sessionId;
          context.shutdown();
        }
        return completionToolResult("accepted", "Alinery accepted phase completion. Do no further work; this session is finishing.", { receipt_id: outcome.receipt_id });
      }
      if (outcome.status === "human_authorization_required") {
        return completionToolResult(
          outcome.status,
          "Completion permission is still locked. Use Alinery's task execution controls to grant permission, then retry. Keep this session open.",
        );
      }
      if (outcome.status === "invalid_outputs") {
        return completionToolResult(
          outcome.status,
          `Required outputs need correction:\n${outcome.diagnostics.join("\n")}\nCorrect them before calling alinery_phase_complete again.`,
          {
            diagnostics: outcome.diagnostics,
          },
        );
      }
      return completionToolResult("rejected", `Alinery rejected phase completion: ${outcome.reason}. Keep this session open and resolve the ownership or protocol error.`, {
        reason: outcome.reason,
      });
    },
  });

  api.registerTool({
    name: "alinery_ask_approval",
    label: "Ask for approval",
    description:
      "Request an explicit Allow/Deny for a binary go/no-go, especially when checks failed or something is blocked. " +
      "Do not use this instead of fixing issues the agent can fix itself. Do not dump a table as the question. " +
      "After Deny or unavailable approval, do not proceed with the gated action. For multi-option questions use ask. " +
      "Before alinery_save_playbook, review the complete source with the user and request approval for that exact source and " +
      "destination (scope and key), explicitly stating create versus replace. Recommend global scope unless repo-local is intended. " +
      "Material source or destination changes require renewed approval. This is an agent-followed gate, not a backend approval receipt.",
    parameters: api.zod.z.object({ title: api.zod.z.string(), message: api.zod.z.string() }),
    async execute(toolCallId: string, input: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, context: OmpExtensionContext) {
      const title = typeof input.title === "string" && input.title !== "" ? input.title : "Approval required";
      const message = typeof input.message === "string" && input.message !== "" ? input.message : "Approval needed.";
      return requestApproval(emit, toolCallId, context, title, message);
    },
  });
}

async function requestApproval(emit: Emitter, toolCallId: string, context: OmpExtensionContext, title: string, message: string) {
  const ui = context.ui;
  if (context.hasUI === false || typeof ui?.confirm !== "function") {
    return {
      content: [{ type: "text" as const, text: "Approval UI is unavailable. Do not proceed with the gated action." }],
      details: { approved: false, status: "unavailable" },
    };
  }
  await safeEmit(emit, { type: "waiting_for_approval", correlation_id: toolCallId });
  try {
    // RPC UI methods use instance state; never detach confirm from its receiver.
    const ok = await ui.confirm(title, message);
    // The native Allow button sends true; no other (even truthy) response grants approval.
    return {
      content: [{ type: "text" as const, text: ok === true ? "User approved. You may proceed with the gated action." : "User denied. Do not proceed with the gated action." }],
      details: { approved: ok === true },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Approval UI is unavailable: ${reason}. Do not proceed with the gated action.` }],
      details: { approved: false, status: "unavailable" },
    };
  } finally {
    await safeEmit(emit, { type: "busy", correlation_id: toolCallId });
  }
}

// ---------- fail-open wrapper ----------

/** Invoke emit; swallow all errors and promise rejections. */
async function safeEmit(emit: Emitter, event: RunnerEvent): Promise<void> {
  try {
    await emit(event);
  } catch {
    // Delivery failure is silently discarded; callback settles normally.
  }
}

function completionToolResult(status: CompletionOutcome["status"] | "delivery_failed", text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details: { status, ...details },
  };
}

// When OMP initializes this run-local extension, capture and scrub the inherited
// transport credential before any repository tool subprocess can inherit it.
export default function (api: OmpExtensionAPI): void {
  const protectedHost = captureProtectedHost();
  const initialPtyPrompt = captureInitialPtyPrompt();
  const config = captureRunnerConfig();
  registerCallbacks(
    api,
    makeProductionEmitter(config),
    makeProductionCompletionEmitter(config),
    protectedHost,
    initialPtyPrompt,
    config?.sessionNaming ? makeProductionSessionNameEmitter(config) : undefined,
  );
}
