import { useCallback, useEffect, useState } from "react";
import { readSpecs, type Specs, writeSpec } from "../sync/specs";

// The three files the daemon reads from `specs/` (domain/repoSpecs.ts SPEC_NAMES). The daemon refuses any other name.
const SLOTS: Record<string, { title: string; hint: string; template: string }> = {
  "requirements.md": { title: "Requirements", hint: "What every change must satisfy.", template: "# Requirements\n\n- \n" },
  "tooling.md": { title: "Tooling", hint: "The linters, formatters and test commands to use, with their settings.", template: "# Tooling\n\n- Lint: \n- Format: \n- Test: \n" },
  "architecture.md": { title: "Architecture", hint: "Layout and design conventions.", template: "# Architecture\n\n- \n" },
};

/** Create, edit and save the repository's requirement files in place. Saving never commits: a playbook step is given the committed text. */
export function SettingsSpecs({ repo }: { repo: string }) {
  const [specs, setSpecs] = useState<Specs | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setSpecs(await readSpecs(repo));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repo]);

  useEffect(() => {
    setSpecs(null);
    setDrafts({});
    void load();
  }, [load]);

  const save = async (name: string, text: string) => {
    setBusy(name);
    try {
      await writeSpec(repo, name, text);
      setDrafts(({ [name]: _saved, ...rest }) => rest);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="specs-settings">
      {error && (
        <p className="hint specs-error" role="alert">
          {error}
        </p>
      )}
      {specs === null && !error && <p className="hint">Loading…</p>}
      {specs?.files.map((file) => {
        const slot = SLOTS[file.name];
        if (!slot) return null;
        const draft = drafts[file.name] ?? file.text;
        const over = draft.length > specs.maxChars;
        const status = !file.present ? "Not created" : file.tooLarge ? "Too large" : file.committed ? "Committed" : "Not committed yet: steps only see committed files";
        return (
          <div className="specs-slot" key={file.name}>
            <div className="specs-slot-head">
              <h4>{slot.title}</h4>
              <code>specs/{file.name}</code>
              <span className={`specs-status ${file.present && file.committed ? "ok" : ""}`}>{status}</span>
            </div>
            <p className="hint">{slot.hint}</p>
            {file.tooLarge ? (
              <p className="hint">
                This file is over {specs.maxChars} characters. Edit it in your editor; a step receives only the first {specs.maxChars}.
              </p>
            ) : !file.present ? (
              <button type="button" className="btn small" disabled={busy !== ""} onClick={() => void save(file.name, slot.template)}>
                Create specs/{file.name}
              </button>
            ) : (
              <>
                <textarea
                  className="specs-editor"
                  aria-label={`${slot.title} (specs/${file.name})`}
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => setDrafts({ ...drafts, [file.name]: e.target.value })}
                />
                <div className="specs-actions">
                  <button type="button" className="btn small" disabled={busy !== "" || over || draft === file.text} onClick={() => void save(file.name, draft)}>
                    Save
                  </button>
                  <span className={`dsc ${over ? "specs-over" : ""}`}>
                    {draft.length} / {specs.maxChars}
                  </span>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
