// The board hooks of src/sync/board.ts, fed from plain rows a test states. For view tests whose subject
// is the view, not the stream: the rows arrive the way the real hooks hand them over (same shapes, same
// stable identities between renders). Tests of the streams themselves use sessionDaemon.
//
//     vi.mock("../sync/board", async (actual) => (await import("../test/boardHooks")).boardHooks(await actual()));
//     fakeBoard.set({ tasks: [task] });
import { useMemo, useSyncExternalStore } from "react";
import type * as Board from "../sync/board";
import type { BoardTask, SessionDisplayMeta, SessionListItem, TaskActivityMap, TaskActivitySummary } from "../types";

type State = {
  /** False while the streams have not delivered their first snapshot. */
  ready: boolean;
  tasks: BoardTask[];
  sessions: SessionListItem[];
  activity: TaskActivityMap;
  /** The activity of every asked task that `activity` does not name. */
  anyActivity: TaskActivitySummary | null;
  /** Task rows in whichever repo a view asks: for tests that care about the task, not the repo. */
  anyRepoTasks: BoardTask[];
  /** One task's session rows, whichever task and repo a view asks. Null until the stream's first snapshot. */
  taskSessions: SessionDisplayMeta[] | null;
  /** Repos whose daemon does not answer: they show their banner and contribute no rows. */
  down: string[];
};
const EMPTY: State = { ready: true, tasks: [], sessions: [], activity: {}, anyActivity: null, anyRepoTasks: [], taskSessions: [], down: [] };
let state: State = EMPTY;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const use = () => useSyncExternalStore(subscribe, () => state);

export const fakeBoard = {
  set(patch: Partial<State>) {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  },
  /** Every repo the stated rows belong to, for a view that is handed its repos. */
  repos: () => [...new Set(state.tasks.map((t) => t.repo_path))],
  reset() {
    state = EMPTY;
    for (const l of [...listeners]) l();
  },
};

export function boardHooks(actual: typeof Board): typeof Board {
  const tasksOf = (s: State, repos: string[]) => s.tasks.filter((t) => repos.includes(t.repo_path) && !s.down.includes(t.repo_path));
  return {
    ...actual,
    useRepoBoard(repos, enabled = true) {
      const s = use();
      const key = JSON.stringify(enabled ? repos : []);
      return useMemo(() => {
        const wanted: string[] = JSON.parse(key);
        const tasks = tasksOf(s, wanted);
        const states = Object.fromEntries(wanted.map((r) => [r, { loaded: true, reachable: !s.down.includes(r), stale: false }]));
        return { tasks, repos: states, loaded: s.ready };
      }, [s, key]);
    },
    useRepoTasks(repo) {
      const s = use();
      return useMemo(() => (repo && s.ready ? [...s.anyRepoTasks, ...tasksOf(s, [repo]).filter((t) => !s.anyRepoTasks.some((x) => x.slug === t.slug))] : null), [s, repo]);
    },
    useBoardTask(repo, slug) {
      const s = use();
      return useMemo(
        () => (repo && s.ready ? (s.anyRepoTasks.find((t) => t.slug === slug) ?? s.tasks.find((t) => t.repo_path === repo && t.slug === slug) ?? null) : undefined),
        [s, repo, slug],
      );
    },
    useRepoLink(repo) {
      const s = use();
      return useMemo(() => ({ loaded: true, reachable: !!repo && !s.down.includes(repo), stale: false }), [s, repo]);
    },
    useTaskActivityMap(refs) {
      const s = use();
      return useMemo(() => {
        const out: TaskActivityMap = {};
        for (const r of refs) {
          const found = s.activity[`${r.repoPath}:${r.taskSlug}`] ?? s.anyActivity;
          if (found) out[`${r.repoPath}:${r.taskSlug}`] = found;
        }
        return out;
      }, [s, JSON.stringify(refs)]);
    },
    useTaskSessions(repo, slug) {
      const s = use();
      return useMemo(() => {
        if (!repo || !s.ready) return null;
        const rows = s.sessions.filter((x) => x.repo_path === repo && x.task_slug === slug);
        return rows.length ? rows : s.taskSessions;
      }, [s, repo, slug]);
    },
    useSessionDisplay(repo, taskSlug, id) {
      const s = use();
      return useMemo(() => {
        const row = s.sessions.find((x) => x.repo_path === repo && x.task_slug === taskSlug && x.id === id);
        return { session: (row as SessionDisplayMeta | undefined) ?? null, taskName: row?.task_name ?? "", subtaskName: row?.subtask_name ?? null, loaded: true };
      }, [s, repo, taskSlug, id]);
    },
    useSessionItems(repos, includeArchived, enabled = true) {
      const s = use();
      const key = JSON.stringify(enabled ? repos : []);
      return useMemo(() => {
        const wanted: string[] = JSON.parse(key);
        const items = s.sessions.filter((x) => wanted.includes(x.repo_path) && !s.down.includes(x.repo_path) && (includeArchived || !x.archived));
        return { items, loaded: true };
      }, [s, key, includeArchived]);
    },
  };
}
