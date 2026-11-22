import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";

/** Resolving this call releases the engine's worktree and capacity. An abort that excludes
 * background tasks, or closing an unknown owner, cannot establish that its work has stopped. */
export async function stopOwningHarness(
  owner: { harness: Pick<Harness, "conversation" | "close"> | null; conversationId: string } | undefined,
  ended: boolean,
  context: Context,
  beforeClose?: (conversation: Conversation) => Promise<void>,
): Promise<void> {
  if (!owner?.harness) {
    if (ended) return;
    throw new Error("cannot confirm shutdown of an unknown session owner");
  }
  const conversation = await owner.harness.conversation(owner.conversationId, context);
  if (!conversation) throw new Error("cannot confirm shutdown of an unknown conversation");
  await conversation.abort(context, { background: true });
  await beforeClose?.(conversation);
  await owner.harness.close(context);
}

/** Whether a session whose open threw is known to run nothing: it never got a harness, or that harness closed. */
export async function closeFailedOpen(harness: Pick<Harness, "close"> | null, context: Context): Promise<boolean> {
  try {
    await harness?.close(context);
    return true;
  } catch {
    return false;
  }
}
