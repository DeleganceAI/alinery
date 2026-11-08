// The chat rail of src/sync/chat.ts, fed from plain rows a test states. For view tests whose subject is the view, not the
// stream (the stream itself is tested in sync/chat.test.tsx): the rows arrive the way `useChatThreads` hands them over, filtered
// by the repos and the archived choice the view asks for, and a change to the rows reaches the view with no read in between.
//
//     vi.mock("../sync/chat", async (actual) => (await import("../test/chatHooks")).chatHooks(await actual()));
//     fakeChat.set([thread]);
import { useMemo, useSyncExternalStore } from "react";
import type * as Chat from "../sync/chat";
import type { ChatThread } from "../types";

let rows: ChatThread[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const fakeChat = {
  set(next: ChatThread[]) {
    rows = next;
    for (const l of [...listeners]) l();
  },
  reset() {
    fakeChat.set([]);
  },
};

export function chatHooks(actual: typeof Chat): typeof Chat {
  return {
    ...actual,
    useChatThreads(repos, includeArchived) {
      const all = useSyncExternalStore(subscribe, () => rows);
      const key = repos?.join("\n");
      // biome-ignore lint/correctness/useExhaustiveDependencies: key stands for repos
      return useMemo(
        () => (repos ? actual.sortChatThreads(all.filter((t) => repos.includes(t.repo_path) && (includeArchived || !t.session.archived))) : []),
        [all, key, includeArchived],
      );
    },
  };
}
