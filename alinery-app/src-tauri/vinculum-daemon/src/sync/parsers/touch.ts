// Files that own no row but change one (S3.5): a playbook snapshot or an artifact moves its task's board
// fields, a name file moves its session, a chat thread's too. They parse to nothing; the feed's `dependents` hook re-reads
// the row they belong to. Tracked like any other file, so the 30 s pass sees a change the watcher missed.
import type { Parser } from "./index.ts";

export const touch: Parser = {
  match: /^(?:tasks\/[^/]+\/(?:playbook\.md|artifacts\/(?!attachments\/|subtasks\/).+)|(?:tasks\/[^/]+\/)?sessions\/[^/]+\.name\.json)$/,
  key: (m) => `touch/${m[0]}`,
  parse: async () => null,
};
