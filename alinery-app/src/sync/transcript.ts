// A Pi session's transcript from `WatchTranscript` (plan 2.1.5, S3.3): the daemon sends items from an
// index, then only what changed. This keeps the list the pane renders and resumes at its end after a drop.
import { toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
import { SessionService, type TranscriptItem, type WatchTranscriptResponse } from "alinery-proto/alinery/v1/sessions_pb";
import type { SessionControls, VinculumMessage, VinculumTranscript } from "../chatTranscript";
import { daemonTransport } from "../daemon/transport";
import { controlsOf } from "./sessions";

export const RECONNECT_MS = 1000;

export function messageOf(item: TranscriptItem): VinculumMessage {
  return {
    id: item.id,
    role: item.role,
    content: item.content.map((part) => {
      const kind = part.kind;
      switch (kind.case) {
        case "text":
          return { type: "text", text: kind.value };
        case "thinking":
          return { type: "thinking", thinking: kind.value };
        case "redactedThinking":
          return { type: "redactedThinking" };
        case "toolCall":
          return {
            type: "toolCall",
            ...(kind.value.id !== undefined ? { id: kind.value.id } : {}),
            ...(kind.value.name !== undefined ? { name: kind.value.name } : {}),
            ...(kind.value.arguments ? { arguments: toJson(ValueSchema, kind.value.arguments) } : {}),
          };
        default:
          return { type: "text", text: "" };
      }
    }),
    ...(item.streaming ? { streaming: true } : {}),
    ...(item.toolName ? { toolName: item.toolName } : {}),
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.isError ? { isError: true } : {}),
    ...(item.runningToolIds.length > 0 ? { runningToolIds: item.runningToolIds } : {}),
  };
}

/**
 * Fold one frame into the list. A frame covers [nextItem - items.length, nextItem): replace or append,
 * the client keeps what comes before. `undefined` means the frame starts past our end, so we are out of
 * step and must ask again from 0.
 */
export function applyFrame(items: readonly VinculumMessage[], frame: WatchTranscriptResponse): VinculumMessage[] | undefined {
  const start = Number(frame.nextItem) - frame.items.length;
  if (start > items.length) return undefined;
  return [...items.slice(0, start), ...frame.items.map(messageOf)];
}

/** Calls `apply` with the whole transcript after every frame. Returns the stop. A dropped stream reconnects after a second and resumes at the end of the list. */
export function watchSessionTranscript(
  repo: string,
  session: { taskSlug: string; id: string },
  apply: (reply: VinculumTranscript) => void,
  reconnectMs = RECONNECT_MS,
): () => void {
  const ac = new AbortController();
  void (async () => {
    let items: VinculumMessage[] = [];
    let controls: Partial<SessionControls> = {};
    while (!ac.signal.aborted) {
      try {
        const client = createClient(SessionService, daemonTransport(repo));
        for await (const frame of client.watchTranscript({ session, fromItem: BigInt(items.length) }, { signal: ac.signal })) {
          const next = applyFrame(items, frame);
          if (!next) {
            items = [];
            break;
          }
          items = next;
          if (frame.controls) controls = controlsOf(frame.controls);
          if (!ac.signal.aborted) apply({ messages: items, ...controls });
        }
      } catch {
        /* the daemon is away or the session is not open yet: try again */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, reconnectMs);
        ac.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  })();
  return () => ac.abort();
}
