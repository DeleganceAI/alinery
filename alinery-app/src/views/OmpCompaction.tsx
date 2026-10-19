import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import type { OmpCompactionField, OmpCompactionSnapshot } from "../types";

const statusWarnings: Record<OmpCompactionSnapshot["status"], string | null> = {
  ready: null,
  legacy_unresolved: "OMP settings unavailable.",
  invalid: "OMP settings contain invalid values.",
  unreadable: "Couldn't read OMP settings.",
  unsupported: "This OMP version doesn't support settings here.",
  missing_binary: "OMP isn't installed.",
};

function fieldText(field: OmpCompactionField<boolean | number>, kind: "boolean" | "percent" | "tokens") {
  if (field.value === null || field.source === "unknown") return "Unknown";
  const value =
    typeof field.value === "boolean" ? (field.value ? "On" : "Off") : field.value <= 0 ? "Default" : `${field.value.toLocaleString()}${kind === "percent" ? "%" : " tokens"}`;
  return field.source === "upstream_default" ? `${value} (OMP default)` : value;
}

export function OmpCompaction() {
  const [snapshot, setSnapshot] = useState<OmpCompactionSnapshot | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setPending(true);
    try {
      const next = await ipc.readOmpCompaction();
      if (current === request.current) {
        setSnapshot(next);
        setError(null);
      }
    } catch (cause) {
      if (current === request.current) setError(String(cause));
    } finally {
      if (current === request.current) setPending(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);

  const warning = error
    ? snapshot
      ? "Values may be out of date. Refresh to try again."
      : "Settings unavailable. Try Refresh."
    : snapshot
      ? (statusWarnings[snapshot.status] ?? (snapshot.errors.length ? "Some OMP settings are unavailable." : null))
      : null;

  return (
    <section aria-labelledby="omp-compaction-title">
      <div className="omp-compaction-heading">
        <h4 id="omp-compaction-title">Compaction</h4>
        <button type="button" className="btn ghost small" aria-label="Refresh compaction" onClick={() => void refresh()} disabled={pending}>
          {pending ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div aria-live="polite" aria-busy={pending}>
        {warning && (
          <p role="alert" className="field-error">
            {warning}
          </p>
        )}
        {snapshot && (
          <dl className="omp-compaction-values">
            <dt>Auto-compaction</dt>
            <dd title={snapshot.enabled.source}>{fieldText(snapshot.enabled, "boolean")}</dd>
            <dt>Compaction threshold</dt>
            <dd title={snapshot.threshold_percent.source}>{fieldText(snapshot.threshold_percent, "percent")}</dd>
            <dt>Token-limit override</dt>
            <dd title={snapshot.threshold_tokens.source}>
              {fieldText(snapshot.threshold_tokens, "tokens")}
              {snapshot.threshold_tokens.value !== null && snapshot.threshold_tokens.value > 0 && <span className="dim"> · overrides %</span>}
            </dd>
            <dt>Mid-turn compaction</dt>
            <dd title={snapshot.mid_turn_enabled.source}>{fieldText(snapshot.mid_turn_enabled, "boolean")}</dd>
            <dt>Async compaction</dt>
            <dd title={snapshot.async_enabled.source}>{fieldText(snapshot.async_enabled, "boolean")}</dd>
            <dt>Context capacity</dt>
            <dd>Varies by model</dd>
          </dl>
        )}
      </div>
    </section>
  );
}
