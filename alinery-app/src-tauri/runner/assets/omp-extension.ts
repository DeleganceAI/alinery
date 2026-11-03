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
//   ALINERY_SESSION_NAMING          "1": task session names itself via a tool; "chat": chat thread
//                                   is titled at turn ends (launch-only)

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
    // Absent on older OMP; chat titling then quietly does nothing.
    getBranch?(): readonly { readonly type?: string; readonly message?: { readonly role?: string } }[];
  };
  // OMP 18.3+. A side turn on the active model that never enters session history.
  runEphemeralTurn?(options: { readonly promptText: string; readonly tools?: boolean; readonly signal?: AbortSignal }): Promise<{ readonly replyText: string }>;
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
  // The turn's messages; the assistant tail carries stopReason/errorMessage when OMP gave up.
  readonly messages?: readonly { readonly role?: string; readonly stopReason?: string; readonly errorMessage?: string }[];
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
  readonly pi?: { readonly AgentSession?: { readonly prototype: object } };
  getAllTools?(): readonly { readonly name: string; readonly sourceInfo?: { readonly source?: string } }[];
  readonly zod: {
    readonly z: {
      object(shape: OmpToolParameters): unknown;
      string(): unknown;
    };
  };
  on(event: "session_start", handler: (payload: unknown, context: OmpExtensionContext) => void | Promise<void>): void;
  on(event: "session_before_switch" | "session_shutdown", handler: (payload: unknown, context: OmpExtensionContext) => void | Promise<void>): void;
  on(event: "before_agent_start", handler: (payload: { readonly systemPrompt: readonly string[] }) => { systemPrompt: string[] } | undefined): void;
  on(event: "agent_start", handler: (payload: OmpAgentStartPayload) => void | Promise<void>): void;
  on(event: "agent_end", handler: (payload: OmpAgentEndPayload, context: OmpExtensionContext) => void | Promise<void>): void;
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
type RunnerEventContinuation =
  | {
      readonly type: "continuation_bind";
      readonly omp_session_id: string;
      readonly groups: readonly string[];
      readonly operation_id: string;
      readonly expected_capability_revision: number;
    }
  | { readonly type: "continuation_poll"; readonly process_incarnation?: string }
  | {
      readonly type: "continuation_revoke";
      readonly process_incarnation: string;
      readonly operation_id: string;
      readonly expected_capability_revision: number;
      readonly reason: string;
    }
  | {
      readonly type: "native_work_entered";
      readonly process_incarnation: string;
      readonly operation_id: string;
      readonly dispatch_id?: string;
      readonly dispatch_proof?: string;
      readonly parent_operation_id?: string;
    }
  | { readonly type: "native_work_settled"; readonly process_incarnation: string; readonly operation_id: string }
  | { readonly type: "native_dispatch_consumed"; readonly process_incarnation: string; readonly dispatch_id: string }
  | { readonly type: "native_dispatch_transferred"; readonly process_incarnation: string; readonly dispatch_id: string; readonly replacement_dispatch_id: string }
  | { readonly type: "native_dispatch_rejected"; readonly process_incarnation: string; readonly dispatch_id: string; readonly reason: string };
type RunnerEventCompletion =
  | { readonly type: "readiness_reported"; readonly process_incarnation: string; readonly expected_work_revision: number }
  | { readonly type: "continuation_finalize"; readonly process_incarnation: string; readonly ready_revision: number };
