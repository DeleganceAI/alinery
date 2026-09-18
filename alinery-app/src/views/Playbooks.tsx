import { useEffect, useRef, useState } from "react";
import { askConfirm } from "../confirm";
import * as ipc from "../ipc";
import { PlaybookGraph } from "../PlaybookGraph";
import { Checkbox, InlineStatus, ModelInput, playbookRefKey } from "../shared";
import type { NormalizedPlaybook, NormalizedStep, PlaybookCatalog, PlaybookRef, PlaybookValidationError, ScopedPlaybook } from "../types";

const blankStep = (): NormalizedStep => ({ key: "work", title: "Work", short: "Work", is_coding_step: false, auto_advance_default: false, inputs: [{ path: "ticket.md", mode: "single" }], outputs: [{ path: "result.md" }], model: "", harness: "", prompt: "Read the assigned inputs and write the assigned result.\n" });
const blankDefinition = (): NormalizedPlaybook => ({ version: 2, key: "new-playbook", title: "New playbook", description: "", default_model: "", default_harness: "omp", step: [blankStep()], preamble: "", section_order: ["work"] });

export function Playbooks({ repoPath }: { repoPath?: string }) {
  const [catalog, setCatalog] = useState<PlaybookCatalog | null>(null);
  const [selected, setSelected] = useState<ScopedPlaybook | null>(null);
  const [editorRepoPath, setEditorRepoPath] = useState(repoPath);
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [definition, setDefinition] = useState<NormalizedPlaybook | null>(null);
  const [scope, setScope] = useState<PlaybookRef["scope"]>(repoPath ? "repo" : "global");
  const [key, setKey] = useState("new-playbook");
  const [mode, setMode] = useState<"source" | "form">("source");
  const [diagnostics, setDiagnostics] = useState<PlaybookValidationError[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [productModel, setProductModel] = useState("");
  const generation = useRef(0);
  const editorRef = useRef<HTMLElement>(null);
  const dirty = source !== savedSource;

  useEffect(() => {
    let live = true;
    setCatalog(null);
    ipc.listPlaybookCatalog(repoPath).then((value) => { if (live) setCatalog(value); }).catch((e) => { if (live) setError(String(e)); });
    (repoPath ? ipc.readConfigForRepo(repoPath) : ipc.readGlobalSettings()).then((value) => { if (live) setProductModel(value.defaults.model); }).catch(() => {});
    return () => { live = false; };
  }, [repoPath]);

  useEffect(() => {
    if (!open) return;
    editorRef.current?.focus({ preventScroll: true });
    editorRef.current?.scrollIntoView?.({ block: "start" });
  }, [open, selected, mode]);

  const discard = async () => !dirty || await askConfirm({ title: "Discard unsaved playbook changes?", body: "The saved definition will remain unchanged.", choices: [{ key: "discard", label: "Discard", tone: "danger" }, { key: "cancel", label: "Keep editing", tone: "ghost" }] }) === "discard";
  const install = (value: ScopedPlaybook, owningRepo = repoPath) => {
    setEditorRepoPath(owningRepo);
    setSelected(value); setSource(value.source_text); setSavedSource(value.source_text); setDefinition(value.definition);
    setScope(value.source.reference.scope); setKey(value.source.reference.key); setDiagnostics([]); setOpen(true);
  };
  const load = async (reference: PlaybookRef) => {
    if (!await discard()) return;
    setBusy(true); setError("");
    try { install(await ipc.readPlaybook(reference, repoPath)); }
    catch (e) { setError(typeof e === "object" ? JSON.stringify(e) : String(e)); }
    finally { setBusy(false); }
  };
  const updateDefinition = async (next: NormalizedPlaybook) => {
    const request = ++generation.current;
    setDefinition(next);
    setBusy(true);
    try {
      const rendered = await ipc.renderPlaybookSource(next);
      if (request === generation.current) { setSource(rendered); setDiagnostics([]); setBusy(false); }
    } catch (e) { if (request === generation.current) { setError(String(e)); setBusy(false); } }
  };
  const validate = async () => {
    const checked = await ipc.validatePlaybookSource(source);
    setDiagnostics(checked.diagnostics); setDefinition(checked.definition);
    if (!checked.definition) setMode("source");
    return checked.definition;
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const parsed = await validate();
      if (!parsed) return;
      if (scope === "bundled") { setError("Bundled definitions are read-only. Choose Global or Repository to save a copy."); return; }
      const target = { scope, key };
      const content = parsed.key === key ? source : await ipc.renderPlaybookSource({ ...parsed, key });
      const currentCatalog = await ipc.listPlaybookCatalog(editorRepoPath);
      let overwrite = false;
      if (currentCatalog.candidates.some((candidate) => playbookRefKey(candidate.source.reference) === playbookRefKey(target))) {
        overwrite = await askConfirm({ title: `Overwrite ${playbookRefKey(target)}?`, body: "This replaces only this library definition. Existing tasks retain their original source.", choices: [{ key: "overwrite", label: "Overwrite", tone: "danger" }, { key: "cancel", label: "Cancel", tone: "ghost" }] }) === "overwrite";
        if (!overwrite) return;
      }
      const saved = await ipc.savePlaybookSource({ target, source: content, overwrite }, editorRepoPath);
      install(saved, editorRepoPath); setCatalog(await ipc.listPlaybookCatalog(repoPath));
    } catch (e) {
      if (e && typeof e === "object" && "diagnostics" in e && Array.isArray(e.diagnostics)) {
        const items = e.diagnostics.filter((item): item is PlaybookValidationError => item !== null && typeof item === "object" && typeof item.code === "string" && typeof item.message === "string");
        setDiagnostics(items);
      }
      setError(typeof e === "object" ? JSON.stringify(e) : String(e));
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || selected.source.reference.scope === "bundled") return;
    if (await askConfirm({ title: `Delete ${playbookRefKey(selected.source.reference)}?`, body: "Only this writable library entry is deleted. Task-owned definitions and other scopes are retained.", choices: [{ key: "delete", label: "Delete", tone: "danger" }, { key: "cancel", label: "Cancel", tone: "ghost" }] }) !== "delete") return;
    setBusy(true); setError("");
    try { await ipc.deletePlaybookSource(selected.source.reference, editorRepoPath); setCatalog(await ipc.listPlaybookCatalog(repoPath)); setOpen(false); setSelected(null); setSource(""); setSavedSource(""); }
    catch (e) { setError(typeof e === "object" ? JSON.stringify(e) : String(e)); }
    finally { setBusy(false); }
  };
  const patchStep = (index: number, patch: Partial<NormalizedStep>) => {
    if (!definition) return;
    void updateDefinition({ ...definition, step: definition.step.map((step, i) => i === index ? { ...step, ...patch } : step) });
  };

  return <main className="create-page playbooks-page">
    <h1>Playbooks</h1>
    <p>Canonical Markdown definitions. Tasks retain the exact source selected at creation.</p>
    {error && <InlineStatus tone="error">{error}</InlineStatus>}
    <div className="actions">
      <button className="btn" type="button" disabled={busy} onClick={async () => {
        if (!await discard()) return;
        setEditorRepoPath(repoPath);
        setSelected(null); setSavedSource(""); setKey("new-playbook"); setScope(repoPath ? "repo" : "global"); setOpen(true); setMode("form"); setError(""); await updateDefinition(blankDefinition());
      }}>New playbook</button>
      <label>Import local file <input type="file" accept=".md,text/markdown,text/plain" disabled={busy} onChange={async (event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file || !await discard()) return;
        setEditorRepoPath(repoPath);
        setBusy(true);
        try {
          const content = await file.text(); const checked = await ipc.validatePlaybookSource(content);
          setSource(content); setSavedSource(""); setSelected(null); setOpen(true); setMode("source"); setDefinition(checked.definition); setDiagnostics(checked.diagnostics);
          setKey(checked.definition?.key ?? "imported-playbook"); setScope(repoPath ? "repo" : "global");
        } catch (e) { setError(String(e)); } finally { setBusy(false); }
      }} /></label>
      <button className="btn" type="button" disabled={busy} onClick={async () => {
        if (!await discard()) return;
        setEditorRepoPath(repoPath);
        setSelected(null); setSource(""); setSavedSource(""); setDefinition(null); setDiagnostics([]); setMode("source"); setOpen(true); setScope(repoPath ? "repo" : "global");
      }}>Paste source</button>
    </div>
    <ul aria-label="Playbook library">
      {catalog?.candidates.map((candidate) => <li key={playbookRefKey(candidate.source.reference)}>
        <button className="btn" type="button" disabled={busy || candidate.diagnostics.length > 0} onClick={() => void load(candidate.source.reference)}>{candidate.title || candidate.source.reference.key}</button>
        <code>{playbookRefKey(candidate.source.reference)}</code> <span>{candidate.modified_at_ms === null ? "Modification time unavailable" : new Date(candidate.modified_at_ms).toLocaleString()}</span>
        {candidate.diagnostics.map((item, i) => <p role="alert" key={`${item.code}:${i}`}>{item.code}: {item.message}{item.line ? ` (line ${item.line})` : ""}</p>)}
      </li>)}
    </ul>
    {catalog?.diagnostics.map((item, i) => <InlineStatus key={i} tone="error">{item.code}: {item.message}</InlineStatus>)}
    {open && <section ref={editorRef} tabIndex={-1} aria-label="Playbook editor">
      <h2>{selected ? playbookRefKey(selected.source.reference) : "Import or create"}{dirty ? " — unsaved" : ""}</h2>
      <p>Library repository: {editorRepoPath || "None — global library only"}</p>
      <label>Save scope <select value={scope} onChange={(e) => setScope(e.target.value as PlaybookRef["scope"])}><option value="bundled" disabled>Bundled (read-only)</option><option value="global">Global</option><option value="repo" disabled={!editorRepoPath}>Repository</option></select></label>
      <label>Save key <input value={key} onChange={(e) => setKey(e.target.value)} /></label>
      <button className="btn" type="button" disabled={busy} onClick={async () => {
        if (mode === "source") { setBusy(true); try { if (await validate()) setMode("form"); } catch (e) { setError(String(e)); } finally { setBusy(false); } }
        else setMode("source");
      }}>{mode === "source" ? "Edit form" : "Edit source"}</button>
      {mode === "source" ? <label>Playbook source<textarea rows={25} value={source} onChange={(e) => { generation.current += 1; setSource(e.target.value); setDefinition(null); }} /></label> : definition && <div>
        <label>Title<input value={definition.title} onChange={(e) => void updateDefinition({ ...definition, title: e.target.value })} /></label>
        <label>Description<textarea value={definition.description} onChange={(e) => void updateDefinition({ ...definition, description: e.target.value })} /></label>
        <label>Default harness<select value={definition.default_harness} onChange={(e) => void updateDefinition({ ...definition, default_harness: e.target.value })}><option value="">Inherit task default</option><option value="omp">OMP</option></select></label>
        <label>Default model<ModelInput ariaLabel="Default model" harness="omp" value={definition.default_model} onChange={(model) => void updateDefinition({ ...definition, default_model: model })} repoPath={repoPath} prefillRemembered={false} /></label>
        <label>Preamble<textarea value={definition.preamble} onChange={(e) => void updateDefinition({ ...definition, preamble: e.target.value })} /></label>
        {definition.step.map((step, index) => <fieldset key={index}>
          <legend>{step.title || `Step ${index + 1}`}</legend>
          <label>Step key<input value={step.key} onChange={(e) => {
            const nextKey = e.target.value; void updateDefinition({ ...definition, step: definition.step.map((item, i) => i === index ? { ...item, key: nextKey } : item), section_order: definition.section_order.map((item) => item === step.key ? nextKey : item) });
          }} /></label>
          <label>Step title<input value={step.title} onChange={(e) => patchStep(index, { title: e.target.value })} /></label>
          <label>Short label<input value={step.short} onChange={(e) => patchStep(index, { short: e.target.value })} /></label>
          <Checkbox checked={step.is_coding_step} onChange={(checked) => patchStep(index, { is_coding_step: checked })} label="Coding step" />
          <Checkbox checked={step.auto_advance_default} onChange={(checked) => patchStep(index, { auto_advance_default: checked })} label="Automatic completion by default" />
          <label>Step harness<select value={step.harness} onChange={(e) => patchStep(index, { harness: e.target.value })}><option value="">Inherit</option><option value="omp">OMP</option></select></label>
          <label>Step model<ModelInput ariaLabel="Step model" harness="omp" value={step.model} onChange={(model) => patchStep(index, { model })} repoPath={repoPath} prefillRemembered={false} /></label>
          <p>Effective model: {step.model || definition.default_model || productModel || "Product default"}. A task launch default applies only when this step and playbook do not specify a model; an explicit session override takes priority.</p>
          {step.inputs.map((input, inputIndex) => <div key={inputIndex}><label>Input path<input value={input.path} onChange={(e) => patchStep(index, { inputs: step.inputs.map((item, i) => i === inputIndex ? { ...item, path: e.target.value } : item) })} /></label><label>Input mode<select value={input.mode} onChange={(e) => patchStep(index, { inputs: step.inputs.map((item, i) => i === inputIndex ? { ...item, mode: e.target.value as typeof input.mode } : item) })}><option value="single">single</option><option value="each">each</option><option value="complete">complete</option></select></label><button className="btn" type="button" onClick={() => patchStep(index, { inputs: step.inputs.filter((_, i) => i !== inputIndex) })}>Remove input</button></div>)}
          <button className="btn" type="button" onClick={() => patchStep(index, { inputs: [...step.inputs, { path: "input.md", mode: "single" }] })}>Add input</button>
          {step.outputs.map((output, outputIndex) => <label key={outputIndex}>Output path<input value={output.path} onChange={(e) => patchStep(index, { outputs: step.outputs.map((item, i) => i === outputIndex ? { path: e.target.value } : item) })} /><button className="btn" type="button" onClick={() => patchStep(index, { outputs: step.outputs.filter((_, i) => i !== outputIndex) })}>Remove output</button></label>)}
          <button className="btn" type="button" onClick={() => patchStep(index, { outputs: [...step.outputs, { path: "result.md" }] })}>Add output</button>
          <label>Prompt<textarea rows={8} value={step.prompt} onChange={(e) => patchStep(index, { prompt: e.target.value })} /></label>
          <button className="btn" type="button" onClick={() => void updateDefinition({ ...definition, step: definition.step.filter((_, i) => i !== index), section_order: definition.section_order.filter((item) => item !== step.key) })}>Remove step</button>
        </fieldset>)}
        <button className="btn" type="button" onClick={() => { const step = { ...blankStep(), key: `step-${definition.step.length + 1}`, title: "New step" }; void updateDefinition({ ...definition, step: [...definition.step, step], section_order: [...definition.section_order, step.key] }); }}>Add step</button>
        <PlaybookGraph title={definition.title} steps={definition.step} selectedAutoAdvance={definition.step.filter((step) => step.auto_advance_default).map((step) => step.key)} />
      </div>}
      <ul aria-label="Validation diagnostics">{diagnostics.map((item, i) => <li role="alert" key={i}><strong>{item.code}</strong> {item.message} {item.field && <code>{item.field}</code>}{item.line && ` Line ${item.line}`}</li>)}</ul>
      <button className="btn" type="button" disabled={busy} onClick={() => { setBusy(true); void validate().catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>Validate</button>
      <button className="btn" type="button" disabled={busy || !key || scope === "bundled"} onClick={() => void save()}>Save definition</button>
      {selected && selected.source.reference.scope !== "bundled" && <button className="btn" type="button" disabled={busy} onClick={() => void remove()}>Delete definition</button>}
      <button className="btn" type="button" disabled={busy} onClick={async () => { if (await discard()) { setOpen(false); setSource(savedSource); } }}>Close editor</button>
    </section>}
  </main>;
}
