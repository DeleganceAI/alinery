// WatchTranscript: the pane's items from an index, then only what changed.
// The items are `formatTranscript`'s list; an item's index is its position in that list.
import type { Context } from "@earendil-works/chord/context";
import { watchEvents, type Harness } from "@earendil-works/pi-durable";
import type { SessionControls } from "../sessionControls.ts";
import type { TranscriptReply } from "../transcript.ts";

export type TranscriptRead = { items: TranscriptReply[]; controls: SessionControls; queued?: QueuedInput[] };

/** One input the harness holds but has not delivered: what the pane's Queued panel and the agent's tool read. */
export type QueuedInput = {
  id: string;
  mode: string; // the harness's own word: "steer" | "followUp"
  text: string;
  images: { mimeType: string; name: string }[];
};

/** An inbox item as the harness stores it. `id` is a branded number at runtime; the wire wants a string. */
export type InboxItemLike = { id: string | number; mode: string; content?: unknown };

/**
 * The inbox's items as waiting inputs, in delivery order (next first). A `write` is the harness's own entry edit, never
 * a person's message, so it is not listed. Text is the content string or the joined text parts; images carry their name
 * and type only — the part's base64 `data` never reaches this result, and so never reaches the wire. `id` is coerced to a
 * string: the harness stores a branded number, and a JSON encode of the frame throws if it is not a string.
 */
export function queuedInputs(items: readonly InboxItemLike[]): QueuedInput[] {
  const out: QueuedInput[] = [];
  for (const item of items) {
    if (item.mode === "write") continue;
    const texts: string[] = [];
    const images: { mimeType: string; name: string }[] = [];
    if (typeof item.content === "string") texts.push(item.content);
    else if (Array.isArray(item.content)) {
      for (const raw of item.content) {
        if (!raw || typeof raw !== "object") continue;
        const part = raw as { type?: unknown; text?: unknown; mimeType?: unknown; name?: unknown };
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
        else if (part.type === "image" && typeof part.mimeType === "string") images.push({ mimeType: part.mimeType, name: typeof part.name === "string" ? part.name : "" });
      }
    }
    out.push({ id: String(item.id), mode: item.mode, text: texts.join("\n"), images });
  }
  return out;
}

/** A queued input read back off the wire. The two sides carry the same fields; this is the one place that says so. */
export function queuedInputOf(message: { id: string; mode: string; text: string; images: { mimeType: string; name: string }[] }): QueuedInput {
  return { id: message.id, mode: message.mode, text: message.text, images: message.images.map((image) => ({ mimeType: image.mimeType, name: image.name })) };
}

export type TranscriptFeed = {
  read(): Promise<TranscriptRead>;
  /** Call `notify` after any change that could alter `read()`. A retained snapshot ends after its first frame. */
  subscribe?(notify: () => void): () => void;
};

/** `items` cover [nextItem - items.length, nextItem). `replace`: the client drops everything from that index on first. */
export type TranscriptFrame = { items: TranscriptReply[]; nextItem: number; replace: boolean; controls?: SessionControls; queued?: QueuedInput[] };

/** Streaming deltas arrive faster than a pane needs; the daemon already folds the partial about every 100 ms. */
export const COALESCE_MS = 100;
/** Only if the events stream ends under us: the last resort of the fallback order. */
export const POLL_MS = 250;

/**
 * Items from `fromItem`, then a frame per change. The first frame always comes, empty if the client is current.
 * The first changed index decides the next frame: at or past the end of what the client has, an append; before
 * it (a streaming message updated in place, or the list shrank), everything from there with `replace`.
 * The queue rides beside the items on the `controls` contract — sent on the first frame and whenever it changes, never
 * when it is unchanged — and a queue-only change is a change worth a frame: a busy submit writes only the inbox, so
 * without this rule a waiting input would never reach a pane. A feed that reports no queue (a retained session) never
 * sends the field, so a client keeps what it has instead of reading silence as "nothing is waiting".
 */
export async function* watchTranscript(source: TranscriptFeed, fromItem: number, signal: AbortSignal, coalesceMs = COALESCE_MS): AsyncGenerator<TranscriptFrame> {
  let dirty = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    dirty = true;
    wake?.();
  };
  const stop = source.subscribe?.(notify);
  const aborted = () => wake?.();
  signal.addEventListener("abort", aborted);
  try {
    // Subscribed before the first read, so a change in between is a second read, not a lost one.
    let sent: string[] | undefined;
    let controls = "";
    let queued: string | undefined;
    while (!signal.aborted) {
      dirty = false;
      const read = await source.read();
      const now = read.items.map((item) => JSON.stringify(item));
      const controlsNow = JSON.stringify(read.controls);
      const changedControls = controlsNow !== controls ? { controls: read.controls } : {};
      controls = controlsNow;
      const queuedNow = read.queued === undefined ? undefined : JSON.stringify(read.queued);
      const changedQueued = queuedNow !== undefined && queuedNow !== queued ? { queued: read.queued as QueuedInput[] } : {};
      if (queuedNow !== undefined) queued = queuedNow;
      if (!sent) {
        // A client ahead of the list (a restored session) starts over from item 0.
        const ahead = fromItem > now.length;
        const start = ahead ? 0 : fromItem;
        yield { items: read.items.slice(start), nextItem: now.length, replace: ahead, ...changedControls, ...changedQueued };
      } else {
        let first = 0;
        while (first < sent.length && first < now.length && sent[first] === now[first]) first += 1;
        const replace = first < sent.length;
        if (replace || now.length > sent.length || "controls" in changedControls || "queued" in changedQueued) {
          yield { items: read.items.slice(first), nextItem: now.length, replace, ...changedControls, ...changedQueued };
        }
      }
      if (!stop) return;
      sent = now;
      while (!dirty && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
      if (!signal.aborted && coalesceMs > 0) await new Promise((resolve) => setTimeout(resolve, coalesceMs));
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    stop?.();
  }
}

/**
 * Change signal from pi-durable's `watchEvents` (one batch per commit). It is experimental, so if it
 * cannot attach or is interrupted, a 250 ms poll takes over. A closed harness has one final read.
 */
export function eventsChanges(harness: Harness, conversationId: string, context: Context, pollMs = POLL_MS): (notify: () => void) => () => void {
  return (notify) => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
    const poll = (why: string) => {
      if (stopped || timer) return;
      console.error(`transcript events unavailable for ${conversationId} (${why}); polling`);
      timer = setInterval(notify, pollMs);
    };
    watchEvents(harness, conversationId, context).then(
      (opened) => {
        if (stopped) {
          void opened.stop();
          return;
        }
        stream = opened;
        opened.start(async () => notify());
        void opened.closed.then((end) => {
          if (stopped) return;
          if (end.reason === "session_closed") notify();
          else poll(end.reason);
        });
        // A commit between the caller's first read and this registration would otherwise be missed.
        notify();
      },
      (error) => poll(String(error)),
    );
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      void stream?.stop();
    };
  };
}
