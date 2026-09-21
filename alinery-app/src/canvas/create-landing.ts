// Where the app lands after CreateTaskPage succeeds.
//
// Extracted from App.tsx rather than reviewed in place: the branch is one line of consequence
// with two very different outcomes, `App.tsx` has no mount test in this repo, and the house
// pattern for logic worth testing inside a component is a React-free module
// (`confirm-focus.ts` is the precedent).

import type { Task, TaskId, View } from "../types";

export type CreateLanding = {
  view: View;
  /** Set only for the Orbitron landing: the new task still has to be placed on the board. */
  placeSlug?: TaskId;
};

/**
 * A task created from Orbitron belongs on the board the user was placing it on — dropping
 * them into TaskDetail instead would throw away the gesture that started the create. Every
 * other origin keeps today's behaviour and opens the new task.
 */
export function nextViewAfterCreate(from: View, task: Task): CreateLanding {
  if (from.kind === "canvas") return { view: from, placeSlug: task.slug };
  return { view: { kind: "task", slug: task.slug, from, initialTask: task } };
}
