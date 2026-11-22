import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type Conversation, type Tx } from "@earendil-works/pi-durable";
import { WRAP_UP_NUDGE, WRAP_UP_NUDGE_ENTRY } from "../../../../shared/wrapUpNudge.ts";
import { DomainError } from "../platform/lock.ts";

/** Admit once on the active run itself. A follow-up keeps its place, and an ended run cannot be woken by a late click. */
export function steerWrapUp(conversation: Conversation, runId: string, deliveryId: string, checkOwner: (tx: Tx) => Promise<void>) {
  return conversation.commit(async (tx) => {
    const prefix = `alinery:wrap-up:${JSON.stringify(runId)}:`;
    const requestId = prefix + deliveryId;
    const previous = await tx.submissionByRequest(conversation.id, requestId);
    if (previous) {
      if (previous.status === "unanswered" && previous.entry === undefined) throw new DomainError("failed_precondition", "The turn ended before the agent received the wrap-up nudge.");
      return;
    }
    const { run } = await tx.doc(LiveDoc, conversation.id);
    if (!run?.inputs.length || String(run.inputs[0]) !== runId) throw new DomainError("failed_precondition", "This turn is no longer running.");
    await checkOwner(tx);
    const alreadyNudged = () => new DomainError("failed_precondition", "This turn already has a wrap-up nudge.");
    if (run.steer) throw alreadyNudged();
    // A placed steer travels with its original run through every subsequent tool round.
    for (const input of run.inputs.slice(1)) {
      if ((await tx.submission(input))?.requestId?.startsWith(prefix)) throw alreadyNudged();
    }
    const submission = await tx.createSubmission({ conversationId: conversation.id, requestId, type: "input", status: "queued" });
    run.steer = { id: submission.id, content: WRAP_UP_NUDGE, entry: { kind: WRAP_UP_NUDGE_ENTRY, data: { deliveryId } } };
  }, BACKGROUND_CONTEXT);
}
