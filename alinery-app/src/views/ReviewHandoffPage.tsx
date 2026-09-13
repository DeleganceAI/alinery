import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { InlineStatus, ModelInput, ompDefaultModel, repoName, taskKey } from "../shared";
import type { BoardTask, PlaybookStepSummary, ReviewHandoffResult, ReviewHandoffSource } from "../types";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

export function ReviewHandoffPage({
  source,
  allRepos,
  activeRepo,
  onCancel,
  onConfirmed,
}: {
  source: ReviewHandoffSource;
  allRepos: boolean;
  activeRepo: string;
  onCancel: () => void;
  onConfirmed: (result: ReviewHandoffResult) => void;
}) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [pickModel, setPickModel] = useState(false);
  const [steps, setSteps] = useState<PlaybookStepSummary[]>([]);
  const [taskId, setTaskId] = useState("");
  const [phase, setPhase] = useState("");
  const harness = "omp";
  const [model, setModel] = useState("");
  const [promptExtra, setPromptExtra] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([ipc.listBoardTasks(allRepos), ipc.readConfig().catch(() => null)])
      .then(([ts, cfg]) => {
        const candidates = ts.filter((task) => !task.archived && Boolean(task.worktree) && task.slug !== source.source_slug);
        setTasks(candidates);
        setTaskId((cur) => cur || (candidates[0] ? taskKey(candidates[0]) : ""));
        setModel((cur) => cur || ompDefaultModel(cfg?.defaults));
      })
      .catch((e) => setErr(String(e)));
  }, [allRepos, source.source_slug]);

  const selectedTask = taskId ? tasks.find((task) => taskKey(task) === taskId) : null;

  useEffect(() => {
    if (!selectedTask) {
      setSteps([]);
      setPhase("");
      return;
    }
    ipc
      .listPlaybookSteps(selectedTask.playbook)
      .then((loadedSteps) => {
        setSteps(loadedSteps);
        setPhase((cur) => {
          if (cur && loadedSteps.some((step) => step.key === cur)) return cur;
          return loadedSteps.find((step) => step.key === "implementation")?.key || loadedSteps[0]?.key || "";
        });
      })
      .catch((e) => setErr(String(e)));
  }, [selectedTask?.playbook, selectedTask?.slug]);

  const confirmDisabled = busy || !selectedTask || !selectedTask.worktree || !harness || !phase;
  const sendHandoff = () => {
    if (!selectedTask) return setErr("Select a target task first");
    setBusy(true);
    setErr("");
    ipc
      .sendReviewHandoff({
        sourceSlug: source.source_slug,
        sourceSession: source.source_session,
        sourceArtifact: source.source_artifact,
        targetSlug: selectedTask.slug,
        targetPhase: phase,
        harness,
        model,
        promptExtra,
      })
      .then(onConfirmed)
      .catch((e) => setErr(String(e)))
      .finally(() => setBusy(false));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !confirmDisabled) sendHandoff();
  };

  return (
    <div className="createpage" onKeyDown={onKey}>
      <div className="createform createform-page review-handoff-page">
        <h2 className="create-title">Send review findings to task</h2>
        <div className="handoff-summary">
          <span className="pill">Source task: {source.source_slug}</span>
          <span className="pill">Session: {source.source_session}</span>
          <span className="pill">Artifact: {source.source_artifact}</span>
        </div>
        <label className="create-field">
          <span>Target task</span>
          <select className="field-input" value={taskId} autoFocus onChange={(e) => setTaskId(e.target.value)}>
            <option value="">Select task…</option>
            {tasks.map((task) => (
              <option key={taskKey(task)} value={taskKey(task)}>
                {task.name}
                {allRepos ? ` — ${repoName(task.repo_path)}` : ""} · {task.branch || "no branch"}
                {task.pr_url ? ` · ${task.pr_url}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="create-field">
          <span>Target step</span>
          <select className="field-input" value={phase} disabled={!selectedTask} onChange={(e) => setPhase(e.target.value)}>
            {steps.map((step) => (
              <option key={step.key} value={step.key}>
                {step.title}
              </option>
            ))}
          </select>
        </label>
        <label className="create-field">
          <span>Model</span>
          <ModelInput harness="omp" value={model} onChange={setModel} onOpenPicker={() => setPickModel(true)} />
          {pickModel && <ProviderSetupDialog mode="manual" initialTab="models" unsignedOpensAccounts onPick={setModel} onClose={() => setPickModel(false)} />}
        </label>
        <label className="create-field">
          <span>Extra instructions</span>
          <textarea
            className="field-input"
            rows={4}
            value={promptExtra}
            placeholder="Optional instructions appended through {{PROMPT_EXTRA}}"
            onChange={(e) => setPromptExtra(e.target.value)}
          />
        </label>
        <label className="create-field">
          <span>Working directory</span>
          <input className="field-input mono" value={selectedTask?.worktree || activeRepo} readOnly />
        </label>
        <div className="handoff-preview">
          <div className="handoff-preview-title">Preview</div>
          <div>
            Copies <span className="mono">{source.source_artifact}</span> into the selected task as the next <span className="mono">review-handoff-00N.md</span>.
          </div>
          <div>
            Creates one target session for <span className="mono">{phase || "—"}</span>.
          </div>
          <div>
            The selected step prompt receives the concrete <span className="mono">review-handoff-00N.md</span> path through{" "}
            <span className="mono">{`{{REVIEW_HANDOFF_FILE}}`}</span>.
          </div>
          <div>
            Extra instructions are optional; when present they are appended through <span className="mono">{`{{PROMPT_EXTRA}}`}</span>
            {promptExtra.trim() ? ": " : "."}
            {promptExtra.trim()}
          </div>
        </div>
        {err && (
          <InlineStatus tone="error" detail={err}>
            The handoff could not be sent.
          </InlineStatus>
        )}
        <div className="create-actions">
          <button
            type="button"
            className="btn"
            disabled={confirmDisabled}
            title={busy ? "Sending…" : !selectedTask ? "Select a target task first" : !phase ? "Select a target step first" : undefined}
            onClick={sendHandoff}
          >
            {busy ? "Sending…" : "Confirm handoff"}
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
