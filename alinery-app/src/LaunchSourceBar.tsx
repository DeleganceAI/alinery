const UNKNOWN_SOURCE_ERROR = "ERROR: launch path unknown — development launcher did not provide provenance";

export function LaunchSourceBar({ sourceRoot }: { sourceRoot: string }) {
  const sourceUnknown = sourceRoot.length === 0;

  return (
    <div className={sourceUnknown ? "launch-source-bar launch-source-bar-error" : "launch-source-bar"} role={sourceUnknown ? "alert" : undefined}>
      <span className="launch-source-label">ALINERY SOURCE</span>
      <span className="launch-source-value">{sourceUnknown ? UNKNOWN_SOURCE_ERROR : sourceRoot}</span>
    </div>
  );
}
