import { useRef, useState } from "react";
import { MAX_CHAT_FILE_BYTES } from "../chat/attachments";
import type { ExecutionAssessment, OutputAssignment, SuppliedExecutionArtifact } from "../types";
import "./ArtifactHandoffPage.css";

type Preview = { assessment: ExecutionAssessment; diagnostics: string[] };
export type ArtifactHandoffPageProps = {
  stepTitle: string;
  outputs: OutputAssignment[];
  destinations: { step_key: string; title: string }[];
  busy: boolean;
  error: string;
  onPreview: (artifacts: SuppliedExecutionArtifact[]) => Promise<Preview>;
  onSubmit: (artifacts: SuppliedExecutionArtifact[]) => Promise<void>;
  onCancel: () => void;
};
type Draft = SuppliedExecutionArtifact & { id: number; assignment: number; supplied: boolean };

function matchesAssignment(path: string, assignment: string): boolean {
  if (!path || /[\\:*?[\]]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  const star = assignment.indexOf("*");
  if (star < 0) return path === assignment;
  const prefix = assignment.slice(0, star);
  const suffix = assignment.slice(star + 1);
  return (
    path.startsWith(prefix) &&
    path.endsWith(suffix) &&
    path.length > prefix.length + suffix.length &&
    !path.slice(prefix.length, path.length - suffix.length || undefined).includes("/")
  );
}

export function ArtifactHandoffPage({ stepTitle, outputs, destinations, busy, error, onPreview, onSubmit, onCancel }: ArtifactHandoffPageProps) {
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    outputs.flatMap((output, assignment) =>
      output.relative_path.includes("*") ? [] : [{ id: assignment, assignment, relative_path: output.relative_path, content: "", supplied: false }],
    ),
  );
  const nextId = useRef(outputs.length);
  const revision = useRef(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [localError, setLocalError] = useState("");
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || uploading || submitting;
  const supplied = drafts.filter((draft) => draft.supplied);
  const artifacts = supplied.map(({ relative_path, content }) => ({ relative_path, content }));
  const pathErrors = supplied.flatMap((draft) =>
    matchesAssignment(draft.relative_path, outputs[draft.assignment].relative_path) ? [] : [`Choose a concrete path matching ${outputs[draft.assignment].relative_path}.`],
  );
  if (new Set(artifacts.map((artifact) => artifact.relative_path)).size !== artifacts.length) pathErrors.push("Each supplied path must be unique.");
  const valid = preview !== null && preview.diagnostics.length === 0 && preview.assessment.terminality !== "unresolved";

  function invalidate() {
    revision.current += 1;
    setPreview(null);
    setLocalError("");
  }
  function update(id: number, patch: Partial<Draft>) {
    invalidate();
    setDrafts((current) => current.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  }
  async function upload(id: number, file: File) {
    invalidate();
    if (file.size > MAX_CHAT_FILE_BYTES) {
      setLocalError(`${file.name} exceeds 25 MiB.`);
      return;
    }
    setUploading(true);
    try {
      const content = await file.text();
      update(id, { content, supplied: true });
    } catch (cause) {
      setLocalError(`Could not read ${file.name}: ${String(cause)}`);
    } finally {
      setUploading(false);
    }
  }
  async function check() {
    if (locked || checking || pathErrors.length) return;
    const checkedRevision = revision.current;
    setChecking(true);
    setPreview(null);
    setLocalError("");
    try {
      const result = await onPreview(artifacts);
      if (revision.current === checkedRevision) setPreview(result);
    } catch (cause) {
      if (revision.current === checkedRevision) setLocalError(String(cause));
    } finally {
      setChecking(false);
    }
  }
  async function submit() {
    if (locked || checking || !valid || pathErrors.length) return;
    setSubmitting(true);
    setLocalError("");
    try {
      await onSubmit(artifacts);
    } catch (cause) {
      setLocalError(String(cause));
      setPreview(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="artifact-handoff" aria-label="Continue with artifact">
      <header>
        <h1>Continue with artifact</h1>
        <p>
          Add the saved work for <strong>{stepTitle}</strong>.
        </p>
        <p>Upload a file or paste text. The current session stops only when you confirm Continue.</p>
      </header>
      <section aria-label="Artifacts">
        <h2>Artifacts</h2>
        <p>Leave a file unchanged to use its saved version.</p>
        {outputs.map((output, assignment) => {
          const family = output.relative_path.includes("*");
          return (
            <fieldset key={output.relative_path} disabled={locked} className="artifact-handoff-output">
              <legend>{output.selector}</legend>
              <p>
                {family ? "File pattern" : "Save to"}: <code>{output.relative_path}</code>
              </p>
              {drafts
                .filter((draft) => draft.assignment === assignment)
                .map((draft, index) => {
                  const label = family ? `${output.selector} member ${index + 1}` : output.relative_path;
                  return (
                    <div className="artifact-handoff-draft" key={draft.id}>
                      {family && (
                        <label>
                          Concrete path for {label}
                          <input
                            value={draft.relative_path}
                            placeholder={output.relative_path.replace("*", "name")}
                            onChange={(event) => update(draft.id, { relative_path: event.target.value })}
                          />
                        </label>
                      )}
                      <label>
                        Upload file for {label}
                        <input
                          type="file"
                          accept=".md,text/markdown,text/plain"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void upload(draft.id, file);
                          }}
                        />
                      </label>
                      <label>
                        Content for {label}
                        <textarea
                          rows={8}
                          value={draft.content}
                          placeholder="Paste or upload artifact content"
                          onChange={(event) => update(draft.id, { content: event.target.value, supplied: true })}
                        />
                      </label>
                      <div className="artifact-handoff-draft-footer">
                        <span>{draft.supplied ? "Will replace this path on Continue" : "Not supplied — existing artifact unchanged"}</span>
                        <button
                          type="button"
                          className="btn ghost small"
                          disabled={!family && !draft.supplied}
                          onClick={() => {
                            invalidate();
                            setDrafts((current) =>
                              family
                                ? current.filter((item) => item.id !== draft.id)
                                : current.map((item) => (item.id === draft.id ? { ...item, supplied: false, content: "" } : item)),
                            );
                          }}
                        >
                          {family ? `Remove ${label}` : "Keep existing artifact"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              {family && (
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    invalidate();
                    const id = nextId.current++;
                    setDrafts((current) => [...current, { id, assignment, relative_path: "", content: "", supplied: true }]);
                  }}
                >
                  Add member to {output.selector}
                </button>
              )}
            </fieldset>
          );
        })}
      </section>
      <section className="artifact-handoff-result" aria-label="Next step" aria-live="polite">
        <h2>Next step</h2>
        {!preview && <p>{checking ? "Checking artifacts…" : "Check artifacts to see what happens next."}</p>}
        {!preview && destinations.length > 0 && <p>Possible next steps: {destinations.map((destination) => destination.title).join(", ")}</p>}
        {preview && (
          <>
            {preview.assessment.terminality === "terminal" ? (
              <p>This finishes this branch.</p>
            ) : preview.assessment.terminality === "unresolved" ? (
              <p>The next step is not clear yet. Address the issues below and check again.</p>
            ) : preview.assessment.destinations.length > 0 ? (
              <p>Next: {preview.assessment.destinations.map((destination) => destination.title).join(", ")}</p>
            ) : (
              <p>Waiting for other steps.</p>
            )}
            {valid && <p>Artifacts are valid. Ready to continue.</p>}
            {preview.diagnostics.length > 0 && (
              <ul>
                {[...new Set(preview.diagnostics)].map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            {preview.assessment.reasons.length > 0 && (
              <ul>
                {[...new Set(preview.assessment.reasons.map((reason) => reason.message))].map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {pathErrors.length > 0 && (
          <ul>
            {[...new Set(pathErrors)].map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
        {(error || localError) && <p role="alert">{localError || error}</p>}
      </section>
      <p>Continuing replaces the files you supplied at the paths shown above. Your code and session history are kept. Nothing is saved before confirmation.</p>
      <footer className="artifact-handoff-actions">
        <button type="button" className="btn ghost" disabled={locked} onClick={onCancel}>
          Back to session
        </button>
        <button type="button" className="btn" disabled={locked || checking || pathErrors.length > 0} onClick={() => void check()}>
          {checking ? "Checking…" : "Check artifacts"}
        </button>
        <button type="button" className="btn primary" disabled={locked || checking || !valid || pathErrors.length > 0} onClick={() => void submit()}>
          {submitting ? "Continuing…" : "Continue"}
        </button>
      </footer>
    </main>
  );
}