type RunnerEventAdapterError = {
  readonly type: "adapter_error";
  readonly detail: string;
};
type RunnerEventTurnError = {
  readonly type: "turn_error";
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
  | RunnerEventContinuation
  | RunnerEventCompletion
  | RunnerEventAdapterError
  | RunnerEventTurnError
  | RunnerEventSessionName;

// ---------- emitter ----------

export type Emitter = (event: RunnerEvent) => Promise<void>;

export type CompletionOutcome =
  | { readonly status: "accepted"; readonly receipt_id: string }
  | { readonly status: "ready"; readonly ready_revision: number }
  | { readonly status: "requested"; readonly ready_revision: number }
  | { readonly status: "waiting"; readonly reason: string }
  | { readonly status: "stale"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "invalid_outputs"; readonly diagnostics: readonly string[] };

export type CompletionEmitter = (event: RunnerEventCompletion, signal?: AbortSignal, onRetry?: (reason: string) => void) => Promise<CompletionOutcome>;

export interface ContinuationControl {
  readonly process_incarnation: string;
  readonly capability_revision: number;
  readonly work_revision: number;
  readonly continuation_requested_revision: number | null;
  readonly available: boolean;
  readonly reason: string | null;
}
type ControlEmitter = (event: RunnerEventContinuation) => Promise<ContinuationControl | Extract<CompletionOutcome, { readonly status: "accepted" }>>;

export type SessionNameOutcome = {
  readonly status: "saved" | "unchanged";
  readonly value: { readonly name: string; readonly source: "auto" | "user" };
};
export type SessionNameEmitter = (event: RunnerEventSessionName) => Promise<SessionNameOutcome>;

interface RunnerConfig {
  readonly runnerPath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly sessionNaming: boolean;
  readonly chatNaming: boolean;
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
  const chatNaming = environment.ALINERY_SESSION_NAMING === "chat";
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
    chatNaming,
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
async function emitAcknowledged(config: RunnerConfig | undefined, event: RunnerEvent, signal?: AbortSignal): Promise<{ result: Record<string, unknown>; code: number | null }> {
  if (!config) throw new Error("runner transport unavailable");
  // The packaged extension targets ES2022, before Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const child = spawn(config.runnerPath, ["emit", "--result"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: config.environment,
      signal,
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

// Storage availability failures are not ownership/output rejections. In particular,
// a parent-sync failure can leave the immutable receipt already committed.
const RETRYABLE_COMPLETION_REJECTIONS = [
  "completion-in-progress",
  "task mutation busy during ",
  "task execution state unavailable (pre-v2 tasks cannot launch): ",
  "read retained task definition: ",
  "create durable parent: ",
  "create durable temporary file: ",
  "write durable temporary file: ",
  "sync durable temporary file: ",
  "rename durable file: ",
  "ambiguous persistence after rename of ",
  "ambiguous persistence after execution replay: ",
] as const;

export function makeProductionCompletionEmitter(config: RunnerConfig | undefined): CompletionEmitter {
  return async (event, signal, onRetry) => {
    // Re-send the same authenticated identity: a committed completion replays its
    // immutable receipt if the acknowledgement was lost. Never retry semantic gates.
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const { result } = await emitAcknowledged(config, event, signal);
        if (result.status === "accepted" && typeof result.receipt_id === "string" && result.receipt_id.length > 0) {
          return { status: "accepted", receipt_id: result.receipt_id };
        }
        if ((result.status === "ready" || result.status === "requested") && Number.isSafeInteger(result.ready_revision) && (result.ready_revision as number) >= 0) {
          return { status: result.status, ready_revision: result.ready_revision as number };
        }
        if ((result.status === "waiting" || result.status === "stale" || result.status === "unavailable") && typeof result.reason === "string" && result.reason.length > 0) {
          return { status: result.status, reason: result.reason };
        }
        if (result.status === "invalid_outputs" && Array.isArray(result.diagnostics) && result.diagnostics.every((item) => typeof item === "string")) {
          return { status: "invalid_outputs", diagnostics: result.diagnostics };
        }
        if (result.status === "rejected" && typeof result.reason === "string" && result.reason.length > 0) {
          const reason = result.reason;
          if (!RETRYABLE_COMPLETION_REJECTIONS.some((prefix) => reason.startsWith(prefix))) return { status: "unavailable", reason };
          throw new Error(result.reason);
        }
        throw new Error("runner delivery failed");
      } catch (error) {
        signal?.throwIfAborted();
        // Missing installation/configuration cannot recover by replaying. Transport
        // outages remain pending until accepted, semantically rejected, or cancelled.
        if (!config || (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES"))) throw error;
        try {
          onRetry?.(error instanceof Error ? error.message : String(error));
        } catch {
          // An observer cannot abandon an unresolved completion obligation.
        }
        await delay(250 * 2 ** Math.min(attempt, 4), undefined, { signal });
      }
    }
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

// ---------- chat thread titles ----------

const CHAT_TITLE_PROMPT =
  "Give this conversation a short title that says what it is about, in the user's language. At most 40 characters; fewer than 30 is better. " +
  "Reply with only the title: no quotes, no markdown, no trailing punctuation, no prefix.";

/** Titles come after the first user message, then every 10th (10, 20, 30, ...). */
export function chatTitleBucket(userMessages: number): number {
  return userMessages >= 10 ? Math.floor(userMessages / 10) * 10 : userMessages >= 1 ? 1 : 0;
}

/** First line of the reply, stripped of quoting and markup, cut to 40 characters on a word edge. */
export function cleanChatTitle(reply: string): string {
  const line = (reply.split("\n").find((candidate) => candidate.trim() !== "") ?? "")
    .replace(/^\s*(title\s*:\s*)/i, "")
    .replace(/^[\s"'`*_#>-]+|[\s"'`*_.]+$/g, "")
    .replace(/\s+/g, " ");
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  // A word that ends exactly at the limit is kept whole.
  const edge = line[40] === " " ? 40 : cut.lastIndexOf(" ");
  return (edge >= 20 ? cut.slice(0, edge) : cut).trim();
}

function userMessageCount(context: OmpExtensionContext): number | undefined {
  const branch = context.sessionManager.getBranch?.();
  if (!Array.isArray(branch)) return undefined;
  return branch.filter((entry) => entry?.type === "message" && entry.message?.role === "user").length;
}

/**
 * Chat threads are titled by the thread's own model through an ephemeral side turn, so the cost
 * lands on the model the user already picked. Everything is best effort: a missing OMP API, a
 * failed turn, or a refused write leaves the old title and tries again at the next turn end.
 * A human rename is protected by the daemon, not here.
 */
function makeChatTitler(emitTitle: SessionNameEmitter) {
  let titledBucket = 0;
  let inFlight = false;
  return {
    // A resumed thread has already had the titles its history earned.
    start(context: OmpExtensionContext): void {
      titledBucket = chatTitleBucket(userMessageCount(context) ?? 0);
    },
    async maybeTitle(context: OmpExtensionContext): Promise<void> {
      if (inFlight || typeof context.runEphemeralTurn !== "function") return;
      const bucket = chatTitleBucket(userMessageCount(context) ?? 0);
      if (bucket === 0 || bucket === titledBucket) return;
      inFlight = true;
      try {
        // Some transports cannot drop their tool definitions; those refuse `tools: false`. The side turn
        // never runs tools, so asking again with them in the request only risks an empty reply.
        const reply = await context.runEphemeralTurn({ promptText: CHAT_TITLE_PROMPT, tools: false }).catch(() => context.runEphemeralTurn?.({ promptText: CHAT_TITLE_PROMPT }));
        const name = cleanChatTitle(reply?.replyText ?? "");
        if (!name) return;
        await emitTitle({ type: "session_name_suggested", name });
        titledBucket = bucket;
      } catch {
        // Retried at the next turn end while the bucket stays untitled.
      } finally {
        inFlight = false;
      }
    },
  };
}

export class NativeControlRejected extends Error {}

export function makeProductionControlEmitter(config: RunnerConfig | undefined): ControlEmitter {
  return async (event) => {
    if (!config) throw new Error("Runner transport unavailable");
    for (let attempt = 0; ; attempt++) {
      const delivered = await emitAcknowledged(config, event).catch((error) => {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES")) throw error;
        return undefined;
      });
      if (delivered) {
        const { result, code } = delivered;
        if (
          (event.type === "continuation_revoke" || (event.type === "continuation_poll" && event.process_incarnation !== undefined)) &&
          code === 0 &&
          result.status === "accepted" &&
          typeof result.receipt_id === "string" &&
          result.receipt_id.trim() &&
          Object.keys(result).length === 2
        ) {
          return { status: "accepted", receipt_id: result.receipt_id };
        }
        if (
          result.status === "rejected" &&
          typeof result.reason === "string" &&
          result.reason.trim().length > 0 &&
          !(
            (event.type === "continuation_bind" || (event.type === "continuation_poll" && event.process_incarnation === undefined)) &&
            (result.reason === "execution process capture pending" || result.reason === "unknown-session")
          ) &&
          !RETRYABLE_COMPLETION_REJECTIONS.some((prefix) => (result.reason as string).startsWith(prefix))
        ) {
          throw new NativeControlRejected(result.reason);
        }
        if (
          code === 0 &&
          typeof result.process_incarnation === "string" &&
          result.process_incarnation &&
          Number.isSafeInteger(result.capability_revision) &&
          (result.capability_revision as number) >= 0 &&
          Number.isSafeInteger(result.work_revision) &&
          (result.work_revision as number) >= 0 &&
          typeof result.available === "boolean" &&
          (result.continuation_requested_revision === null ||
            (Number.isSafeInteger(result.continuation_requested_revision) && (result.continuation_requested_revision as number) >= 0)) &&
          (result.reason === null || typeof result.reason === "string")
        ) {
          return result as unknown as ContinuationControl;
        }
      }
      // Replay exactly this native identity; an uncertain ACK never authorizes
      // effects or implies settlement. The attempt budget is deliberately unbounded.
      await delay(250 * 2 ** Math.min(attempt, 4));
    }
  };
}

type NativeMethod = (...args: unknown[]) => unknown;
interface NativeAgent {
  [name: string]: unknown;
  subscribe(callback: (event: { type: string; message?: object }) => void): () => void;
  addBeforeQueuedMessageDequeueHook(callback: () => Promise<void>): () => void;
  peekSteeringQueue(): readonly object[];
  peekFollowUpQueue(): readonly object[];
  waitForIdle(): Promise<void>;
  replaceQueues(steering: readonly object[], followUp: readonly object[]): void;
}
interface NativeTool {
  readonly name: string;
  execute: NativeMethod;
}
interface NativeSession {
  [name: string]: unknown;
  readonly sessionManager: OmpExtensionContext["sessionManager"];
  readonly agent: NativeAgent;
  readonly yieldQueue?: { drainLazy(): NativeMethod[] };
  readonly asyncJobManager?: {
    register: NativeMethod;
    getJob(id: string): { readonly promise: Promise<void>; readonly ownerId?: string; readonly status: string } | undefined;
    drainDeliveries(options: { filter: { ownerId: string } }): Promise<boolean>;
    isDeliverySuppressed(id: string): boolean;
  };
  getToolByName(name: string): NativeTool | undefined;
  hasBuiltInTool(name: string): boolean;
}
interface NativeOperation {
  readonly id: string;
  readonly dispatch?: string;
  readonly entered: Promise<void>;
  readonly parent?: NativeOperation;
  settling?: boolean;
  pending: number;
  returned: boolean;
  queuedUser?: object;
  consumed?: boolean;
  transfers?: NativeOperation[];
  returnWaiters?: (() => void)[];
}
interface SelectedJob {
  readonly id: string;
  readonly operation: NativeOperation;
  readonly runs: WeakSet<Promise<unknown>>;
  seenMessage: boolean;
  producerSettled: boolean;
  activeRuns: number;
}
interface NativeRunScope {
  owner?: NativeOperation;
  held?: NativeOperation;
  plain: boolean;
  closed?: boolean;
}

// This is a public getter decoration, not a guessed/global "latest session".
// Each factory registers its own manager map; one descriptor survives factory reuse.
const receiverBindings = new WeakMap<object, Set<WeakMap<object, NativeSession>>>();
function bindPrimaryReceivers(api: OmpExtensionAPI): WeakMap<object, NativeSession> {
  const receivers = new WeakMap<object, NativeSession>();
  const prototype = api.pi?.AgentSession?.prototype;
  if (!prototype) throw new Error("Primary control unavailable: public AgentSession prototype is missing");
  let maps = receiverBindings.get(prototype);
  if (!maps) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "extensionRunner");
    if (!descriptor?.get || !descriptor.configurable) throw new Error("Primary control unavailable: public extensionRunner getter cannot be decorated");
    maps = new Set();
    const bindings = maps;
    Object.defineProperty(prototype, "extensionRunner", {
      ...descriptor,
      get(this: NativeSession) {
        const result = descriptor.get?.call(this);
        for (const map of bindings) map.set(this.sessionManager, this);
        return result;
      },
    });
    receiverBindings.set(prototype, maps);
  }
  maps.add(receivers);
  return receivers;
}

export const SELECTED_SESSION_METHODS = [
  "prompt",
  "steer",
  "followUp",
  "sendUserMessage",
  "promptCustomMessage",
  "compact",
  "shake",
  "dropImages",
  "runIdleCompaction",
  "setModel",
  "abort",
] as const;

export class NativeContinuation {
  private readonly scope = new AsyncLocalStorage<NativeOperation | NativeRunScope>();
  private readonly operations = new Map<string, NativeOperation>();
  private readonly queued = new Map<object, NativeOperation>();
  private readonly immediate = new Map<object, NativeOperation>();
  private readonly selectedJobs = new Map<string, SelectedJob>();
  private nativeTools = new Map<string, { tool: NativeTool; execute: NativeMethod }>();
  private readonly nativeDecorations = new WeakMap<NativeTool, NativeMethod>();
  private modelChanges = 0;
  private readonly receivers?: WeakMap<object, NativeSession>;
  private control?: ContinuationControl;
  private processIncarnation?: string;
  private bootstrapRevision?: number;
  private bindingRevision?: number;
  private lifecycle: Promise<void> = Promise.resolve();
  private lifecycleToken = 0;
  private revocation?: Promise<void>;
  private plainReview = false;
  private context?: OmpExtensionContext;
  private session?: NativeSession;
  private boundSessionId?: string;
  private failure?: string;
  private requestedReady = false;
  private reviewReadyRevision?: number;
  private fenced = false;
  private accepted = false;
  private driving?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly api: OmpExtensionAPI,
    private readonly emitControl: ControlEmitter,
    private readonly emitCompletion: CompletionEmitter,
  ) {
    try {
      this.receivers = bindPrimaryReceivers(api);
    } catch (error) {
      this.failure = String(error);
    }
  }

  get unavailableReason(): string | undefined {
    return this.failure;
  }

  private decorate(target: object, name: string, value: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    Object.defineProperty(target, name, { configurable: true, writable: true, value });
    this.disposers.push(() => {
      if (Reflect.get(target, name) !== value) return;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    });
  }

  async invalidate(reason: string): Promise<void> {
    this.failure = reason;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.accepted) {
      this.fenced = true;
      return;
    }
    if (this.revocation) return this.revocation;
    if (this.plainReview) {
      this.disposeRevokedIfSettled();
      return;
    }
    this.fenced = true;
    const token = ++this.lifecycleToken;
    const work = this.lifecycle.then(() => this.revokeNow(reason, token));
    this.revocation = work;
    this.lifecycle = work.catch(() => undefined);
    try {
      await work;
    } finally {
      if (this.revocation === work) this.revocation = undefined;
    }
  }

  private async revokeNow(reason: string, token: number): Promise<void> {
    reason = reason.trim() ? reason : "Native continuation capability is unavailable";
    this.failure = reason;
    this.fenced = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.accepted) return;
    const incarnation = this.processIncarnation;
    const expected = this.bindingRevision ?? this.bootstrapRevision;
    if (!incarnation || expected === undefined) {
      // This instance never obtained a binding; it cannot have granted readiness.
      this.plainReview = true;
      this.fenced = false;
      this.disposeRevokedIfSettled();
      return;
    }
    const event: RunnerEventContinuation = {
      type: "continuation_revoke",
      process_incarnation: incarnation,
      operation_id: randomUUID(),
      expected_capability_revision: expected,
      reason,
    };
    try {
      const outcome = await this.emitControl(event);
      if ("status" in outcome) {
        this.handleOutcome(outcome);
        return;
      }
      this.rememberControl(outcome);
      if (outcome.capability_revision === expected + 1) this.bindingRevision = outcome.capability_revision;
      if (
        token === this.lifecycleToken &&
        outcome.capability_revision === expected + 1 &&
        this.control?.capability_revision === outcome.capability_revision &&
        !outcome.available &&
        outcome.continuation_requested_revision === null
      ) {
        this.plainReview = true;
        this.fenced = false;
        this.requestedReady = false;
        this.reviewReadyRevision = undefined;
        this.disposeRevokedIfSettled();
        return;
      }
    } catch {
      // A lost or rejected revoke never proves that Continue/acceptance lost.
    }
    try {
      const current = await this.emitControl({ type: "continuation_poll", process_incarnation: incarnation });
      if ("status" in current) this.handleOutcome(current);
      else this.rememberControl(current);
    } catch {
      /* Remain fenced until authority can be reconciled. */
    }
  }

  private disposeRevokedIfSettled(): void {
    if (!this.plainReview || this.accepted || this.operations.size || this.selectedJobs.size || this.queued.size || this.immediate.size) return;
    for (const dispose of this.disposers.splice(0).reverse()) dispose();
  }

  private rememberControl(control: ContinuationControl): void {
    if (this.processIncarnation && control.process_incarnation !== this.processIncarnation) throw new Error("Continuation process incarnation changed");
    const previous = this.control;
    if (
      previous &&
      (control.capability_revision < previous.capability_revision ||
        control.work_revision < previous.work_revision ||
        (control.capability_revision === previous.capability_revision &&
          control.work_revision === previous.work_revision &&
          previous.continuation_requested_revision !== null &&
          control.continuation_requested_revision === null))
    )
      return;
    this.control = control;
    if (this.reviewReadyRevision !== undefined && (!control.available || control.work_revision !== this.reviewReadyRevision)) {
      // Settlement invalidates the snapshot, not the agent's request to finish.
      // A new review clears both fields before admission instead.
      if (control.available && control.work_revision !== this.reviewReadyRevision) this.requestedReady = true;
      this.reviewReadyRevision = undefined;
    }
  }

  async bind(context: OmpExtensionContext): Promise<void> {
    if (this.failure || this.accepted) return;
    const token = ++this.lifecycleToken;
    const work = this.lifecycle.then(async () => {
      try {
        await this.bindNow(context, token);
      } catch (error) {
        await this.revokeNow(error instanceof Error ? error.message : String(error), token);
      }
    });
    this.lifecycle = work.catch(() => undefined);
    await work;
  }

  private async bindNow(context: OmpExtensionContext, token: number): Promise<void> {
    this.context = context;
    if (this.failure) return;
    const session = this.receivers?.get(context.sessionManager);
    if (!session || session.sessionManager !== context.sessionManager) {
      this.failure = "Primary control unavailable: session_start did not match an actual public receiver";
      return;
    }
    if (this.session && (this.session !== session || this.boundSessionId !== context.sessionManager.getSessionId())) {
      await this.revokeNow("Primary control unavailable: replaced session requires a fresh extension binding", token);
      return;
    }
    if (this.session) return;
    const agent = session.agent;
    const manager = session.asyncJobManager;
    if (
      manager &&
      (typeof manager.register !== "function" ||
        typeof manager.getJob !== "function" ||
        typeof manager.drainDeliveries !== "function" ||
        typeof manager.isDeliverySuppressed !== "function" ||
        typeof session.yieldQueue?.drainLazy !== "function")
    ) {
      this.failure = "Selected native job delivery boundary is unavailable";
      return;
    }
    const required = [
      "prompt",
      "continue",
      "steer",
      "followUp",
      "subscribe",
      "addBeforeQueuedMessageDequeueHook",
      "peekSteeringQueue",
      "peekFollowUpQueue",
      "waitForIdle",
      "replaceQueues",
    ];
    if (
      SELECTED_SESSION_METHODS.some((name) => typeof session[name] !== "function") ||
      required.some((name) => typeof agent[name] !== "function") ||
      typeof session.hasBuiltInTool !== "function" ||
      !this.api.getAllTools
    ) {
      this.failure = "Selected public entry or native queue boundary is unavailable";
      return;
    }
    this.fenced = true;
    const bootstrap = await this.emitControl({ type: "continuation_poll" });
    if ("status" in bootstrap) throw new Error("Bootstrap polling cannot grant acceptance");
    if (this.processIncarnation && bootstrap.process_incarnation !== this.processIncarnation) throw new Error("Primary process incarnation changed");
    this.processIncarnation = bootstrap.process_incarnation;
    this.bootstrapRevision = bootstrap.capability_revision;
    this.rememberControl(bootstrap);
    if (token !== this.lifecycleToken) return;
    const current = await this.emitControl({ type: "continuation_poll", process_incarnation: this.incarnation() });
    if ("status" in current) {
      this.handleOutcome(current);
      return;
    }
    this.rememberControl(current);
    if (current.capability_revision !== bootstrap.capability_revision || current.continuation_requested_revision !== null) {
      throw new Error("Continuation capability or intent changed during binding");
    }
    if (token !== this.lifecycleToken) return;
    // Keep canonical native objects and their complete execution context intact.
    // Re-registration would mutate native SDK provenance and later tool mounting.
    // Custom/MCP work is covered only when entered through the selected session
    // boundaries (and exposed selected jobs), not as independent autonomous work.
    this.session = session;
    this.boundSessionId = context.sessionManager.getSessionId();
    this.refreshNativeTools();
    if (manager) {
      const register = manager.register;
      const controller = this;
      this.decorate(manager, "register", function (this: NonNullable<NativeSession["asyncJobManager"]>, ...args: unknown[]) {
        const operation = controller.activeScope();
        if (operation && controller.accepted) throw new Error("Session is finishing");
        const id = operation ? controller.scope.run(operation, () => Reflect.apply(register, this, args)) : Reflect.apply(register, this, args);
        if (operation && controller.operations.has(operation.id)) {
          operation.pending++;
          const job = typeof id === "string" ? this.getJob(id) : undefined;
          if (typeof id !== "string" || !job || typeof job.promise?.then !== "function") {
            controller.failure = `Selected native job ${String(id)} has no exposed settlement promise`;
          } else if (controller.selectedJobs.has(id)) {
            controller.failure = `Selected native job identity ${id} was reused before delivery settled`;
          } else {
            const selected: SelectedJob = { id, operation, runs: new WeakSet(), seenMessage: false, producerSettled: false, activeRuns: 0 };
            controller.selectedJobs.set(id, selected);
            // Producer settlement precedes the native foreground/background
            // decision; neither cancellation nor delivery intent clears its work.
            void job.promise
              .then(() =>
                controller.scope.run(operation, async () => {
                  if (!operation.returned)
                    await new Promise<void>((resolve) => {
                      operation.returnWaiters ??= [];
                      operation.returnWaiters.push(resolve);
                    });
                  if (job.status !== "cancelled" && !this.isDeliverySuppressed(id)) {
                    if (!job.ownerId) throw new Error(`Selected native job ${id} has no owner-scoped delivery barrier`);
                    const delivered = await this.drainDeliveries({ filter: { ownerId: job.ownerId } });
                    if (!delivered || (!selected.seenMessage && !this.isDeliverySuppressed(id))) {
                      throw new Error(`Selected native job ${id} has no proven native delivery consumption`);
                    }
                  }
                  selected.producerSettled = true;
                  if (selected.activeRuns === 0) controller.selectedJobs.delete(id);
                  operation.pending--;
                  await controller.settle(operation);
                }),
              )
              .catch((error) => {
                controller.failure = String(error);
              });
          }
        }
        return id;
      });
    }
    if (manager && session.yieldQueue) {
      const queue = session.yieldQueue;
      const drainLazy = queue.drainLazy;
      const controller = this;
      this.decorate(queue, "drainLazy", function (this: typeof queue) {
        const thunks = drainLazy.call(this);
        if (controller.selectedJobs.size === 0) return thunks;
        return thunks.map(
          (thunk) =>
            function (this: unknown, ...args: unknown[]) {
              const message = Reflect.apply(thunk, this, args);
              // Native prompt/continue establish this exact run promise before lazy
              // aside consumption. Observe the original result before native commit.
              const run = agent.waitForIdle();
              const jobs = controller.trackJobMessage(message, run);
              if (jobs) {
                void run.then(
                  () => controller.releaseJobRuns(jobs),
                  () => controller.releaseJobRuns(jobs),
                );
              }
              return message;
            },
        );
      });
    }
    for (const name of SELECTED_SESSION_METHODS) {
      const original = session[name] as NativeMethod;
      const controller = this;
      this.decorate(session, name, function (this: NativeSession, ...args: unknown[]) {
        return controller.invoke(original, this, args, name);
      });
    }
    const controller = this;
    for (const name of ["prompt", "continue"]) {
      const original = agent[name] as NativeMethod;
      this.decorate(agent, name, function (this: NativeAgent, ...args: unknown[]) {
        return controller.runAgent(original, this, args, name === "prompt");
      });
    }
    for (const name of ["steer", "followUp"]) {
      const original = agent[name] as NativeMethod;
      const controller = this;
      this.decorate(agent, name, function (this: NativeAgent, message: object) {
        let operation = controller.activeScope();
        if (controller.accepted || ((controller.fenced || (!controller.plainReview && controller.failure)) && !operation)) throw new Error("Session is finishing");
        if (!controller.control || (controller.plainReview && !operation)) return Reflect.apply(original, this, [message]);
        if (!controller.plainReview && !controller.revocation) controller.assertNativeTools();
        if (!operation) {
          operation = controller.enter();
          operation.returned = true;
        }
        if ("role" in message && message.role === "user") operation.queuedUser = message;
        if (!controller.queued.has(message)) {
          operation.pending++;
          controller.queued.set(message, operation);
        }
        return Reflect.apply(original, this, [message]);
      });
    }
    this.disposers.push(
      agent.addBeforeQueuedMessageDequeueHook(async () => {
        if (!this.control) return;
        this.assertNativeTools();
        for (const message of [...agent.peekSteeringQueue(), ...agent.peekFollowUpQueue()]) {
          const operation = this.queued.get(message);
          if (!operation) {
            if (this.plainReview) continue;
            throw new Error("Continuation unavailable: untracked selected native queue item");
          }
          this.adoptRunOwner(operation);
          await operation.entered;
        }
      }),
    );
    this.disposers.push(
      agent.subscribe((event) => {
        if (event.type !== "message_start" || !event.message) return;
        const operation = this.queued.get(event.message) ?? this.immediate.get(event.message);
        if (!operation) return;
        this.queued.delete(event.message);
        this.immediate.delete(event.message);
        // The exact native object was consumed. Cancellation does not settle its run.
        // Capture the actual current run before awaiting transport; a later run
        // must not accidentally become this item's settlement evidence.
        const settlement = agent.waitForIdle();
        const consumedDispatch = operation.dispatch && operation.queuedUser === event.message && !operation.consumed ? operation.dispatch : undefined;
        if (consumedDispatch) operation.consumed = true;
        void (async () => {
          await operation.entered;
          if (consumedDispatch) await this.send({ type: "native_dispatch_consumed", process_incarnation: this.incarnation(), dispatch_id: consumedDispatch });
          await settlement;
          operation.pending--;
          await this.settle(operation);
        })().catch((error) => {
          this.failure = String(error);
        });
      }),
    );
    this.assertNativeTools();
    if (token !== this.lifecycleToken) return;
    const control = await this.emitControl({
      type: "continuation_bind",
      omp_session_id: context.sessionManager.getSessionId(),
      groups: ["primary_control", "native_tools", "admitted_queue", "public_entries"],
      operation_id: randomUUID(),
      expected_capability_revision: bootstrap.capability_revision,
    });
    if ("status" in control) throw new Error("Binding cannot acknowledge acceptance");
    this.rememberControl(control);
    if (control.capability_revision === bootstrap.capability_revision + 1) this.bindingRevision = control.capability_revision;
    if (token !== this.lifecycleToken || control.capability_revision !== bootstrap.capability_revision + 1 || this.control?.capability_revision !== control.capability_revision) {
      this.failure ??= "Stale continuation binding acknowledgement";
      return;
    }
    if (!control.available || control.continuation_requested_revision !== null) throw new Error(control.reason ?? "Continuation binding was refused");
    this.plainReview = false;
    this.fenced = false;
    this.schedule();
  }

  private incarnation(): string {
    if (!this.processIncarnation) throw new Error(this.failure ?? "Continuation has not bound its primary receiver");
    return this.processIncarnation;
  }

  private async send(event: RunnerEventContinuation): Promise<void> {
    const control = await this.emitControl(event);
    if ("status" in control) {
      if (event.type !== "continuation_poll" && event.type !== "continuation_revoke") throw new Error("This event cannot replay acceptance");
      this.handleOutcome(control);
      return;
    }
    this.rememberControl(control);
    const retained =
      event.type === "native_work_settled" ||
      event.type === "native_dispatch_consumed" ||
      event.type === "native_dispatch_rejected" ||
      event.type === "native_dispatch_transferred" ||
      (event.type === "native_work_entered" && (event.parent_operation_id !== undefined || event.dispatch_proof !== undefined));
    if (!control.available && !retained) throw new Error(control.reason ?? "Continuation unavailable");
  }

  private isLiveOperation(operation: NativeOperation | undefined): operation is NativeOperation {
    return !!operation && this.operations.has(operation.id) && !operation.settling && (!operation.returned || operation.pending > 0);
  }

  private activeScope(): NativeOperation | undefined {
    const scope = this.scope.getStore();
    const operation = scope && ("id" in scope ? scope : scope.closed ? undefined : scope.owner);
    return this.isLiveOperation(operation) ? operation : undefined;
  }

  private adoptRunOwner(operation: NativeOperation, runScope?: NativeRunScope): void {
    const scope = runScope ?? this.scope.getStore();
    if (!scope || "id" in scope || scope.closed || scope.held || !this.isLiveOperation(operation)) return;
    scope.owner = operation;
    scope.held = operation;
    scope.plain = false;
    operation.pending++;
  }

  private runParent(messages: readonly unknown[]): NativeOperation | undefined {
    const active = this.activeScope();
    if (active) return active;
    for (const message of messages) {
      if (message && typeof message === "object") {
        const queued = this.queued.get(message);
        if (this.isLiveOperation(queued)) return queued;
      }
      const job = this.messageJobs(message)?.find((entry) => this.isLiveOperation(entry.operation));
      if (job) return job.operation;
    }
    if (this.queued.size && this.session) {
      for (const queue of [this.session.agent.peekSteeringQueue(), this.session.agent.peekFollowUpQueue()]) {
        for (const message of queue) {
          const operation = this.queued.get(message);
          if (this.isLiveOperation(operation)) return operation;
        }
      }
    }
    return undefined;
  }

  private async runAgent(original: NativeMethod, receiver: NativeAgent, args: unknown[], prompt: boolean): Promise<unknown> {
    const messages = prompt ? (Array.isArray(args[0]) ? args[0] : [args[0]]) : [];
    const active = this.activeScope();
    const owner = this.runParent(messages);
    if (this.accepted || ((this.fenced || (!this.plainReview && this.failure)) && !owner)) throw new Error(this.failure ?? "Session is finishing");
    if (this.control && !this.plainReview && !this.revocation) this.assertNativeTools();
    const scope: NativeRunScope = { plain: this.plainReview && !owner };
    if (owner) this.adoptRunOwner(owner, scope);
    const selected: object[] = [];
    let deliveries: SelectedJob[] | undefined;
    try {
      if (owner && !active) await owner.entered;
      if (active?.dispatch && !active.queuedUser) {
        for (const message of messages) {
          if (message && typeof message === "object" && "role" in message && message.role === "user") {
            active.queuedUser = message;
            active.pending++;
            this.immediate.set(message, active);
            selected.push(message);
            break;
          }
        }
      }
      const run = Promise.resolve(this.scope.run(scope, () => Reflect.apply(original, receiver, args)));
      for (const message of messages) {
        const jobs = this.trackJobMessage(message, run, scope);
        if (jobs) {
          deliveries ??= [];
          deliveries.push(...jobs);
        }
      }
      return await run;
    } finally {
      scope.closed = true;
      for (const message of selected) {
        if (this.immediate.delete(message) && active) {
          active.pending--;
          if (active.queuedUser === message) active.queuedUser = undefined;
        }
      }
      if (deliveries) this.releaseJobRuns(deliveries);
      if (scope.held) {
        scope.held.pending--;
        void this.settle(scope.held).catch((error) => {
          this.failure = String(error);
        });
      }
    }
  }

  private enter(dispatch?: string, kind = "native_queue", proof?: string, parent?: NativeOperation): NativeOperation {
    const id = `${kind}:${randomUUID()}`;
    if (parent) parent.pending++;
    const operation: NativeOperation = {
      id,
      dispatch,
      parent,
      pending: 0,
      returned: false,
      entered: this.send({
        type: "native_work_entered",
        process_incarnation: this.incarnation(),
        operation_id: id,
        dispatch_id: dispatch,
        dispatch_proof: proof,
        parent_operation_id: parent?.id,
      }),
    };
    // A failed/ambiguous admission is not proof that the operation never entered.
    operation.entered.catch((error) => {
      if (error instanceof NativeControlRejected && operation.pending === 0) {
        this.operations.delete(id);
        if (parent) {
          parent.pending--;
          void this.settle(parent).catch((failure) => {
            this.failure = String(failure);
          });
        }
        this.disposeRevokedIfSettled();
        this.schedule();
      } else this.failure = String(error);
    });
    this.operations.set(id, operation);
    return operation;
  }

  private async settle(operation: NativeOperation): Promise<void> {
    if (!this.operations.has(operation.id) || operation.settling || !operation.returned || operation.pending !== 0) return;
    operation.settling = true;
    try {
      await operation.entered;
      await this.send({ type: "native_work_settled", process_incarnation: this.incarnation(), operation_id: operation.id });
      this.operations.delete(operation.id);
      for (const previous of operation.transfers ?? []) {
        previous.pending--;
        await this.settle(previous);
      }
      if (operation.parent) {
        operation.parent.pending--;
        await this.settle(operation.parent);
      }
      this.disposeRevokedIfSettled();
      this.schedule();
    } catch (error) {
      operation.settling = false;
      throw error;
    }
  }

  private async invoke(original: NativeMethod, receiver: object, args: unknown[], name: string): Promise<unknown> {
    let dispatch: string | undefined;
    let proof: string | undefined;
    let transfer: string | undefined;
    if (this.control && ["prompt", "steer", "followUp"].includes(name) && typeof args[0] === "string" && args[0].startsWith("\u001eALINERY:")) {
      const end = args[0].indexOf("\u001f");
      if (end >= 0) {
        try {
          const envelope = JSON.parse(args[0].slice(9, end));
          if (typeof envelope.proof === "string" && envelope.proof && typeof envelope.id === "string" && envelope.id) {
            dispatch = envelope.id;
            proof = envelope.proof;
            if (typeof envelope.transfer_dispatch_id === "string") transfer = envelope.transfer_dispatch_id;
            args[0] = args[0].slice(end + 1);
          }
        } catch {
          /* Ordinary user text is never interpreted as authority. */
        }
      }
    }
    if (this.accepted) throw new Error("Session is finishing");
    const parent = this.activeScope();
    if (!this.control) return Reflect.apply(original, receiver, args);
    if (this.plainReview && !parent && !dispatch) {
      const scope = this.scope.getStore();
      if (name.startsWith("tool:") && this.operations.size && (!scope || "id" in scope || !scope.plain)) {
        throw new Error("Native execution has no proven retained scope while previous work retires");
      }
      return this.scope.run({ plain: true }, () => Reflect.apply(original, receiver, args));
    }
    if ((this.fenced || (!this.plainReview && this.failure)) && !parent) {
      throw new Error(this.failure ?? "Session is finishing");
    }
    if (!this.plainReview && !this.revocation) this.assertNativeTools();
    const supersedesReady = name === "prompt" || name === "steer" || name === "followUp" || name === "sendUserMessage" || name === "promptCustomMessage" || name === "abort";
    if (!name.startsWith("tool:") && (dispatch || (supersedesReady && (!parent || !this.operations.has(parent.id))))) {
      // A later review cannot inherit an earlier deferred completion request.
      // The selected ancestor's own unwind remains part of that earlier request.
      this.requestedReady = false;
      this.reviewReadyRevision = undefined;
    }
    const operation = this.enter(dispatch, name, proof, parent);
    await operation.entered;
    if (name === "setModel") this.modelChanges++;
    try {
      if (transfer && dispatch) {
        const agent = this.session?.agent;
        const match = [...this.queued].find(([message, queuedOperation]) => queuedOperation.dispatch === transfer && queuedOperation.queuedUser === message);
        if (!agent || !match) throw new Error("Selected queued input is no longer transferable");
        const [message, previous] = match;
        // Exact public queue objects only; snapshot and replacement have no await gap.
        const steering = agent.peekSteeringQueue();
        const followUp = agent.peekFollowUpQueue();
        if (!steering.includes(message) && !followUp.includes(message)) throw new Error("Selected queued input has already been consumed");
        agent.replaceQueues(
          steering.filter((item) => item !== message),
          followUp.filter((item) => item !== message),
        );
        this.queued.delete(message);
        operation.transfers = [previous];
        await this.send({ type: "native_dispatch_transferred", process_incarnation: this.incarnation(), dispatch_id: transfer, replacement_dispatch_id: dispatch });
      }
      return await this.scope.run(operation, () => Reflect.apply(original, receiver, args));
    } catch (error) {
      // Once removed from the queue, a failed transfer cannot promise that the
      // original remains queued. Keep continuation fenced and report uncertainty.
      if (operation.transfers && !operation.consumed) this.failure = String(error);
      if (dispatch && !operation.transfers && !operation.consumed && !operation.queuedUser && operation.pending === 0) {
        await this.send({
          type: "native_dispatch_rejected",
          process_incarnation: this.incarnation(),
          dispatch_id: dispatch,
          reason: error instanceof Error ? error.message : String(error),
        }).catch((deliveryError) => {
          this.failure = String(deliveryError);
        });
      }
      throw error;
    } finally {
      if (name === "setModel") {
        try {
          if (this.control && !this.failure && this.modelChanges === 1) this.refreshNativeTools();
        } catch (error) {
          // Native setModel's own result/error wins. A failed rebind separately
          // revokes continuation while every entered old lifetime stays owned.
          this.failure = `Native model transition could not rebind: ${error instanceof Error ? error.message : String(error)}`;
          await this.invalidate(this.failure);
        } finally {
          this.modelChanges--;
        }
      }
      operation.returned = true;
      if (operation.returnWaiters) {
        for (const resolve of operation.returnWaiters) resolve();
        operation.returnWaiters = undefined;
      }
      await this.settle(operation).catch((error) => {
        this.failure = String(error);
      });
    }
  }

  private messageJobs(message: unknown): SelectedJob[] | undefined {
    if (this.selectedJobs.size === 0 || !message || typeof message !== "object" || !("customType" in message) || message.customType !== "async-result" || !("details" in message))
      return;
    const details = message.details;
    if (!details || typeof details !== "object" || !("jobs" in details) || !Array.isArray(details.jobs)) return;
    let jobs: SelectedJob[] | undefined;
    for (const item of details.jobs) {
      if (!item || typeof item !== "object" || typeof item.jobId !== "string") continue;
      const job = this.selectedJobs.get(item.jobId);
      if (job) {
        jobs ??= [];
        jobs.push(job);
      }
    }
    return jobs;
  }

  private trackJobMessage(message: unknown, run: Promise<unknown>, runScope?: NativeRunScope): SelectedJob[] | undefined {
    const jobs = this.messageJobs(message);
    if (!jobs) return;
    let joined: SelectedJob[] | undefined;
    for (const job of jobs) {
      if (job.runs.has(run)) continue;
      this.adoptRunOwner(job.operation, runScope);
      job.seenMessage = true;
      job.runs.add(run);
      job.activeRuns++;
      job.operation.pending++;
      joined ??= [];
      joined.push(job);
    }
    return joined;
  }

  private releaseJobRuns(jobs: readonly SelectedJob[]): void {
    for (const job of jobs) {
      job.activeRuns--;
      job.operation.pending--;
      if (job.producerSettled && job.activeRuns === 0 && this.selectedJobs.get(job.id) === job) this.selectedJobs.delete(job.id);
      void this.settle(job.operation).catch((error) => {
        this.failure = String(error);
      });
    }
  }

  private refreshNativeTools(): void {
    const session = this.session;
    if (!session || !this.api.getAllTools) throw new Error("Native tool catalog is unavailable");
    const tools = this.api
      .getAllTools()
      .filter(({ name }) => session.hasBuiltInTool(name))
      .map(({ name }) => session.getToolByName(name));
    if (tools.length === 0 || tools.some((tool) => !tool || typeof tool.execute !== "function")) {
      throw new Error("Native same-tool delegation is unavailable");
    }
    const bindings = new Map<string, { tool: NativeTool; execute: NativeMethod }>();
    for (const tool of tools) {
      if (!tool) continue;
      let execute = this.nativeDecorations.get(tool);
      if (!execute || tool.execute !== execute) {
        const original = tool.execute;
        execute = (...args) => this.invoke(original, tool, args, `tool:${tool.name}`);
        this.decorate(tool, "execute", execute);
        this.nativeDecorations.set(tool, execute);
      }
      bindings.set(tool.name, { tool, execute });
    }
    // Old canonical references remain decorated until this owner is disposed.
    this.nativeTools = bindings;
  }

  private assertNativeTools(): void {
    if (!this.session || this.modelChanges > 0 || this.plainReview || this.revocation || this.failure) return;
    for (const [name, installed] of this.nativeTools) {
      if (this.session.getToolByName(name) === installed.tool && installed.tool.execute === installed.execute) continue;
      this.failure = `Native execution boundary changed for ${name}; a fresh binding is required`;
      void this.invalidate(this.failure);
      throw new Error(this.failure);
    }
  }

  async ready(context: OmpExtensionContext, signal?: AbortSignal, onRetry?: (reason: string) => void): Promise<CompletionOutcome> {
    signal?.throwIfAborted();
    this.context = context;
    if (this.failure || !this.control) return { status: "unavailable", reason: this.failure ?? "Primary receiver has not bound" };
    try {
      this.assertNativeTools();
    } catch {
      return { status: "unavailable", reason: this.failure ?? "Native execution boundary changed" };
    }
    this.requestedReady = true;
    if (this.operations.size || this.queued.size) {
      this.schedule();
      const pending = [...this.operations.values()]
        .slice(0, 8)
        .map((operation) => `${operation.id} (returned=${operation.returned}, pending=${operation.pending})`)
        .join(", ");
      return { status: "waiting", reason: `Selected native work is still active: ${pending}; readiness will be checked after actual settlement` };
    }
    const token = this.lifecycleToken;
    const expectedWorkRevision = this.control.work_revision;
    let outcome: CompletionOutcome;
    try {
      outcome = await this.emitCompletion({ type: "readiness_reported", process_incarnation: this.incarnation(), expected_work_revision: expectedWorkRevision }, signal, onRetry);
    } catch (error) {
      // A later native settlement must not restart a cancelled tool request.
      if (signal?.aborted) this.requestedReady = false;
      throw error;
    }
    if (outcome.status !== "accepted" && token !== this.lifecycleToken) {
      return { status: "unavailable", reason: this.failure ?? "Continuation lifecycle changed while reporting readiness" };
    }
    if (outcome.status !== "accepted" && !this.requestedReady) {
      return { status: "stale", reason: "A later review or cancellation superseded the readiness request" };
    }
    if (outcome.status !== "accepted" && expectedWorkRevision !== this.control?.work_revision) {
      return { status: "stale", reason: "Work changed while readiness was being reported" };
    }
    this.requestedReady = outcome.status === "waiting";
    this.handleOutcome(outcome);
    this.schedule();
    return outcome;
  }

  private handleOutcome(outcome: CompletionOutcome): void {
    if (outcome.status === "ready" || outcome.status === "requested") {
      this.reviewReadyRevision = outcome.ready_revision === this.control?.work_revision ? outcome.ready_revision : undefined;
    }
    if (outcome.status === "accepted") {
      if (!this.accepted) {
        const processIncarnation = this.incarnation();
        this.accepted = true;
        this.context?.shutdown();
        // RPC shutdown is requested synchronously, but its idle input loop needs
        // a native observational frame to run the existing shutdown coordinator.
        // The daemon sends that wake only after this authenticated poll's ACK.
        void this.send({ type: "continuation_poll", process_incarnation: processIncarnation }).catch(() => undefined);
      }
    } else if (outcome.status === "invalid_outputs" || outcome.status === "stale") {
      this.requestedReady = false;
      this.reviewReadyRevision = undefined;
      if (this.failure && !this.plainReview) {
        this.fenced = true;
        if (!this.revocation) void this.invalidate(this.failure);
      } else if (!this.revocation) this.fenced = false;
    }
  }

  private get wantsControl(): boolean {
    if (this.operations.size || this.queued.size) return false;
    const intent = this.control?.continuation_requested_revision;
    return this.requestedReady || this.reviewReadyRevision !== undefined || (intent !== undefined && intent !== null);
  }

  private schedule(): void {
    if (this.timer || this.accepted || this.failure || !this.wantsControl) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.driving && this.wantsControl)
        this.driving = this.drive().finally(() => {
          this.driving = undefined;
          this.schedule();
        });
    }, 250);
    this.timer.unref?.();
  }

  private async drive(): Promise<void> {
    if (!this.wantsControl) return;
    const token = this.lifecycleToken;
    try {
      await this.send({ type: "continuation_poll", process_incarnation: this.incarnation() });
      if (token !== this.lifecycleToken || this.failure || this.plainReview || this.accepted || this.operations.size || this.queued.size) return;
      this.assertNativeTools();
      if (this.requestedReady && this.context) await this.ready(this.context);
      if (token !== this.lifecycleToken || this.failure || this.plainReview || this.accepted || this.operations.size || this.queued.size) return;
      const revision = this.control?.continuation_requested_revision;
      if (revision === null || revision === undefined) return;
      this.fenced = true;
      this.assertNativeTools();
      // No tool cancellation signal: an ambiguous commit must replay while fenced.
      const outcome = await this.emitCompletion({ type: "continuation_finalize", process_incarnation: this.incarnation(), ready_revision: revision });
      this.handleOutcome(outcome);
    } catch {
      // Transient authority loss never reopens an ambiguous finalization.
    }
  }
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
  emitChatTitle?: SessionNameEmitter,
  continuation?: NativeContinuation,
): void {
  let shutdownSessionId: string | undefined;
  let pendingPtyPrompt = initialPtyPrompt;
  if (continuation) {
    api.on("session_before_switch", () => continuation.invalidate("Primary session is switching; continuation requires a fresh binding"));
    api.on("session_shutdown", () => continuation.invalidate("Primary session shut down; continuation binding is unavailable"));
  }
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
  const chatTitles = emitChatTitle ? makeChatTitler(emitChatTitle) : undefined;
  api.on("session_start", async (_payload, context) => {
    shutdownSessionId = undefined;
    if (continuation) {
      try {
        await continuation.bind(context);
      } catch (error) {
        await continuation.invalidate(`Native continuation installation failed: ${String(error)}`);
      }
      if (continuation.unavailableReason && continuation.unavailableReason !== "session has no primary execution") {
        await safeEmit(emit, { type: "adapter_error", detail: continuation.unavailableReason });
      }
    }
    chatTitles?.start(context);
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

  api.on("agent_end", async (payload: OmpAgentEndPayload, context: OmpExtensionContext) => {
    const assistant = payload.messages?.filter((message) => message.role === "assistant") ?? [];
    const tail = assistant[assistant.length - 1];
    if (!payload.willContinue && tail?.stopReason === "error") {
      // OMP exhausted its own retries. Reporting idle here hides the failure and stalls the step (issue #128).
      await safeEmit(emit, { type: "turn_error", detail: tail.errorMessage?.trim() || "Model request failed" });
    } else {
      await safeEmit(emit, { type: payload.willContinue ? "busy" : "idle" });
    }
    // Not awaited: a title is a side request and must never hold up the next turn.
    if (!payload.willContinue) void chatTitles?.maybeTitle(context);
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
      "Request completion of the current engine-assigned Alinery Playbook execution. " +
      "When its work, checks, substantive decisions, and at least one valid assigned artifact are ready, send the user-facing handoff, then call this tool in the same assistant turn before ending it. " +
      "Each declared output is a possible publication, not a requirement to create every file; missing substantive deliverables or human decisions still require work. " +
      "Ready keeps this session available for review; manual continuation comes only from the desktop Continue action. " +
      "If accepted, do no further work because ordinary OMP shutdown is requested. " +
      "Otherwise keep the session open and resolve the reported requirement.",
    parameters: api.zod.z.object({}),
    async execute(_toolCallId: string, _input: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, context: OmpExtensionContext) {
      const sessionId = context.sessionManager.getSessionId();
      if (!sessionId) {
        return completionToolResult(
          "delivery_failed",
          "Alinery could not confirm phase completion because the OMP session identity is unavailable. Retry after the session is ready.",
        );
      }

      const reportRetry = (reason: string) => {
        if (typeof onUpdate !== "function") return;
        try {
          onUpdate(completionToolResult("waiting_for_acceptance", `Alinery has not confirmed completion: ${reason}. Automatically retrying; keep this session open.`, { reason }));
        } catch {
          // Rendering a progress update must not abandon completion recovery.
        }
      };
      let outcome: CompletionOutcome;
      try {
        outcome = continuation
          ? await continuation.ready(context, signal, reportRetry)
          : await emitCompletion({ type: "readiness_reported", process_incarnation: sessionId, expected_work_revision: 0 }, signal, reportRetry);
      } catch (error) {
        if (signal?.aborted) {
          return completionToolResult(
            "delivery_failed",
            "Completion confirmation was cancelled. Acceptance may already be committed; retry to recover its receipt. Keep this session open.",
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        return completionToolResult("delivery_failed", `Alinery could not confirm phase completion: ${reason}. Retry after the Alinery daemon is available.`, { reason });
      }
      if (outcome.status === "accepted") {
        if (!continuation && shutdownSessionId !== sessionId) {
          shutdownSessionId = sessionId;
          context.shutdown();
        }
        return completionToolResult("accepted", "Alinery accepted phase completion. Do no further work; this session is finishing.", { receipt_id: outcome.receipt_id });
      }
      if (outcome.status === "ready" || outcome.status === "requested") {
        return completionToolResult(
          outcome.status,
          outcome.status === "ready"
            ? "Alinery validated this handoff. Keep the session open for review; the desktop Continue action releases it."
            : "Continuation is requested. Known native work must settle before acceptance.",
          { ready_revision: outcome.ready_revision },
        );
      }
      if (outcome.status === "invalid_outputs") {
        return completionToolResult(
          outcome.status,
          `Assigned publications need correction:\n${outcome.diagnostics.join("\n")}\nCompletion requires at least one valid assigned artifact overall and no invalid present outputs. Resolve these diagnostics before calling alinery_phase_complete again; individual outputs may be omitted.`,
          {
            diagnostics: outcome.diagnostics,
          },
        );
      }
      return completionToolResult(outcome.status, `Alinery ${outcome.status}: ${outcome.reason}. Keep this session open.`, {
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

function completionToolResult(status: CompletionOutcome["status"] | "delivery_failed" | "waiting_for_acceptance", text: string, details: Record<string, unknown> = {}) {
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
  const completion = makeProductionCompletionEmitter(config);
  const continuation = new NativeContinuation(api, makeProductionControlEmitter(config), completion);
  registerCallbacks(
    api,
    makeProductionEmitter(config),
    completion,
    protectedHost,
    initialPtyPrompt,
    config?.sessionNaming ? makeProductionSessionNameEmitter(config) : undefined,
    config?.chatNaming ? makeProductionSessionNameEmitter(config) : undefined,
    continuation,
  );
}
