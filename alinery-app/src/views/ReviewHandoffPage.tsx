import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { InlineStatus, ModelInput, ompDefaultModel, repoName, taskKey } from "../shared";
import type { BoardTask, NormalizedStep, ReviewHandoffResult, ReviewHandoffSource } from "../types";
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
  const [steps, setSteps] = useState<NormalizedStep[]>([]);
  const [taskId, setTaskId] = useState("");
  const [phase, setPhase] = useState("");
  const harness = "omp";
  const [model, setModel] = useState("");
  const [promptExtra, setPromptExtra] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<ReviewHandoffResult | null>(null);

  useEffect(() => {
    let alive = true;
    ipc.listBoardTasks(allRepos)
      .then((loaded) => {
        if (!alive) return;
        const candidates = loaded.filter((task) => !task.archived && !task.draft && Boolean(task.worktree)
          && !(task.slug === source.source_slug && task.repo_path === source.source_repo_path));
        setTasks(candidates);
        setTaskId((current) => candidates.some((task) => taskKey(task) === current) ? current : "");
      })
      .catch((error) => { if (alive) setErr(String(error)); });
    return () => { alive = false; };
  }, [allRepos, activeRepo, source.source_slug, source.source_repo_path]);

  const selectedTask = taskId ? tasks.find((task) => taskKey(task) === taskId) : null;

  useEffect(() => {
    let alive = true;
    setSteps([]);
    setPhase("");
    setModel("");
    setErr("");
    if (!selectedTask) return;
    Promise.all([
      ipc.getTaskExecution(selectedTask.slug, selectedTask.repo_path),
      ipc.readScopedSettingsForRepo(selectedTask.repo_path),
    ])
      .then(([execution, settings]) => {
        if (!alive) return;
        setSteps(execution.definition.step);
        setModel(ompDefaultModel(settings.effective.defaults));
      })
      .catch((error) => { if (alive) setErr(String(error)); });
    return () => { alive = false; };
  }, [selectedTask?.repo_path, selectedTask?.slug]);

  const confirmDisabled = busy || attempted || !selectedTask || !selectedTask.worktree || !harness || !steps.some((step) => step.key === phase);
  const sendHandoff = () => {
    if (confirmDisabled || !selectedTask) return;
    setBusy(true);
    setAttempted(true);
    setErr("");
    ipc
      .sendReviewHandoff({
        sourceRepoPath: source.source_repo_path,
        sourceSlug: source.source_slug,
        sourceSession: source.source_session,
        sourceArtifact: source.source_artifact,
        targetSlug: selectedTask.slug,
        targetRepoPath: selectedTask.repo_path,
        targetPhase: phase,
        harness,
        model,
        promptExtra,
      })
      .then((result) => {
        if (result.errors.length > 0 || result.start === "failed") setCreated(result);
        else onConfirmed(result);
      })
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
          <span className="pill">Source repository: {source.source_repo_path}</span>
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
                {` — ${repoName(task.repo_path)} (${task.repo_path})`} · {task.branch || "no branch"}
                {task.pr_url ? ` · ${task.pr_url}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="create-field">
          <span>Target step</span>
          <select className="field-input" value={phase} disabled={!selectedTask || steps.length === 0} onChange={(e) => setPhase(e.target.value)}>
            <option value="">Select retained step…</option>
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
            The handoff could not be confirmed. Inspect the target task before trying again.
          </InlineStatus>
        )}
        {created && (
          <InlineStatus tone="error" detail={created.errors.map((error) => `${error.stage}: ${error.message}`).join("\n")}>
            Session {created.target_session.id} was created in {created.target_repo_path}; start status: {created.start}.
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
          {created && <button type="button" className="btn" onClick={() => onConfirmed(created)}>Open created session</button>}
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
