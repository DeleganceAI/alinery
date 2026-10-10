import { ChevronDown } from "lucide-react";

/**
 * The thread's thinking level as OMP reports it, changeable when the model offers more than one.
 * The value comes only from OMP: a pick writes the command and the label moves when OMP's
 * `thinking_level_changed` lands, never before. Only spans and a select, so a `<p>` can hold it.
 */
export function ThinkingSelect({
  level,
  levels,
  disabledReason,
  onPick,
}: {
  level: string | undefined;
  levels: string[] | undefined;
  disabledReason: string | null;
  onPick: (level: string) => void;
}) {
  if (!level) return null;
  if (!levels || levels.length === 0) return <span>{level}</span>;
  // OMP's own level always shows, even one the model's list does not name.
  const options = levels.includes(level) ? levels : [...levels, level];
  return (
    <span className="thinking-select">
      <select
        aria-label="Thinking level"
        title={disabledReason ?? "Change thinking level"}
        value={level}
        disabled={disabledReason !== null}
        onChange={(event) => onPick(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown size={12} aria-hidden="true" />
    </span>
  );
}
