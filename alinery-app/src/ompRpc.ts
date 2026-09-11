/** Official OMP RPC stdin commands. Never `{ method, params }`. */

let seq = 0;
const nextId = (): string => {
  seq += 1;
  return `c${seq}`;
};

export const promptCommand = (message: string, id = nextId()) => ({ id, type: "prompt" as const, message });
export const followUpCommand = (message: string, id = nextId()) => ({ id, type: "follow_up" as const, message });
export const abortCommand = (id = nextId()) => ({ id, type: "abort" as const });
export const negotiateProtocolCommand = (protocolVersion = 2, id = nextId()) => ({
  id,
  type: "negotiate_protocol" as const,
  protocolVersion,
});
export const getAvailableCommandsCommand = (id = nextId()) => ({ id, type: "get_available_commands" as const });
export const getStateCommand = (id = nextId()) => ({ id, type: "get_state" as const });
export const getAvailableModelsCommand = (id = nextId()) => ({ id, type: "get_available_models" as const });
export const setModelCommand = (provider: string, modelId: string, id = nextId()) => ({
  id,
  type: "set_model" as const,
  provider,
  modelId,
});
export const cycleModelCommand = (id = nextId()) => ({ id, type: "cycle_model" as const });
export const compactCommand = (customInstructions?: string, id = nextId()) =>
  customInstructions ? { id, type: "compact" as const, customInstructions } : { id, type: "compact" as const };
export const setAutoCompactionCommand = (enabled: boolean, id = nextId()) => ({
  id,
  type: "set_auto_compaction" as const,
  enabled,
});
export const setSubagentSubscriptionCommand = (level: "progress" | "events" | "off" = "events", id = nextId()) => ({
  id,
  type: "set_subagent_subscription" as const,
  level,
});
export const getSubagentsCommand = (id = nextId()) => ({ id, type: "get_subagents" as const });
export const abortAndPromptCommand = (message: string, id = nextId()) => ({ id, type: "abort_and_prompt" as const, message });

export const getLoginProvidersCommand = (id = nextId()) => ({ id, type: "get_login_providers" as const });
export const loginCommand = (providerId: string, id = nextId()) => ({ id, type: "login" as const, providerId });
export const cancelExtensionUi = (requestId: string) => ({ type: "extension_ui_response" as const, id: requestId, cancelled: true });
export const extensionUiValue = (requestId: string, value: string) => ({
  type: "extension_ui_response" as const,
  id: requestId,
  value,
});
export const extensionUiConfirm = (requestId: string, confirmed: boolean) => ({
  type: "extension_ui_response" as const,
  id: requestId,
  confirmed,
});

/** Actionable copy when OMP rejects an oversized v1 frame (or a single message still overflows v2). */
export const TRANSPORT_LIMIT_HINT = "History snapshot was too large; live messages still stream.";

export function transportLimitMessage(error: string): string {
  return error.includes("transport limit") ? TRANSPORT_LIMIT_HINT : error;
}
