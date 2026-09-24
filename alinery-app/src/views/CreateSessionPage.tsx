import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../confirm";
import * as ipc from "../ipc";
import { ExecutionAvailabilityNotice, InlineStatus, ModelInput, repoName, taskKey } from "../shared";
import type { BoardTask, SessionTypeChoice, TaskExecutionReply } from "../types";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

export function CreateSessionPage({
  allRepos,
  activeRepo,
  initialTask,
  onCancel,
  onCreated,
}: {
  allRepos: boolean;
  activeRepo: string;
  initialTask?: { repo_path: string; slug: string };
  onCancel: () => void;
  onCreated: (task: BoardTask, choice: SessionTypeChoice, harness: string, model: string, prompt?: string) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [taskId, setTaskId] = useState("");
  const [executionView, setExecutionView] = useState<TaskExecutionReply | null>(null);
  const [loadedTaskId, setLoadedTaskId] = useState("");
  const [selection, setSelection] = useState("auxiliary");
  const [harness, setHarness] = useState("no-harness");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pickModel, setPickModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [executionError, setExecutionError] = useState("");
  const [decisionPending, setDecisionPending] = useState(false);
  const decisionRef = useRef(false);
  const task = tasks.find((candidate) => taskKey(candidate) === taskId);
  const records = Object.values(executionView?.state.executions ?? {});
  const [mode, executionId] = selection.split(":");
  const execution = records.find((record) => record.id === executionId);
  const step = executionView?.definition.step.find((candidate) => candidate.key === execution?.candidate.step_key);
  const auxiliary = selection === "auxiliary";
  const existing = mode === "existing";
  const effectiveHarness = auxiliary ? harness : "omp";
  const exactTaskLoaded = loadedTaskId === taskId;
  const executionAvailable = executionView?.live?.status === "available" && !executionError;

  useEffect(() => {
    let alive = true;
    ipc
      .listBoardTasks(allRepos)
      .then((items) => {
        if (!alive) return;
        const available = items.filter((item) => !item.archived && !item.draft);
        setTasks(available);
        setTaskId((current) => {
          const requested = available.find((item) => item.repo_path === initialTask?.repo_path && item.slug === initialTask?.slug);
          return requested ? taskKey(requested) : available.some((item) => taskKey(item) === current) ? current : available[0] ? taskKey(available[0]) : "";
        });
      })
      .catch((cause) => {
        if (alive) setError(String(cause));
      });
    return () => {
      alive = false;
    };
  }, [allRepos, initialTask?.repo_path, initialTask?.slug]);

  useEffect(() => {
    let alive = true;
    setExecutionView(null);
    setLoadedTaskId("");
    setExecutionError("");
    setSelection("auxiliary");
    setModel("");
    if (!task) return;
    ipc
      .getTaskExecution(task.slug, task.repo_path)
      .then((value) => {
        if (!alive) return;
        setExecutionView(value);
        setLoadedTaskId(taskKey(task));
        const queued = Object.values(value.state.executions).find((record) => record.lifecycle === "queued");
        if (queued) setSelection(`existing:${queued.id}`);
      })
      .catch((cause) => {
        if (!alive) return;
        setLoadedTaskId(taskKey(task));
        setExecutionError(String(cause));
      });
    return () => {
      alive = false;
    };
  }, [task?.repo_path, task?.slug]);

  const changeContext = async (apply: () => void) => {
    if (decisionRef.current) return;
    if (!prompt) {
      apply();
      return;
    }
    decisionRef.current = true;
    setDecisionPending(true);
    try {
      const answer = await askConfirm({
        title: "Change session settings?",
        body: "Discard the additional instructions before changing the task or execution?",
        choices: [
          { key: "discard", label: "Discard edits" },
          { key: "cancel", label: "Cancel", tone: "ghost" },
        ],
        cancelKey: "cancel",
        defaultKey: "cancel",
      });
      if (answer === "discard") {
        setPrompt("");
        apply();
      }
    } finally {
      decisionRef.current = false;
      setDecisionPending(false);
    }
  };

  const disabled = busy || decisionPending || !task?.worktree || !exactTaskLoaded || (!auxiliary && (!execution || !executionAvailable));
  const launch = async () => {
    if (disabled || !task) return;
    let choice: SessionTypeChoice;
    if (auxiliary) choice = { kind: "auxiliary" };
    else if (existing && execution) choice = { kind: "existing", session_id: execution.owner_session_id };
    else if (execution)
      choice =
        mode === "recover"
          ? { kind: "primary", step_key: execution.candidate.step_key, execution_id: execution.id }
          : { kind: "primary", step_key: execution.candidate.step_key, input_occurrence_ids: Object.values(execution.candidate.inputs).flat() };
    else return;
    setBusy(true);
    setError("");
    try {
      await onCreated(
        task,
        choice,
        effectiveHarness,
        effectiveHarness === "no-harness" || existing ? "" : model,
        effectiveHarness === "no-harness" || existing || !prompt ? undefined : prompt,
      );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="createpage"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void launch();
      }}
    >
      <div className="createform createform-page">
        <h2 className="create-title">New session</h2>
        <label className="create-field">
          <span>Task</span>
          <select
            className="field-input"
            value={taskId}
            disabled={busy || decisionPending}
            onChange={(event) => {
              const next = event.target.value;
              void changeContext(() => setTaskId(next));
            }}
          >
            <option value="">Select task…</option>
            {tasks.map((item) => (
              <option key={taskKey(item)} value={taskKey(item)} disabled={!item.worktree}>
                {item.name}
                {allRepos ? ` — ${repoName(item.repo_path)}` : ""}
                {!item.worktree ? " (worktree removed)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="create-field">
          <span>Session type</span>
          <select
            className="field-input"
            value={selection}
            disabled={!task || !exactTaskLoaded || busy || decisionPending}
            onChange={(event) => {
              const next = event.target.value;
              void changeContext(() => {
                setSelection(next);
                setModel("");
              });
            }}
          >
            {executionView && (
              <optgroup label={executionView.definition.title} disabled={!executionAvailable}>
                {records.flatMap((record) => {
                  const title = executionView.definition.step.find((item) => item.key === record.candidate.step_key)?.title ?? record.candidate.step_key;
                  const options = [];
                  if (record.lifecycle === "queued")
                    options.push(
                      <option key={`existing:${record.id}`} value={`existing:${record.id}`}>
                        Start queued · {title} · {record.id}
                      </option>,
                    );
                  if (record.shutdown_confirmed && !record.receipt_id)
                    options.push(
                      <option key={`recover:${record.id}`} value={`recover:${record.id}`}>
                        Recover · {title} · {record.id}
                      </option>,
                    );
                  options.push(
                    <option key={`manual:${record.id}`} value={`manual:${record.id}`}>
                      Independent execution · {title} · binding {record.id}
                    </option>,
                  );
                  return options;
                })}
              </optgroup>
            )}
            <option value="auxiliary">Auxiliary session (outside task graph)</option>
          </select>
        </label>
        {executionView && <ExecutionAvailabilityNotice live={executionView.live} controls />}
        {auxiliary && (
          <label className="create-field">
            <span>Auxiliary harness</span>
            <select
              className="field-input"
              value={harness}
              disabled={busy || decisionPending}
              onChange={(event) => {
                const next = event.target.value;
                void changeContext(() => setHarness(next));
              }}
            >
              <option value="no-harness">Terminal</option>
              <option value="omp">OMP</option>
            </select>
          </label>
        )}
        {auxiliary && <p className="hint">Auxiliary sessions do not acquire graph execution claims or advance task progress.</p>}
        {execution && !auxiliary && (
          <section aria-label="Execution binding">
            <p>
              Execution {execution.id} · {execution.lifecycle} · Current owner {execution.owner_session_id}
            </p>
            {mode === "recover" && executionAvailable && (
              <p>Recovery retains these assignments and replaces only this proven-stopped owner. Its completion permission will be reset.</p>
            )}
            {mode === "manual" && (
              <p>This independent execution uses the selected input occurrences. The daemon reserves new output paths; it does not complete the original execution.</p>
            )}
            {execution.error && <InlineStatus tone="warning">{execution.error}</InlineStatus>}
            <ul aria-label="Bound inputs">
              {Object.entries(execution.candidate.inputs).flatMap(([selector, ids]) =>
                ids.map((id) => (
                  <li key={`${selector}:${id}`}>
                    <code>{selector}</code> ← <code>{executionView?.state.occurrences[id]?.relative_path ?? id}</code> · occurrence {id}
                  </li>
                )),
              )}
            </ul>
            <ul aria-label="Assigned outputs">
              {mode === "manual"
                ? step?.outputs.map((output) => (
                    <li key={output.path}>
                      <code>{output.path}</code> · new assignment reserved on creation
                    </li>
                  ))
                : execution.outputs.map((output) => (
                    <li key={output.relative_path}>
                      <code>{output.selector}</code> → <code>{output.relative_path}</code>
                    </li>
                  ))}
            </ul>
          </section>
        )}
        {executionView && records.length === 0 && <p>No eligible executions are reserved. Required graph inputs may be unsatisfied.</p>}
        {step && !auxiliary && (
          <details>
            <summary>Retained step instructions</summary>
            <pre className="mono">{step.prompt}</pre>
          </details>
        )}
        {executionView && !executionAvailable && auxiliary && (
          <details>
            <summary>Retained playbook instructions</summary>
            {executionView.definition.step.map((savedStep) => (
              <section key={savedStep.key}>
                <h3>{savedStep.title}</h3>
                <pre className="mono">{savedStep.prompt}</pre>
              </section>
            ))}
          </details>
        )}
        {effectiveHarness !== "no-harness" && !existing && (
          <label className="create-field">
            <span>Model override (empty = authored precedence)</span>
            <ModelInput harness="omp" value={model} onChange={setModel} prefillRemembered={false} repoPath={task?.repo_path} onOpenPicker={() => setPickModel(true)} />
          </label>
        )}
        {pickModel && <ProviderSetupDialog mode="manual" initialTab="models" unsignedOpensAccounts onPick={setModel} onClose={() => setPickModel(false)} />}
        <label className="create-field">
          <span>Working directory</span>
          <input className="field-input mono" value={task?.worktree || activeRepo} readOnly />
        </label>
        <label className="create-field">
          <span>Additional instructions</span>
          <textarea
            className="field-input mono"
            rows={8}
            value={prompt}
            disabled={effectiveHarness === "no-harness" || existing || busy || decisionPending}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <p className="hint">
          Instructions supplement the retained step prompt. The daemon appends authoritative input/output assignments and completion rules. Existing queued sessions retain their
          recorded launch choices.
        </p>
        {executionError && (
          <InlineStatus tone="error" detail={executionError}>
            Could not load retained execution state. Graph session creation is unavailable.
          </InlineStatus>
        )}
        {error && (
          <InlineStatus tone="error" detail={error}>
            Could not create or start the session.
          </InlineStatus>
        )}
        <div className="create-actions">
          <button type="button" className="btn" disabled={disabled} onClick={() => void launch()}>
            {busy ? "Launching…" : "Launch"}
          </button>
          <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
