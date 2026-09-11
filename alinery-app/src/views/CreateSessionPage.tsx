import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../confirm";
import * as ipc from "../ipc";
import { InlineStatus, ModelInput, ompDefaultModel, repoName, taskKey } from "../shared";
import type { BoardTask, PlaybookStepSummary, PlaybookSummary, SessionListItem, SessionTypeChoice } from "../types";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

type PlaybookGroup = { playbook: PlaybookSummary; steps: PlaybookStepSummary[] };
type LaunchContext = {
  repoPath: string;
  taskSlug: string;
  playbook: string;
  phase: string;
  generic: boolean;
  harness: string;
  model: string;
};
type PromptDraft = {
  context: LaunchContext;
  value: string;
  edited: boolean;
  ready: boolean;
};

const choiceValue = (choice: SessionTypeChoice) => JSON.stringify(choice);
const contextValue = (context: LaunchContext) => JSON.stringify(context);

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
  const [pickModel, setPickModel] = useState(false);
  const [groups, setGroups] = useState<PlaybookGroup[]>([]);
  const [sessionItems, setSessionItems] = useState<SessionListItem[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [taskId, setTaskId] = useState("");
  const [choice, setChoice] = useState<SessionTypeChoice>({ kind: "generic" });
  const [model, setModel] = useState("");
  const [err, setErr] = useState("");
  const [playbookErr, setPlaybookErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [playbookTaskId, setPlaybookTaskId] = useState("");
  const [promptDraft, setPromptDraft] = useState<PromptDraft | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const promptDraftRef = useRef<PromptDraft | null>(null);
  const carryEditRef = useRef<{ value: string } | null>(null);
  const decisionPendingRef = useRef(false);
  const updatePromptDraft = (update: (current: PromptDraft | null) => PromptDraft | null) => {
    setPromptDraft((current) => {
      const next = update(current);
      promptDraftRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    Promise.all([ipc.listBoardTasks(allRepos), ipc.readConfig().catch(() => null), ipc.listSessionItems(allRepos, false)])
      .then(([ts, cfg, items]) => {
        const liveTasks = ts.filter((task) => !task.archived);
        setTasks(liveTasks);
        setSessionItems(items);
        setDefaultModel(ompDefaultModel(cfg?.defaults));
        setTaskId((current) => {
          const requested = initialTask ? liveTasks.find((task) => task.repo_path === initialTask.repo_path && task.slug === initialTask.slug) : null;
          if (requested) return taskKey(requested);
          if (current && liveTasks.some((task) => taskKey(task) === current)) return current;
          return liveTasks[0] ? taskKey(liveTasks[0]) : "";
        });
      })
      .catch((error) => setErr(String(error)));
  }, [allRepos, initialTask?.repo_path, initialTask?.slug]);

  const selectedTask = taskId ? tasks.find((task) => taskKey(task) === taskId) : null;
  const harness = choice.kind === "generic" ? "no-harness" : "omp";
  const recentSession = selectedTask ? sessionItems.find((item) => item.repo_path === selectedTask.repo_path && item.task_slug === selectedTask.slug) : undefined;
  useEffect(() => {
    if (!selectedTask) return;
    if (harness === "no-harness") {
      setModel("");
      return;
    }
    if (recentSession?.harness === "omp" && recentSession.model) {
      setModel(recentSession.model);
      return;
    }
    setModel(defaultModel);
  }, [selectedTask?.repo_path, selectedTask?.slug, sessionItems, defaultModel, harness]);
  useEffect(() => {
    let active = true;
    setPlaybookTaskId("");
    if (!selectedTask) {
      setGroups([]);
      setChoice({ kind: "generic" });
      return () => {
        active = false;
      };
    }
    setErr("");
    setPlaybookErr("");
    ipc
      .listPlaybooksForRepo(selectedTask.repo_path)
      .then(async (playbooks) => {
        const primary = playbooks.find((playbook) => playbook.key === selectedTask.playbook);
        const ordered = primary ? [primary, ...playbooks.filter((playbook) => playbook.key !== primary.key)] : playbooks;
        const loaded = await Promise.all(
          ordered.map(async (playbook) => ({
            playbook,
            steps: await ipc.listPlaybookStepsForRepo(selectedTask.repo_path, playbook.key),
          })),
        );
        if (!active) return;
        const nonempty = loaded.filter((group) => group.steps.length > 0);
        setGroups(nonempty);
        const first = nonempty[0];
        if (!first) {
          setChoice({ kind: "generic" });
          setPlaybookTaskId(taskKey(selectedTask));
          return;
        }
        const currentIndex = first.steps.findIndex((step) => step.key === selectedTask.current_phase);
        const suggestedIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, first.steps.length - 1);
        setChoice({
          kind: "playbook-step",
          playbook: first.playbook.key,
          phase: first.steps[suggestedIndex].key,
        });
        setPlaybookTaskId(taskKey(selectedTask));
      })
      .catch((error) => {
        if (active) {
          setGroups([]);
          setChoice({ kind: "generic" });
          setPlaybookErr(String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [selectedTask?.repo_path, selectedTask?.slug, selectedTask?.playbook]);

  const selectedTaskId = selectedTask ? taskKey(selectedTask) : "";
  const launchContext: LaunchContext | null =
    selectedTask && playbookTaskId === selectedTaskId && harness
      ? {
          repoPath: selectedTask.repo_path,
          taskSlug: selectedTask.slug,
          playbook: choice.kind === "playbook-step" ? choice.playbook : "",
          phase: choice.kind === "playbook-step" ? choice.phase : "",
          generic: choice.kind === "generic",
          harness,
          model: harness === "no-harness" ? "" : model,
        }
      : null;
  const launchContextValue = launchContext ? contextValue(launchContext) : "";

  useEffect(() => {
    let active = true;
    if (!launchContext) {
      updatePromptDraft(() => null);
      return () => {
        active = false;
      };
    }

    if (launchContext.harness === "no-harness") {
      carryEditRef.current = null;
      updatePromptDraft(() => ({ context: launchContext, value: "", edited: false, ready: true }));
      return () => {
        active = false;
      };
    }

    const carried = carryEditRef.current;
    if (carried) {
      carryEditRef.current = null;
      updatePromptDraft(() => ({ context: launchContext, value: carried.value, edited: true, ready: true }));
      return () => {
        active = false;
      };
    }

    setErr("");
    updatePromptDraft(() => ({ context: launchContext, value: "", edited: false, ready: false }));
    ipc
      .previewSessionPrompt({
        repoPath: launchContext.repoPath,
        taskSlug: launchContext.taskSlug,
        playbook: launchContext.playbook,
        phase: launchContext.phase,
        generic: launchContext.generic,
        harness: launchContext.harness,
        model: launchContext.model,
      })
      .then((resolved) => {
        if (!active) return;
        updatePromptDraft((current) => {
          if (!current || contextValue(current.context) !== launchContextValue || current.edited) return current;
          return { ...current, value: resolved, ready: true };
        });
      })
      .catch((error) => {
        if (!active) return;
        updatePromptDraft((current) => {
          if (!current || contextValue(current.context) !== launchContextValue || current.edited) return current;
          return { ...current, value: "", ready: false };
        });
        setErr(String(error));
      });
    return () => {
      active = false;
    };
  }, [launchContextValue]);

  const exactDraft = launchContext && promptDraft && contextValue(promptDraft.context) === launchContextValue ? promptDraft : null;
  const promptReady = !!exactDraft?.ready;
  const promptValue = launchContext?.harness === "no-harness" ? "" : exactDraft?.value || "";

  const requestContextChange = async (apply: () => void, promptAvailable = true) => {
    if (decisionPendingRef.current) return;
    const current = promptDraftRef.current;
    if (!launchContext || !current?.edited || contextValue(current.context) !== launchContextValue) {
      apply();
      return;
    }

    decisionPendingRef.current = true;
    setDecisionPending(true);
    try {
      const answer = await askConfirm({
        title: "Change session settings?",
        body: promptAvailable
          ? "The launch prompt has edits. Keep them for the new settings, discard them and generate a new prompt, or cancel the change."
          : "Terminal sessions cannot use launch prompts. Discard the edits and switch to Terminal, or cancel the change.",
        choices: promptAvailable
          ? [
              { key: "keep", label: "Keep edits" },
              { key: "discard", label: "Discard edits" },
              { key: "cancel", label: "Cancel", tone: "ghost" },
            ]
          : [
              { key: "discard", label: "Discard edits" },
              { key: "cancel", label: "Cancel", tone: "ghost" },
            ],
        cancelKey: "cancel",
        defaultKey: "cancel",
      });
      if (answer === "keep" && promptAvailable) {
        carryEditRef.current = { value: current.value };
      } else if (answer === "discard") {
        carryEditRef.current = null;
        updatePromptDraft(() => null);
      } else {
        return;
      }
      apply();
    } finally {
      decisionPendingRef.current = false;
      setDecisionPending(false);
    }
  };

  const launchDisabled = busy || decisionPending || !selectedTask || !harness || !selectedTask.worktree || !launchContext || !promptReady;
  const launch = () => {
    if (!selectedTask) return setErr("Select a task first");
    if (!selectedTask.worktree) return setErr("Selected task has no worktree");
    if (!launchContext || !exactDraft?.ready) return;
    setBusy(true);
    setErr("");
    onCreated(selectedTask, choice, harness, harness === "no-harness" ? "" : model, harness === "no-harness" || !exactDraft.edited ? undefined : exactDraft.value)
      .catch((error) => setErr(String(error)))
      .finally(() => setBusy(false));
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !launchDisabled) launch();
  };

  return (
    <div className="createpage" onKeyDown={onKey}>
      <div className="createform createform-page">
        <h2 className="create-title">New session</h2>
        <label className="create-field">
          <span>Task</span>
          <select
            className="field-input"
            value={taskId}
            autoFocus
            onChange={(event) => {
              const next = event.target.value;
              if (next !== taskId) void requestContextChange(() => setTaskId(next));
            }}
          >
            <option value="">Select task…</option>
            {tasks.map((task) => (
              <option key={taskKey(task)} value={taskKey(task)} disabled={!task.worktree}>
                {task.name}
                {allRepos ? ` — ${repoName(task.repo_path)}` : ""}
                {!task.worktree ? " (worktree removed)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="create-field">
          <span>Session type</span>
          <select
            className="field-input"
            value={choiceValue(choice)}
            disabled={!selectedTask || playbookTaskId !== selectedTaskId}
            onChange={(event) => {
              const next = JSON.parse(event.target.value) as SessionTypeChoice;
              if (choiceValue(next) !== choiceValue(choice)) void requestContextChange(() => setChoice(next));
            }}
          >
            {groups.map((group) => (
              <optgroup key={group.playbook.key} label={group.playbook.title || group.playbook.key}>
                {group.steps.map((step) => {
                  const option: SessionTypeChoice = {
                    kind: "playbook-step",
                    playbook: group.playbook.key,
                    phase: step.key,
                  };
                  return (
                    <option key={`${group.playbook.key}:${step.key}`} value={choiceValue(option)}>
                      {group.playbook.title || group.playbook.key} · {step.title || step.key}
                    </option>
                  );
                })}
              </optgroup>
            ))}
            <option value={choiceValue({ kind: "generic" })}>Terminal</option>
          </select>
        </label>
        <label className="create-field">
          <span>Model</span>
          {harness !== "no-harness" && (
            <>
              <ModelInput
                harness={harness}
                value={model}
                onChange={(next) => {
                  if (next !== model) void requestContextChange(() => setModel(next));
                }}
                prefillRemembered={false}
                repoPath={selectedTask?.repo_path}
                onOpenPicker={() => setPickModel(true)}
              />
              {pickModel && (
                <ProviderSetupDialog
                  mode="manual"
                  initialTab="models"
                  unsignedOpensAccounts
                  onPick={(next) => {
                    if (next !== model) void requestContextChange(() => setModel(next));
                  }}
                  onClose={() => setPickModel(false)}
                />
              )}
            </>
          )}
        </label>
        <label className="create-field">
          <span>Working directory</span>
          <input className="field-input mono" value={selectedTask?.worktree || activeRepo} readOnly />
        </label>
        <label className="create-field">
          <span>Launch prompt</span>
          <textarea
            className="field-input mono"
            rows={12}
            value={promptValue}
            disabled={harness === "no-harness" || !launchContext || !promptReady || decisionPending}
            placeholder={harness === "no-harness" ? "Terminal sessions do not receive a prompt." : "Resolving launch prompt…"}
            onChange={(event) => {
              const value = event.target.value;
              updatePromptDraft((current) => (current && contextValue(current.context) === launchContextValue ? { ...current, value, edited: true } : current));
            }}
            spellCheck={false}
          />
          <span className="hint">Edits apply only to this new session. Clearing removes the task instructions; OMP still appends its required completion contract at runtime.</span>
        </label>
        {(playbookErr || err) && (
          <InlineStatus tone="error" detail={playbookErr || err}>
            {playbookErr ? "Could not load playbooks." : "Could not create the session."}
          </InlineStatus>
        )}
        <div className="create-actions">
          <button
            type="button"
            className="btn"
            disabled={launchDisabled}
            title={
              busy
                ? "Launching…"
                : !selectedTask
                  ? "Select a task first"
                  : !selectedTask.worktree
                    ? "The selected task has no worktree"
                    : !promptReady
                      ? "Waiting for the launch prompt to resolve"
                      : undefined
            }
            onClick={launch}
          >
            {busy ? "Launching…" : "Launch"}
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
