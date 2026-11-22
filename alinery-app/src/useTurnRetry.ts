import { useCallback, useMemo, useRef, useState } from "react";
import { UnconfirmedDelivery } from "./sync/mutation";
import { retryTurn } from "./sync/sessions";
import type { SessionObservation } from "./types";

export type TurnRetryControl = {
  failedEntryId: string;
  reason: string;
  pending: boolean;
  error: string;
  unconfirmed: boolean;
  retry: () => void;
};

export function useTurnRetry(repo: string, sessionId: string, observation: SessionObservation | null | undefined, enabled: boolean): TurnRetryControl | undefined {
  const state = observation?.state;
  const failure = state?.agent.state === "errored" ? state.agent : undefined;
  const failedEntryId = failure?.correlation_id;
  const reason = failure?.reason;
  const available = enabled && !observation?.stale && observation?.lifecycle.state === "live" && observation.transport === "rpc" && state?.process.state === "alive";
  const key = JSON.stringify([repo, sessionId, failedEntryId]);
  const inFlight = useRef<string | null>(null);
  const [result, setResult] = useState<{ key: string; error: string; checkDelivery?: () => Promise<void> } | null>(null);
  const current = result?.key === key ? result : null;
  const checkDelivery = current?.checkDelivery;
  const retry = useCallback(() => {
    if (!available || !failedEntryId || inFlight.current === key) return;
    // Keep the button locked after admission until the observation advances to a different turn.
    inFlight.current = key;
    setResult({ key, error: "" });
    const delivery = checkDelivery ? checkDelivery() : retryTurn(repo, sessionId, failedEntryId);
    void delivery.catch((cause: unknown) => {
      if (inFlight.current !== key) return;
      inFlight.current = null;
      setResult({
        key,
        error: (cause instanceof Error ? cause.message : String(cause)) || "The retry failed.",
        checkDelivery: cause instanceof UnconfirmedDelivery ? cause.checkDelivery : undefined,
      });
    });
  }, [available, checkDelivery, failedEntryId, key, repo, sessionId]);

  return useMemo(() => {
    if (!available || !failedEntryId) return undefined;
    return {
      failedEntryId,
      reason: reason || "The provider could not finish this turn.",
      pending: current?.error === "",
      error: current?.error ?? "",
      unconfirmed: !!checkDelivery,
      retry,
    };
  }, [available, failedEntryId, reason, current, checkDelivery, retry]);
}
