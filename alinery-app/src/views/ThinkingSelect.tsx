import { ChevronDown } from "lucide-react";

/**
 * The thread's thinking level. A pick writes the command and the label moves when the reply
 * lands, never before. Only spans and a select, so a `<p>` can hold it.
 */
export function ThinkingSelect({
  level,
  levels,
  disabledReason,
  title,
  onPick,
}: {
  level: string | undefined;
  levels: string[] | undefined;
  disabledReason: string | null;
  /** Shown while the control is enabled. An in-flight turn uses this to say the next turn picks the change up. */
  title?: string;
  onPick: (level: string) => void;
}) {
  if (!level) return null;
  if (!levels || levels.length === 0) return <span>{level}</span>;
  // The stored level always shows, even one this model's list does not name.
  const options = levels.includes(level) ? levels : [...levels, level];
  return (
    <span className="thinking-select">
      <select
        aria-label="Thinking level"
        title={disabledReason ?? title ?? "Change thinking level"}
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
