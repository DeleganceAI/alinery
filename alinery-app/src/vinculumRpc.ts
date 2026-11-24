/** Official Vinculum RPC stdin commands. Never `{ method, params }`. */

/** An image part of a prompt. `name` is the copy in the session's attachment directory, so the transcript can
 *  point the pane at the same file the model read instead of carrying its bytes back. */
export type ImageContent = { type: "image"; data: string; mimeType: string; name?: string };

let seq = 0;
const nextId = (): string => {
  seq += 1;
  return `c${seq}`;
};

export const promptCommand = (message: string, id = nextId(), images?: ImageContent[]) =>
  images && images.length > 0 ? { id, type: "prompt" as const, message, images } : { id, type: "prompt" as const, message };
export const followUpCommand = (message: string, id = nextId(), images?: ImageContent[]) =>
  images && images.length > 0 ? { id, type: "follow_up" as const, message, images } : { id, type: "follow_up" as const, message };
export const getStateCommand = (id = nextId()) => ({ id, type: "get_state" as const });
export const abortAndPromptCommand = (message: string, id = nextId(), images?: ImageContent[]) =>
  images && images.length > 0 ? { id, type: "abort_and_prompt" as const, message, images } : { id, type: "abort_and_prompt" as const, message };

/** Actionable copy when Vinculum rejects an oversized v1 frame (or a single message still overflows v2). */
export const TRANSPORT_LIMIT_HINT = "History snapshot was too large; live messages still stream.";

export function transportLimitMessage(error: string): string {
  return error.includes("transport limit") ? TRANSPORT_LIMIT_HINT : error;
}
