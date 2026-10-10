import { ArrowLeft, BookOpen, Check, Download, Eye, Share2, Upload, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { askConfirm } from "../confirm";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { PlaybookSourceEditor } from "../PlaybookSourceEditor";
import { Checkbox, Dialog, InlineStatus, LoadingState, playbookRefKey, repoName, samePlaybookRef } from "../shared";
import { toast } from "../toast";
import type {
  CommunityImportRow,
  CommunitySummary,
  DownloadStatusRow,
  NormalizedPlaybook,
  PickerPreference,
  PickerPreferences,
  PlaybookCatalog,
  PlaybookRef,
  PlaybookValidationError,
  ScopedPlaybook,
} from "../types";

const blankDefinition: NormalizedPlaybook = {
  version: 2,
  key: "new-playbook",
  title: "New playbook",
  description: "",
  default_model: "",
  default_harness: "omp",
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
const libraryColumns = [
  { field: "name", label: "Playbook Name", initialDirection: "asc" },
  { field: "source", label: "Source", initialDirection: "asc" },
  { field: "modified", label: "Last modified", initialDirection: "desc" },
  { field: "preferred", label: "Preferred for this repo", initialDirection: "desc" },
];

function PlaybookIdentity({ playbookKey, name }: { playbookKey: string; name: string }) {
  return (
    <span className="playbooks-identity">
      <small>{playbookKey}</small>
      <span>{name}</span>
    </span>
  );
}

function RowIcon({
  label,
  hint,
  caption,
  disabled,
  ghost,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  caption?: string;
  disabled?: boolean;
  ghost?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className={`btn small${caption ? "" : " icon"}${ghost ? " ghost" : ""}`} aria-label={label} title={hint || label} disabled={disabled} onClick={onClick}>
      {children}
      {caption}
    </button>
  );
}

function CommunityColumns({ labels }: { labels: string[] }) {
  return (
    <thead>
      <tr>
        {labels.map((label) => (
          <th key={label} scope="col">
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function CatalogDownload({
  name,
  missing = false,
  imported,
  remoteVersion,
  onDownload,
  onUpdate,
}: {
  name: string;
  missing?: boolean;
  imported: { importedVersion: number } | undefined;
  remoteVersion: number | null;
  onDownload: () => void;
  onUpdate: () => void;
}) {
  if (missing || remoteVersion === null) return null;
  if (!imported) {
    return (
      <RowIcon label={`Download ${name}`} onClick={onDownload}>
        <Download size={16} aria-hidden="true" />
      </RowIcon>
    );
  }
  if (remoteVersion > imported.importedVersion) {
    return (
      <RowIcon label={`Download update ${name}`} onClick={onUpdate}>
        <Download size={16} aria-hidden="true" />
      </RowIcon>
    );
  }
  return (
    <RowIcon label={`Downloaded ${name}`} disabled>
      <Check size={16} aria-hidden="true" />
    </RowIcon>
  );
}

export function Playbooks({ repoPath, onCreateTask }: { repoPath?: string; onCreateTask: (reference: PlaybookRef) => void }) {
  const [catalog, setCatalog] = useState<PlaybookCatalog | null>(null);
  const [selected, setSelected] = useState<ScopedPlaybook | null>(null);
  const [editorRepoPath, setEditorRepoPath] = useState(repoPath);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"repo" | "global">(repoPath ? "repo" : "global");
  const [key, setKey] = useState("new-playbook");
  const [mode, setMode] = useState<"graph" | "editor">("graph");
  const [graphFraction, setGraphFraction] = useState(2 / 3);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("name-asc");
  const [preferredOnly, setPreferredOnly] = useState(false);
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
  const [libraryTab, setLibraryTab] = useState<"local" | "community">("local");
  const [communityFilter, setCommunityFilter] = useState<"all" | "downloaded" | "published">("all");
  const [communityQuery, setCommunityQuery] = useState("");
  const [imports, setImports] = useState<CommunityImportRow[]>([]);
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
  const [myLabel, setMyLabel] = useState<string | null>(null);
  const [downloadRows, setDownloadRows] = useState<DownloadStatusRow[]>([]);
  const [downloadsReady, setDownloadsReady] = useState(false);
  const [publishGuideOpen, setPublishGuideOpen] = useState(false);
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
    ipc
      .listPlaybookCatalog(repoPath)
      .then((value) => {
        if (live) setCatalog(value);
      })
      .catch((e) => {
        if (live) setCatalogError(errorText(e));
      });
    if (repoPath) {
      ipc
        .listCommunityImports({ repoPath })
        .then((value) => {
          if (live) setImports(value.imports);
        })
        .catch(() => {
          if (live) setImports([]);
        });
    } else if (live) {
      setImports([]);
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
    if (open || libraryTab !== "local" || !returningToLibrary.current) return;
    returningToLibrary.current = false;
    if (libraryRef.current) libraryRef.current.scrollTop = libraryScrollTop.current;
    searchRef.current?.focus({ preventScroll: true });
  }, [open, libraryTab]);

  useEffect(() => {
    if (libraryTab !== "community" || communityFilter !== "all") return;
    const trimmed = communityQuery.trim();
    if (trimmed.length > 80) return;
    const generation = communityGeneration.current + 1;
    communityGeneration.current = generation;
    let live = true;
    const timer = setTimeout(
      () => {
        const args = trimmed ? { q: trimmed } : {};
        void Promise.resolve(ipc.listCommunityPlaybooks(args))
          .then((page) => {
            if (!live || generation !== communityGeneration.current) return;
            if (page) {
              setCommunityPlaybooks(page.playbooks);
              setCommunityPage({ query: trimmed, cursor: page.nextCursor });
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
  }, [libraryTab, communityFilter, communityQuery]);

  useEffect(() => {
    if (libraryTab !== "community" || communityFilter !== "downloaded" || !repoPath) return;
    let live = true;
    setDownloadsReady(false);
    ipc
      .communityDownloadStatus({ repoPath })
      .then((value) => {
        if (!live) return;
        setDownloadRows(value.rows);
        setDownloadsReady(true);
      })
      .catch((error) => {
        if (!live) return;
        setCommunityError(errorText(error));
        setDownloadsReady(true);
      });
    return () => {
      live = false;
    };
  }, [libraryTab, communityFilter, repoPath]);

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
      const label = result.playbooks.find((row) => row.label)?.label;
      if (label) setMyLabel(label);
      setMineError("");
      setCommunitySignedIn(true);
      setMineReady(true);
    } catch (error) {
      if (generation !== mineGeneration.current) return;
      setMineError(errorText(error));
      setMineReady(true);
    }
  }, []);

  useEffect(() => {
    if (libraryTab !== "community") return;
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
  }, [libraryTab, reloadMine]);

  const refresh = async (owner: string | undefined) => {
    try {
      const value = await ipc.listPlaybookCatalog(owner);
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
      install(await ipc.readPlaybook(reference, owner), owner);
      setMode("graph");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const begin = async (kind: "new" | "paste" | "copy" | "file", file?: File) => {
    if (busy || !(await discard())) return;
    const owner = kind === "copy" ? editorRepoPath : repoPath;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const content = kind === "new" ? await ipc.renderPlaybookSource(blankDefinition) : kind === "copy" ? source : kind === "file" && file ? await file.text() : "";
      const checked = content ? await ipc.validatePlaybookSource(content) : null;
      setEditorRepoPath(owner);
      setSelected(null);
      setSource(content);
      setOpen(true);
      setMode("editor");
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
    const checked = await ipc.validatePlaybookSource(source);
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
        const current = await ipc.listPlaybookCatalog(owner);
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
      const content = parsed.key === target.key ? source : await ipc.renderPlaybookSource({ ...parsed, key: target.key });
      // The library may have changed while the key-choice dialog was open.
      const latest = await ipc.listPlaybookCatalog(owner);
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
      const saved = await ipc.savePlaybookSource({ target, source: content, overwrite: exists }, owner);
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
      const imports = (await ipc.listCommunityImports({ repoPath: owner })).imports;
      if (currentRepo.current === owner) setImports(imports);
    } catch {
      if (currentRepo.current === owner) setImports([]);
    }
  };
  const showCommunity = async () => {
    if (libraryTab === "community") return;
    if (!(await discard())) return;
    if (open) close();
    setLibraryTab("community");
    setShowImport(false);
  };
  const showLocal = () => setLibraryTab("local");
  // The header action lands on My Playbooks and explains that publish lives on each row.
  const openPublishLibrary = () => {
    setShowImport(false);
    setLibraryTab("community");
    setCommunityQuery("");
    setCommunityFilter("published");
    setPublishGuideOpen(true);
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
    const rows = (await ipc.communityDownloadStatus({ repoPath: owner })).rows;
    if (currentRepo.current === owner) setDownloadRows(rows);
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
  const importPublication = async (owner: string | undefined, id: string, overwrite: boolean) => {
    if (!owner) return;
    const result = await ipc.importCommunityPlaybook({ id, repoPath: owner, overwrite });
    if (result.kind === "needs_account") {
      openSignup(() => importPublication(owner, id, overwrite));
      return;
    }
    if (result.kind === "conflict") {
      if (
        (await askConfirm({
          title: `Overwrite repo/${result.localKey}?`,
          body: `Replace this library definition in ${owner}. Existing tasks retain their original definition.`,
          choices: [
            { key: "overwrite", label: "Overwrite", tone: "danger" },
            { key: "cancel", label: "Cancel", tone: "ghost" },
          ],
        })) !== "overwrite"
      )
        return;
      await importPublication(owner, id, true);
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
    }
  };
  const updatePublication = async (owner: string | undefined, id: string, overwriteEdited: boolean) => {
    if (!owner) return;
    if (!overwriteEdited && editedImports.current.has(id)) {
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
    const result = await ipc.updateCommunityImport({ id, repoPath: owner, overwriteEdited });
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
      ? await ipc.publishCommunityPlaybook({ reference, repoPath, label: publishLabel })
      : await ipc.publishCommunityPlaybook({ reference, repoPath });
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
    setMyLabel(result.label);
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
      await ipc.deletePlaybookSource(selected.source.reference, editorRepoPath);
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
      await ipc.savePlaybookPickerPreferences(next, owner);
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
  const setPreferred = (reference: PlaybookRef, preferred: boolean) => {
    if (!preferences) return;
    const existing = preferences.entries.find((entry) => samePlaybookRef(entry.reference, reference));
    const entry: PickerPreference = {
      reference,
      hidden: false,
      collapsed: false,
      badge: null,
      color: null,
      last_imported_at_ms: null,
      ...existing,
      preferred,
    };
    void savePreferences({
      ...preferences,
      entries: existing ? preferences.entries.map((item) => (samePlaybookRef(item.reference, reference) ? entry : item)) : [...preferences.entries, entry],
    });
  };
  const preferredKeys = new Set(repoPath ? preferences?.entries.filter((entry) => entry.preferred).map((entry) => playbookRefKey(entry.reference)) : []);
  const candidates = catalog?.candidates
    .filter(
      (candidate) =>
        `${candidate.title || ""} ${candidate.description || ""} ${playbookRefKey(candidate.source.reference)}`.toLowerCase().includes(query.trim().toLowerCase()) &&
        (!preferredOnly || !repoPath || !preferences || preferredKeys.has(playbookRefKey(candidate.source.reference))),
    )
    .sort((left, right) => {
      const identityOrder = playbookRefKey(left.source.reference).localeCompare(playbookRefKey(right.source.reference));
      const difference = (left.title || left.source.reference.key).localeCompare(right.title || right.source.reference.key, undefined, { sensitivity: "base", numeric: true });
      if (sort.startsWith("modified")) {
        if (left.modified_at_ms === null) return right.modified_at_ms === null ? difference || identityOrder : sort === "modified-asc" ? -1 : 1;
        if (right.modified_at_ms === null) return sort === "modified-asc" ? 1 : -1;
        const modifiedDifference = left.modified_at_ms - right.modified_at_ms;
        return (sort === "modified-asc" ? modifiedDifference : -modifiedDifference) || difference || identityOrder;
      }
      if (sort.startsWith("source")) {
        const sourceDifference = scopeLabels[left.source.reference.scope].localeCompare(scopeLabels[right.source.reference.scope]);
        return (sort === "source-desc" ? -sourceDifference : sourceDifference) || difference || identityOrder;
      }
      if (sort.startsWith("preferred")) {
        const preferredDifference = Number(preferredKeys.has(playbookRefKey(left.source.reference))) - Number(preferredKeys.has(playbookRefKey(right.source.reference)));
        return (sort === "preferred-desc" ? -preferredDifference : preferredDifference) || difference || identityOrder;
      }
      return (sort === "name-desc" ? -difference : difference) || identityOrder;
    });

  // Publish offers what the user made — repo and global. The bundled library
  // ships with the app and is not theirs to publish.
  const ownPlaybooks = (catalog?.candidates ?? []).filter((candidate) => candidate.source.reference.scope !== "bundled");
  // The label field only exists once the server asks for one. Until it holds a valid
  // slug the request would come back rejected, so Confirm stays off and the rule shows.
  const labelValid = labelPattern.test(publishLabel);
  const mineByKey = new Map(minePlaybooks.map((item) => [item.playbookKey, item]));
  const communityNeedle = communityQuery.trim().toLowerCase();
  const visibleDownloads = downloadRows.filter((row) => {
    if (!communityNeedle) return true;
    return [row.title, row.description, row.label, row.playbookKey].some((value) => (value || "").toLowerCase().includes(communityNeedle));
  });
  const publishedRows = [
    ...ownPlaybooks.map((candidate) => {
      const key = candidate.source.reference.key;
      const publication = mineByKey.get(key);
      const scope = scopeLabels[candidate.source.reference.scope];
      const broken = candidate.diagnostics.length > 0;
      const reference: PlaybookRef | null = candidate.source.reference;
      return {
        key: playbookRefKey(candidate.source.reference),
        playbookKey: key,
        name: publication ? `${publication.label}/${key}` : `${scope}/${key}`,
        title: candidate.title || publication?.title || key,
        author: publication?.label || myLabel || "You",
        status: publication ? "Published" : "Not published",
        version: publication ? String(publication.version) : "—",
        local: scope,
        reference,
        publicationId: publication?.id ?? null,
        remoteVersion: publication?.version ?? null,
        canPush: !broken && !!repoPath,
        pushTitle: broken ? "Fix validation errors in Local first." : !repoPath ? "Select a repository before publishing." : "Publishes the saved file as the next version.",
        pushName: `${publication ? "Update" : "Publish"} ${scope} ${key}`,
      };
    }),
    ...minePlaybooks
      .filter((item) => !ownPlaybooks.some((candidate) => candidate.source.reference.key === item.playbookKey))
      .map((item) => ({
        key: item.id,
        playbookKey: item.playbookKey,
        name: `${item.label}/${item.playbookKey}`,
        title: item.title,
        author: item.label || "You",
        status: "Published",
        version: String(item.version),
        local: "—",
        reference: null as PlaybookRef | null,
        publicationId: item.id,
        remoteVersion: item.version,
        canPush: false,
        pushTitle: "No local copy to publish.",
        pushName: `Update ${item.label}/${item.playbookKey}`,
      })),
  ].filter((row) => !communityNeedle || [row.name, row.title, row.author, row.status, row.local].some((value) => value.toLowerCase().includes(communityNeedle)));
  const communityListReady =
    (communityFilter === "all" && communityReady) ||
    (communityFilter === "downloaded" && (!repoPath || downloadsReady)) ||
    (communityFilter === "published" && (communitySignedIn === false || mineReady));
  const communityRowsEmpty =
    communityFilter === "all" ? communityPlaybooks.length === 0 : communityFilter === "downloaded" ? visibleDownloads.length === 0 : publishedRows.length === 0;

  return (
    <main className="playbooks-page">
      <div className="playbooks-detail">
        <div className="playbooks-toolbar">
          {open ? (
            <button
              className="btn ghost"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (await discard()) close();
              }}
            >
              <ArrowLeft size={16} aria-hidden="true" /> Back to playbooks
            </button>
          ) : (
            <h1>Playbooks</h1>
          )}
          {open && (
            <div className="modes" aria-label="Playbook view">
              <button className={`tab${mode === "graph" ? " on" : ""}`} type="button" aria-pressed={mode === "graph"} onClick={() => setMode("graph")}>
                Graph
              </button>
              <button className={`tab${mode === "editor" ? " on" : ""}`} type="button" aria-pressed={mode === "editor"} onClick={() => setMode("editor")}>
                Editor
              </button>
            </div>
          )}
          <div role="tablist" aria-label="Playbook libraries">
            <button className={`tab${libraryTab === "local" ? " on" : ""}`} type="button" role="tab" aria-selected={libraryTab === "local"} onClick={showLocal}>
              Local
            </button>
            <button
              className={`tab${libraryTab === "community" ? " on" : ""}`}
              type="button"
              role="tab"
              aria-selected={libraryTab === "community"}
              onClick={() => void showCommunity()}
            >
              Community
            </button>
          </div>
          <div className="playbooks-primary-actions" role="group" aria-label="Playbook actions">
            {!open && libraryTab === "community" && (
              <button className="btn" type="button" onClick={openPublishLibrary}>
                Publish playbook
              </button>
            )}
            {libraryTab === "local" && (
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
        {showImport && libraryTab === "local" && (
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
        {!open && libraryTab === "local" && (
          <section
            ref={libraryRef}
            className="playbooks-library"
            aria-label="Playbook library"
            onScroll={(event) => {
              libraryScrollTop.current = event.currentTarget.scrollTop;
            }}
          >
            <section aria-label={repoPath ? `Preferred for ${repoName(repoPath)}` : "Preferred playbooks"}>
              <h2>{repoPath ? `Preferred for ${repoName(repoPath)}` : "Preferred playbooks"}</h2>
              <div className="playbooks-library-controls">
                <label className="playbooks-search">
                  Search playbooks
                  <input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, description or key…" />
                </label>
                <Checkbox label="Preferred only" checked={!!repoPath && !!preferences && preferredOnly} disabled={!repoPath || !preferences} onChange={setPreferredOnly} />
              </div>
              {!repoPath && <p className="hint">Select a repository to manage its preferred playbooks.</p>}
              {preferenceError && <InlineStatus tone="error">{preferenceError}</InlineStatus>}
              {preferenceSaving && <p role="status">Saving preferred playbooks…</p>}
            </section>
            {catalogError && (
              <InlineStatus tone="error">
                {catalogError}
                <button className="btn ghost" type="button" onClick={() => void refresh(repoPath)}>
                  Retry library
                </button>
              </InlineStatus>
            )}
            {!catalog && !catalogError && <LoadingState label="Loading playbooks" state={ORB_STATE} />}
            <div className="playbooks-table-scroll">
              <table className="playbooks-table" aria-label="Playbook library">
                <thead>
                  <tr>
                    {libraryColumns.map(({ field, label, initialDirection }) => {
                      const active = sort.startsWith(`${field}-`);
                      const descending = sort.endsWith("-desc");
                      const nextDirection = active ? (descending ? "asc" : "desc") : initialDirection;
                      const header = (
                        <th key={field} scope="col" aria-sort={active ? (descending ? "descending" : "ascending") : undefined}>
                          <button
                            type="button"
                            className={`playbooks-sort-header${active ? " active" : ""}`}
                            aria-label={`Sort by ${label}`}
                            title={`Sort ${label} ${nextDirection === "desc" ? "descending" : "ascending"}`}
                            onClick={() => setSort(`${field}-${nextDirection}`)}
                          >
                            {label} <span aria-hidden="true">{active ? (descending ? "↓" : "↑") : "↕"}</span>
                          </button>
                        </th>
                      );
                      return header;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {candidates?.map((candidate) => {
                    const identity = playbookRefKey(candidate.source.reference);
                    const isPreferred = preferredKeys.has(identity);
                    return (
                      <tr key={identity} aria-label={identity}>
                        <td>
                          <button
                            className="playbooks-library-row"
                            type="button"
                            aria-label={`${candidate.title || candidate.source.reference.key} ${scopeLabels[candidate.source.reference.scope]}`}
                            disabled={busy || candidate.diagnostics.length > 0}
                            title={identity}
                            onClick={() => void load(candidate.source.reference)}
                          >
                            <BookOpen className="playbooks-library-icon" size={24} aria-hidden="true" />
                            <span className="playbooks-library-name">
                              <strong>{candidate.title || candidate.source.reference.key}</strong>
                              <small>{candidate.description || candidate.source.reference.key}</small>
                            </span>
                          </button>
                          {candidate.diagnostics.map((item) => (
                            <p role="alert" key={`${item.code}:${item.field}:${item.line}:${item.message}`}>
                              {item.code}: {item.message}
                              {item.line ? ` (line ${item.line})` : ""}
                              {item.field ? ` · ${item.field}` : ""}
                            </p>
                          ))}
                        </td>
                        <td>
                          <span className="playbooks-library-source">
                            {scopeLabels[candidate.source.reference.scope]}
                            {candidate.source.reference.scope === "repo" &&
                              imports
                                .filter((item) => item.localKey === candidate.source.reference.key)
                                .map((item) => (
                                  <span key={item.id}>
                                    {" "}
                                    Imported from community {item.label}/{item.playbookKey}
                                  </span>
                                ))}
                          </span>
                        </td>
                        <td>
                          {candidate.modified_at_ms === null ? (
                            "—"
                          ) : (
                            <time dateTime={new Date(candidate.modified_at_ms).toISOString()} title={new Date(candidate.modified_at_ms).toLocaleString()}>
                              {new Date(candidate.modified_at_ms).toLocaleDateString()}
                            </time>
                          )}
                        </td>
                        <td>
                          <Checkbox
                            label={<span className="sr-only">Preferred for this repo: {identity}</span>}
                            checked={isPreferred}
                            disabled={!repoPath || !preferences || preferenceSaving}
                            onChange={(checked) => setPreferred(candidate.source.reference, checked)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {catalog && candidates?.length === 0 && <p>{query || preferredOnly ? "No matching playbooks." : "No playbooks yet. Create or import a definition."}</p>}
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
            <p className="playbooks-library-note">Library changes apply to future tasks only.</p>
          </section>
        )}
        {!open && libraryTab === "community" && (
          <section className="playbooks-library">
            <div className="playbooks-library-controls" role="group" aria-label="Community list">
              <button
                type="button"
                className={`btn ghost small${communityFilter === "all" ? " on" : ""}`}
                aria-pressed={communityFilter === "all"}
                onClick={() => {
                  setCommunityQuery("");
                  setCommunityFilter("all");
                }}
              >
                All
              </button>
              <button
                type="button"
                className={`btn ghost small${communityFilter === "downloaded" ? " on" : ""}`}
                aria-pressed={communityFilter === "downloaded"}
                onClick={() => {
                  setCommunityQuery("");
                  setCommunityFilter("downloaded");
                }}
              >
                Downloaded
              </button>
              <button
                type="button"
                className={`btn ghost small${communityFilter === "published" ? " on" : ""}`}
                aria-pressed={communityFilter === "published"}
                onClick={() => {
                  setCommunityQuery("");
                  setCommunityFilter("published");
                }}
              >
                My Playbooks
              </button>
            </div>
            <label>
              Search community playbooks
              <input type="search" value={communityQuery} onChange={(event) => setCommunityQuery(event.target.value)} />
            </label>
            {communityQuery.trim().length > 80 && <p>Invalid query.</p>}
            {communityFilter === "all" && communityQuery.trim().length > 0 && communityQuery.trim().length <= 80 && <p>Search can omit matches.</p>}
            {communityError && communityFilter !== "published" && <InlineStatus tone="error">{communityError}</InlineStatus>}
            {communityFilter === "published" && mineError && <InlineStatus tone="error">{mineError}</InlineStatus>}
            {communityFilter === "published" && mineTruncated && <p>Only the newest 1000 publications are listed.</p>}
            {communityFilter === "published" && communitySignedIn === false && (
              <p className="playbook-empty">
                Sign in to see playbooks you published.
                <button type="button" className="btn small" onClick={() => void withAccount(async () => reloadMine())}>
                  Sign up
                </button>
              </p>
            )}
            {communityFilter === "published" && communitySignedIn !== false && !mineReady && <LoadingState label="Loading your playbooks" state={ORB_STATE} />}
            {((communityFilter === "all" && communityReady) ||
              communityFilter === "downloaded" ||
              (communityFilter === "published" && (communitySignedIn === false || mineReady))) && (
              <table className="playbooks-table playbooks-community-table" aria-label="Community playbooks">
                {communityFilter === "all" ? (
                  <CommunityColumns labels={["Playbook", "Title", "Description", "Version", "Updated", "Actions"]} />
                ) : communityFilter === "downloaded" ? (
                  <CommunityColumns labels={["Playbook", "Title", "Imported", "Catalog", "Status", "Actions"]} />
                ) : (
                  <CommunityColumns labels={["Playbook", "Title", "Status", "Version", "Local", "Actions"]} />
                )}
                <tbody>
                  {communityFilter === "all"
                    ? communityPlaybooks.map((item) => {
                        const imported = imports.find((row) => row.id === item.id);
                        const name = `${item.label}/${item.playbookKey}`;
                        const updateAvailable = !!imported && item.version > imported.importedVersion;
                        return (
                          <tr key={item.id}>
                            <td>
                              <PlaybookIdentity playbookKey={item.playbookKey} name={item.title} />
                            </td>
                            <td>{item.title}</td>
                            <td>{item.description}</td>
                            <td>{item.version}</td>
                            <td>{item.updatedAt}</td>
                            <td>
                              <span className="playbooks-row-actions">
                                {(!imported || updateAvailable) && (
                                  <RowIcon ghost label={`Preview ${name}`} onClick={() => void withAccount(() => previewPublication(item.id, name))}>
                                    <Eye size={16} aria-hidden="true" />
                                  </RowIcon>
                                )}
                                <CatalogDownload
                                  name={name}
                                  imported={imported}
                                  remoteVersion={item.version}
                                  onDownload={() => void withAccount(() => importPublication(repoPath, item.id, false))}
                                  onUpdate={() => void withAccount(() => updatePublication(repoPath, item.id, false))}
                                />
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    : communityFilter === "downloaded"
                      ? visibleDownloads.map((row) => {
                          const name = `${row.label}/${row.playbookKey}`;
                          const status = row.remoteMissing
                            ? "No longer published"
                            : row.error
                              ? row.error
                              : row.updateAvailable
                                ? `Update available${row.localMissing ? " Local copy missing" : ""}`
                                : row.remoteVersion != null && row.remoteVersion < row.importedVersion
                                  ? `${row.importedVersion} ${row.remoteVersion}`
                                  : `Up to date${row.localMissing ? " Local copy missing" : ""}`;
                          return (
                            <tr key={row.id}>
                              <td>
                                <PlaybookIdentity playbookKey={row.playbookKey} name={row.title || row.playbookKey} />
                              </td>
                              <td>{row.title}</td>
                              <td>{row.importedVersion}</td>
                              <td>{row.remoteVersion ?? ""}</td>
                              <td>{status}</td>
                              <td>
                                <span className="playbooks-row-actions">
                                  {row.updateAvailable && !row.remoteMissing && (
                                    <RowIcon ghost label={`Preview ${name}`} onClick={() => void withAccount(() => previewPublication(row.id, name))}>
                                      <Eye size={16} aria-hidden="true" />
                                    </RowIcon>
                                  )}
                                  <CatalogDownload
                                    name={name}
                                    missing={row.remoteMissing}
                                    imported={{ importedVersion: row.importedVersion }}
                                    remoteVersion={row.remoteVersion}
                                    onDownload={() => void withAccount(() => importPublication(repoPath, row.id, false))}
                                    onUpdate={() => void withAccount(() => updatePublication(repoPath, row.id, false))}
                                  />
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      : publishedRows.map((row) => {
                          const publicationId = row.publicationId;
                          return (
                            <tr key={row.key}>
                              <td>
                                <PlaybookIdentity playbookKey={row.playbookKey} name={row.title} />
                              </td>
                              <td>{row.title}</td>
                              <td>{row.status}</td>
                              <td>{row.version}</td>
                              <td>{row.local}</td>
                              <td>
                                <span className="playbooks-row-actions">
                                  {publicationId && (
                                    <CatalogDownload
                                      name={row.name}
                                      imported={imports.find((item) => item.id === publicationId)}
                                      remoteVersion={row.remoteVersion}
                                      onDownload={() => void withAccount(() => importPublication(repoPath, publicationId, false))}
                                      onUpdate={() => void withAccount(() => updatePublication(repoPath, publicationId, false))}
                                    />
                                  )}
                                  <RowIcon
                                    label={row.pushName}
                                    hint={row.pushTitle}
                                    caption={row.pushName.startsWith("Publish") ? "Publish" : undefined}
                                    disabled={!row.canPush || !row.reference}
                                    onClick={() => {
                                      const reference = row.reference;
                                      if (!reference) return;
                                      void withAccount(async () =>
                                        openPublishConfirm({ reference, playbookKey: row.playbookKey, title: row.title, fromVersion: row.remoteVersion }),
                                      );
                                    }}
                                  >
                                    {row.pushName.startsWith("Publish") ? <Share2 size={16} aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}
                                  </RowIcon>
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                </tbody>
              </table>
            )}
            {communityListReady && communityRowsEmpty && <p className="playbook-empty">No playbooks found</p>}
            {communityFilter === "all" && communityPage.cursor && communityPage.query === communityQuery.trim() && communityQuery.trim().length <= 80 && (
              <button
                type="button"
                onClick={() => {
                  const cursor = communityPage.cursor;
                  if (!cursor) return;
                  const trimmed = communityPage.query;
                  const generation = communityGeneration.current;
                  const args = trimmed ? { q: trimmed, cursor } : { cursor };
                  void Promise.resolve(ipc.listCommunityPlaybooks(args))
                    .then((page) => {
                      if (!page || generation !== communityGeneration.current) return;
                      setCommunityPlaybooks((current) => [...current, ...page.playbooks]);
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
        )}
        {publishGuideOpen && (
          <Dialog onClose={() => setPublishGuideOpen(false)} role="dialog" ariaLabel="Publish a playbook">
            <div className="mh">
              <span className="mt">Publish a playbook</span>
              <button type="button" className="x" aria-label="Close" title="Close" onClick={() => setPublishGuideOpen(false)}>
                <X size={14} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
            <div className="mb">
              <p className="dim">You can publish any playbook you've made here.</p>
            </div>
            <div className="mfoot">
              <button type="button" className="btn ghost small" data-autofocus onClick={() => setPublishGuideOpen(false)}>
                Close
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
                    {selected ? scopeLabels[selected.source.reference.scope] : "New definition"}
                    {dirty && " · Unsaved changes"}
                  </div>
                  <h2>{selected?.definition.title || "Create playbook"}</h2>
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
              {mode === "graph" ? (
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
                    <p className="playbooks-empty">Save this definition before a graph is available. Continue editing in Editor.</p>
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
