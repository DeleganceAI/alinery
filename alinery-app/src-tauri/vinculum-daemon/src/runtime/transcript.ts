// WatchTranscript (plan 2.1.5, S3.3): the pane's items from an index, then only what changed.
// The items are `formatTranscript`'s list; an item's index is its position in that list.
import type { Context } from "@earendil-works/chord/context";
import { watchEvents, type Harness } from "@earendil-works/pi-durable";
import type { SessionControls } from "../sessionControls.ts";
import type { TranscriptReply } from "../transcript.ts";

export type TranscriptRead = { items: TranscriptReply[]; controls: SessionControls };

export type TranscriptFeed = {
  read(): Promise<TranscriptRead>;
  /** Call `notify` after any change that could alter `read()`. Returns the unsubscribe. */
  subscribe(notify: () => void): () => void;
};

/** `items` cover [nextItem - items.length, nextItem). `replace`: the client drops everything from that index on first. */
export type TranscriptFrame = { items: TranscriptReply[]; nextItem: number; replace: boolean; controls?: SessionControls };

/** Streaming deltas arrive faster than a pane needs; the daemon already folds the partial about every 100 ms. */
export const COALESCE_MS = 100;
/** Only if the events stream ends under us: the last resort of the fallback order (plan S3.3 Research). */
export const POLL_MS = 250;

/**
 * Items from `fromItem`, then a frame per change. The first frame always comes, empty if the client is current.
 * The first changed index decides the next frame: at or past the end of what the client has, an append; before
 * it (a streaming message updated in place, or the list shrank), everything from there with `replace`.
 */
export async function* watchTranscript(source: TranscriptFeed, fromItem: number, signal: AbortSignal, coalesceMs = COALESCE_MS): AsyncGenerator<TranscriptFrame> {
  let dirty = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    dirty = true;
    wake?.();
  };
  const stop = source.subscribe(notify);
  const aborted = () => wake?.();
  signal.addEventListener("abort", aborted);
  try {
    // Subscribed before the first read, so a change in between is a second read, not a lost one.
    let sent: string[] | undefined;
    let controls = "";
    while (!signal.aborted) {
      dirty = false;
      const read = await source.read();
      const now = read.items.map((item) => JSON.stringify(item));
      const controlsNow = JSON.stringify(read.controls);
      const changedControls = controlsNow !== controls ? { controls: read.controls } : {};
      controls = controlsNow;
      if (!sent) {
        // A client ahead of the list (a restored session) starts over from item 0.
        const ahead = fromItem > now.length;
        const start = ahead ? 0 : fromItem;
        yield { items: read.items.slice(start), nextItem: now.length, replace: ahead, ...changedControls };
      } else {
        let first = 0;
        while (first < sent.length && first < now.length && sent[first] === now[first]) first += 1;
        const replace = first < sent.length;
        if (replace || now.length > sent.length || "controls" in changedControls) {
          yield { items: read.items.slice(first), nextItem: now.length, replace, ...changedControls };
        }
      }
      sent = now;
      while (!dirty && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
      if (!signal.aborted && coalesceMs > 0) await new Promise((resolve) => setTimeout(resolve, coalesceMs));
    }
  } finally {
    signal.removeEventListener("abort", aborted);
    stop();
  }
}

/**
 * Change signal from pi-durable's `watchEvents` (one batch per commit). It is experimental, so if it
 * cannot attach or its stream ends before we stop it, a 250 ms poll takes over.
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
        void opened.closed.then((end) => poll(end.reason));
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
