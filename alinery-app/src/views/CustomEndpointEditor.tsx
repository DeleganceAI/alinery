import { CircleAlert, CircleCheck, TriangleAlert, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { CustomCheck } from "../chat/providers";
import { CUSTOM_ENDPOINT_REFERENCE, CUSTOM_ENDPOINT_STARTER } from "../customEndpointExample";
import { Dialog, InlineStatus } from "../shared";

type Props = {
  /** The saved provider being edited, or null for a new one. */
  editing: { id: string; name: string; config: string } | null;
  check: (config: string, live: boolean) => Promise<CustomCheck>;
  save: (config: string, replaces?: string) => Promise<void>;
  onClose: () => void;
};

type Phase = { kind: "editing" } | { kind: "testing" } | { kind: "tested"; failed: number } | { kind: "saving" };

/**
 * Edit one custom OpenAI-compatible endpoint as YAML or JSON, in the shape of an OMP `models.yml` provider block. The daemon
 * reads the text as the user types and names each problem by field; Save first sends one short request per model, and a
 * model that fails turns the button into Save anyway.
 */
export function CustomEndpointEditor({ editing, check, save, onClose }: Props) {
  const [text, setText] = useState(editing?.config ?? CUSTOM_ENDPOINT_STARTER);
  const [result, setResult] = useState<CustomCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const run = ++latest.current;
    const timer = setTimeout(() => {
      check(text, false).then(
        (next) => {
          if (run !== latest.current) return;
          setResult(next);
          setCheckError(null);
        },
        (error) => run === latest.current && setCheckError(String(error)),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [check, text]);

  const problems = result?.problems ?? [];
  const errors = problems.filter((problem) => problem.error);
  const warnings = problems.filter((problem) => !problem.error);
  const tests = phase.kind === "tested" || phase.kind === "saving" ? (result?.tests ?? []) : [];
  const busy = phase.kind === "testing" || phase.kind === "saving";
  const blocked = !result || errors.length > 0 || checkError !== null;

  const edit = (next: string) => {
    setText(next);
    setPhase({ kind: "editing" });
    setSaveError(null);
  };

  const commit = async () => {
    setPhase({ kind: "saving" });
    try {
      await save(text, editing?.id);
      onClose();
    } catch (error) {
      setSaveError(String(error));
      setPhase({ kind: "editing" });
    }
  };

  const testThenSave = async () => {
    if (phase.kind === "tested" && phase.failed > 0) return commit();
    setSaveError(null);
    setPhase({ kind: "testing" });
    try {
      const tested = await check(text, true);
      setResult(tested);
      const failed = tested.tests.filter((test) => !test.ok).length;
      if (tested.problems.some((problem) => problem.error)) return setPhase({ kind: "editing" });
      if (failed > 0) return setPhase({ kind: "tested", failed });
      setPhase({ kind: "tested", failed: 0 });
      await commit();
    } catch (error) {
      setSaveError(String(error));
      setPhase({ kind: "editing" });
    }
  };

  // YAML refuses tab indentation, so Tab indents with two spaces.
  const indent = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    const area = event.currentTarget;
    const { selectionStart: start, selectionEnd: end } = area;
    edit(`${text.slice(0, start)}  ${text.slice(end)}`);
    requestAnimationFrame(() => area.setSelectionRange(start + 2, start + 2));
  };

  const summary = checkError
    ? null
    : !result
      ? "Reading…"
      : errors.length > 0
        ? `${count(errors.length, "error")} to fix${warnings.length ? `, ${count(warnings.length, "warning")}` : ""}`
        : warnings.length > 0
          ? `Ready to test. ${count(warnings.length, "warning")}`
          : "Ready to test";

  return (
    <Dialog onClose={busy ? () => undefined : onClose} ariaLabel="OpenAI-compatible endpoint" className="custom-endpoint-dialog">
      <div className="mh">
        <span className="mt">{editing ? `Edit ${editing.name}` : "Add an OpenAI-compatible endpoint"}</span>
        <button type="button" className="x" aria-label="Close" title="Close" onClick={onClose} disabled={busy}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb custom-endpoint-body">
        <p className="dsc">
          Paste a provider block from an OMP <code>models.yml</code> or a pi <code>models.json</code>, or fill in the one below. YAML and JSON both work. Several providers in one
          paste are saved together.
        </p>
        <textarea
          className="custom-endpoint-source"
          aria-label="Endpoint configuration"
          value={text}
          onChange={(event) => edit(event.currentTarget.value)}
          onKeyDown={indent}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={14}
          data-autofocus
          disabled={busy}
        />
        <div className="custom-endpoint-check" aria-live="polite">
          {checkError ? <InlineStatus tone="error">The configuration could not be checked: {checkError}</InlineStatus> : null}
          {summary ? <p className={`custom-endpoint-summary${errors.length ? " bad" : ""}`}>{summary}</p> : null}
          {problems.length > 0 ? (
            <ul className="custom-endpoint-problems">
              {[...errors, ...warnings].map((problem) => (
                <li key={`${problem.error}:${problem.path}:${problem.message}`} className={problem.error ? "error" : "warning"}>
                  {problem.error ? <CircleAlert size={14} aria-label="Error" /> : <TriangleAlert size={14} aria-label="Warning" />}
                  <span>
                    {problem.path ? <code>{problem.path}</code> : null} {problem.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {tests.length > 0 ? (
            <ul className="custom-endpoint-problems">
              {tests.map((test) => (
                <li key={`${test.provider}/${test.model}`} className={test.ok ? "ok" : "error"}>
                  {test.ok ? <CircleCheck size={14} aria-label="Passed" /> : <CircleAlert size={14} aria-label="Failed" />}
                  <span>
                    <code>
                      {test.provider}/{test.model}
                    </code>{" "}
                    {test.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {phase.kind === "tested" && phase.failed > 0 ? (
            <InlineStatus tone="warning">{count(phase.failed, "model")} did not answer. Fix the config, or save anyway if the endpoint is down for now.</InlineStatus>
          ) : null}
          {saveError ? <InlineStatus tone="error">{saveError}</InlineStatus> : null}
        </div>
        <details className="custom-endpoint-reference">
          <summary>Every supported field</summary>
          <pre>{CUSTOM_ENDPOINT_REFERENCE}</pre>
          <button type="button" className="btn ghost small" onClick={() => edit(CUSTOM_ENDPOINT_REFERENCE)} disabled={busy}>
            Start from this example
          </button>
        </details>
      </div>
      <div className="mfoot custom-endpoint-foot">
        <button type="button" className="btn ghost small" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn primary small" onClick={() => void testThenSave()} disabled={busy || blocked}>
          {phase.kind === "testing" ? "Testing models…" : phase.kind === "saving" ? "Saving…" : phase.kind === "tested" && phase.failed > 0 ? "Save anyway" : "Test and save"}
        </button>
      </div>
    </Dialog>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
