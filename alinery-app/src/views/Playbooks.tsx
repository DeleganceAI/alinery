import { Activity, ArrowLeft, Compass, Download, GitBranch, Hand, Layers, type LucideIcon, Star, Triangle, Upload, User, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./Playbooks.css";
import { askConfirm, confirmDanger } from "../confirm";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { PlaybookRing, PlaybookRingMark, placeholderSteps, RingReadout, readsEach } from "../PlaybookRing";
import { PlaybookSourceEditor } from "../PlaybookSourceEditor";
import { type LibraryRow, libraryRows, lineDiff, originLabel, SIGNAL_STATES, statusOf } from "../playbookLibrary";
import { Checkbox, Dialog, InlineStatus, LoadingState, playbookRefKey, repoName, samePlaybookRef, starredPlaybookKeys, withPlaybookStar } from "../shared";
import * as community from "../sync/community";
import {
  deletePlaybookSource,
  listPlaybookCatalog,
  readPlaybook,
  renderPlaybookSource,
  restoreBundledPlaybook,
  savePlaybookPickerPreferences,
  savePlaybookSource,
  validatePlaybookSource,
} from "../sync/playbooks";
import { toast } from "../toast";
import type {
  CommunityImportRow,
  CommunitySummary,
  DownloadStatusRow,
  NormalizedPlaybook,
  NormalizedStep,
  PickerPreferences,
  PlaybookCatalog,
  PlaybookRef,
  PlaybookValidationError,
  PublicationLink,
  ScopedPlaybook,
} from "../types";

const blankDefinition: NormalizedPlaybook = {
  version: 2,
  key: "new-playbook",
  title: "New playbook",
  description: "",
  default_model: "",
  default_harness: "vinculum",
  step: [
    {
      key: "work",
      title: "Work",
      short: "Work",
      is_coding_step: false,
      auto_advance_default: false,
      inputs: [{ path: "ticket.md", mode: "single" }],
      outputs: [{ path: "result.md" }],
      model: "",
      harness: "",
      prompt: "Read the assigned inputs and write the assigned result.\n",
    },
  ],
  preamble: "",
  section_order: ["work"],
};
const scopeLabels = { repo: "Repository", global: "Global", bundled: "Bundled" };
const catalogContains = (catalog: PlaybookCatalog, reference: PlaybookRef) => catalog.candidates.some((candidate) => samePlaybookRef(candidate.source.reference, reference));
// The accounts contract's label rule (^[a-z0-9][a-z0-9-]{1,31}$), one home for both
// the client-side guard and the field's own state.
const labelPattern = /^[a-z0-9][a-z0-9-]{1,31}$/;
// A rejected save/import/publish throws its validation result, so the diagnostics ride
// along on the error. Keep only well-formed entries.
const validationDiagnostics = (error: unknown): PlaybookValidationError[] => {
  if (typeof error !== "object" || error === null || !("diagnostics" in error)) return [];
  const raw = error.diagnostics;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PlaybookValidationError => item !== null && typeof item === "object" && typeof item.code === "string" && typeof item.message === "string");
};
// One diagnostic per line (see .inline-status-msg, which keeps the breaks). The raw
// result object is unreadable and repeats the field names the messages already carry.
const errorText = (error: unknown) => {
  const diagnostics = validationDiagnostics(error);
  if (diagnostics.length > 0) {
    return diagnostics.map((item) => `${item.code}: ${item.message}${item.line === null ? "" : ` · line ${item.line}`}`).join("\n");
  }
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string" && error.message) return error.message;
    return JSON.stringify(error);
  }
  return String(error);
};

// The rail: Library slices by origin, Signals only while something needs you, Community for what is not here yet.
type View = "all" | "starred" | "mine" | "downloaded" | "team" | "alinery" | "update" | "changed" | "diverged" | "withdrawn" | "explore" | "listings";
const VIEWS: { key: View; group: "Library" | "Signals" | "Community"; label: string; icon: LucideIcon; test?: (row: LibraryRow, starred: Set<string>) => boolean }[] = [
  { key: "all", group: "Library", label: "All", icon: Layers, test: (row) => row.state !== "remote" },
  { key: "starred", group: "Library", label: "Starred", icon: Star, test: (row, starred) => starred.has(row.id) },
  { key: "mine", group: "Library", label: "Mine", icon: User, test: (row) => row.origin.kind === "mine" && row.state !== "remote" },
  { key: "downloaded", group: "Library", label: "Downloaded", icon: Download, test: (row) => row.origin.kind === "download" },
  { key: "team", group: "Library", label: "Team", icon: GitBranch, test: (row) => row.origin.kind === "team" },
  { key: "alinery", group: "Library", label: "Alinery", icon: Triangle, test: (row) => row.origin.kind === "alinery" },
  { key: "update", group: "Signals", label: "Updates", icon: Activity, test: (row) => row.state === "update" },
  { key: "changed", group: "Signals", label: "Not published", icon: Activity, test: (row) => row.state === "changed" },
  { key: "diverged", group: "Signals", label: "Edited, update waiting", icon: Activity, test: (row) => row.state === "diverged" },
  { key: "withdrawn", group: "Signals", label: "Withdrawn", icon: Activity, test: (row) => row.state === "withdrawn" },
  { key: "explore", group: "Community", label: "Explore", icon: Compass },
  { key: "listings", group: "Community", label: "Your listings", icon: Upload, test: (row) => row.publication !== null },
];
const NOTES: Record<LibraryRow["state"], string> = {
  builtin: "Built-ins update with the app. A copy is yours: it never changes underneath you.",
  team: "Your team's version, committed in alinery/playbooks and changed through git. Copy it to experiment without touching the repo.",
  broken: "This definition doesn't read. Fix the file, then come back to the library.",
  yours: "Sign in to see whether this is published.",
  private: "Only on this machine. Publishing makes it a community listing.",
  live: "This file is exactly what people download.",
  changed: "You saved changes after publishing. People download the last published version until you publish again.",
  remote: "Your listing has no copy on this machine. Download it to edit and republish.",
  downloaded: "Not checked against the community yet.",
  synced: "Unedited and current.",
  edited: "You edited this copy. An update from the author asks before it overwrites your edits.",
  update: "Your copy is unedited, so updating replaces it.",
  diverged: "Both sides moved. Compare shows the author's changes against yours: take theirs, or keep yours as your own playbook.",
  withdrawn: "The author removed the listing. Your copy still works; keep it as yours to stop tracking the listing.",
};

