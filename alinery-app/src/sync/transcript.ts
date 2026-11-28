// A Pi session's transcript from `WatchTranscript`: the daemon sends items from an
// index, then only what changed. On reconnect, re-read any tail that was still changing.
import { toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { SessionService, type TranscriptItem, type WatchTranscriptResponse } from "alinery-proto/alinery/v1/sessions_pb";
import type { QueuedLine } from "../chat/types";
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
        case "image":
          return { type: "image", mimeType: kind.value.mimeType, ...(kind.value.name ? { name: kind.value.name } : {}) };
        default:
          return { type: "text", text: "" };
      }
    }),
    ...(item.streaming ? { streaming: true } : {}),
    ...(item.toolName ? { toolName: item.toolName } : {}),
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.isError ? { isError: true } : {}),
    ...(item.turnError ? { turnError: item.turnError } : {}),
    ...(item.nudgeDeliveryId ? { nudgeDeliveryId: item.nudgeDeliveryId } : {}),
    ...(item.runningToolIds.length > 0 ? { runningToolIds: item.runningToolIds } : {}),
    ...(item.compactionReason ? { compactionReason: item.compactionReason } : {}),
    ...(item.at ? { at: Number(item.at) } : {}),
  };
}

/** The frame's waiting inputs. The field is set only when the queue changed, so `undefined` means "as it was". */
export function queuedOf(frame: WatchTranscriptResponse): QueuedLine[] | undefined {
  if (!frame.queued) return undefined;
  return frame.queued.items.map((item) => ({
    id: item.id,
    mode: item.mode,
    text: item.text,
    images: item.images.map((image) => ({ name: image.name, mimeType: image.mimeType })),
  }));
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

/** Calls `apply` with the whole transcript after every frame. Returns the stop. */
export function watchSessionTranscript(
  repo: string,
  session: { taskSlug: string; id: string },
  apply: (reply: VinculumTranscript) => void,
  reconnectMs = RECONNECT_MS,
  history?: { onMissing: (signal: AbortSignal) => Promise<void>; onError: (error: Error) => void },
): () => void {
  const ac = new AbortController();
  void (async () => {
    let items: VinculumMessage[] = [];
    let controls: Partial<SessionControls> = {};
    while (!ac.signal.aborted) {
      try {
        const client = createClient(SessionService, daemonTransport(repo));
        let needsReplay = false;
        // The first frame of this connection, including the first after a reconnect, is ground truth for the queue.
        let firstOfConnection = true;
        // A nudge or a completed reply can take a streaming row's index while we're disconnected.
        const firstUnfinished = items.findIndex((item) => item.streaming || item.runningToolIds?.length);
        const fromItem = BigInt(firstUnfinished < 0 ? items.length : firstUnfinished);
        for await (const frame of client.watchTranscript({ session, fromItem }, { signal: ac.signal })) {
          const next = applyFrame(items, frame);
          if (!next) {
            items = [];
            needsReplay = true;
            break;
          }
          items = next;
          if (frame.controls) controls = controlsOf(frame.controls);
          // Presence is the signal on later frames: a frame that carries no queue says nothing about it. The first frame does not get that courtesy.
          const queued = queuedOf(frame);
          const authoritative = firstOfConnection;
          firstOfConnection = false;
          if (!ac.signal.aborted) apply({ messages: items, ...controls, ...(queued === undefined ? {} : { queued }), ...(authoritative ? { queueAuthoritative: true } : {}) });
        }
        if (history && !needsReplay) return;
      } catch (error) {
        if (ac.signal.aborted) return;
        if (history) {
          const failure = ConnectError.from(error);
          if (failure.code === Code.NotFound) {
            await history.onMissing(ac.signal);
            return;
          }
          if (![Code.Unavailable, Code.DeadlineExceeded, Code.Unknown, Code.Aborted].includes(failure.code)) {
            history.onError(failure);
            return;
          }
        }
      }
      if (ac.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          ac.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, reconnectMs);
        ac.signal.addEventListener("abort", finish, { once: true });
      });
    }
  })();
  return () => ac.abort();
}
