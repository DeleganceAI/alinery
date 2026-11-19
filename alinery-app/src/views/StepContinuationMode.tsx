import { useState } from "react";
import { setStepContinuation } from "../sync/execution";
import { toast } from "../toast";
import type { TaskExecutionReply } from "../types";

export function StepContinuationMode({ repo, slug, step, view }: { repo: string; slug: string; step: string; view: TaskExecutionReply }) {
  const [saving, setSaving] = useState(false);
  const all = view.state.auto_approve_all === true;
  const automatic = all || view.state.enabled_steps.includes(step);
  return (
    <select
      className="step-continuation-mode"
      aria-label="Step continuation"
      title={all ? "Auto Approval All is enabled for this task" : "How this step continues when its outputs are ready"}
      value={automatic ? "automatic" : "manual"}
      disabled={all || saving}
      onChange={async (event) => {
        const enable = event.currentTarget.value === "automatic";
        setSaving(true);
        try {
          await setStepContinuation(repo, slug, step, enable, view.revision ?? 0n);
        } catch (error) {
          toast.error(String(error));
        } finally {
          setSaving(false);
        }
      }}
    >
      <option value="manual">Wait for me</option>
      <option value="automatic">Continue automatically</option>
    </select>
  );
}
