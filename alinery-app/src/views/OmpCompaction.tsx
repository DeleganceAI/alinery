import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { InlineStatus } from "../shared";
import type { OmpCompactionField, OmpCompactionSnapshot } from "../types";

const statusWarnings: Record<OmpCompactionSnapshot["status"], string | null> = {
  ready: null,
  legacy_unresolved: "Inspect legacy settings through OMP, then refresh.",
  invalid: "Inspect and correct the OMP configuration, then refresh.",
  unreadable: "Check access to the OMP configuration, then refresh.",
  unsupported: "Alinery hasn't verified this OMP version. Check compatibility, then refresh.",
  missing_binary: "OMP wasn't found. Check the installation, then refresh.",
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
  const [error, setError] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    setPending(true);
    try {
      const next = await ipc.readOmpCompaction();
      if (current === request.current) {
        setSnapshot(next);
        setError(false);
      }
    } catch {
      if (current === request.current) setError(true);
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
      : "Couldn't read OMP settings. Refresh to try again."
    : snapshot
      ? snapshot.status === "unsupported" && snapshot.installed_version === null
        ? "Couldn't identify OMP. Check the installation, then refresh."
        : (statusWarnings[snapshot.status] ?? (snapshot.errors.length ? "Some OMP settings are unavailable. Inspect the configuration, then refresh." : null))
      : null;

  return (
    <section aria-labelledby="omp-compaction-title">
      <div className="omp-compaction-heading">
        <h4 id="omp-compaction-title">Compaction</h4>
        <button type="button" className="btn ghost small" aria-label="Refresh compaction" onClick={() => void refresh()} disabled={pending}>
          {pending ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="omp-compaction-content" aria-live="polite" aria-busy={pending}>
        <dl className={`omp-compaction-values${!snapshot && error ? " omp-compaction-values-hidden" : ""}`} aria-hidden={!snapshot && error ? true : undefined}>
          <dt>Auto-compaction</dt>
          <dd title={snapshot?.enabled.source}>
            {snapshot ? fieldText(snapshot.enabled, "boolean") : <span className="omp-compaction-placeholder" role="img" aria-label="Loading" />}
          </dd>
          <dt>Compaction threshold</dt>
          <dd title={snapshot?.threshold_percent.source}>
            {snapshot ? fieldText(snapshot.threshold_percent, "percent") : <span className="omp-compaction-placeholder" role="img" aria-label="Loading" />}
          </dd>
          <dt>Token-limit override</dt>
          <dd className="omp-compaction-token-limit" title={snapshot?.threshold_tokens.source}>
            {snapshot ? fieldText(snapshot.threshold_tokens, "tokens") : <span className="omp-compaction-placeholder" role="img" aria-label="Loading" />}
            {snapshot && snapshot.threshold_tokens.value !== null && snapshot.threshold_tokens.value > 0 && <span className="dim"> · overrides %</span>}
          </dd>
          <dt>Mid-turn compaction</dt>
          <dd title={snapshot?.mid_turn_enabled.source}>
            {snapshot ? fieldText(snapshot.mid_turn_enabled, "boolean") : <span className="omp-compaction-placeholder" role="img" aria-label="Loading" />}
          </dd>
          <dt>Async compaction</dt>
          <dd title={snapshot?.async_enabled.source}>
            {snapshot ? fieldText(snapshot.async_enabled, "boolean") : <span className="omp-compaction-placeholder" role="img" aria-label="Loading" />}
          </dd>
          <dt>Context capacity</dt>
          <dd>{snapshot ? "Varies by model" : <span className="omp-compaction-placeholder" role="img" aria-label="Loading" />}</dd>
        </dl>
        {warning && (
          <div className={!snapshot ? "omp-compaction-first-error" : undefined}>
            <InlineStatus tone="error" detail={!error ? snapshot?.errors.join("\n") : undefined}>
              {warning}
            </InlineStatus>
          </div>
        )}
      </div>
    </section>
  );
}
