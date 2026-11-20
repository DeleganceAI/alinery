import { InboxDoc, LiveDoc, type ConversationId, type Cursor, type EntryId, type Tx } from "@earendil-works/pi-durable";

/** Check the durable answer to this particular review message, including after a daemon restart. */
export async function answeredReviewFollowUp(tx: Tx, conversationId: ConversationId, requestId: string): Promise<boolean> {
  const submission = await tx.submissionByRequest(conversationId, requestId);
  if (submission?.type !== "input" || submission.status !== "done") return false;
  return hasSettledAnswer(tx, conversationId, submission.answer);
}

/** A normal final answer with no newer work. Pi also settles truncated answers as "done". */
export async function hasSettledAnswer(tx: Tx, conversationId: ConversationId, expectedAnswerId?: EntryId): Promise<boolean> {
  if ((await tx.doc(LiveDoc, conversationId)).run) return false;
  if ((await tx.doc(InboxDoc, conversationId)).items.some((item) => item.mode !== "write")) return false;

  // A session has its own Pi database. Background or child work can outlive the run that answered.
  for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
    if ((await tx.scanTasks({ status }, 1)).items.length) return false;
  }
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, minEntryId: expectedAnswerId, order: "descending" }, 16, cursor);
    for (const entry of page.items) {
      if (entry.head) return false;
      const last = entry.model?.at(-1);
      if (last) return last.role === "assistant" && last.stopReason === "stop" && (expectedAnswerId === undefined || entry.id === expectedAnswerId);
    }
    cursor = page.next;
  } while (cursor);
  return false;
}
