import { useRef, useState } from "react";
import { continueReviewed, ExecutionConflict } from "./sync/execution";
import type { ExecutionRecord, NormalizedStep } from "./types";

type Props = {
  repo: string;
  slug: string;
  execution: ExecutionRecord;
  steps: NormalizedStep[];
  disabled: boolean;
};

export function ReviewedCompletion({ repo, slug, execution, steps, disabled }: Props) {
  const ready = execution.ready;
  if (!ready || execution.lifecycle !== "running" || execution.receipt_id || !execution.owner_session_id) return null;
  const titles = ready.destinations.map((key) => steps.find((step) => step.key === key)?.title ?? key);
  const label = ready.endpoint ? "Finish step" : titles.length === 1 ? `Continue to ${titles[0]}` : "Continue playbook";
  return (
    <ReviewButton
      key={JSON.stringify([repo, slug, execution.id, execution.owner_session_id, ready.revision])}
      label={label}
      title={titles.length > 1 ? `${label} · ${titles.join(", ")}` : label}
      disabled={disabled}
      submit={() => continueReviewed(repo, slug, execution.id, execution.owner_session_id, ready.revision)}
    />
  );
}

function ReviewButton({ label, title, disabled, submit }: { label: string; title: string; disabled: boolean; submit: () => Promise<void> }) {
  const inFlight = useRef(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState("");
  const request = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setRequested(true);
    setError("");
    try {
      await submit();
      // The stream can lag a successful reply. Keep this exact review spent until the row changes.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (!(cause instanceof ExecutionConflict)) {
        inFlight.current = false;
        setRequested(false);
      }
    }
  };
  return (
    <>
      <button type="button" className="btn primary small reviewed-completion" title={title} disabled={disabled || requested} onClick={() => void request()}>
        {requested && !error ? "Continuing…" : label}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
