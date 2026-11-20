import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { GenerationTask, LiveDoc, type Conversation, type ConversationId, type Cursor, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { DomainError } from "../platform/lock.ts";
import { appendEntryMessages, transcriptEntryId, type TranscriptSource } from "../transcript.ts";

export function generationError(task: Awaited<ReturnType<Tx["task"]>>): string | undefined {
  if (task?.kind !== GenerationTask.definition.name || (task.state.status !== "terminal" && task.state.status !== "completing")) return;
  const outcome = task.state.outcome;
  if (outcome.status !== "failed") return;
  const detail = outcome.error.detail;
  if (typeof detail === "object" && detail !== null && "reason" in detail && detail.reason === "model_error") return outcome.error.message || "The provider could not complete this turn.";
}

/** Pi commits failed attempts during backoff. Only the last assistant entry of a settled, failed generation is actionable. */
async function readFailure(tx: Tx, conversationId: ConversationId) {
  if ((await tx.doc(LiveDoc, conversationId)).run) return;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId, order: "descending" }, 16, cursor);
    for (const entry of page.items) {
      if (entry.head) return;
      if (!entry.model?.length) continue;
      const message = entry.model[entry.model.length - 1]!;
      if (message.role !== "assistant" || message.stopReason !== "error" || !entry.byTaskId) return;
      const reason = generationError(await tx.task(entry.byTaskId));
      if (reason) return { id: transcriptEntryId(entry.id, entry.model.length - 1, entry.model.length), reason };
      return;
    }
    cursor = page.next;
  } while (cursor);
}

export function latestFailedTurn(conversation: Conversation) {
  return conversation.commit((tx) => readFailure(tx, conversation.id), context);
}

export async function committedTurnMessages(conversation: Conversation) {
  const messages: TranscriptSource[] = [];
  const lastErrors = new Map<TaskId, TranscriptSource>();
  let cursor: Cursor | undefined;
  let lastEntry: EntryId | undefined;
  let lastModelTask: TaskId | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
    for (const entry of page.items) {
      appendEntryMessages(messages, entry, lastErrors);
      lastEntry = entry.id;
      if (entry.model?.length) lastModelTask = entry.byTaskId;
    }
    cursor = page.next;
    if (!cursor) break;
  }
  if (!lastErrors.size) return messages;
  await conversation.commit(async (tx) => {
    // An automatic attempt may have ended while the transcript was paging, or its final entry may lie beyond the window.
    if (lastModelTask && lastErrors.has(lastModelTask)) {
      const latest = await tx.scanEntries({ conversationId: conversation.id, order: "descending" }, 1);
      if (lastEntry !== latest.items[0]?.id) lastErrors.delete(lastModelTask);
    }
    for (const [taskId, message] of lastErrors) message.turnError = generationError(await tx.task(taskId));
  }, context);
  return messages;
}

export async function retryFailedTurn(
  conversation: Conversation,
  failedEntryId: string,
  submitWork: (check: () => Promise<boolean>, send: () => Promise<void>) => Promise<void>,
) {
  if (!failedEntryId) throw new DomainError("invalid_argument", "Retry needs the failed turn.");
  const requestId = `alinery:retry:${failedEntryId}`;
  await submitWork(
    () => conversation.commit(async (tx) => {
      // Pi keeps this admission across a daemon restart or a lost RPC reply.
      if (await tx.submissionByRequest(conversation.id, requestId)) return false;
      if ((await readFailure(tx, conversation.id))?.id !== failedEntryId) throw new DomainError("failed_precondition", "This turn is no longer available to retry.");
      return true;
    }, context),
    async () => {
      await conversation.submit({ type: "input", content: "Continue from where the failed turn stopped.", requestId, whenBusy: "reject" }, context);
    },
  );
}
