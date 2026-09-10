import { useState } from "react";
import { PRIORITY_SESSION_SORT, type SessionSort } from "./sessionAttention";

type SessionSortControl = { sort: SessionSort; onChange: (sort: SessionSort) => void };

export function useSessionSort(control?: SessionSortControl): [SessionSort, (sort: SessionSort) => void] {
  const [localSort, setLocalSort] = useState<SessionSort>(PRIORITY_SESSION_SORT);
  return control ? [control.sort, control.onChange] : [localSort, setLocalSort];
}