function StatusLed({ row }: { row: LibraryRow }) {
  const { label, tone } = statusOf(row);
  return (
    <span className={`pb-status t-${tone}`}>
      <span className="pb-led" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function Track({ nodes }: { nodes: { label: string; value: ReactNode; lit: boolean }[] }) {
  return (
    <ol className="pb-track" aria-label="Lineage">
      {nodes.map((node) => (
        <li key={node.label} className={node.lit ? "lit" : "off"}>
          <span className="pb-dot" aria-hidden="true" />
          <span>
            <span className="pb-track-label">{node.label}</span>
            <span className="pb-track-value">{node.value}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepChips({ steps, active, onActive }: { steps: NormalizedStep[]; active: string | null; onActive: (key: string) => void }) {
  return (
    <div className="pb-steps" role="group" aria-label="Steps">
      {steps.map((step, index) => (
        <button
          key={step.key}
          type="button"
          className={[!step.auto_advance_default && "cp", readsEach(step) && "each", active === step.key && "cur"].filter(Boolean).join(" ")}
          aria-pressed={active === step.key}
          onClick={() => onActive(step.key)}
          onMouseEnter={() => onActive(step.key)}
        >
          {index + 1} · {step.title}
        </button>
      ))}
    </div>
  );
}

function RingLegend() {
  return (
    <dl className="pb-legend">
      <div>
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <path d="M4 22 A10 10 0 1 1 24 22" className="lg-ring" />
          <circle cx="4" cy="22" r="3" className="lg-node" />
          <circle cx="24" cy="22" r="3" className="lg-node" />
        </svg>
        <dt>The ring</dt>
        <dd>Steps in order. A dashed green arc means it loops back for another pass.</dd>
      </div>
      <div>
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <path d="M5 20 Q14 6 23 20" className="lg-chord" />
          <path d="M6 24 A12 12 0 0 1 22 24" className="lg-rail" />
        </svg>
        <dt>What it reads</dt>
        <dd>A chord carries one file forward. A dashed rail is context many later steps read.</dd>
      </div>
      <div>
        <svg viewBox="0 0 28 28" aria-hidden="true">
          <circle cx="17" cy="11" r="6" className="lg-node" opacity=".5" />
          <circle cx="14" cy="14" r="6" className="lg-node" />
        </svg>
        <dt>Fan out</dt>
        <dd>A stacked node runs one agent per item, all at once, then merges.</dd>
      </div>
      <div>
        <Hand className="lg-hand" aria-hidden="true" />
        <dt>You</dt>
        <dd>A hand waits for you. Nothing moves on until you say so.</dd>
      </div>
    </dl>
  );
}

export function Playbooks({ repoPath, onCreateTask }: { repoPath?: string; onCreateTask: (reference: PlaybookRef) => void }) {
  const [catalog, setCatalog] = useState<PlaybookCatalog | null>(null);
  const [selected, setSelected] = useState<ScopedPlaybook | null>(null);
  const [editorRepoPath, setEditorRepoPath] = useState(repoPath);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"repo" | "global">(repoPath ? "repo" : "global");
  const [key, setKey] = useState("new-playbook");
  const [mode, setMode] = useState<"ring" | "graph" | "source">("ring");
  const [graphFraction, setGraphFraction] = useState(2 / 3);
  const [view, setView] = useState<View>("all");
  // A row id in the library views, a listing id in Explore.
  const [chosen, setChosen] = useState<string | null>(null);
  // The step the rings and chips agree on. Hover sets it and leaving keeps it, so the readout stays put.
  const [step, setStep] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [diagnostics, setDiagnostics] = useState<PlaybookValidationError[]>([]);
  const [error, setError] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [preferenceError, setPreferenceError] = useState("");
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const preferenceGeneration = useRef(0);
  const pendingPreference = useRef<number | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [imports, setImports] = useState<CommunityImportRow[]>([]);
  const [published, setPublished] = useState<PublicationLink[]>([]);
  // null = closed. Opened before the reads so the click is never silent.
  const [compare, setCompare] = useState<{ row: LibraryRow; mine: string; theirs: string; version: number | null; error: string } | null>(null);
  const [downloads, setDownloads] = useState<DownloadStatusRow[] | null>(null);
  const [communityPlaybooks, setCommunityPlaybooks] = useState<CommunitySummary[]>([]);
  // The cursor and the query that minted it, together: a cursor from another query would
  // page the current one from the old one's position, and the answer would be committed as
  // if it belonged to the current query.
  const [communityPage, setCommunityPage] = useState<{ query: string; cursor: string | null }>({ query: "", cursor: null });
  const [communityReady, setCommunityReady] = useState(false);
  const [communityError, setCommunityError] = useState("");
  const [minePlaybooks, setMinePlaybooks] = useState<CommunitySummary[]>([]);
  const [mineTruncated, setMineTruncated] = useState(false);
  const [mineReady, setMineReady] = useState(false);
  const [mineError, setMineError] = useState("");
  const [communitySignedIn, setCommunitySignedIn] = useState<boolean | null>(null);
  const [signupOpen, setSignupOpen] = useState(false);
  // True only while this dialog has a pairing in flight, so Cancel knows what to cancel.
  const [signupPairing, setSignupPairing] = useState(false);
  const signupGeneration = useRef(0);
  const [publishConfirm, setPublishConfirm] = useState<{ reference: PlaybookRef; playbookKey: string; title: string; fromVersion: number | null } | null>(null);
  // null = closed. Opened before the fetch so the click is never silent; source stays
  // empty until the document arrives.
  const [preview, setPreview] = useState<{ name: string; source: string; error: string } | null>(null);
  const [attest, setAttest] = useState(false);
  const [publishLabel, setPublishLabel] = useState("");
  const [showPublishLabel, setShowPublishLabel] = useState(false);
  const [publishMessage, setPublishMessage] = useState("");
  const [publishDiagnostics, setPublishDiagnostics] = useState<PlaybookValidationError[]>([]);
  const pendingSignup = useRef<(() => Promise<void>) | null>(null);
  const editedImports = useRef(new Set<string>());
  const communityGeneration = useRef(0);
  const mineGeneration = useRef(0);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLElement>(null);
  const libraryScrollTop = useRef(0);
  const returningToLibrary = useRef(false);
  const currentRepo = useRef(repoPath);
  currentRepo.current = repoPath;
  const dirty = open && (!selected || source !== selected.source_text);
  const readOnly = selected?.source.reference.scope === "bundled";
  const communityQuery = view === "explore" ? query.trim().replace(/^@\s*/, "") : "";
  const createTaskDisabledReason = dirty
    ? "Save this playbook's changes before creating a task."
    : !repoPath
      ? "Select a repository before creating a task."
      : editorRepoPath !== repoPath
        ? `Return to ${editorRepoPath || "the selected definition's repository"} before creating a task.`
        : busy
          ? "Wait for the current playbook operation to finish."
          : "";

  useEffect(() => {
    let live = true;
    setCatalog(null);
    setCatalogError("");
    setPreferenceError("");
    setPreferenceSaving(false);
    pendingPreference.current = null;
    listPlaybookCatalog(repoPath)
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch((e) => {
        if (live) setCatalogError(errorText(e));
      });
    setDownloads(null);
    if (repoPath) {
      community
        .listCommunityImports({ repoPath })
        .then((value) => {
          if (!live) return;
          setImports(value.imports);
          setPublished(value.published);
        })
        .catch(() => {
          if (!live) return;
          setImports([]);
          setPublished([]);
        });
      // Until the community answers, a download reads as its version alone.
      community
        .communityDownloadStatus({ repoPath })
        .then((value) => {
          if (live) setDownloads(value.rows);
        })
        .catch(() => {});
    } else if (live) {
      setImports([]);
      setPublished([]);
    }
    return () => {
      live = false;
      preferenceGeneration.current += 1;
    };
  }, [repoPath]);

  useEffect(() => {
    if (open) detailRef.current?.focus({ preventScroll: true });
  }, [open, selected]);

  useLayoutEffect(() => {
    if (open || !returningToLibrary.current) return;
    returningToLibrary.current = false;
    if (libraryRef.current) libraryRef.current.scrollTop = libraryScrollTop.current;
    searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (view !== "explore" || communityQuery.length > 80) return;
    const generation = communityGeneration.current + 1;
    communityGeneration.current = generation;
    let live = true;
    const timer = setTimeout(
      () => {
        const args = communityQuery ? { q: communityQuery } : {};
        void Promise.resolve(ipc.listCommunityPlaybooks(args))
          .then((page) => {
            if (!live || generation !== communityGeneration.current) return;
            if (page) {
              setCommunityPlaybooks(page.playbooks);
              setCommunityPage({ query: communityQuery, cursor: page.nextCursor });
            }
            setCommunityError("");
            setCommunityReady(true);
          })
          .catch((error) => {
            if (!live || generation !== communityGeneration.current) return;
            setCommunityError(errorText(error));
            setCommunityReady(true);
          });
      },
      communityQuery ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, communityQuery]);

  const reloadMine = useCallback(async () => {
    const generation = mineGeneration.current + 1;
    mineGeneration.current = generation;
    try {
      const result = await ipc.listMyCommunityPlaybooks();
      if (generation !== mineGeneration.current || !result) return;
      if (result.kind === "needs_account") {
        setCommunitySignedIn(false);
        setMineReady(true);
        return;
      }
      if (result.kind === "failed") {
        setMineError(result.message);
        setMineReady(true);
        return;
      }
      setMinePlaybooks(result.playbooks);
      setMineTruncated(result.truncated);
      setMineError("");
      setCommunitySignedIn(true);
      setMineReady(true);
    } catch (error) {
      if (generation !== mineGeneration.current) return;
      setMineError(errorText(error));
      setMineReady(true);
    }
  }, []);

  // Your listings are read up front: whether a playbook is published is part of its status everywhere.
  useEffect(() => {
    let live = true;
    void ipc
      .accountStatus()
      .then((status) => {
        if (!live) return;
        if (!status.signedIn) {
          setCommunitySignedIn(false);
          setMineReady(true);
          return;
        }
        setCommunitySignedIn(true);
        void reloadMine();
      })
      .catch((error) => {
        if (!live) return;
        setMineError(errorText(error));
        setMineReady(true);
      });
    return () => {
      live = false;
      mineGeneration.current += 1;
    };
  }, [reloadMine]);

  const refresh = async (owner: string | undefined) => {
    try {
      const value = await listPlaybookCatalog(owner);
      if (currentRepo.current === owner) {
        setCatalog(value);
        setCatalogError("");
      }
    } catch (e) {
      if (currentRepo.current === owner) setCatalogError(errorText(e));
    }
  };
  const discard = async () =>
    !dirty ||
    (await askConfirm({
      title: "Discard unsaved playbook changes?",
      body: `The saved definition in ${editorRepoPath || "the global library"} will remain unchanged.`,
      choices: [
        { key: "discard", label: "Discard", tone: "danger" },
        { key: "cancel", label: "Keep editing", tone: "ghost" },
      ],
    })) === "discard";
  const install = (value: ScopedPlaybook, owner: string | undefined) => {
    setEditorRepoPath(owner);
    setSelected(value);
    setSource(value.source_text);
    setDiagnostics([]);
    setOpen(true);
  };
  const load = async (reference: PlaybookRef) => {
    if (busy || !(await discard())) return;
    const owner = repoPath;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      install(await readPlaybook(reference, owner), owner);
      setMode("ring");
      setStep(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // A copy starts from the open definition, or from `from` when the inspector copies a closed one.
  const begin = async (kind: "new" | "paste" | "copy" | "file", file?: File, from?: ScopedPlaybook) => {
    if (busy || !(await discard())) return;
    const owner = kind === "copy" && !from ? editorRepoPath : repoPath;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const content =
        kind === "new" ? await renderPlaybookSource(blankDefinition) : kind === "copy" ? (from?.source_text ?? source) : kind === "file" && file ? await file.text() : "";
      const checked = content ? await validatePlaybookSource(content) : null;
      setEditorRepoPath(owner);
      setSelected(null);
      setSource(content);
      setOpen(true);
      setMode("source");
      setScope(owner ? "repo" : "global");
      setKey(kind === "copy" ? `${checked?.definition?.key || "playbook"}-copy` : checked?.definition?.key || (kind === "new" ? "new-playbook" : "imported-playbook"));
      setDiagnostics(checked?.diagnostics || []);
      setShowImport(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const validate = async () => {
    const checked = await validatePlaybookSource(source);
    setDiagnostics(checked.diagnostics);
    return checked.definition;
  };
  const save = async () => {
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    setNotice("");
    const owner = editorRepoPath;
    try {
      const parsed = await validate();
      if (!parsed) return;
      let target = selected?.source.reference || { scope, key };
      if (selected && parsed.key !== target.key) {
        setError("The document key must match this library entry. Use Make a copy to save under another key.");
        return;
      }
      if (!selected && parsed.key !== target.key) {
        const current = await listPlaybookCatalog(owner);
        const documentTarget = { scope, key: parsed.key };
        const documentConflict = catalogContains(current, documentTarget);
        const destinationConflict = catalogContains(current, target);
        const choice = await askConfirm({
          title: "Choose playbook key",
          body: (answer) => (
            <div className="playbooks-key-choice">
              <p>
                Both choices save to <strong>{scope === "repo" ? "Repository scope" : "Global scope"}</strong>.{scope === "repo" && <code>{owner}</code>}
              </p>
              <dl>
                <div>
                  <dt>Document key</dt>
                  <dd>
                    <code>{parsed.key}</code>
                    <small>Keep the key from your source.</small>
                  </dd>
                  <dd className="playbooks-key-action">
                    <button type="button" className={`btn small${documentConflict ? " danger" : ""}`} onClick={() => answer("document")}>
                      {documentConflict ? "Overwrite existing playbook" : "Use document key"}
                    </button>
                  </dd>
                  {documentConflict && (
                    <dd className="playbooks-key-conflict">
                      <InlineStatus tone="warning">{playbookRefKey(documentTarget)} already exists. Overwrite confirmation required.</InlineStatus>
                    </dd>
                  )}
                </div>
                <div>
                  <dt>Save key</dt>
                  <dd>
                    <code>{target.key}</code>
                    <small>Rewrite the saved document key to match.</small>
                  </dd>
                  <dd className="playbooks-key-action">
                    <button type="button" className={`btn small${destinationConflict ? " danger" : ""}`} onClick={() => answer("destination")}>
                      {destinationConflict ? "Overwrite existing playbook" : "Keep Save key"}
                    </button>
                  </dd>
                  {destinationConflict && (
                    <dd className="playbooks-key-conflict">
                      <InlineStatus tone="warning">{playbookRefKey(target)} already exists. Overwrite confirmation required.</InlineStatus>
                    </dd>
                  )}
                </div>
              </dl>
              {(documentConflict || destinationConflict) && (
                <p>
                  To save a separate playbook, cancel and change the top-level <strong>key</strong> value in the editor, then choose <strong>Use document key</strong>.
                </p>
              )}
            </div>
          ),
          choices: [{ key: "cancel", label: "Cancel", tone: "ghost" }],
          cancelKey: "cancel",
          defaultKey: "cancel",
        });
        if (choice === "document") target = documentTarget;
        else if (choice !== "destination") return;
      }
      // Pass matching source through; only an acknowledged save-as rewrites its key here.
      const content = parsed.key === target.key ? source : await renderPlaybookSource({ ...parsed, key: target.key });
      // The library may have changed while the key-choice dialog was open.
      const latest = await listPlaybookCatalog(owner);
      const exists = catalogContains(latest, target);
      if (
        exists &&
        (await askConfirm({
          title: `Overwrite ${playbookRefKey(target)}?`,
          body: `Replace this library definition in ${owner || "the global library"}. Existing tasks retain their original definition.`,
          choices: [
            { key: "overwrite", label: "Overwrite", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        })) !== "overwrite"
      )
        return;
      const saved = await savePlaybookSource({ target, source: content, overwrite: exists }, owner);
      install(saved, owner);
      setNotice("Definition saved.");
      await refresh(owner);
    } catch (e) {
      const diagnostics = validationDiagnostics(e);
      if (diagnostics.length > 0) setDiagnostics(diagnostics);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    returningToLibrary.current = true;
    setOpen(false);
    setSelected(null);
    setSource("");
    setDiagnostics([]);
    setNotice("");
    setShowImport(false);
  };
  // Repository-scoped results commit only while that repository is still the current one.
  // A reload that lands after a switch would otherwise replace the new repo's rows with
  // the old repo's.
  const reloadImports = async (owner: string | undefined) => {
    if (!owner) return;
    try {
      const value = await community.listCommunityImports({ repoPath: owner });
      if (currentRepo.current !== owner) return;
      setImports(value.imports);
      setPublished(value.published);
    } catch {
      if (currentRepo.current !== owner) return;
      setImports([]);
      setPublished([]);
    }
  };
  const openSignup = (action: () => Promise<void>) => {
    pendingSignup.current = action;
    setSignupOpen(true);
  };
  // Closing by any route abandons the queued action; only continueSignup keeps it. A pairing
  // this dialog started is cancelled on the backend too — hiding the dialog would leave the
  // attempt registered, so a late callback could still persist it and the next attempt would
  // be refused as already in progress.
  const closeSignup = () => {
    signupGeneration.current += 1;
    if (signupPairing) ipc.accountCancelSignIn().catch(() => {});
    setSignupPairing(false);
    pendingSignup.current = null;
    setSignupOpen(false);
  };
  const withAccount = async (action: () => Promise<void>) => {
    try {
      const status = await ipc.accountStatus();
      if (!status.signedIn) {
        openSignup(action);
        return;
      }
      await action();
    } catch (error) {
      setError(errorText(error));
    }
  };
  const continueSignup = async () => {
    const generation = signupGeneration.current + 1;
    signupGeneration.current = generation;
    setSignupPairing(true);
    try {
      await ipc.accountSignIn();
      // Dismissed while the browser was pairing: the continuation is retired even though the
      // backend may have committed, exactly as AccountMenu retires its own.
      if (generation !== signupGeneration.current) return;
      await ipc.accountRefresh().catch(() => undefined);
      setSignupOpen(false);
      const action = pendingSignup.current;
      pendingSignup.current = null;
      if (action) await action();
    } catch (error) {
      if (generation !== signupGeneration.current) return;
      if (/cancelled/i.test(String(error))) return;
      toast.error(`Couldn't sign in: ${String(error)}`);
    } finally {
      if (generation === signupGeneration.current) setSignupPairing(false);
    }
  };
  const refreshDownloads = async (owner: string | undefined) => {
    if (!owner) return;
    const rows = await community
      .communityDownloadStatus({ repoPath: owner })
      .then((value) => value.rows)
      .catch(() => null);
    if (rows && currentRepo.current === owner) setDownloads(rows);
  };
  const previewPublication = async (id: string, name: string) => {
    setPreview({ name, source: "", error: "" });
    const result = await ipc.previewCommunityPlaybook({ id });
    if (result.kind === "needs_account") {
      setPreview(null);
      openSignup(() => previewPublication(id, name));
      return;
    }
    setPreview(result.kind === "failed" ? { name, source: "", error: result.message } : { name, source: result.source, error: "" });
  };
  const importPublication = async (owner: string | undefined, id: string, overwrite: boolean, global = false) => {
    if (!owner) return;
    const result = await community.importCommunityPlaybook({ id, repoPath: owner, overwrite, global });
    if (result.kind === "needs_account") {
      openSignup(() => importPublication(owner, id, overwrite, global));
      return;
    }
    if (result.kind === "already_downloaded") {
      setNotice("Already in your library.");
      return;
    }
    if (result.kind === "conflict") {
      if (
        (await askConfirm({
          title: `Overwrite ${global ? "global" : "repo"}/${result.localKey}?`,
          body: `Replace this library definition ${global ? "for every repository" : `in ${owner}`}. Existing tasks retain their original definition.`,
          choices: [
            { key: "overwrite", label: "Overwrite", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        })) !== "overwrite"
      )
        return;
      await importPublication(owner, id, true, global);
      return;
    }
    if (result.kind === "invalid") {
      setPublishDiagnostics(result.diagnostics);
      setError(errorText(result));
      return;
    }
    if (result.kind === "failed") {
      setError(result.message);
      return;
    }
    if (result.kind === "saved") {
      await refresh(owner);
      await reloadImports(owner);
      await refreshDownloads(owner);
    }
  };
  const updatePublication = async (owner: string | undefined, id: string, overwriteEdited: boolean) => {
    if (!owner) return;
    if (!overwriteEdited && (editedImports.current.has(id) || imports.find((item) => item.id === id)?.locallyEdited)) {
      if (
        (await askConfirm({
          title: "Overwrite local copy?",
          body: "This local copy has been edited. Update will overwrite it.",
          choices: [
            { key: "overwrite", label: "Overwrite", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        })) !== "overwrite"
      )
        return;
      await updatePublication(owner, id, true);
      return;
    }
    const result = await community.updateCommunityImport({ id, repoPath: owner, overwriteEdited });
    if (!result) return;
    if (result.kind === "needs_account") {
      openSignup(() => updatePublication(owner, id, overwriteEdited));
      return;
    }
    if (result.kind === "edited") {
      editedImports.current.add(id);
      if (
        (await askConfirm({
          title: "Overwrite local copy?",
          body: "This local copy has been edited. Update will overwrite it.",
          choices: [
            { key: "overwrite", label: "Overwrite", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        })) !== "overwrite"
      )
        return;
      await updatePublication(owner, id, true);
      return;
    }
    if (result.kind === "invalid") {
      setError(errorText(result));
      return;
    }
    if (result.kind === "failed") {
      setError(result.message);
      return;
    }
    if (result.kind === "saved") {
      editedImports.current.delete(id);
      await refresh(owner);
      await reloadImports(owner);
      await refreshDownloads(owner);
    }
  };
  const openPublishConfirm = (confirm: { reference: PlaybookRef; playbookKey: string; title: string; fromVersion: number | null }) => {
    setAttest(false);
    setPublishLabel("");
    setShowPublishLabel(false);
    setPublishMessage("");
    setPublishDiagnostics([]);
    setPublishConfirm(confirm);
  };
  const confirmPublish = async () => {
    if (!repoPath || !publishConfirm) return;
    if (showPublishLabel && !labelPattern.test(publishLabel)) return;
    const { reference } = publishConfirm;
    const result = showPublishLabel
      ? await community.publishCommunityPlaybook({ reference, repoPath, label: publishLabel })
      : await community.publishCommunityPlaybook({ reference, repoPath });
    if (!result) return;
    if (result.kind === "needs_account") {
      openSignup(() => confirmPublish());
      return;
    }
    if (result.kind === "label_required") {
      setShowPublishLabel(true);
      return;
    }
    if (result.kind === "invalid" || result.kind === "failed") {
      if (
        result.kind === "failed" &&
        (result.message === "That label is already set." || result.message === "That label is taken." || result.message === "The playbook key cannot change. Publish a new one.")
      ) {
        setShowPublishLabel(false);
      }
      setPublishMessage(result.kind === "failed" ? result.message : errorText(result));
      if (result.kind === "invalid") setPublishDiagnostics(result.diagnostics);
      return;
    }
    setPublishConfirm(null);
    await reloadMine();
    await refresh(repoPath);
  };
  const remove = async () => {
    if (busy || !selected || !(await discard())) return;
    if (
      (await askConfirm({
        title: `Are you sure you want to delete ${playbookRefKey(selected.source.reference)}?`,
        body:
          selected.source.reference.scope === "bundled"
            ? "Remove this bundled playbook from your library for all repositories, including after app updates. Existing tasks and copies in other scopes are retained."
            : `Delete only this library entry in ${selected.source.reference.scope === "repo" ? editorRepoPath : "the global library"}. Existing tasks and other scopes are retained.`,
        defaultKey: "cancel",
        choices: [
          { key: "delete", label: "Delete", tone: "danger" },
          { key: "cancel", label: "Cancel", tone: "ghost" },
        ],
      })) !== "delete"
    )
      return;
    setBusy(true);
    setError("");
    try {
      await deletePlaybookSource(selected.source.reference, editorRepoPath);
      await refresh(editorRepoPath);
      await reloadImports(editorRepoPath);
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const preferences = catalog?.diagnostics.some((item) => item.code === "picker_preferences") ? undefined : catalog?.picker_preferences;
  const savePreferences = async (next: PickerPreferences) => {
    if (!repoPath || !preferences || pendingPreference.current !== null) return;
    const owner = repoPath;
    const generation = preferenceGeneration.current;
    pendingPreference.current = generation;
    setPreferenceSaving(true);
    setPreferenceError("");
    try {
      await savePlaybookPickerPreferences(next, owner);
      if (currentRepo.current === owner && preferenceGeneration.current === generation) {
        setCatalog((value) => value && { ...value, picker_preferences: next });
      }
    } catch (error) {
      if (currentRepo.current === owner && preferenceGeneration.current === generation) setPreferenceError(errorText(error));
    } finally {
      if (currentRepo.current === owner && preferenceGeneration.current === generation) {
        pendingPreference.current = null;
        setPreferenceSaving(false);
      }
    }
  };
  const setStarred = (reference: PlaybookRef, starred: boolean) => {
    if (preferences) void savePreferences(withPlaybookStar(preferences, reference, starred));
  };
  const starredKeys = starredPlaybookKeys(repoPath ? preferences : undefined);
  // The label field only exists once the server asks for one. Until it holds a valid
  // slug the request would come back rejected, so Confirm stays off and the rule shows.
  const labelValid = labelPattern.test(publishLabel);
  const rows = libraryRows({
    candidates: catalog?.candidates ?? [],
    imports,
    downloads,
    mine: communitySignedIn && mineReady && !mineError ? minePlaybooks : null,
    published,
  });
  const counts = new Map(VIEWS.map((item) => [item.key, item.test ? rows.filter((row) => item.test?.(row, starredKeys)).length : communityPlaybooks.length]));
  const current = VIEWS.find((item) => item.key === view) ?? VIEWS[0];
  const needle = query.trim().toLowerCase();
  const visible = rows
    .filter((row) => current.test?.(row, starredKeys) && `${row.title} ${row.description} ${row.id}`.toLowerCase().includes(needle))
    .sort(
      (left, right) =>
        (view === "all" ? Number(SIGNAL_STATES.has(right.state)) - Number(SIGNAL_STATES.has(left.state)) : 0) ||
        left.title.localeCompare(right.title, undefined, { sensitivity: "base", numeric: true }),
    );
  const rowForListing = (id: string) => rows.find((row) => row.importRow?.id === id || row.publication?.id === id) ?? null;
  const listing = view === "explore" ? (communityPlaybooks.find((item) => item.id === chosen) ?? communityPlaybooks[0] ?? null) : null;
  const inspected = listing ? rowForListing(listing.id) : view === "explore" ? null : (visible.find((row) => row.id === chosen) ?? visible[0] ?? null);
  const realSteps = (row: LibraryRow) => row.candidate?.steps;
  const stepsOf = (row: LibraryRow) => realSteps(row) ?? placeholderSteps(row.publication?.stepCount ?? 0);

  const selectView = (next: View) => {
    if ((next === "explore") !== (view === "explore")) setQuery("");
    setView(next);
    setChosen(null);
    setStep(null);
  };
  const choose = (id: string) => {
    if (id !== chosen) setStep(null);
    setChosen(id);
  };
  const openRow = (row: LibraryRow) => {
    if (row.reference && row.state !== "broken") void load(row.reference);
  };
  const copyRow = async (reference: PlaybookRef) => {
    try {
      void begin("copy", undefined, await readPlaybook(reference, repoPath));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const publish = (row: LibraryRow) => {
    const reference = row.reference;
    if (!reference) return;
    void withAccount(async () => openPublishConfirm({ reference, playbookKey: reference.key, title: row.title, fromVersion: row.publication?.version ?? null }));
  };
  const download = (id: string, global = false) => void withAccount(() => importPublication(repoPath, id, false, global));
  const downloadButtons = (id: string, primary: boolean) => (
    <>
      <button
        type="button"
        className={primary ? "btn primary" : "btn"}
        disabled={!repoPath}
        title={repoPath ? undefined : "Select a repository before downloading."}
        onClick={() => download(id)}
      >
        Download to this repo
      </button>
      <button type="button" className="btn ghost" disabled={!repoPath} title="Keep it in this machine's library for every repository" onClick={() => download(id, true)}>
        For all repos
      </button>
    </>
  );
  const keepAsMine = async (row: LibraryRow) => {
    const owner = repoPath;
    const id = row.importRow?.id;
    if (!owner || !id) return;
    try {
      await community.forgetCommunityImport({ id, repoPath: owner });
      setCompare(null);
      setNotice(`${row.title} is yours now. It no longer follows @${row.importRow?.label}.`);
      await refresh(owner);
      await reloadImports(owner);
      await refreshDownloads(owner);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const unpublish = async (row: LibraryRow) => {
    const owner = repoPath;
    const listing = row.publication;
    if (!owner || !listing) return;
    if (
      !(await confirmDanger(
        `Unpublish ${row.title}?`,
        "People can no longer find or download it, and their copies read as withdrawn. Your local playbook stays. Publishing again starts a new listing at v1.",
        "Unpublish",
      ))
    )
      return;
    const run = async () => {
      const result = await community.unpublishCommunityPlaybook({ id: listing.id, repoPath: owner });
      if (result.kind === "needs_account") {
        openSignup(run);
        return;
      }
      if (result.kind === "failed") {
        setError(result.message);
        return;
      }
      setNotice(`${row.title} is no longer published.`);
      await reloadMine();
      await reloadImports(owner);
    };
    await run();
  };
  const restoreBuiltIn = async (key: string) => {
    const owner = repoPath;
    try {
      await restoreBundledPlaybook(key, owner);
      await refresh(owner);
    } catch (e) {
      setError(errorText(e));
    }
  };
  // Your copy against the author's newer version; the choice is theirs or yours, never a silent merge.
  const openCompare = async (row: LibraryRow) => {
    const id = row.importRow?.id;
    if (!row.reference || !id) return;
    const version = row.download?.remoteVersion ?? null;
    setCompare({ row, mine: "", theirs: "", version, error: "" });
    try {
      const [mine, theirs] = await Promise.all([readPlaybook(row.reference, repoPath), ipc.previewCommunityPlaybook({ id })]);
      if (theirs.kind === "needs_account") {
        setCompare(null);
        openSignup(() => openCompare(row));
        return;
      }
      setCompare(
        theirs.kind === "failed"
          ? { row, mine: mine.source_text, theirs: "", version, error: theirs.message }
          : { row, mine: mine.source_text, theirs: theirs.source, version, error: "" },
      );
    } catch (e) {
      setCompare({ row, mine: "", theirs: "", version, error: errorText(e) });
    }
  };
  const update = (id: string) => void withAccount(() => updatePublication(repoPath, id, false));
  const previewListing = (id: string, name: string) => void withAccount(() => previewPublication(id, name));

  // The one action each state asks for; Open and Create task sit beside it.
  const stateActions = (row: LibraryRow) => {
    const id = row.importRow?.id;
    const name = row.importRow ? `${row.importRow.label}/${row.importRow.playbookKey}` : row.title;
    const noRepo = !repoPath;
    const unpublishButton = row.publication && (
      <button type="button" className="btn ghost" disabled={noRepo} onClick={() => void unpublish(row)}>
        Unpublish
      </button>
    );
    switch (row.state) {
      case "builtin":
      case "team":
        return (
          row.reference && (
            <button type="button" className="btn" disabled={busy} onClick={() => row.reference && void copyRow(row.reference)}>
              Copy to edit
            </button>
          )
        );
      case "yours":
        return (
          <button type="button" className="btn" onClick={() => void withAccount(() => reloadMine())}>
            Sign in to publish
          </button>
        );
      case "private":
      case "changed":
        return (
          <>
            <button type="button" className="btn primary" disabled={noRepo} title={noRepo ? "Select a repository before publishing." : undefined} onClick={() => publish(row)}>
              {row.publication ? `Publish v${row.publication.version + 1}` : "Publish"}
            </button>
            {unpublishButton}
          </>
        );
      case "live":
        return unpublishButton;
      case "diverged":
        return (
          <button type="button" className="btn primary" onClick={() => void openCompare(row)}>
            Compare
          </button>
        );
      case "withdrawn":
        return (
          <button type="button" className="btn primary" disabled={noRepo} onClick={() => void keepAsMine(row)}>
            Keep as mine
          </button>
        );
      case "update":
        return (
          id && (
            <>
              <button type="button" className="btn primary" onClick={() => update(id)}>
                Update
              </button>
              <button type="button" className="btn ghost" onClick={() => previewListing(id, name)}>
                Preview
              </button>
            </>
          )
        );
      case "remote":
        return (
          row.publication && (
            <>
              {downloadButtons(row.publication.id, true)}
              {unpublishButton}
            </>
          )
        );
      default:
        return null;
    }
  };

  const lineage = (row: LibraryRow) => {
    const here = row.range === "This repo" ? "this repo" : "all repos";
    if (row.origin.kind === "alinery") {
      return [
        { label: "Source", value: "Ships with Alinery", lit: true },
        { label: "Your copy", value: "None. Copy to edit; the original stays.", lit: false },
      ];
    }
    if (row.origin.kind === "team") {
      return [
        { label: "Source", value: "Committed in alinery/playbooks", lit: true },
        { label: "Your copy", value: "None. Edits go through the repo.", lit: false },
      ];
    }
    if (row.origin.kind === "download") {
      const have = row.importRow?.importedVersion;
      const remote = row.download?.remoteVersion;
      return [
        {
          label: "Upstream",
          value:
            row.state === "withdrawn" ? (
              <>
                <span className="t-bad">Withdrawn</span> by @{row.origin.label}
              </>
            ) : (
              <>
                @{row.origin.label} · v{remote ?? have}
                {row.download?.updateAvailable && <span className="t-act"> new</span>}
              </>
            ),
          lit: row.state !== "withdrawn",
        },
        {
          label: `Your copy · ${here}`,
          value: (
            <>
              v{have}
              {(row.state === "edited" || row.state === "diverged") && <span className="t-warn"> edited</span>}
            </>
          ),
          lit: true,
        },
        { label: "Your listing", value: "None. Publish your edits as your own listing.", lit: false },
      ];
    }
    if (row.state === "remote") {
      return [
        { label: "Your listing", value: `alinery.ai · v${row.publication?.version}`, lit: true },
        { label: "On this machine", value: "No copy", lit: false },
      ];
    }
    return [
      {
        label: `Your playbook · ${here}`,
        value: row.state === "changed" ? <span className="t-act">Saved ahead of listing</span> : "Saved",
        lit: true,
      },
      {
        label: "Your listing",
        value: row.publication ? (
          <>
            alinery.ai · v{row.publication.version}
            {row.state === "live" && <span className="t-ok"> matches</span>}
          </>
        ) : row.state === "yours" ? (
          "Unknown until you sign in"
        ) : (
          "Not published"
        ),
        lit: !!row.publication,
      },
    ];
  };

  const ringOf = (title: string, steps: NormalizedStep[], size: "full" | "panel") => (
    <PlaybookRing size={size} steps={steps} label={`${title} ring`} selectedStepKey={step} onSelectStep={setStep} onHoverStep={(hovered) => hovered && setStep(hovered)}>
      <RingReadout title={size === "full" ? title : undefined} steps={steps} activeKey={step} excerpt={size === "full"} />
    </PlaybookRing>
  );

  const rowInspector = (row: LibraryRow) => {
    const steps = realSteps(row);
    const key = row.reference?.key ?? row.publication?.playbookKey ?? row.id;
    return (
      <>
        <span className="pb-k">
          {originLabel(row.origin).toLowerCase()} / {key}
        </span>
        <h2>{row.title}</h2>
        <StatusLed row={row} />
        {row.description && <p>{row.description}</p>}
        {ringOf(row.title, stepsOf(row), "panel")}
        <div className="pb-acts">
          {row.reference && row.state !== "broken" && (
            <button type="button" className="btn" disabled={busy} onClick={() => openRow(row)}>
              Open
            </button>
          )}
          {stateActions(row)}
          {row.reference && row.state !== "broken" && (
            <button
              type="button"
              className="btn ghost"
              disabled={!repoPath}
              title={repoPath ? undefined : "Select a repository before creating a task."}
              onClick={() => row.reference && onCreateTask(row.reference)}
            >
              Create task
            </button>
          )}
        </div>
        {row.candidate?.diagnostics.map((item) => (
          <p role="alert" key={`${item.code}:${item.field}:${item.line}:${item.message}`} className="danger-text">
            {item.code}: {item.message}
            {item.line ? ` (line ${item.line})` : ""}
            {item.field ? ` · ${item.field}` : ""}
          </p>
        ))}
        <Track nodes={lineage(row)} />
        {steps && (
          <div>
            <div className="pb-k">
              {steps.length} {steps.length === 1 ? "step" : "steps"}
            </div>
            <StepChips steps={steps} active={step} onActive={setStep} />
          </div>
        )}
        <p className="pb-note">{NOTES[row.state]}</p>
      </>
    );
  };

  const listingInspector = (item: CommunitySummary) => {
    const name = `${item.label}/${item.playbookKey}`;
    return (
      <>
        <span className="pb-k">
          @{item.label} / {item.playbookKey}
        </span>
        <h2>{item.title}</h2>
        {item.description && <p>{item.description}</p>}
        {ringOf(item.title, placeholderSteps(item.stepCount), "panel")}
        <div className="pb-acts">
          {downloadButtons(item.id, true)}
          <button type="button" className="btn ghost" onClick={() => previewListing(item.id, name)}>
            Preview
          </button>
        </div>
        <Track
          nodes={[
            { label: "Listing", value: `@${item.label} · v${item.version}`, lit: true },
            { label: "In your library", value: "Not yet", lit: false },
          ]}
        />
        <p className="pb-note">The catalog sends only a step count, so the ring shows its chords, hands and loops once it is downloaded.</p>
      </>
    );
  };

  const libraryManifest = (
    <section ref={libraryRef} className="pb-manifest" aria-label={current.label} onScroll={(event) => (libraryScrollTop.current = event.currentTarget.scrollTop)}>
      <header className="pb-mhead">
        <h2>{view === "all" ? "Library" : current.label}</h2>
        <span>
          {visible.length} {visible.length === 1 ? "playbook" : "playbooks"}
          {view === "all" && " · signals first"} · double-click to open
        </span>
      </header>
      {!repoPath && <p className="pb-hint">Select a repository to see its playbooks, downloads and stars.</p>}
      {view === "listings" && communitySignedIn === false && (
        <p className="pb-hint">
          Sign in to see playbooks you published.{" "}
          <button type="button" className="btn small" onClick={() => void withAccount(() => reloadMine())}>
            Sign in
          </button>
        </p>
      )}
      {view === "listings" && mineError && <InlineStatus tone="error">{mineError}</InlineStatus>}
      {view === "listings" && mineTruncated && <p className="pb-hint">Only the newest 1000 publications are listed.</p>}
      {preferenceError && <InlineStatus tone="error">{preferenceError}</InlineStatus>}
      {preferenceSaving && <p role="status">Saving starred playbooks…</p>}
      {catalogError && (
        <InlineStatus tone="error">
          {catalogError}
          <button className="btn ghost" type="button" onClick={() => void refresh(repoPath)}>
            Retry library
          </button>
        </InlineStatus>
      )}
      {!catalog && !catalogError && <LoadingState label="Loading playbooks" state={ORB_STATE} />}
      {catalog && (
        <div className="pb-cols" aria-hidden="true">
          <span>Shape</span>
          <span>Name</span>
          <span>Origin</span>
          <span>Range</span>
          <span>Status</span>
        </div>
      )}
      <ul className="pb-rows" aria-label="Playbook library">
        {visible.map((row) => {
          const isStarred = starredKeys.has(row.id);
          return (
            <li key={row.id} aria-label={row.id} className={row.id === inspected?.id ? "on" : undefined}>
              <button
                type="button"
                className="pb-row"
                aria-label={row.title}
                aria-pressed={row.id === inspected?.id}
                title={row.id}
                onClick={() => choose(row.id)}
                onDoubleClick={() => openRow(row)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  openRow(row);
                }}
              >
                <PlaybookRingMark steps={stepsOf(row)} />
                <span className="pb-name">
                  <b>{row.title}</b>
                  <small>{row.description || row.reference?.key}</small>
                </span>
                <span className="pb-origin">{originLabel(row.origin)}</span>
                <span className="pb-range">{row.range ?? "Listing"}</span>
                <StatusLed row={row} />
              </button>
              {row.reference && (
                <button
                  type="button"
                  className="playbook-star-button"
                  aria-label={`Star playbook: ${row.id}`}
                  title={`${isStarred ? "Unstar" : "Star"} ${row.title}`}
                  aria-pressed={isStarred}
                  disabled={!repoPath || !preferences || preferenceSaving}
                  onClick={() => row.reference && setStarred(row.reference, !isStarred)}
                >
                  <Star size={14} strokeWidth={1.5} fill={isStarred ? "currentColor" : "none"} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {catalog && visible.length === 0 && <p className="pb-empty">{needle ? "No matching playbooks." : "Nothing here."}</p>}
      {view === "alinery" && !!catalog?.hidden?.length && (
        <details className="pb-hidden">
          <summary>
            {catalog.hidden.length} removed {catalog.hidden.length === 1 ? "built-in" : "built-ins"}
          </summary>
          <ul aria-label="Removed built-ins">
            {catalog.hidden.map((item) => (
              <li key={item.key}>
                <span>{item.title}</span>
                <button type="button" className="btn ghost small" aria-label={`Restore ${item.title}`} onClick={() => void restoreBuiltIn(item.key)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {catalog?.diagnostics.map((item) => (
        <InlineStatus key={`${item.code}:${item.message}`} tone="error">
          {item.code === "picker_preferences" && (
            <>
              <p>Couldn't read saved playbook preferences. Preference changes are disabled to protect the file. Fix the file, then retry.</p>
              <button className="btn ghost" type="button" onClick={() => void refresh(repoPath)}>
                Retry preferences
              </button>
            </>
          )}
          {item.code}: {item.message}
        </InlineStatus>
      ))}
      <p className="pb-note">Library changes apply to future tasks only.</p>
    </section>
  );

  const exploreManifest = (
    <section className="pb-manifest" aria-label="Explore">
      <header className="pb-mhead">
        <h2>Explore</h2>
        <span>Community playbooks{communityQuery && " · search can omit matches"}</span>
      </header>
      {communityQuery.length > 80 && <p className="pb-hint">Invalid query.</p>}
      {communityError && <InlineStatus tone="error">{communityError}</InlineStatus>}
      {!communityReady && <LoadingState label="Loading community playbooks" state={ORB_STATE} />}
      <ul className="pb-cards" aria-label="Community playbooks">
        {communityPlaybooks.map((item) => {
          const row = rowForListing(item.id);
          return (
            <li key={item.id}>
              <button
                type="button"
                className={`pb-card${item.id === listing?.id ? " on" : ""}`}
                aria-label={item.title}
                aria-pressed={item.id === listing?.id}
                onClick={() => choose(item.id)}
                onDoubleClick={() => row && openRow(row)}
              >
                <span className="pb-card-top">
                  <PlaybookRingMark steps={row ? stepsOf(row) : placeholderSteps(item.stepCount)} />
                  <span className="pb-card-meta">
                    <span>@{item.label}</span>
                    <span>
                      v{item.version} · {item.stepCount} {item.stepCount === 1 ? "step" : "steps"}
                    </span>
                  </span>
                </span>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
                {row ? (
                  <StatusLed row={row} />
                ) : (
                  <span className="pb-status t-dim">
                    <span className="pb-led" aria-hidden="true" />
                    <span>Not in library</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {communityReady && communityPlaybooks.length === 0 && <p className="pb-empty">No playbooks found</p>}
      {communityPage.cursor && communityPage.query === communityQuery && communityQuery.length <= 80 && (
        <button
          type="button"
          className="btn ghost pb-more"
          onClick={() => {
            const cursor = communityPage.cursor;
            if (!cursor) return;
            const trimmed = communityPage.query;
            const generation = communityGeneration.current;
            const args = trimmed ? { q: trimmed, cursor } : { cursor };
            void Promise.resolve(ipc.listCommunityPlaybooks(args))
              .then((page) => {
                if (!page || generation !== communityGeneration.current) return;
                setCommunityPlaybooks((items) => [...items, ...page.playbooks]);
                setCommunityPage({ query: trimmed, cursor: page.nextCursor });
              })
              .catch((error) => {
                if (generation !== communityGeneration.current) return;
                setCommunityError(errorText(error));
              });
          }}
        >
          Load more
        </button>
      )}
    </section>
  );

  const openRowStatus = selected ? rows.find((row) => row.id === playbookRefKey(selected.source.reference)) : undefined;

  return (
    <main className="playbooks-page pb-deck">
      <div className="playbooks-detail">
        <div className="playbooks-toolbar pb-bar">
          {open ? (
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (await discard()) close();
              }}
            >
              <ArrowLeft size={16} aria-hidden="true" /> Library
            </button>
          ) : (
            <>
              <h1 className="pb-title">Playbooks</h1>
              <span className="pb-repo">
                <span className="pb-led" aria-hidden="true" />
                {repoPath ? repoName(repoPath) : "Global library"}
              </span>
              <input
                ref={searchRef}
                className="pb-search"
                type="search"
                aria-label="Search playbooks"
                value={query}
                placeholder={view === "explore" ? "Search the community" : "Search your library, or type @ to search the community"}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.startsWith("@") && view !== "explore") {
                    setView("explore");
                    setChosen(null);
                    setStep(null);
                  }
                  setQuery(value);
                }}
              />
            </>
          )}
          {open && (
            <div className="pb-seg" role="group" aria-label="Playbook view">
              {(["ring", "graph", "source"] as const).map((item) => (
                <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>
                  {item === "ring" ? "Ring" : item === "graph" ? "Graph" : "Source"}
                </button>
              ))}
            </div>
          )}
          <div className="playbooks-primary-actions" role="group" aria-label="Playbook actions">
            {!open && (
              <>
                <button className="btn" type="button" disabled={busy} onClick={() => void begin("new")}>
                  New playbook
                </button>
                <button className="btn ghost" type="button" disabled={busy} aria-expanded={showImport} onClick={() => setShowImport(!showImport)}>
                  Import
                </button>
              </>
            )}
            {open && selected && (
              <>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={!!createTaskDisabledReason}
                  title={createTaskDisabledReason || "Open Create Task with this saved playbook selected."}
                  onClick={() => onCreateTask(selected.source.reference)}
                >
                  Create task from this playbook
                </button>
                <button className="btn ghost" type="button" disabled={busy} onClick={() => void begin("copy")}>
                  {readOnly ? "Make a copy to edit" : "Make a copy"}
                </button>
              </>
            )}
            {open && !readOnly && (
              <>
                <button className="btn" type="button" disabled={busy || (!selected && !key)} onClick={() => void save()}>
                  Save definition
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      if (await validate()) setNotice("Definition is valid. Not saved.");
                    } catch (e) {
                      setError(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Validate
                </button>
              </>
            )}
          </div>
        </div>
        {showImport && !open && (
          <div className="playbooks-import">
            <label>
              Import local file
              <input
                type="file"
                accept=".md,text/markdown,text/plain"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void begin("file", file);
                }}
              />
            </label>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => void begin("paste")}>
              Paste source
            </button>
          </div>
        )}
        {error && (
          <InlineStatus tone="error" onDismiss={() => setError("")}>
            {error}
          </InlineStatus>
        )}
        {!open && (
          <div className="pb-body">
            <nav className="pb-rail" aria-label="Library views">
              {(["Library", "Signals", "Community"] as const).map((group) => {
                const items = VIEWS.filter((item) => item.group === group && (group !== "Signals" || counts.get(item.key) || view === item.key));
                if (items.length === 0) return null;
                return (
                  <div key={group} className={`pb-rail-group${group === "Signals" ? " sig" : ""}`}>
                    <span className="pb-eyebrow">{group}</span>
                    {items.map((item) => (
                      <button key={item.key} type="button" aria-pressed={view === item.key} onClick={() => selectView(item.key)}>
                        <item.icon size={14} strokeWidth={1.5} aria-hidden="true" />
                        {item.label}
                        {item.key !== "explore" && (
                          <>
                            {" "}
                            <span className="pb-n">{counts.get(item.key)}</span>
                          </>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
            {view === "explore" ? exploreManifest : libraryManifest}
            <aside className="pb-inspector" aria-label="Inspector">
              {inspected ? rowInspector(inspected) : listing ? listingInspector(listing) : <p className="pb-empty">Nothing selected.</p>}
            </aside>
          </div>
        )}
        {compare && (
          <Dialog onClose={() => setCompare(null)} role="dialog" ariaLabel={`Compare ${compare.row.title}`}>
            <div className="mh">
              <span className="mt">
                Your copy against @{compare.row.importRow?.label}
                {compare.version ? ` v${compare.version}` : ""}
              </span>
              <button type="button" className="x" aria-label="Close" title="Close" onClick={() => setCompare(null)}>
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <div className="mb">
              {compare.error ? (
                <InlineStatus tone="error">{compare.error}</InlineStatus>
              ) : compare.theirs ? (
                <section aria-label="Changes">
                  <pre className="playbook-preview pb-diff">
                    {lineDiff(compare.mine, compare.theirs).map((line) => (
                      <span key={line.at} className={`pb-diff-${line.kind}`}>
                        {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                        {line.text}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                </section>
              ) : (
                <LoadingState label="Loading both versions" state={ORB_STATE} />
              )}
              <p className="pb-note">Lines marked − are only in your copy; + only in the author's.</p>
            </div>
            <div className="mfoot">
              <button type="button" className="btn ghost small" data-autofocus onClick={() => setCompare(null)}>
                Cancel
              </button>
              <button type="button" className="btn small" disabled={!repoPath} onClick={() => void keepAsMine(compare.row)}>
                Keep mine
              </button>
              <button
                type="button"
                className="btn primary small"
                disabled={!compare.theirs}
                onClick={() => {
                  const id = compare.row.importRow?.id;
                  setCompare(null);
                  if (id) void withAccount(() => updatePublication(repoPath, id, true));
                }}
              >
                Take theirs
              </button>
            </div>
          </Dialog>
        )}
        {preview && (
          <Dialog onClose={() => setPreview(null)} role="dialog" ariaLabel={`Preview ${preview.name}`}>
            <div className="mh">
              <span className="mt">Preview {preview.name}</span>
              <button type="button" className="x" aria-label="Close" title="Close" onClick={() => setPreview(null)}>
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <div className="mb">
              {preview.error ? (
                <InlineStatus tone="error">{preview.error}</InlineStatus>
              ) : preview.source ? (
                <pre className="playbook-preview">{preview.source}</pre>
              ) : (
                <LoadingState label="Loading published playbook" state={ORB_STATE} />
              )}
            </div>
            <div className="mfoot">
              <button type="button" className="btn ghost small" data-autofocus onClick={() => setPreview(null)}>
                Close
              </button>
            </div>
          </Dialog>
        )}
        {signupOpen && (
          <Dialog onClose={closeSignup} role="dialog" ariaLabel="Sign up">
            <div className="mh">
              <span className="mt">Sign up</span>
              <button type="button" className="x" aria-label="Close" title="Close" onClick={closeSignup}>
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <div className="mb">
              <p className="dim">To View, Download, or Publish playbooks you need an account. Sign up for free now.</p>
            </div>
            <div className="mfoot">
              <button type="button" className="btn ghost small" data-autofocus onClick={closeSignup}>
                Cancel
              </button>
              <button type="button" className="btn small" disabled={signupPairing} onClick={() => void continueSignup()}>
                SIGN UP
              </button>
            </div>
          </Dialog>
        )}
        {publishConfirm && (
          <Dialog onClose={() => setPublishConfirm(null)} role="dialog" ariaLabel="Publish playbook">
            <div className="mh">
              <span className="mt">{publishConfirm.fromVersion == null ? "Publish playbook" : "Update playbook"}</span>
              <button type="button" className="x" aria-label="Close" title="Close" onClick={() => setPublishConfirm(null)}>
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <div className="mb">
              <dl>
                <dt>Key</dt>
                <dd>
                  <code>{publishConfirm.playbookKey}</code>
                </dd>
                <dt>Title</dt>
                <dd>{publishConfirm.title}</dd>
                <dt>Version</dt>
                <dd>{publishConfirm.fromVersion == null ? "Not published → 1" : `${publishConfirm.fromVersion} → ${publishConfirm.fromVersion + 1}`}</dd>
              </dl>
              <Checkbox checked={attest} onChange={setAttest} label="Confirm you can share this playbook." />
              {showPublishLabel && (
                <div className="field">
                  <label>
                    Public label
                    <input value={publishLabel} onChange={(event) => setPublishLabel(event.target.value)} />
                  </label>
                  {!labelValid && <p className="danger-text">Label must be a lowercase slug, 2 to 32 characters, like spec-driven-development.</p>}
                </div>
              )}
              {dirty && selected && playbookRefKey(publishConfirm.reference) === playbookRefKey(selected.source.reference) && (
                <p className="dim">Unsaved editor changes are not published.</p>
              )}
              {publishMessage && <p className="dim">{publishMessage}</p>}
              {publishDiagnostics.map((item) => (
                <p key={`${item.code}:${item.message}`} className="dim">
                  {item.code} {item.message}
                </p>
              ))}
            </div>
            <div className="mfoot">
              <button type="button" className="btn ghost small" data-autofocus onClick={() => setPublishConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn small" disabled={!attest || (showPublishLabel && !labelValid)} onClick={() => void confirmPublish()}>
                Confirm
              </button>
            </div>
          </Dialog>
        )}
        {open && (
          <section className="playbooks-workspace" ref={detailRef} tabIndex={-1} aria-label="Playbook details">
            <div className="playbooks-body">
              <header className="playbooks-detail-header">
                <div>
                  <div className="playbooks-context">
                    {openRowStatus ? `${originLabel(openRowStatus.origin)} / ${openRowStatus.range}` : selected ? scopeLabels[selected.source.reference.scope] : "New definition"}
                    {dirty && " · Unsaved changes"}
                  </div>
                  <h2>
                    {selected?.definition.title || "Create playbook"}
                    {openRowStatus && <StatusLed row={openRowStatus} />}
                  </h2>
                  {selected?.definition.description && <p>{selected.definition.description}</p>}
                </div>
              </header>
              {editorRepoPath !== repoPath && (
                <InlineStatus tone="warning">
                  This definition belongs to {editorRepoPath || "the global library"}. Switching repositories has not moved or discarded it.
                </InlineStatus>
              )}
              {selected && (
                <details className="playbooks-provenance">
                  <summary>Source details</summary>
                  <dl>
                    <dt>Identity</dt>
                    <dd>
                      <code>{playbookRefKey(selected.source.reference)}</code>
                    </dd>
                    <dt>Library repository</dt>
                    <dd>{editorRepoPath || "None — global library only"}</dd>
                    {selected.source.path && (
                      <>
                        <dt>Path</dt>
                        <dd>
                          <code>{selected.source.path}</code>
                        </dd>
                      </>
                    )}
                    {selected.modified_at_ms !== null && (
                      <>
                        <dt>Modified</dt>
                        <dd>{new Date(selected.modified_at_ms).toLocaleString()}</dd>
                      </>
                    )}
                    <dt>Default model</dt>
                    <dd>{selected.definition.default_model || "Inherit task default"}</dd>
                    <dt>Default harness</dt>
                    <dd>{selected.definition.default_harness || "Inherit task default"}</dd>
                  </dl>
                </details>
              )}
              {!selected && (
                <fieldset className="playbooks-destination" disabled={busy}>
                  <legend>Save destination</legend>
                  <label>
                    Save scope
                    <select value={scope} onChange={(event) => setScope(event.target.value as "repo" | "global")}>
                      <option value="global">Global</option>
                      <option value="repo" disabled={!editorRepoPath}>
                        Repository
                      </option>
                    </select>
                  </label>
                  <label>
                    Save key
                    <input value={key} onChange={(event) => setKey(event.target.value)} />
                  </label>
                  <p>{editorRepoPath || "Global library"}</p>
                </fieldset>
              )}
              {mode === "ring" ? (
                <>
                  {dirty && selected && <InlineStatus tone="info">Showing saved version · Unsaved changes in Source.</InlineStatus>}
                  {selected ? (
                    <div className="pb-hero">
                      {ringOf(selected.definition.title, selected.definition.step, "full")}
                      <StepChips steps={selected.definition.step} active={step} onActive={setStep} />
                      <RingLegend />
                    </div>
                  ) : (
                    <p className="playbooks-empty">Save this definition before its ring is available. Continue editing in Source.</p>
                  )}
                </>
              ) : mode === "graph" ? (
                <>
                  {dirty && selected && <InlineStatus tone="info">Showing saved version · Unsaved changes in editor.</InlineStatus>}
                  {selected ? (
                    <PlaybookGraph
                      key={`${editorRepoPath}:${playbookRefKey(selected.source.reference)}`}
                      variant="definition"
                      title={selected.definition.title}
                      steps={selected.definition.step}
                      defaultModel={selected.definition.default_model}
                      defaultHarness={selected.definition.default_harness}
                      graphFraction={graphFraction}
                      onGraphFractionChange={setGraphFraction}
                    />
                  ) : (
                    <p className="playbooks-empty">Save this definition before a graph is available. Continue editing in Source.</p>
                  )}
                </>
              ) : (
                <section className="playbooks-editor-panel" aria-label="Playbook editor">
                  {readOnly && <p className="playbooks-context">Bundled source is read-only. Make a copy to edit it.</p>}
                  <PlaybookSourceEditor
                    value={source}
                    onChange={(value) => {
                      setSource(value);
                      setDiagnostics([]);
                      setNotice("");
                    }}
                    readOnly={readOnly}
                    disabled={busy}
                  />
                </section>
              )}
              {diagnostics.length > 0 && (
                <ul className="danger-text" aria-label="Validation diagnostics">
                  {diagnostics.map((item) => (
                    <li role="alert" key={`${item.code}:${item.field}:${item.line}:${item.message}`}>
                      <strong>{item.code}</strong> {item.message} {item.field && <code>{item.field}</code>}
                      {item.line && ` · Line ${item.line}`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer className="playbooks-savebar">
              <span role="status">{busy ? "Working…" : notice || (dirty ? "Unsaved changes" : readOnly ? "Read-only" : "Saved definition")}</span>
              {selected && (
                <button className="btn ghost playbooks-delete" type="button" disabled={busy} onClick={() => void remove()}>
                  Delete Playbook
                </button>
              )}
            </footer>
          </section>
        )}
      </div>
    </main>
  );
}
