// OMP run-local extension for Alinery.
//
// Injected at session startup via --extension <path>. Registers OMP lifecycle
// callbacks and the alinery_phase_complete tool. Passive callbacks emit one
// normalized RunnerEvent with bounded, terminal-silent, fail-open delivery.
// Phase completion preserves the daemon acknowledgement and reports accepted,
// rejected, or delivery-failed status to the OMP model.
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
//   ALINERY_EVENT_PROTOCOL_VERSION   "1"
//   ALINERY_EVENT_TOKEN              per-session secret token
//   ALINERY_HOST_EXECUTABLE          canonical host app executable (launch-only)

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
  readonly sessionManager: {
    getSessionId(): string;
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
    input: Record<string, never>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: OmpExtensionContext,
  ): Promise<{
    // The only implementation (alinery_phase_complete) returns a one-element array and a
    // details object carrying {status, reason?}. The previous declaration said
    // `readonly [..]` and `Record<string, never>` — a fixed 1-tuple and an object with no
    // properties permitted — which described neither. Nothing caught it because this file
    // was outside every tsconfig until now.
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
    };
  };
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

type RunnerEvent = RunnerEventBusy | RunnerEventIdle | RunnerEventWaitingForInput | RunnerEventWaitingForApproval | RunnerEventPhaseCompleted | RunnerEventAdapterError;

// ---------- emitter ----------

export type Emitter = (event: RunnerEvent) => Promise<void>;

export type CompletionOutcome = { readonly status: "accepted" } | { readonly status: "rejected"; readonly reason: string };

export type CompletionEmitter = (event: RunnerEventPhaseCompleted) => Promise<CompletionOutcome>;

interface RunnerConfig {
  readonly runnerPath: string;
  readonly environment: Readonly<Record<string, string>>;
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

/**
 * Production completion emitter. Unlike passive lifecycle reporting, this path
 * requires and parses the daemon acknowledgement so the model can repair/retry.
 */
export function makeProductionCompletionEmitter(config: RunnerConfig | undefined): CompletionEmitter {
  return async (event: RunnerEventPhaseCompleted): Promise<CompletionOutcome> => {
    if (!config) throw new Error("runner transport unavailable");

    return new Promise<CompletionOutcome>((resolve, reject) => {
      const child = spawn(config.runnerPath, ["emit", "--result"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: config.environment,
      });
      let settled = false;
      let output = "";
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        reject(new Error("runner delivery failed"));
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        try {
          const result = JSON.parse(output) as {
            status?: unknown;
            reason?: unknown;
          };
          if (result.status === "accepted") {
            resolve({ status: "accepted" });
          } else if (result.status === "rejected" && typeof result.reason === "string" && result.reason.length > 0) {
            resolve({ status: "rejected", reason: result.reason });
          } else {
            reject(new Error("runner delivery failed"));
          }
        } catch {
          reject(new Error("runner delivery failed"));
        }
      };
      const watchdog = setTimeout(() => {
        child.kill();
        fail();
      }, 500);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        output += chunk;
        if (output.length > 4096) {
          child.kill();
          fail();
        }
      });
      child.on("error", fail);
      child.on("close", finish);
      try {
        // @types/node declares this callback as `() => void`, but node really does invoke
        // it with a write error. Declaring the parameter optional keeps the runtime
        // behaviour and satisfies the narrower published signature.
        child.stdin?.end(JSON.stringify(event), "utf8", (error?: Error | null) => {
          if (!error) return;
          child.kill();
          fail();
        });
      } catch {
        child.kill();
        fail();
      }
    });
  };
}

// ---------- callback registration ----------

/**
 * Register all Alinery OMP callbacks and the alinery_phase_complete tool against api.
 * Exported for testability: tests supply a fake api and emitter.
 */
export function registerCallbacks(api: OmpExtensionAPI, emit: Emitter, emitCompletion: CompletionEmitter, protectedHost: string | undefined): void {
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
      "Call this exactly once after the required artifact has been written. " +
      "Do not call this to end a turn — only when the phase deliverable is finished.",
    parameters: api.zod.z.object({}),
    async execute(_toolCallId: string, _input: Record<string, never>, _signal: AbortSignal | undefined, _onUpdate: unknown, context: OmpExtensionContext) {
      const sessionId = context.sessionManager.getSessionId();
      if (!sessionId) {
        return completionToolResult(
          "delivery_failed",
          "Alinery could not confirm phase completion because the OMP session identity is unavailable. Retry after the session is ready.",
        );
      }

      try {
        const outcome = await emitCompletion({
          type: "phase_completed",
          omp_session_id: sessionId,
        });
        if (outcome.status === "accepted") {
          return completionToolResult("accepted", "Alinery accepted phase completion.");
        }

        const reason = outcome.reason.replace(/^completion-rejected:/, "");
        return completionToolResult(
          "rejected",
          `Alinery rejected phase completion: ${reason}. Fix the required artifact or session ownership, then call alinery_phase_complete again.`,
          outcome.reason,
        );
      } catch {
        return completionToolResult(
          "delivery_failed",
          "Alinery could not confirm phase completion because delivery failed. Retry alinery_phase_complete after the Alinery daemon is available.",
        );
      }
    },
  });
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

function completionToolResult(status: "accepted" | "rejected" | "delivery_failed", text: string, reason?: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: reason ? { status, reason } : { status },
  };
}

// When OMP initializes this run-local extension, capture and scrub the inherited
// transport credential before any repository tool subprocess can inherit it.
export default function (api: OmpExtensionAPI): void {
  const protectedHost = captureProtectedHost();
  const config = captureRunnerConfig();
  registerCallbacks(api, makeProductionEmitter(config), makeProductionCompletionEmitter(config), protectedHost);
}
