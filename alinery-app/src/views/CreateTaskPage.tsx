import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { afterPaint } from "../afterPaint";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { Checkbox, InlineStatus, ModelInput, ompDefaultModel, orderPlaybookCandidates, playbookPickerAppearance, playbookRefKey, samePlaybookRef } from "../shared";
import * as taskMutationGuard from "../taskMutationGuard";
import { toast } from "../toast";
import type { BoardTask, DraftOrigin, PickerPreferences, PlaybookCandidate, PlaybookRef, ScopedPlaybook, TargetedCreateResult } from "../types";
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
  onBusy = () => {},
  onOpened = () => {},
  initialDraft,
  activeRepo,
  knownRepos,
}: {
  onCancel: () => void;
  onCreated: (result: TargetedCreateResult) => void | Promise<void>;
  onBusy?: (kind: "create" | "duplicate" | null) => void;
  onOpened?: () => void;
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
  const [created, setCreated] = useState<TargetedCreateResult | null>(null);
  const [err, setErr] = useState<ErrState>(null);
  const [mode, setMode] = useState<"inline" | "linear" | "github">(initialDraft?.linear_id ? "linear" : initialDraft?.github_issue ? "github" : "inline");
  const [ref, setRef] = useState(initialDraft?.linear_id || initialDraft?.github_issue || "");
  const [linearId, setLinearId] = useState(initialDraft?.linear_id ?? "");
  const [githubIssue, setGithubIssue] = useState(initialDraft?.github_issue ?? "");
  const [importing, setImporting] = useState(false);
  const [maxLiveSessions, setMaxLiveSessions] = useState(String(initialDraft?.max_live_sessions ?? 10));
  const [start, setStart] = useState(true);
  const [branchName, setBranchName] = useState(initialDraft?.branch ?? "");
  const [worktreeName, setWorktreeName] = useState(initialDraft?.has_worktree ? initialDraft.worktree : "");
  const [playbooks, setPlaybooks] = useState<PlaybookCandidate[]>([]);
  const [pickerPreferences, setPickerPreferences] = useState<PickerPreferences>({ order: [], entries: [] });
  const [playbook, setPlaybook] = useState<PlaybookRef | null>(initialDraft?.playbook_ref ?? null);
  const [selectedSource, setSelectedSource] = useState<ScopedPlaybook | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const resetAutoAdvance = useRef(!initialDraft);
  const [autoAdvance, setAutoAdvance] = useState<string[]>(initialDraft?.auto_advance ?? []);
  const harness = "omp";
  const [model, setModel] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [draftAutosave, setDraftAutosave] = useState(true);
  const [draftSlug, setDraftSlug] = useState(initialDraft?.slug ?? "");
  const [draftOrigins, setDraftOrigins] = useState<DraftOrigin[]>(initialDraft ? [{ repoPath: initialDraft.repo_path, slug: initialDraft.slug }] : []);
  const mutationKind = useSyncExternalStore(taskMutationGuard.subscribe, taskMutationGuard.currentKind);
  const [playbookNeedsReselection, setPlaybookNeedsReselection] = useState(false);
  const [modelNeedsReselection, setModelNeedsReselection] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const draftSaveInFlightRef = useRef<Promise<void>>(Promise.resolve());
  const draftIdentities = useRef(new Map(initialDraft ? [[initialDraft.repo_path, initialDraft.slug]] : []));
  const draftWriteGeneration = useRef(0);
  const targetRequest = useRef(0);
  const modelRequest = useRef(0);
  const initialTargetLoaded = useRef(false);
  const repoRef = useRef(repoPath);
  const ticketLoaded = useRef(false);
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  // dirty only after a real user edit (or reopen of an existing draft).
  const dirtyRef = useRef(!!initialDraft);
  const cap = Number(maxLiveSessions);
  const validCap = /^\d+$/.test(maxLiveSessions) && Number.isInteger(cap) && cap > 0 && cap <= 4_294_967_295;

  // The busy flag is the shared guard, not this component's own: a create started from
  // the ⌘N form and a duplicate started from a board are the same slot.
  const creating = mutationKind === "create";

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
    setCatalogLoading(true);
    setSelectedSource(null);
    Promise.all([ipc.readConfigForRepo(repoPath), ipc.listPlaybookCatalog(repoPath)])
      .then(async ([c, catalog]) => {
        if (!alive || request !== targetRequest.current) return;
        setDraftAutosave(c.defaults.draft_autosave !== false);
        setPlaybooks(orderPlaybookCandidates(catalog.candidates, catalog.picker_preferences));
        setPickerPreferences(catalog.picker_preferences);
        setDefaultModel(ompDefaultModel(c.defaults));
        if (catalog.diagnostics.length) {
          setErr({ msg: "Some playbook sources could not be loaded.", detail: catalog.diagnostics.map((diagnostic) => diagnostic.message).join("\n") });
        }
        const choice = initialTargetLoaded.current ? playbook : initialDraft ? initialDraft.playbook_ref : c.defaults.playbook;
        const candidate = catalog.candidates.find((item) => samePlaybookRef(item.source.reference, choice));
        setPlaybook(choice ?? null);
        setPlaybookNeedsReselection(!candidate || candidate.diagnostics.length > 0);
        if (!initialTargetLoaded.current) {
          initialTargetLoaded.current = true;
          setModel(initialDraft?.launch_defaults?.model ?? ompDefaultModel(c.defaults));
          setModelNeedsReselection(false);
        }
        setCatalogLoading(false);
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
        if (alive && request === targetRequest.current) {
          setCatalogLoading(false);
          setPlaybookNeedsReselection(true);
          setErr({ msg: "Couldn't load repository settings.", detail: String(e) });
        }
      })
      .finally(() => {
        if (alive && request === targetRequest.current) onOpenedRef.current();
      });
    return () => {
      alive = false;
    };
  }, [repoPath, catalogRevision]);

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
    let alive = true;
    setSelectedSource(null);
    setSourceError("");
    if (!playbook || catalogLoading || playbookNeedsReselection) return;
    ipc
      .readPlaybook(playbook, repoPath)
      .then((source) => {
        if (!alive || !samePlaybookRef(source.source.reference, playbook)) return;
        setSelectedSource(source);
        if (resetAutoAdvance.current) {
          setAutoAdvance(source.definition.step.filter((step) => step.auto_advance_default).map((step) => step.key));
          resetAutoAdvance.current = false;
        } else {
          const stepKeys = new Set(source.definition.step.map((step) => step.key));
          setAutoAdvance((current) => current.filter((key) => stepKeys.has(key)));
        }
      })
      .catch((error) => {
        if (alive) setSourceError(String(error));
      });
    return () => {
      alive = false;
    };
  }, [repoPath, playbook, catalogLoading, playbookNeedsReselection, catalogRevision]);

  // Debounced draft write — only after user edit and when setting is on.
  useEffect(() => {
    if (!draftAutosave || !dirtyRef.current || creatingRef.current || taskMutationGuard.currentKind() || !validCap) return;
    const n = name.trim();
    if (!n || !playbook || !harness) return;
    const target = repoPath;
    const generation = draftWriteGeneration.current;
    const handle = window.setTimeout(() => {
      if (!dirtyRef.current || creatingRef.current || taskMutationGuard.currentKind() || generation !== draftWriteGeneration.current) return;
      const save = draftSaveInFlightRef.current
        .then(async () => {
          if (creatingRef.current || taskMutationGuard.currentKind() || generation !== draftWriteGeneration.current) return;
          const t = await ipc.writeDraftForRepo({
            repoPath: target,
            draftSlug: draftIdentities.current.get(target) ?? "",
            name: n,
            description: desc,
            evidence,
            linearId,
            githubIssue,
            playbook,
            harness,
            model,
            autoAdvance,
            maxLiveSessions: cap,
            branchName: branchName.trim(),
            worktreeName: worktreeName.trim(),
            taskSlug,
          });
          draftIdentities.current.set(target, t.slug);
          setDraftOrigins((origins) =>
            origins.some((origin) => origin.repoPath === target && origin.slug === t.slug) ? origins : [...origins, { repoPath: target, slug: t.slug }],
          );
          if (repoRef.current === target) setDraftSlug(t.slug);
        })
        .catch((e) => {
          if (repoRef.current === target) setErr({ msg: "Couldn't save the draft.", detail: String(e) });
        });
      draftSaveInFlightRef.current = save;
    }, 400);
    return () => window.clearTimeout(handle);
  }, [
    repoPath,
    name,
    desc,
    evidence,
    linearId,
    githubIssue,
    playbook,
    harness,
    model,
    autoAdvance,
    branchName,
    worktreeName,
    taskSlug,
    draftAutosave,
    maxLiveSessions,
    mutationKind,
  ]);

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

  const sourceReady = selectedSource !== null && samePlaybookRef(selectedSource.source.reference, playbook) && !catalogLoading && !playbookNeedsReselection;
  const create = () => {
    const n = name.trim();
    if (!n || !taskSlug || !sourceReady || !selectedSource || modelNeedsReselection || !validCap) return;
    if (creatingRef.current) {
      taskMutationGuard.refuseIfBusy();
      return;
    }
    // A create or duplicate already running owns the slot; refuse rather than queue.
    if (!taskMutationGuard.claim("create")) return;
    creatingRef.current = true;
    draftWriteGeneration.current += 1;
    dirtyRef.current = false;
    const target = repoPath;
    flushSync(() => {
      onBusy("create");
      setErr(null);
    });
    let provisioningRequested = false;
    let resultReceived = false;
    afterPaint()
      .then(() => draftSaveInFlightRef.current)
      .then(async () => {
        const prepared = await ipc.prepareTaskAttachments(attachments);
        provisioningRequested = true;
        return ipc.createTaskForRepo({
          repoPath: target,
          request: {
            ...prepared,
            draft_slug: draftIdentities.current.get(target) || undefined,
            name: n,
            description: desc,
            evidence,
            linear_id: linearId,
            github_issue: githubIssue,
            related_tasks: initialDraft?.related_tasks ?? [],
            playbook: { reference: selectedSource.source.reference, source: selectedSource.source_text },
            launch_defaults: { harness, model },
            auto_advance_steps: autoAdvance,
            max_live_sessions: cap,
            start,
            branch_name: branchName.trim() || undefined,
            worktree_name: worktreeName.trim() || undefined,
            requested_slug: taskSlug,
          },
        });
      })
      .then(async (result) => {
        resultReceived = true;
        setCreated({ ...result, repoPath: target });
        if (result.creation !== "ready" || !result.task || result.start === "failed" || result.errors.length) {
          toast.error(`Task creation needs attention: ${result.errors.map((error) => error.message).join("; ") || "Inspect the creation result."}`);
        } else {
          toast.success("Task created");
        }
        if (result.creation === "ready" && result.task) {
          const origins = [...draftOrigins, ...Array.from(draftIdentities.current, ([originRepo, slug]) => ({ repoPath: originRepo, slug }))];
          for (const origin of origins) {
            void ipc.deleteDraftForRepo(origin.repoPath, origin.slug).catch(() => {
              // Deletion is draft-only; a promoted task is never removed.
            });
          }
          if (result.start !== "failed" && result.errors.length === 0 && !result.attachment_errors?.length) {
            await onCreated({ ...result, repoPath: target });
          }
        }
      })
      .catch((e) => {
        if (resultReceived) {
          toast.error(`Couldn't open the task: ${e}`);
          setErr({ msg: "Couldn't open the task.", detail: String(e) });
        } else if (provisioningRequested) {
          // A lost reply can follow durable provisioning. Never blindly retry it.
          toast.error(`Creation outcome is unknown. Inspect the repository before creating another task: ${e}`);
          setErr({ msg: "Creation outcome is unknown. Inspect the repository before creating another task.", detail: String(e) });
        } else {
          creatingRef.current = false;
          dirtyRef.current = true;
          toast.error(`Couldn't prepare task attachments. No creation was requested: ${e}`);
          setErr({ msg: "Couldn't prepare task attachments. No creation was requested.", detail: String(e) });
        }
      })
      .finally(() => {
        taskMutationGuard.release();
        onBusy(null);
      });
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

  const selectPlaybook = (reference: PlaybookRef) => {
    dirtyRef.current = true;
    resetAutoAdvance.current = true;
    setSelectedSource(null);
    setPlaybook(reference);
    setPlaybookNeedsReselection(false);
    setAutoAdvance([]);
    setModel(defaultModel);
    setModelNeedsReselection(false);
  };

  const selectRepo = (nextRepo: string) => {
    if (nextRepo === repoPath) return;
    repoRef.current = nextRepo;
    dirtyRef.current = false;
    setRepoPath(nextRepo);
    setDraftSlug(draftIdentities.current.get(nextRepo) ?? "");
    setImporting(false);
    setErr(null);
  };

  const clearDraft = () => {
    if (creatingRef.current) return;
    const slug = draftSlug;
    draftWriteGeneration.current += 1;
    const reset = () => {
      dirtyRef.current = false;
      setDraftSlug("");
      setName("");
      setTaskSlug("");
      setSlugEdited(false);
      setDesc("");
      setEvidence("");
      setAttachments([]);
      setAttachmentDraft("");
      draftIdentities.current.delete(repoPath);
      setCreated(null);
      setErr(null);
      setMode("inline");
      setRef("");
      setLinearId("");
      setGithubIssue("");
      setBranchName("");
      setWorktreeName("");
      setPlaybook(null);
      setSelectedSource(null);
      setAutoAdvance([]);
      setModel("");
      setPlaybookNeedsReselection(false);
      setModelNeedsReselection(false);
    };
    const target = repoPath;
    setErr(null);
    dirtyRef.current = false;
    draftSaveInFlightRef.current
      .then(() => {
        const storedSlug = draftIdentities.current.get(target) ?? slug;
        if (storedSlug) return ipc.deleteDraftForRepo(target, storedSlug);
      })
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

  const selectedPlaybook = playbooks.find((item) => samePlaybookRef(item.source.reference, playbook));

  // Why the create button is unavailable — shown beside it, not hidden in a tooltip.
  const createBlockedReason = !name.trim()
    ? "Type a task name first."
    : !validCap
      ? "Maximum live sessions must be a positive whole number no greater than 4294967295."
      : playbookNeedsReselection
        ? "The selected or configured playbook is unavailable or invalid. Choose a valid scoped playbook."
        : modelNeedsReselection
          ? "Select a model available in this repository."
          : !sourceReady
            ? sourceError || "Select a playbook and wait for its validated source."
            : "";

  return (
    <div className="createpage createpage-with-preview" onKeyDown={onKey}>
      <div className="createform createform-page">
        <h1 className="create-title">New task</h1>
        <label className="create-field">
          <span>Repository</span>
          <select className="field-input" value={repoPath} disabled={creating} onChange={(e) => selectRepo(e.target.value)}>
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
        {!!selectedSource?.definition.step.length && (
          <div className="create-field">
            <span>Automatic completion permission for future executions</span>
            {selectedSource.definition.step.map((step) => (
              <Checkbox
                key={step.key}
                checked={autoAdvance.includes(step.key)}
                onChange={(checked) => {
                  dirtyRef.current = true;
                  setAutoAdvance((cur) => (checked ? [...cur, step.key] : cur.filter((key) => key !== step.key)));
                }}
                label={step.title}
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
          <span>Dedicated task worktree</span>
          <input
            className="field-input worktree-input"
            value={branchName}
            onChange={(e) => {
              dirtyRef.current = true;
              setBranchName(e.target.value);
            }}
            placeholder="Branch name (optional — auto if blank or taken)"
          />
          <input
            className="field-input worktree-input"
            value={worktreeName}
            onChange={(e) => {
              dirtyRef.current = true;
              setWorktreeName(e.target.value);
            }}
            placeholder="Worktree folder name (optional — auto if blank or taken)"
          />
        </div>
        <label className="create-field">
          <span>Maximum live sessions</span>
          <input className="field-input" type="number" min="1" max="4294967295" step="1" value={maxLiveSessions} onChange={(event) => setMaxLiveSessions(event.target.value)} />
        </label>
        <Checkbox checked={start} onChange={setStart} label="Start eligible sessions after creation" />
        {created && (
          <section aria-label="Creation result">
            <InlineStatus tone={created.creation === "partial" || created.start === "failed" ? "warning" : "info"}>
              Creation: {created.creation}. Start: {created.start}.
            </InlineStatus>
            {created.errors.map((error) => (
              <InlineStatus key={`${error.stage}:${error.code}:${error.message}`} tone="error" detail={error.code}>
                {error.stage}: {error.message}
              </InlineStatus>
            ))}
            {created.attachment_errors?.map((error) => (
              <InlineStatus key={error} tone="warning">
                {error}
              </InlineStatus>
            ))}
            {created.sessions.map((session) => (
              <button className="btn ghost" type="button" key={session.id} disabled={!created.task} onClick={() => onCreated({ ...created, selectedSessionId: session.id })}>
                Open session {session.id}
              </button>
            ))}
            {created.executions.map((execution) => (
              <div key={execution.id}>
                {execution.candidate.step_key}: {execution.lifecycle}
                {execution.error ? ` — ${execution.error}` : ""}
              </div>
            ))}
            {!created.task && <InlineStatus tone="warning">No task identity was returned. Inspect the repository before trying again.</InlineStatus>}
          </section>
        )}
        {creating && <InlineStatus tone="info">Creating New Task… You can keep using Alinery while the worktree is set up.</InlineStatus>}
        {err && (
          <InlineStatus tone="error" detail={err.detail}>
            {err.msg}
          </InlineStatus>
        )}
        <div className="create-actions">
          {created ? (
            <button className="btn" type="button" disabled={!created.task} onClick={() => onCreated(created)}>
              Open task
            </button>
          ) : (
            <button type="button" className="btn" disabled={creating || creatingRef.current || !!createBlockedReason || !taskSlug} onClick={create}>
              {creating ? "Creating…" : "Create task"}
            </button>
          )}
          {!created && createBlockedReason && !creating && <span className="hint">{createBlockedReason}</span>}
          {draftSlug ? (
            <button className="btn ghost" disabled={creating || creatingRef.current} onClick={clearDraft} type="button">
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
          <button type="button" className="btn ghost small" disabled={creating} onClick={() => setCatalogRevision((revision) => revision + 1)}>
            Refresh playbooks
          </button>
          <div className="playbook-picker" role="radiogroup" aria-label="Choose playbook">
            {playbooks.length > 0 ? (
              playbooks.map((item) => {
                const preference = pickerPreferences.entries.find((entry) => samePlaybookRef(entry.reference, item.source.reference));
                if (preference?.hidden && !item.diagnostics.length && !samePlaybookRef(playbook, item.source.reference)) return null;
                const appearance = playbookPickerAppearance(item.source.reference, preference);
                return (
                  <label
                    className={`playbook-option${samePlaybookRef(playbook, item.source.reference) ? " selected" : ""}`}
                    key={playbookRefKey(item.source.reference)}
                    style={{ borderColor: appearance.color }}
                  >
                    <input
                      checked={samePlaybookRef(playbook, item.source.reference)}
                      disabled={creating || item.diagnostics.length > 0}
                      className="playbook-option-input"
                      name="create-playbook"
                      onChange={() => selectPlaybook(item.source.reference)}
                      type="radio"
                      value={playbookRefKey(item.source.reference)}
                    />
                    <span className="playbook-option-content">
                      <span className="playbook-option-kicker">{playbookRefKey(item.source.reference)}</span>
                      <span className="playbook-option-topline">
                        <span className="playbook-option-title">{item.title ?? item.source.reference.key}</span>
                        <span className="pill" style={{ borderColor: appearance.color }}>
                          {appearance.badge}
                        </span>
                        <span className="playbook-option-meta">
                          {item.modified_at_ms == null ? "Modification time unavailable" : new Date(item.modified_at_ms).toLocaleString()}
                        </span>
                      </span>
                      <span className="playbook-option-description">{item.description}</span>
                      {item.diagnostics.map((diagnostic) => (
                        <span key={`${diagnostic.code}:${diagnostic.field}:${diagnostic.line}:${diagnostic.message}`}>{diagnostic.message}</span>
                      ))}
                    </span>
                    <span aria-hidden="true" className="playbook-option-indicator" />
                  </label>
                );
              })
            ) : (
              <div className="playbook-empty">No playbooks available in this repository.</div>
            )}
          </div>
          {playbookNeedsReselection && <InlineStatus tone="error">The selected or configured playbook is unavailable or invalid. Choose a valid scoped playbook.</InlineStatus>}
          {sourceError && <InlineStatus tone="error">{sourceError}</InlineStatus>}
        </div>
        {selectedSource && (
          <PlaybookGraph title={selectedPlaybook?.title ?? selectedSource.definition.title} steps={selectedSource.definition.step} selectedAutoAdvance={autoAdvance} />
        )}
      </aside>
    </div>
  );
}
