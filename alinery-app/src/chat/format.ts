export type ChatStampParts = { date?: boolean; time?: boolean };

/** Journal stamp: date and/or time, matching the Chat demo (`Sep 5 12:11`). */
export function formatChatStamp(at: number, parts: ChatStampParts = {}): string {
  const showDate = parts.date !== false;
  const showTime = parts.time !== false;
  if (!showDate && !showTime) return "";
  const bits = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(at));
  const g = (type: Intl.DateTimeFormatPartTypes) => bits.find((p) => p.type === type)?.value ?? "";
  const date = `${g("month")} ${g("day")}`;
  const time = `${g("hour")}:${g("minute")}`;
  if (showDate && showTime) return `${date} ${time}`;
  if (showDate) return date;
  return time;
}

/** @deprecated Prefer formatChatStamp — kept for call sites that always want both. */
export function formatTinyTime(at: number): string {
  return formatChatStamp(at, { date: true, time: true });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function formatIso(at: number): string {
  return new Date(at).toISOString();
}

export function formatContextUsage(tokens?: number, window?: number): string {
  if (tokens == null || window == null || window <= 0) return "";
  const used = formatTokenCount(tokens);
  const cap = formatTokenCount(window);
  return `${used}/${cap}`;
}

/** Composer footer: `128 chars`. */
export function formatComposerStats(codePoints: number): string {
  return `${codePoints.toLocaleString()} chars`;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const rounded = Math.round((n / 1000) * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`;
  }
  return String(n);
}
