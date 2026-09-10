import { harnessDisplayName, isAllowedLaunchHarness, KillButton } from "../shared";
import type { LifecycleState } from "../types";

// Shown instead of a live terminal for a session the running daemon does NOT own
// (orphaned / interrupted / exited), or a leftover non-OMP harness (including live
// and never_started — those rows refuse attach rather than mounting a PTY).
function stateLabel(state: LifecycleState, artifactReady: boolean, unsupported: boolean): { label: string; hint: string } {
  if (unsupported) {
    return {
      label: "Unsupported",
      hint:
        state.state === "live"
          ? "This session can't be started or resumed. History, archive, and Kill remain available."
          : "This session can't be started or resumed. History and archive remain available.",
    };
  }
  switch (state.state) {
    case "orphaned":
      return {
        label: "Orphaned",
        hint: artifactReady ? "The live terminal is gone; the expected artifact exists and work is preserved." : "Started, then the daemon died — its live output is gone.",
      };
    case "interrupted":
      return {
        label: "Interrupted",
        hint: artifactReady ? "The daemon was killed mid-run; the expected artifact exists and work is preserved." : "The daemon was killed mid-run; no clean exit was recorded.",
      };
    case "exited":
      return { label: `Exited (code ${state.code})`, hint: "The harness process finished." };
    default:
      return { label: state.state, hint: "" };
  }
}

export function SessionActionPanel({
  id,
  phase,
  harness,
  model,
  state,
  artifactReady = false,
  repoPath,
  taskSlug,
  onStartFresh,
  onArchive,
  onViewHistory,
  onKilled,
}: {
  id: string;
  phase: string;
  harness: string;
  model: string;
  state: LifecycleState;
  artifactReady?: boolean;
  repoPath: string;
  taskSlug: string;
  onStartFresh: () => void;
  onArchive: () => void;
  onViewHistory: () => void;
  onKilled: () => void;
}) {
  const unsupported = !isAllowedLaunchHarness(harness);
  const { label, hint } = stateLabel(state, artifactReady, unsupported);
  const harnessName = harnessDisplayName(harness);
  return (
    <div className="session-action-panel">
      <div className="sap-meta">
        <span className={`pill sap-state ${state.state}`}>{label}</span>
        {phase && <span className="pill">{phase}</span>}
        <span className="pill">{harnessName + (model ? ` · ${model}` : "")}</span>
        <span className="dim mono sap-id">{id}</span>
      </div>
      {hint ? <p className="sap-hint dim">{hint}</p> : null}
      <div className="sap-actions">
        {!unsupported && (
          <button type="button" className="btn" onClick={onStartFresh}>
            Start fresh
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onViewHistory}>
          View history
        </button>
        {unsupported && <KillButton id={id} slug={taskSlug} repoPath={repoPath} live={state.state === "live"} onKilled={onKilled} />}

        <button type="button" className="btn ghost sap-archive" onClick={onArchive}>
          Archive session
        </button>
      </div>
    </div>
  );
}
