import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { Checkbox, InlineStatus, ModelInput, ompDefaultModel } from "../shared";
import * as taskMutationGuard from "../taskMutationGuard";
import { toast } from "../toast";
import type { BoardTask, DraftOrigin, PlaybookStepSummary, PlaybookSummary, TargetedCreateResult } from "../types";
import { ProviderSetupDialog } from "./ProviderSetupDialog";

type ErrState = { msg: string; detail: string } | null;

const slugifyTaskName = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || (value.trim() ? "task" : "");
};

export function CreateTaskPage({
  onCancel,
  onCreated,
  initialDraft,
  activeRepo,
  knownRepos,
}: {
  onCancel: () => void;
  onCreated: (result: TargetedCreateResult) => void;
  initialDraft?: BoardTask;
  activeRepo: string;
  knownRepos: string[];
}) {
  const initialTaskSlug = initialDraft?.requested_slug || slugifyTaskName(initialDraft?.name ?? "");
  const [repoPath, setRepoPath] = useState(initialDraft?.repo_path ?? activeRepo);
  const [pickModel, setPickModel] = useState(false);
  const [name, setName] = useState(initialDraft?.name ?? "");
  const [taskSlug, setTaskSlug] = useState(initialTaskSlug);
  const [slugEdited, setSlugEdited] = useState(!!initialDraft?.requested_slug && initialDraft.requested_slug !== slugifyTaskName(initialDraft.name));
  const [desc, setDesc] = useState("");
  const [evidence, setEvidence] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachmentDraft, setAttachmentDraft] = useState("");
  const [dropping, setDropping] = useState(false);
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<TargetedCreateResult | null>(null);
  const [err, setErr] = useState<ErrState>(null);
  const [mode, setMode] = useState<"inline" | "linear" | "github">(initialDraft?.linear_id ? "linear" : initialDraft?.github_issue ? "github" : "inline");
  const [ref, setRef] = useState(initialDraft?.linear_id || initialDraft?.github_issue || "");
  const [linearId, setLinearId] = useState(initialDraft?.linear_id ?? "");
  const [githubIssue, setGithubIssue] = useState(initialDraft?.github_issue ?? "");
  const [importing, setImporting] = useState(false);
  const [useWorktree, setUseWorktree] = useState(initialDraft ? initialDraft.has_worktree : true);
  const [branchName, setBranchName] = useState(initialDraft?.branch ?? "");
  const [worktreeName, setWorktreeName] = useState(initialDraft?.has_worktree ? initialDraft.worktree : "");
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[]>([]);
  const [playbook, setPlaybook] = useState(initialDraft?.playbook || "superdevelop");
  const [playbookSteps, setPlaybookSteps] = useState<PlaybookStepSummary[]>([]);
  const [autoAdvance, setAutoAdvance] = useState<string[]>(initialDraft?.auto_advance ?? []);
  const harness = "omp";
  const [model, setModel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [draftAutosave, setDraftAutosave] = useState(true);
  const [draftSlug, setDraftSlug] = useState(initialDraft?.slug ?? "");
  const [draftOrigins, setDraftOrigins] = useState<DraftOrigin[]>(initialDraft ? [{ repoPath: initialDraft.repo_path, slug: initialDraft.slug }] : []);
  const [mutationKind, setMutationKind] = useState<taskMutationGuard.TaskMutationKind | null>(taskMutationGuard.currentKind());
  const [playbookNeedsReselection, setPlaybookNeedsReselection] = useState(false);
  const [modelNeedsReselection, setModelNeedsReselection] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const draftSlugRef = useRef(initialDraft?.slug ?? "");
  const draftSaveInFlightRef = useRef<Promise<void> | null>(null);
  const targetRequest = useRef(0);
  const modelRequest = useRef(0);
  const initialTargetLoaded = useRef(false);
  const repoRef = useRef(repoPath);
  const ticketLoaded = useRef(false);
  // dirty only after a real user edit (or reopen of an existing draft).
  const dirtyRef = useRef(!!initialDraft);
  const setCurrentDraftSlug = (slug: string) => {
    draftSlugRef.current = slug;
    setDraftSlug(slug);
  };

  // The busy flag is the shared guard, not this component's own: a create started from
  // the ⌘N form and a duplicate started from a board are the same slot.
  const creating = mutationKind === "create";
  useEffect(() => taskMutationGuard.subscribe(setMutationKind), []);

  useEffect(() => {
    const t = window.setTimeout(() => titleRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    repoRef.current = repoPath;
  }, [repoPath]);

  useEffect(() => {
    let alive = true;
    const request = ++targetRequest.current;
    setErr(null);
    Promise.all([ipc.readConfigForRepo(repoPath), ipc.listPlaybooksForRepo(repoPath)])
      .then(async ([c, ws]) => {
        if (!alive || request !== targetRequest.current) return;
        setDraftAutosave(c.defaults.draft_autosave !== false);
        setPlaybooks(ws);
        setDefaultModel(ompDefaultModel(c.defaults));

        if (!initialTargetLoaded.current) {
          initialTargetLoaded.current = true;
          const initialPlaybook = initialDraft?.playbook || ws[0]?.key || "";
          setPlaybook(initialPlaybook);
          setAutoAdvance(
            initialDraft?.auto_advance?.length
              ? initialDraft.auto_advance
              : (ws.find((w) => w.key === initialPlaybook)?.auto_advance ?? []).filter((edge) => edge.default_enabled).map((edge) => edge.key),
          );
          setPlaybookNeedsReselection(!initialPlaybook || !ws.some((w) => w.key === initialPlaybook));
          setModel(ompDefaultModel(c.defaults));
          setModelNeedsReselection(false);
        } else {
          if (!ws.some((w) => w.key === playbook)) {
            setPlaybook("");
            setAutoAdvance([]);
            setPlaybookNeedsReselection(true);
          } else {
            setPlaybookNeedsReselection(false);
          }
        }
        if (initialDraft && initialDraft.repo_path === repoPath && !ticketLoaded.current) {
          try {
            const raw = await ipc.readArtifactForRepo(repoPath, initialDraft.slug, "00-ticket.md");
            if (!alive || request !== targetRequest.current) return;
            // The composer emits the heading exactly once and always after the description,
            // so the occurrence nearest the end is the machine-written one.
            const marker = "\n## Evidence & Pointers\n";
            const cut = raw.lastIndexOf(marker);
            const body = cut >= 0 ? raw.slice(0, cut) : raw;
            const evidenceText = cut >= 0 ? raw.slice(cut + marker.length).trim() : "";
            const lines = body.trim().split("\n");
            setDesc(lines[0]?.startsWith("#") ? lines.slice(1).join("\n").replace(/^\n+/, "").trimEnd() : body.trim());
            setEvidence(evidenceText);
            ticketLoaded.current = true;
          } catch {
            // no ticket yet
          }
        }
      })
      .catch((e) => {
        if (alive && request === targetRequest.current) setErr({ msg: "Couldn't load repository settings.", detail: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [repoPath]);

  useEffect(() => {
    let alive = true;
    const request = ++modelRequest.current;
    ipc
      .listHarnessModelsForRepo(repoPath, harness)
      .then((models) => {
        if (!alive || request !== modelRequest.current) return;
        if (model && models.length && !models.includes(model)) {
          setModel("");
          setModelNeedsReselection(true);
        } else {
          setModelNeedsReselection(false);
        }
      })
      .catch(() => {
        if (alive && request === modelRequest.current) setModelNeedsReselection(false);
      });
    return () => {
      alive = false;
    };
  }, [repoPath, harness]);

  useEffect(() => {
    if (!playbook) {
      setPlaybookSteps([]);
      return;
    }
    const target = repoPath;
    ipc
      .listPlaybookStepsForRepo(target, playbook)
      .then((steps) => {
        if (repoRef.current === target) setPlaybookSteps(steps);
      })
      .catch(() => {
        if (repoRef.current === target) setPlaybookSteps([]);
      });
  }, [repoPath, playbook]);

  // Debounced draft write — only after user edit and when setting is on.
  useEffect(() => {
    if (!draftAutosave || !dirtyRef.current || taskMutationGuard.currentKind()) return;
    const n = name.trim();
    if (!n || !playbook || !harness) return;
    const target = repoPath;
    const handle = window.setTimeout(() => {
      if (!dirtyRef.current || taskMutationGuard.currentKind()) return;
      const save = ipc
        .writeDraftForRepo({
          repoPath: target,
          draftSlug: draftSlugRef.current,
          name: n,
          description: desc,
          evidence,
          linearId,
          githubIssue,
          playbook,
          harness,
          model,
          autoAdvance,
          useWorktree,
          branchName: branchName.trim(),
          worktreeName: worktreeName.trim(),
          taskSlug,
        })
        .then((t) => {
          setDraftOrigins((origins) =>
            origins.some((origin) => origin.repoPath === target && origin.slug === t.slug) ? origins : [...origins, { repoPath: target, slug: t.slug }],
          );
          if (repoRef.current === target) setCurrentDraftSlug(t.slug);
        })
        .catch((e) => {
          if (repoRef.current === target) setErr({ msg: "Couldn't save the draft.", detail: String(e) });
        });
      draftSaveInFlightRef.current = save;
      save.finally(() => {
        if (draftSaveInFlightRef.current === save) draftSaveInFlightRef.current = null;
      });
    }, 400);
    return () => window.clearTimeout(handle);
  }, [repoPath, name, desc, evidence, linearId, githubIssue, playbook, harness, model, autoAdvance, useWorktree, branchName, worktreeName, taskSlug, draftAutosave]);

  // onDragDropEvent carries `paths` on "enter" and "drop" only, and "enter" fires first —
  // so the highlight predicate is enter||over, not drop.
  useEffect(() => {
    const un = ipc.getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropping(true);
        return;
      }
      if (event.payload.type === "leave") {
        setDropping(false);
        return;
      }
      const { paths } = event.payload;
      setDropping(false);
      dirtyRef.current = true;
      setAttachments((cur) => [...new Set([...cur, ...paths])]);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  const create = () => {
    const n = name.trim();
    if (!n || !taskSlug || !playbook || playbookNeedsReselection || modelNeedsReselection) return;
    // A create or duplicate already running owns the slot; this attempt is refused out
    // loud rather than queued behind a worktree checkout of unknown length.
    if (!taskMutationGuard.claim("create")) return;
    dirtyRef.current = false;
    setErr(null);
    const target = repoPath;
    const loading = toast.loading("Creating New Task…");
    const pendingDraftSave = draftSaveInFlightRef.current;
    const createAfterDraftSettles = () =>
      ipc.createTaskForRepo({
        repoPath: target,
        draftSlug: draftSlugRef.current,
        name: n,
        description: desc,
        evidence,
        attachments,
        linearId,
        githubIssue,
        playbook,
        harness,
        model,
        autoAdvance,
        useWorktree,
        branchName: branchName.trim(),
        worktreeName: worktreeName.trim(),
        taskSlug,
      });
    (pendingDraftSave ?? Promise.resolve())
      .then(createAfterDraftSettles)
      .then(({ task, session, attachment_errors }) => {
        // The task is on disk now, whether or not the form navigates away next.
        loading.success("Task created");
        const origins = [...draftOrigins, { repoPath: target, slug: draftSlugRef.current || task.slug }, { repoPath: target, slug: task.slug }].filter(
          (origin, index, all) => all.findIndex((item) => item.repoPath === origin.repoPath && item.slug === origin.slug) === index,
        );
        Promise.all(
          origins.map((origin) =>
            ipc.deleteDraftForRepo(origin.repoPath, origin.slug).catch(() => {
              // A promoted task is intentionally retained; cleanup is draft-only.
            }),
          ),
        );
        if (attachment_errors?.length) {
          // Navigation deferred, not cancelled — the guard is already free, but the form
          // stays up so the attachment warning is read before the task opens.
          setAttachmentErrors(attachment_errors);
          setCreated({ repoPath: target, task, session });
          return;
        }
        onCreated({ repoPath: target, task, session });
      })
      .catch((e) => {
        dirtyRef.current = true;
        loading.error(`Couldn't create the task: ${e}`);
        if (repoRef.current === target) setErr({ msg: "Couldn't create the task.", detail: String(e) });
      })
      .finally(taskMutationGuard.release);
  };

  const addAttachmentEntries = (raw: string) => {
    const next = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!next.length) return;
    dirtyRef.current = true;
    setAttachments((cur) => [...new Set([...cur, ...next])]);
    setAttachmentDraft("");
  };

  const pickAttachments = () =>
    ipc
      .pickAttachmentFilesDialog()
      .then((paths) => {
        if (paths.length) {
          dirtyRef.current = true;
          setAttachments((cur) => [...new Set([...cur, ...paths])]);
        }
      })
      .catch((e) => setErr({ msg: "Couldn't add attachments.", detail: String(e) }));

  const importLinear = () => {
    const r = ref.trim();
    if (!r) return;
    const target = repoPath;
    setImporting(true);
    setErr(null);
    setLinearId("");
    setGithubIssue("");
    // Import populates fields without marking dirty — no draft until user edits.
    dirtyRef.current = false;
    ipc
      .importLinearForRepo(target, r)
      .then((t) => {
        if (repoRef.current !== target) return;
        setName(t.title);
        if (!slugEdited) setTaskSlug(slugifyTaskName(t.title));
        setDesc(t.description);
        setLinearId(t.identifier);
        dirtyRef.current = false;
      })
      .catch((e) => {
        if (repoRef.current === target) setErr({ msg: "Couldn't import the Linear ticket.", detail: String(e) });
      })
      .finally(() => {
        if (repoRef.current === target) setImporting(false);
      });
  };

  const importGitHub = (reference = ref) => {
    const r = reference.trim();
    if (!r) return;
    const target = repoPath;
    setImporting(true);
    setErr(null);
    ipc
      .importGithubForRepo(target, r)
      .then((i) => {
        if (repoRef.current !== target) return;
        setLinearId("");
        setName(i.title);
        if (!slugEdited) setTaskSlug(slugifyTaskName(i.title));
        setDesc(i.description);
        setGithubIssue(i.reference);
        dirtyRef.current = false;
      })
      .catch((e) => {
        if (repoRef.current === target) setErr({ msg: "Couldn't import the GitHub issue or pull request.", detail: String(e) });
      })
      .finally(() => {
        if (repoRef.current === target) setImporting(false);
      });
  };

  const selectPlaybook = (key: string) => {
    dirtyRef.current = true;
    setPlaybook(key);
    setPlaybookNeedsReselection(false);
    const wf = playbooks.find((w) => w.key === key);
    setAutoAdvance((wf?.auto_advance ?? []).filter((edge) => edge.default_enabled).map((edge) => edge.key));
    setModel(defaultModel);
    setModelNeedsReselection(false);
  };

  const selectRepo = (nextRepo: string) => {
    if (nextRepo === repoPath) return;
    repoRef.current = nextRepo;
    dirtyRef.current = false;
    setRepoPath(nextRepo);
    setDraftSlug(draftOrigins.find((origin) => origin.repoPath === nextRepo)?.slug ?? "");
    setErr(null);
  };

  const clearDraft = () => {
    const slug = draftSlug;
    const reset = () => {
      dirtyRef.current = false;
      setCurrentDraftSlug("");
      setName("");
      setTaskSlug("");
      setSlugEdited(false);
      setDesc("");
      setEvidence("");
      setAttachments([]);
      setAttachmentDraft("");
      setAttachmentErrors([]);
      setCreated(null);
      setErr(null);
      setMode("inline");
      setRef("");
      setLinearId("");
      setGithubIssue("");
      setUseWorktree(true);
      setBranchName("");
      setWorktreeName("");
      setPlaybook("");
      setAutoAdvance([]);
      setModel("");
      setPlaybookNeedsReselection(false);
      setModelNeedsReselection(false);
    };
    if (!slug) {
      reset();
      return;
    }
    const target = repoPath;
    setErr(null);
    dirtyRef.current = false;
    ipc
      .deleteDraftForRepo(target, slug)
      .then(() => {
        setDraftOrigins((origins) => origins.filter((origin) => origin.repoPath !== target || origin.slug !== slug));
        reset();
      })
      .catch((e) => {
        if (repoRef.current === target) setErr({ msg: "Couldn't clear the draft.", detail: String(e) });
      });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) create();
  };

  const selectedPlaybook = playbooks.find((w) => w.key === playbook);

  // Why the create button is unavailable — shown beside it, not hidden in a tooltip.
  const createBlockedReason = !name.trim()
    ? "Type a task name first."
    : playbookNeedsReselection || modelNeedsReselection
      ? "Select any unavailable target options before creating."
      : !playbook
        ? "Select a playbook."
        : "";

  return (
    <div className="createpage createpage-with-preview" onKeyDown={onKey}>
      <div className="createform createform-page">
        <h1 className="create-title">New task</h1>
        <label className="create-field">
          <span>Repository</span>
          <select className="field-input" value={repoPath} onChange={(e) => selectRepo(e.target.value)}>
            {knownRepos.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>
        <div className="modes">
          {(["inline", "github", "linear"] as const).map((m) => (
            <button
              type="button"
              key={m}
              className={`tab${mode === m ? " on" : ""}`}
              onClick={() => {
                setMode(m);
                if (m !== "linear") setLinearId("");
                if (m !== "github") setGithubIssue("");
              }}
            >
              {m === "inline" ? "Inline" : m === "github" ? "GitHub" : "Linear"}
            </button>
          ))}
        </div>
        {mode === "linear" && (
          <div className="crow">
            <input
              className="field-input grow"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && importLinear()}
              placeholder="Linear ticket id or URL (e.g. ENG-123)…"
            />
            <button type="button" className="btn ghost small" disabled={importing} onClick={importLinear}>
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        )}
        {mode === "github" && (
          <div className="crow">
            <input
              className="field-input grow"
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                setGithubIssue("");
              }}
              onKeyDown={(e) => e.key === "Enter" && importGitHub()}
              placeholder={importing ? "Importing GitHub issue or pull request…" : "GitHub issue or pull request URL, owner/repo#123, or #123…"}
            />
            <button type="button" className="btn ghost small" disabled={importing || !ref.trim()} onClick={() => importGitHub()}>
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        )}
        <input
          ref={titleRef}
          className="field-input title"
          value={name}
          onChange={(e) => {
            dirtyRef.current = true;
            const next = e.target.value;
            setName(next);
            if (!slugEdited) setTaskSlug(slugifyTaskName(next));
          }}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="New task name…"
        />
        <label className="create-field">
          <span>Task slug</span>
          <input
            className="field-input"
            value={taskSlug}
            onChange={(e) => {
              dirtyRef.current = true;
              const next = slugifyTaskName(e.target.value);
              setTaskSlug(next);
              setSlugEdited(next !== slugifyTaskName(name));
            }}
            placeholder="task-slug"
          />
          <div className="hint">Task folder and automatic Git names. Edit to override.</div>
        </label>
        <textarea
          className="field-input description"
          rows={7}
          value={desc}
          onChange={(e) => {
            dirtyRef.current = true;
            setDesc(e.target.value);
          }}
          placeholder="Describe the feature / ticket — the original impetus every phase session reads (optional)…"
        />
        <label className="create-field">
          <span>Evidence / pointers</span>
          <textarea
            className="field-input"
            rows={4}
            value={evidence}
            onChange={(e) => {
              dirtyRef.current = true;
              setEvidence(e.target.value);
            }}
            placeholder="Logs, stack traces, repro steps, links — appended to the ticket every session reads (optional)…"
          />
        </label>
        <div className={`create-field attachments-field${dropping ? " dropping" : ""}`}>
          <span>Attachments</span>
          <div className="crow">
            <input
              className="field-input grow"
              value={attachmentDraft}
              onChange={(e) => setAttachmentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addAttachmentEntries(attachmentDraft);
                }
              }}
              placeholder="Paste file paths or http(s) URLs, comma-separated…"
            />
            <button className="btn ghost small" type="button" onClick={pickAttachments}>
              Add files…
            </button>
          </div>
          {attachments.map((entry) => (
            <div key={entry} className="attachment-row">
              <span className="attachment-row-name" title={entry}>
                {entry}
              </span>
              <button
                className="btn ghost small"
                type="button"
                onClick={() => {
                  dirtyRef.current = true;
                  setAttachments((cur) => cur.filter((x) => x !== entry));
                }}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="hint">Local files are copied into the task. URLs are recorded, never fetched. Drop files anywhere on this form.</div>
        </div>
        {(playbooks.find((w) => w.key === playbook)?.auto_advance.length ?? 0) > 0 && (
          <div className="create-field">
            <span>Auto-advance</span>
            {playbooks
              .find((w) => w.key === playbook)
              ?.auto_advance.map((edge) => (
                <Checkbox
                  key={edge.key}
                  checked={autoAdvance.includes(edge.key)}
                  onChange={(checked) => {
                    dirtyRef.current = true;
                    setAutoAdvance((cur) => (checked ? [...cur, edge.key] : cur.filter((k) => k !== edge.key)));
                  }}
                  label={edge.title}
                />
              ))}
          </div>
        )}
        <label className="create-field">
          <span>Model</span>
          <ModelInput
            harness="omp"
            repoPath={repoPath}
            value={model}
            onChange={(v) => {
              dirtyRef.current = true;
              setModel(v);
              setModelNeedsReselection(false);
            }}
            onOpenPicker={() => setPickModel(true)}
          />
          {pickModel && (
            <ProviderSetupDialog
              mode="manual"
              initialTab="models"
              unsignedOpensAccounts
              onPick={(next) => {
                dirtyRef.current = true;
                setModel(next);
                setModelNeedsReselection(false);
              }}
              onClose={() => setPickModel(false)}
            />
          )}
          {modelNeedsReselection && <InlineStatus tone="error">Select a model available in this repository.</InlineStatus>}
        </label>
        <div className="crow worktree-row">
          <Checkbox
            checked={useWorktree}
            onChange={(v) => {
              dirtyRef.current = true;
              setUseWorktree(v);
            }}
            label="Use worktree"
          />
          <input
            className="field-input worktree-input"
            value={branchName}
            onChange={(e) => {
              dirtyRef.current = true;
              setBranchName(e.target.value);
            }}
            placeholder="Branch name (optional — auto if blank or taken)"
          />
          {useWorktree && (
            <input
              className="field-input worktree-input"
              value={worktreeName}
              onChange={(e) => {
                dirtyRef.current = true;
                setWorktreeName(e.target.value);
              }}
              placeholder="Worktree folder name (optional — auto if blank or taken)"
            />
          )}
        </div>
        {!useWorktree && <InlineStatus tone="info">No worktree — the main repo's working directory switches to the new branch immediately when this task is created.</InlineStatus>}
        {attachmentErrors.length > 0 && (
          <InlineStatus tone="warning">
            Task created. Not attached:
            {attachmentErrors.map((entry) => (
              <div key={entry}>{entry}</div>
            ))}
          </InlineStatus>
        )}
        {err && (
          <InlineStatus tone="error" detail={err.detail}>
            {err.msg}
          </InlineStatus>
        )}
        <div className="create-actions">
          {created ? (
            <button className="btn" type="button" onClick={() => onCreated(created)}>
              Open task
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={!name.trim() || !taskSlug || creating || !playbook || playbookNeedsReselection || modelNeedsReselection}
              onClick={create}
            >
              {creating ? "Creating…" : "Create task"}
            </button>
          )}
          {!created && createBlockedReason && !creating && <span className="hint">{createBlockedReason}</span>}
          {draftSlug ? (
            <button className="btn ghost" onClick={clearDraft} type="button">
              Clear draft
            </button>
          ) : null}
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      <aside className="create-preview-panel" aria-labelledby="create-playbook-title">
        <div className="artifacthead">
          <div className="artifacttitle" id="create-playbook-title">
            Playbook
          </div>
          {draftSlug ? <span className="pill">Draft</span> : null}
        </div>
        <div className="playbook-panel-controls">
          <div className="playbook-panel-label">Choose a playbook</div>
          <div className="playbook-picker" role="radiogroup" aria-label="Choose playbook">
            {playbooks.length > 0 ? (
              playbooks.map((item) => (
                <label className={`playbook-option${playbook === item.key ? " selected" : ""}`} key={item.key}>
                  <input
                    checked={playbook === item.key}
                    className="playbook-option-input"
                    name="create-playbook"
                    onChange={() => selectPlaybook(item.key)}
                    type="radio"
                    value={item.key}
                  />
                  <span className="playbook-option-content">
                    <span className="playbook-option-kicker">{item.key}</span>
                    <span className="playbook-option-topline">
                      <span className="playbook-option-title">{item.title}</span>
                      <span className="playbook-option-meta">
                        {item.steps.length} {item.steps.length === 1 ? "step" : "steps"}
                      </span>
                    </span>
                    <span className="playbook-option-description">{item.description}</span>
                  </span>
                  <span aria-hidden="true" className="playbook-option-indicator" />
                </label>
              ))
            ) : (
              <div className="playbook-empty">No playbooks available in this repository.</div>
            )}
          </div>
          {playbookNeedsReselection && <InlineStatus tone="error">Select a playbook available in this repository.</InlineStatus>}
        </div>
        <PlaybookGraph title={selectedPlaybook?.title ?? playbook} steps={playbookSteps} autoAdvanceEdges={selectedPlaybook?.auto_advance} selectedAutoAdvance={autoAdvance} />
      </aside>
    </div>
  );
}
