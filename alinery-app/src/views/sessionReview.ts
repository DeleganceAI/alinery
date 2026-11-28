/** Review stays hidden while a panel line is waiting, and appears in the same update that empties the queue after the turn ends. */
export function sessionReviewOffered(input: {
  reviewCurrent: boolean;
  turnActive: boolean;
  messageSending: boolean;
  messageInterrupting: boolean;
  retryPending: boolean;
  compacting: boolean;
  queuedCount: number;
  pendingUi: boolean;
}): boolean {
  return (
    input.reviewCurrent &&
    !input.turnActive &&
    !input.messageSending &&
    !input.messageInterrupting &&
    !input.retryPending &&
    !input.compacting &&
    input.queuedCount === 0 &&
    !input.pendingUi
  );
}
