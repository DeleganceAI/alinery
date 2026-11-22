import { FastForward, Hand } from "lucide-react";
import { type ReactNode, useState } from "react";
import { setStepContinuation } from "../sync/execution";
import { toast } from "../toast";
import type { ExecutionRecord, TaskExecutionReply } from "../types";

type Props = { repo: string; slug: string; execution: ExecutionRecord; view: TaskExecutionReply; children?: ReactNode };

export function StepContinuationMode({ repo, slug, execution, view, children }: Props) {
  const [saving, setSaving] = useState(false);
  const all = view.state.auto_approve_all === true;
  const step = execution.candidate.step_key;
  const permission = execution.permission.kind;
  // A one-time grant applies to this execution; the toolbar still shows the step's saved mode.
  const automatic = all || permission === "automatic" || (permission === "human_granted" && view.state.enabled_steps.includes(step));
  const changeMode = async (enable: boolean) => {
    if (all || saving || enable === automatic) return;
    setSaving(true);
    try {
      await setStepContinuation(repo, slug, step, enable, view.revision ?? 0n);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <fieldset className="btn-group step-continuation-mode" aria-label="Session continuation controls">
      <button
        type="button"
        className="btn ghost small"
        aria-label="Wait for me"
        aria-pressed={!automatic}
        title={
          all
            ? "Turn off Auto Approval All in task details to wait for review."
            : "Pause for review when this step’s outputs are ready. Applies each time this step runs in this task."
        }
        disabled={all || saving}
        onClick={() => void changeMode(false)}
      >
        <Hand size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="btn ghost small"
        aria-label="Continue automatically"
        aria-pressed={automatic}
        title={all ? "Auto Approval All is enabled for this task." : "Continue automatically after this step’s outputs pass validation. Final steps stay open for review."}
        disabled={all || saving}
        onClick={() => void changeMode(true)}
      >
        <FastForward size={16} aria-hidden="true" />
      </button>
      {children}
    </fieldset>
  );
}
