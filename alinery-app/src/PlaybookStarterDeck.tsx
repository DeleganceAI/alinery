import "./onboarding.css";
import { useId, useState } from "react";
import { CURATED_PLAYBOOK_ARCHETYPES, type StarterTaskPreset } from "./onboarding";
import { PlaybookLibraryLink } from "./PlaybookLibraryLink";
import type { PlaybookRef } from "./types";

export function PlaybookStarterDeck({
  onCreate,
  onReplayOnboarding,
}: {
  onCreate?: (initialPlaybook?: PlaybookRef, initialPreset?: StarterTaskPreset) => void;
  onReplayOnboarding?: () => void;
}) {
  const starterId = useId();
  const [selectedStarterKey, setSelectedStarterKey] = useState(CURATED_PLAYBOOK_ARCHETYPES[0].reference.key);
  const selectedStarter = CURATED_PLAYBOOK_ARCHETYPES.find((archetype) => archetype.reference.key === selectedStarterKey) ?? CURATED_PLAYBOOK_ARCHETYPES[0];
  return (
    <section className="grid-starter-gate" data-testid="grid-starter-gate" aria-label="Playbook starter deck">
      <div className="grid-starter-header">
        <div>
          <h3>Start your first task with a playbook</h3>
          <p className="grid-starter-subtitle">Choose a workflow for your task. You'll review the details before starting.</p>
        </div>
        <button type="button" className="btn ghost small grid-starter-utility" disabled={!onCreate} onClick={() => onCreate?.()}>
          New task
        </button>
      </div>
      <fieldset className="grid-starter-cards">
        <legend className="sr-only">Choose a playbook</legend>
        {CURATED_PLAYBOOK_ARCHETYPES.slice(0, 4).map((archetype) => (
          <label key={archetype.reference.key} className="grid-starter-card">
            <input
              type="radio"
              name={starterId}
              value={archetype.reference.key}
              checked={selectedStarterKey === archetype.reference.key}
              onChange={() => setSelectedStarterKey(archetype.reference.key)}
              aria-labelledby={`${starterId}-${archetype.reference.key}-title`}
              aria-describedby={`${starterId}-${archetype.reference.key}-summary`}
            />
            <strong id={`${starterId}-${archetype.reference.key}-title`}>{archetype.title}</strong>
            <p id={`${starterId}-${archetype.reference.key}-summary`} className="grid-starter-card-summary">
              {archetype.patternSummary}
            </p>
          </label>
        ))}
      </fieldset>
      <section className="grid-starter-selection" aria-label={`${selectedStarter.title} workflow details`}>
        <div className="grid-starter-selection-heading">
          <h4>{selectedStarter.title}</h4>
          <span>{selectedStarter.badge}</span>
        </div>
        <p className="grid-starter-card-tagline">{selectedStarter.tagline}</p>
        <p className="grid-starter-checkpoint">{selectedStarter.checkpointNote}</p>
        <div className="grid-starter-actions">
          <button type="button" className="btn" disabled={!onCreate} aria-label={`Use playbook: ${selectedStarter.title}`} onClick={() => onCreate?.(selectedStarter.reference)}>
            Use playbook
          </button>
          <button type="button" className="btn ghost" disabled={!onCreate} onClick={() => onCreate?.(selectedStarter.reference, selectedStarter.starterPreset)}>
            Try starter preset
          </button>
        </div>
      </section>
      <div className="grid-starter-footer">
        <PlaybookLibraryLink className="small grid-starter-utility" />
        {onReplayOnboarding && (
          <button type="button" className="btn ghost small grid-starter-utility" onClick={onReplayOnboarding}>
            How playbooks work
          </button>
        )}
      </div>
    </section>
  );
}
