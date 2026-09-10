import { ArrowRight } from "lucide-react";
import type { AutoAdvanceSummary, PlaybookStepSummary } from "./types";

function displayPlaybookTitle(title: string) {
  if (!title) return "Playbook";
  if (title === "superdevelop") return "SuperDevelop";
  if (title.includes(" ") || title !== title.toLowerCase()) return title;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function PlaybookGraph({
  title,
  steps,
  countsByStep = {},
  autoAdvanceEdges = [],
  selectedAutoAdvance = [],
}: {
  title: string;
  steps: PlaybookStepSummary[];
  countsByStep?: Record<string, number>;
  autoAdvanceEdges?: AutoAdvanceSummary[];
  selectedAutoAdvance?: string[];
}) {
  const playbookTitle = displayPlaybookTitle(title);
  const autoAdvanceFromKeys = new Set(autoAdvanceEdges.filter((e) => selectedAutoAdvance.includes(e.key)).map((e) => e.from));
  return (
    <div className="playbook-graph-view">
      <div className="playbook-graph-title">{playbookTitle}</div>
      {steps.length === 0 ? (
        <div className="playbook-graph-empty">
          <div className="playbook-node future freeform">
            <span className="playbook-node-key">free-form</span>
            <span className="playbook-node-title">Ad-hoc sessions</span>
          </div>
        </div>
      ) : (
        <div className="playbook-chain" aria-label={`${playbookTitle} steps`}>
          {steps.map((step, index) => {
            const count = countsByStep[step.key] ?? 0;
            const hasSession = count > 0;
            return (
              <div className="playbook-chain-item" key={step.key}>
                <div className={`playbook-node${hasSession ? " solid" : " future"}`}>
                  <div className="playbook-node-main">
                    <span className="playbook-node-key">{step.short || step.key}</span>
                    <span className="playbook-node-title">{step.title}</span>
                  </div>
                  <div className="playbook-node-side">
                    {count > 0 && <span className="playbook-node-count">{count}</span>}
                    {autoAdvanceFromKeys.has(step.key) && (
                      <span title="Auto-advances to the next stage">
                        <ArrowRight className="playbook-node-autoadvance" size={12} strokeWidth={1.5} aria-hidden="true" focusable="false" />
                      </span>
                    )}
                  </div>
                </div>
                {index < steps.length - 1 && <div className={`playbook-edge${hasSession ? " solid" : " future"}`} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
