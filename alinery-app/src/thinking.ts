// The one TS mirror of alinery-core `THINKING_LEVELS`; the two lists move together.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const DEFAULT_THINKING = "high";

/** What the daemon will launch with: an unset or unknown value falls back to `high`, as `thinking_launch_level` does. */
export const effectiveThinking = (value: string | undefined): string => {
  const level = value?.trim() ?? "";
  return (THINKING_LEVELS as readonly string[]).includes(level) ? level : DEFAULT_THINKING;
};
