import { useMemo, useRef, useState } from "react";
import { WRAP_UP_NUDGE } from "../shared/wrapUpNudge";
import type { ChatEntry, WrapUpPrompt } from "./chat/types";
import { nudgeExecution } from "./sync/execution";
import { newMutationMeta, UnconfirmedDelivery } from "./sync/mutation";
import type { SessionObservation } from "./types";

type Attempt = {
  session: string;
  runId: string;
  meta: ReturnType<typeof newMutationMeta>;
  at: number;
  status: "sending" | "sent" | "failed";
  error?: string;
  checkDelivery?: () => Promise<void>;
};

export function useWrapUpNudge(
  repo: string,
  taskSlug: string,
  executionId: string,
  sessionId: string,
  observation: SessionObservation | null | undefined,
  enabled: boolean,
  entries: readonly ChatEntry[],
) {
  const agent = observation?.state?.agent;
  const runId = agent?.state === "busy" ? agent.correlation_id : undefined;
  const session = JSON.stringify([repo, taskSlug, sessionId]);
  const [attempt, setAttempt] = useState<Attempt>();
  const latest = useRef<Attempt | undefined>(undefined);
  const current = attempt?.session === session ? attempt : undefined;
  const placed = !!current && entries.some((entry) => entry.type === "prompt" && entry.nudgeDeliveryId === current.meta.mutationId);
  const runEnded =
    !observation?.stale && (agent?.state === "idle" || agent?.state === "errored" || observation?.lifecycle.state === "exited" || (runId && runId !== current?.runId));
  const prompt = useMemo<WrapUpPrompt | undefined>(() => {
    if (!current || placed) return undefined;
    let status: WrapUpPrompt["status"] = "sending";
    if (current.status === "sent") status = runEnded ? "ended" : "pending";
    if (current.status === "failed") status = current.checkDelivery ? "unconfirmed" : "failed";
    return { deliveryId: current.meta.mutationId, at: current.at, text: WRAP_UP_NUDGE, status };
  }, [current, placed, runEnded]);
  const record = (next: Attempt) => {
    latest.current = next;
    setAttempt(next);
  };

  const send = async () => {
    const previous = latest.current?.session === session ? latest.current : undefined;
    if (previous?.status === "sending" && !placed) return;
    // An unconfirmed request still belongs to its original run, even if the session has advanced.
    const retry = !placed && previous?.checkDelivery ? previous : undefined;
    const target = retry?.runId ?? runId;
    if (!target || (!retry && (!enabled || (previous?.runId === target && (previous.status === "sent" || placed))))) return;
    const sending: Attempt = { session, runId: target, status: "sending", meta: retry?.meta ?? newMutationMeta(), at: retry?.at ?? Date.now() };
    record(sending);
    try {
      if (retry?.checkDelivery) await retry.checkDelivery();
      else await nudgeExecution(repo, taskSlug, executionId, sessionId, target, sending.meta);
      if (latest.current === sending) record({ ...sending, status: "sent" });
    } catch (cause) {
      if (latest.current !== sending) return;
      record({
        ...sending,
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
        checkDelivery: cause instanceof UnconfirmedDelivery ? cause.checkDelivery : undefined,
      });
    }
  };

  return {
    send,
    prompt,
    pending: !placed && current?.status === "sending",
    sent: !!current && (placed || current.status === "sent") && current.runId === runId,
    error: placed ? "" : (current?.error ?? ""),
    unconfirmed: !placed && Boolean(current?.checkDelivery),
  };
}
