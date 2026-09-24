import { ArrowLeft, BookOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { askConfirm } from "../confirm";
import { ORB_STATE } from "../Indicators";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { PlaybookSourceEditor } from "../PlaybookSourceEditor";
import { Checkbox, InlineStatus, LoadingState, playbookRefKey, repoName, samePlaybookRef } from "../shared";
import type { NormalizedPlaybook, PickerPreference, PickerPreferences, PlaybookCatalog, PlaybookRef, PlaybookValidationError, ScopedPlaybook } from "../types";

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
const errorText = (error: unknown) => (typeof error === "object" ? JSON.stringify(error) : String(error));
const libraryColumns = [
  { field: "name", label: "Playbook Name", initialDirection: "asc" },
  { field: "source", label: "Source", initialDirection: "asc" },
  { field: "modified", label: "Last modified", initialDirection: "desc" },
  { field: "preferred", label: "Preferred for this repo", initialDirection: "desc" },
];

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
      const target = selected?.source.reference || { scope, key };
      // Only save-as changes the document identity. Ordinary editing preserves exact authored bytes.
      if (selected && parsed.key !== target.key) {
        setError("The document key must match this library entry. Use Make a copy to save under another key.");
        return;
      }
      const content = parsed.key === target.key ? source : await ipc.renderPlaybookSource({ ...parsed, key: target.key });
      const latest = await ipc.listPlaybookCatalog(owner);
      const exists = latest.candidates.some((candidate) => playbookRefKey(candidate.source.reference) === playbookRefKey(target));
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
      if (e && typeof e === "object" && "diagnostics" in e && Array.isArray(e.diagnostics))
        setDiagnostics(
          e.diagnostics.filter(
            (item): item is PlaybookValidationError => item !== null && typeof item === "object" && typeof item.code === "string" && typeof item.message === "string",
          ),
        );
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
  const remove = async () => {
    if (busy || !selected || readOnly || !(await discard())) return;
    if (
      (await askConfirm({
        title: `Delete ${playbookRefKey(selected.source.reference)}?`,
        body: `Delete only this library entry in ${editorRepoPath || "the global library"}. Existing tasks and other scopes are retained.`,
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
          <div className="playbooks-primary-actions" role="group" aria-label="Playbook actions">
            <button className="btn" type="button" disabled={busy} onClick={() => void begin("new")}>
              New playbook
            </button>
            <button className="btn ghost" type="button" disabled={busy} aria-expanded={showImport} onClick={() => setShowImport(!showImport)}>
              Import
            </button>
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
        {showImport && (
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
        {error && <InlineStatus tone="error">{error}</InlineStatus>}
        {!open && (
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
                      return (
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
                          <span className="playbooks-library-source">{scopeLabels[candidate.source.reference.scope]}</span>
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
              {selected && !readOnly && (
                <button className="btn ghost playbooks-delete" type="button" disabled={busy} onClick={() => void remove()}>
                  Delete definition
                </button>
              )}
            </footer>
          </section>
        )}
      </div>
    </main>
  );
}
