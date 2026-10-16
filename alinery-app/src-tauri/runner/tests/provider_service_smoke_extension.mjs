// Diagnostic only: explicitly invoked stream boundary, NOT production session interception.
// Keep native API/model identity: custom-API retagging changes Codex behavior before dispatch.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { AssistantMessageEventStream, streamSimple } from "@oh-my-pi/pi-ai";

export default function (api) {
  const reportPath = process.env.ALINERY_PROVIDER_SMOKE_REPORT;
  const localUrl = process.env.ALINERY_PROVIDER_SMOKE_LOCAL_URL;
  const toolPath = process.env.ALINERY_PROVIDER_SMOKE_TOOL_PATH ?? "adapter";
  assert.ok(["adapter", "native"].includes(toolPath));
  const toolSetup = process.env.ALINERY_PROVIDER_SMOKE_TOOL_SETUP ?? "warmed";
  assert.ok(["warmed", "fresh"].includes(toolSetup));
  let nativeToolCalls = 0;
  let nativeTextDeltas = 0;
  api.on("message_update", (event) => {
    if (event.assistantMessageEvent?.type === "text_delta") nativeTextDeltas++;
  });
  api.on("tool_call", (event) => {
    if (event.toolName === "service_smoke_echo") return;
    if (event.toolName === "write" && event.input.path === "xd://service_smoke_echo") return;
    return { block: true, reason: "This disposable diagnostic authorizes only its harmless echo tool." };
  });
  api.registerTool({
    name: "service_smoke_echo",
    label: "Service smoke echo",
    description: "Return SERVICE_SMOKE_TOOL for a harmless provider diagnostic.",
    parameters: api.zod.z.object({ value: api.zod.z.string() }),
    async execute(_id, input) {
      assert.equal(input.value, "SERVICE_SMOKE_TOOL");
      nativeToolCalls++;
      return { content: [{ type: "text", text: "SERVICE_SMOKE_TOOL" }], details: {} };
    },
  });
  if (localUrl) {
    api.registerProvider("service-smoke-local", {
      api: "openai-completions",
      apiKey: "local-only",
      baseUrl: localUrl,
      models: [
        { id: "probe", name: "Local smoke", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 },
      ],
    });
  }
  api.registerCommand("alinery-provider-smoke", {
    description: "Run an explicitly authorized native-provider boundary diagnostic (not Playbook completion).",
    async handler(_args, ctx) {
      const checks = [];
      let route;
      let localError;
      let cancellationEvidence;
      let toolEvidence;
      let failureStep;
      let failureKind;
      let errorKeywordHints;
      const save = (status) =>
        writeFileSync(
          reportPath,
          JSON.stringify(
            {
              status,
              route,
              checks,
              localError,
              cancellationEvidence,
              toolEvidence,
              toolPath,
              toolSetup,
              failureStep,
              failureKind,
              errorKeywordHints,
              scope: toolSetup === "fresh" ? "standalone-tool-only" : "explicit-native-stream-boundary",
              automaticSessionInterception: "not-tested",
              remoteCompaction: "not-tested",
              advisorAndEvalRouting: "not-tested",
              agentSessionSettingsParity: "not-tested",
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      try {
        const model = ctx.models.resolve(process.env.ALINERY_PROVIDER_SMOKE_MODEL);
        assert.ok(model, "Requested model is absent from the configured runtime catalog");
        assert.equal(`${model.provider}/${model.id}`, process.env.ALINERY_PROVIDER_SMOKE_MODEL, "Fuzzy or fallback model selection is not permitted");
        const endpoint = new URL(model.baseUrl);
        route = {
          provider: model.provider,
          model: model.id,
          api: model.api,
          configuredTransport: model.transport ?? "native",
          endpointOrigin: endpoint.origin,
          oauthCredentialsPresent: ctx.modelRegistry.isUsingOAuth(model),
          preferWebsockets: model.preferWebsockets ?? null,
          credentialSelection: "native-resolver-not-inspected",
        };
        save("running");
        if (process.env.ALINERY_PROVIDER_SMOKE_INSPECT === "1") {
          save("inspected");
          return;
        }
        assert.equal(`${ctx.model?.provider}/${ctx.model?.id}`, `${model.provider}/${model.id}`, "Native session changed models; do not credit a fallback to the requested route");
        if (toolSetup === "warmed") {
          assert.equal(nativeToolCalls, 1, "Native OMP session did not execute exactly one echo tool");
          assert.ok(nativeTextDeltas > 0, "Native OMP session did not stream text");
          checks.push("native-omp-session-stream-and-tool");
        }
        const sessionId = `provider-service-smoke-${randomUUID()}`;
        // Preserve OMP's session-sticky selection, refresh, rotation and auth retry policy.
        // Never resolve/copy a bearer into configuration, reports, prompts or adapter models.
        const options = {
          apiKey: ctx.modelRegistry.resolver(model, sessionId),
          headers: ctx.modelRegistry.getProviderHeaders(model.provider),
          sessionId,
          providerSessionState: new Map(),
        };
        const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
        const simpleContext = { messages: [user("Reply with exactly SERVICE_SMOKE_OK.")] };
        const requests = new Set();
        let dispatches = 0;
        let sealed = false;
        const canCommit = () => requests.size === 0 && !sealed;
        function admittedStream(context, streamOptions, allow) {
          const output = new AssistantMessageEventStream();
          const identity = Symbol();
          requests.add(identity); // Reserve before awaiting authority, including before auth resolution.
          void (async () => {
            try {
              if (sealed || !(await allow()) || streamOptions.signal?.aborted || sealed) {
                const error = {
                  role: "assistant",
                  content: [],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  stopReason: "aborted",
                  errorMessage: "Smoke admission refused",
                  timestamp: Date.now(),
                  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                };
                requests.delete(identity);
                output.push({ type: "error", reason: "aborted", error });
                return;
              }
              dispatches++;
              const native = streamSimple(model, context, streamOptions);
              output.forwardLocalWorkFrom(native);
              let terminal;
              for await (const event of native) {
                if (event.type === "done" || event.type === "error") terminal = event;
                else output.push(event);
              }
              const result = await native.result();
              requests.delete(identity);
              if (terminal) output.push(terminal);
              output.end(result);
            } catch (error) {
              requests.delete(identity);
              // Do not turn upstream failure into admission refusal or fabricated success.
              output.fail(error);
            } finally {
              requests.delete(identity);
            }
          })();
          return output;
        }
        async function collect(stream, onEvent = () => {}) {
          let deltas = 0;
          for await (const event of stream) {
            if (event.type === "text_delta") deltas++;
            onEvent(event);
          }
          return { result: await stream.result(), deltas };
        }
        const healthy = (result) => assert.ok(!["error", "aborted"].includes(result.stopReason), "Native provider did not complete successfully");
        if (toolSetup === "warmed") {
          const native = await collect(streamSimple(model, simpleContext, options));
          healthy(native.result);
          assert.ok(native.deltas > 0, "No native text streaming observed");
          checks.push("native-stream");
          save("running");

          const denied = await collect(admittedStream(simpleContext, options, async () => false));
          assert.equal(denied.result.stopReason, "aborted");
          assert.equal(dispatches, 0);
          assert.equal(requests.size, 0);
          checks.push("denial-before-native-dispatch");

          // A real side request owns a reservation after its handle is returned. A fresh
          // completion attempt may succeed only after actual native stream settlement.
          const admission = Promise.withResolvers();
          const background = admittedStream(simpleContext, options, () => admission.promise);
          assert.equal(canCommit(), false);
          assert.equal(dispatches, 0);
          const collected = collect(background);
          admission.resolve(true);
          const finished = await collected;
          healthy(finished.result);
          assert.ok(finished.deltas > 0);
          assert.equal(canCommit(), true);
          assert.equal(dispatches, 1);
          checks.push("background-reservation-blocks-commit-until-settlement");
          save("running");
        }

        const toolContext = {
          messages: [user("Call service_smoke_echo exactly once with value SERVICE_SMOKE_TOOL. Do not answer until the tool returns.")],
          tools: [
            {
              name: "service_smoke_echo",
              description: "Echo the provided value for a harmless integration diagnostic.",
              parameters: api.zod.z.object({ value: api.zod.z.string() }),
            },
          ],
        };
        toolEvidence = {};
        function describeToolResponse(result) {
          return {
            stopReason: ["stop", "length", "toolUse", "error", "aborted"].includes(result.stopReason) ? result.stopReason : "other",
            toolCallCount: result.content.filter((part) => part.type === "toolCall").length,
            hasText: result.content.some((part) => part.type === "text" && part.text.length > 0),
            containsExpectedText: result.content.some((part) => part.type === "text" && part.text.includes("SERVICE_SMOKE_TOOL")),
            errorKeywordHints: ["abort", "cancel", "auth", "rate", "previous_response", "tool", "websocket", "timeout"].filter((keyword) =>
              result.errorMessage?.toLowerCase().includes(keyword),
            ),
            errorSignals: Object.entries({
              rate_limit: /\brate[_ -]limit(?:[_ -](?:exceeded|reached|error))?\b|\btoo many requests\b/i,
              usage_limit: /\busage[_ -]limit[_ -]reached\b|\binsufficient[_ -]quota\b/i,
              http_429: /\b(?:http|status|error)[\s:"=]+429\b/i,
              authentication: /\b(?:invalid_api_key|authentication_error|unauthorized)\b/i,
              invalid_request: /\binvalid_request(?:_error)?\b/i,
              previous_response: /\bprevious_response(?:_not_found|_id)?\b/i,
              server_error: /\b(?:server_error|internal_error|internal server error)\b/i,
              generation_failed: /\bfailed to generate\b/i,
              timeout: /\b(?:timed out|timeout|request_timeout)\b/i,
            })
              .filter(([, pattern]) => pattern.test(result.errorMessage ?? ""))
              .map(([label]) => label),
          };
        }
        // Observe only lifecycle/status metadata. Undefined onPayload return leaves
        // the native request untouched; raw headers, bodies and messages never enter reports.
        function observedOptions(boundary) {
          Object.assign(boundary, { payloadCalls: 0, responseStatuses: [], eventCount: 0, errorEvents: 0, errorCodes: [], sawWebSocketFrames: false });
          return {
            ...options,
            onPayload() {
              boundary.payloadCalls++;
            },
            onResponse(response) {
              boundary.responseStatuses.push(Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null);
            },
            onSseEvent(event) {
              boundary.eventCount++;
              if (event.raw?.some((line) => line.startsWith(": ws "))) boundary.sawWebSocketFrames = true;
              let frame;
              try {
                frame = JSON.parse(event.data);
              } catch {
                return;
              }
              if (frame?.type === "error" || frame?.type === "response.failed") boundary.errorEvents++;
              const error = frame?.error ?? frame?.response?.error;
              for (const code of [error?.code, error?.type]) {
                if (typeof code !== "string") continue;
                const safeCode = [
                  "rate_limit_exceeded",
                  "rate_limit_error",
                  "rate_limited",
                  "usage_limit_reached",
                  "insufficient_quota",
                  "invalid_request_error",
                  "invalid_prompt",
                  "invalid_function_parameters",
                  "unsupported_parameter",
                  "server_error",
                  "internal_error",
                  "response_generation_failed",
                  "response_failed",
                  "tool_call_error",
                ].includes(code)
                  ? code
                  : "other";
                if (!boundary.errorCodes.includes(safeCode)) boundary.errorCodes.push(safeCode);
              }
            },
          };
        }
        toolEvidence.requestBoundary = {};
        const toolOptions = observedOptions(toolEvidence.requestBoundary);
        failureStep = "tool_request_stream";
        const toolReply = await collect(toolPath === "native" ? streamSimple(model, toolContext, toolOptions) : admittedStream(toolContext, toolOptions, async () => true));
        toolEvidence.request = describeToolResponse(toolReply.result);
        failureStep = "tool_request_health";
        healthy(toolReply.result);
        const calls = toolReply.result.content.filter((part) => part.type === "toolCall");
        failureStep = "tool_call_count";
        assert.equal(calls.length, 1, "Model did not supply exactly one tool call");
        failureStep = "tool_call_name";
        toolEvidence.expectedToolName = calls[0].name === "service_smoke_echo";
        assert.equal(calls[0].name, "service_smoke_echo");
        failureStep = "tool_call_argument";
        toolEvidence.expectedToolArgument = calls[0].arguments.value === "SERVICE_SMOKE_TOOL";
        assert.equal(calls[0].arguments.value, "SERVICE_SMOKE_TOOL");
        toolContext.messages.push(toolReply.result, {
          role: "toolResult",
          toolCallId: calls[0].id,
          toolName: calls[0].name,
          content: [{ type: "text", text: "SERVICE_SMOKE_TOOL" }],
          isError: false,
          timestamp: Date.now(),
        });
        toolEvidence.responseBoundary = {};
        const responseOptions = observedOptions(toolEvidence.responseBoundary);
        failureStep = "tool_result_stream";
        const afterTool = await collect(toolPath === "native" ? streamSimple(model, toolContext, responseOptions) : admittedStream(toolContext, responseOptions, async () => true));
        toolEvidence.response = describeToolResponse(afterTool.result);
        failureStep = "tool_result_health";
        healthy(afterTool.result);
        failureStep = "tool_result_expected_text";
        assert.ok(afterTool.result.content.some((part) => part.type === "text" && part.text.includes("SERVICE_SMOKE_TOOL")));
        failureStep = undefined;
        checks.push("native-tool-call-and-result-roundtrip");
        save("running");
        if (toolSetup === "fresh") {
          save("passed");
          return;
        }

        const abort = new AbortController();
        cancellationEvidence = { sawTextDelta: false, abortRequested: false, requestBoundary: {} };
        const cancellationOptions = { ...observedOptions(cancellationEvidence.requestBoundary), signal: abort.signal };
        let sawDelta = false;
        failureStep = "cancellation_stream";
        const cancellation = await collect(
          admittedStream({ messages: [user("Write a long numbered list of 500 ordinary words, one per line.")] }, cancellationOptions, async () => true),
          (event) => {
            if (event.type === "text_delta" && !sawDelta) {
              sawDelta = true;
              cancellationEvidence.sawTextDelta = true;
              cancellationEvidence.activeBeforeAbort = requests.size;
              failureStep = "cancellation_active_before_abort";
              assert.equal(canCommit(), false);
              abort.abort();
              cancellationEvidence.abortRequested = true;
              cancellationEvidence.activeAfterAbort = requests.size;
              failureStep = "cancellation_active_after_abort";
              assert.equal(canCommit(), false, "Cancel signal is not settlement");
              failureStep = "cancellation_stream";
            }
          },
        );
        cancellationEvidence.response = describeToolResponse(cancellation.result);
        cancellationEvidence.stopReason = ["stop", "length", "toolUse", "error", "aborted"].includes(cancellation.result.stopReason) ? cancellation.result.stopReason : "other";
        cancellationEvidence.activeAfterSettlement = requests.size;
        // Only fixed category labels leave the process, never provider error text.
        cancellationEvidence.errorCategories = ["abort", "cancel", "auth", "rate", "previous_response", "tool", "websocket", "timeout"].filter((category) =>
          cancellation.result.errorMessage?.toLowerCase().includes(category),
        );
        failureStep = "cancellation_observed_text";
        assert.ok(sawDelta, "No live stream to cancel");
        failureStep = "cancellation_terminal_reason";
        assert.equal(cancellation.result.stopReason, "aborted", "Cancellation raced natural completion; not a passing cancellation proof");
        failureStep = "cancellation_settled_accounting";
        assert.equal(canCommit(), true);
        failureStep = undefined;
        checks.push("cancellation-accounted-through-settlement");

        sealed = true;
        const beforeFence = dispatches;
        const fenced = await collect(admittedStream(simpleContext, options, async () => true));
        assert.equal(fenced.result.stopReason, "aborted");
        assert.equal(dispatches, beforeFence);
        checks.push("sealed-boundary-prevents-native-dispatch");
        save("passed");
      } catch (error) {
        failureKind = error instanceof assert.AssertionError ? "assertion" : "runtime-or-stream";
        errorKeywordHints = ["abort", "cancel", "auth", "rate", "previous_response", "tool", "websocket", "timeout"].filter((keyword) =>
          String(error).toLowerCase().includes(keyword),
        );
        if (localUrl) localError = String(error);
        // Native failures can contain URLs/headers or echoed credentials. Persist only
        // completed check names and status; inspect through the user's OMP UI if needed.
        save("failed");
      } finally {
        ctx.shutdown();
        ctx.ui.notify("ALINERY_PROVIDER_SMOKE_FINISHED", "info");
      }
    },
  });
}
