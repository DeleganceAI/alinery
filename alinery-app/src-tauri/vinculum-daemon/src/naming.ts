// The same naming rules the OMP extension used. A task session is named by its own tool
// call. A chat is titled from a side request that is not part of the transcript.

export const SESSION_NAME_INSTRUCTION =
  "As one of your first useful actions, identify this session's requested work and call alinery_set_session_name with a concise purpose-specific phrase. Read assigned ticket/context first if necessary; defer if intent is unknown, but do not wait until the work is finished. Prefer fewer than 30 characters; never exceed 40. Do not use a generic workflow/type label.";

export const CHAT_TITLE_PROMPT =
  "Give this conversation a short title that says what it is about, in the user's language. At most 40 characters; fewer than 30 is better. " +
  "Reply with only the title: no quotes, no markdown, no trailing punctuation, no prefix.";

/** Titles come after the first user message, then every 10th (10, 20, 30, ...). */
export function chatTitleBucket(userMessages: number): number {
  return userMessages >= 10 ? Math.floor(userMessages / 10) * 10 : userMessages >= 1 ? 1 : 0;
}

/** First line of the reply, stripped of quoting and markup, cut to 40 characters on a word edge. */
export function cleanChatTitle(reply: string): string {
  const line = (reply.split("\n").find((candidate) => candidate.trim() !== "") ?? "")
    .replace(/^\s*(title\s*:\s*)/i, "")
    .replace(/^[\s"'`*_#>-]+|[\s"'`*_.]+$/g, "")
    .replace(/\s+/g, " ");
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  // A word that ends exactly at the limit is kept whole.
  const edge = line[40] === " " ? 40 : cut.lastIndexOf(" ");
  return (edge >= 20 ? cut.slice(0, edge) : cut).trim();
}
