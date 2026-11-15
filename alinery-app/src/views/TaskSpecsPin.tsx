import { useCallback, useEffect, useState } from "react";
import { readTaskSpecs, repinTaskSpecs, type TaskSpecs } from "../sync/specs";

/**
 * A row of Task view: which commit's `specs/` this task's steps are held to. Shows nothing when neither the task nor the
 * repository has any requirement files, and nothing when the daemon cannot answer: the row is information, not a gate.
 */
export function TaskSpecsPin({ repo, slug }: { repo: string; slug: string }) {
  const [pin, setPin] = useState<TaskSpecs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setPin(await readTaskSpecs(repo, slug));
    } catch {
      setPin(null);
    }
  }, [repo, slug]);

  useEffect(() => {
    setError("");
    void load();
  }, [load]);

  if (!pin || (pin.files.length === 0 && pin.headFiles === 0)) return null;
  const applied = pin.files.length > 0;

  const repin = async () => {
    setBusy(true);
    try {
      await repinTaskSpecs(repo, slug);
      setError("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kv">
      <span className="k">Requirements</span>
      <span className="v mono" title={pin.files.map((f) => `specs/${f}`).join("\n") || undefined}>
        {applied ? `${pin.files.length} ${pin.files.length === 1 ? "file" : "files"} @ ${pin.commit.slice(0, 7)}` : `none applied (${pin.headFiles} committed since)`}
      </span>
      <button type="button" className="btn ghost small" disabled={busy} onClick={() => void repin()}>
        {applied ? "Re-pin to HEAD" : "Apply HEAD"}
      </button>
      {error && (
        <span className="hint specs-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
