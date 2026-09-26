import { useEffect, useRef } from "react";
import * as ipc from "./ipc";
import { liveNoticeSuppression, type SessionNoticeRow, sessionListItemKey } from "./sessionAttention";
import type { NotificationPrefs, SessionObservation } from "./types";

export type NativeAttentionRequest = { key: string; repoPath: string; slug: string; reason: string };

const NATIVE_PREF_BY_NOTICE = {
  waiting_for_input: "native_input_waits",
  waiting_for_approval: "native_approval_waits",
  failure: "native_failures",
  interrupted: "native_interruptions",
  unread_completion: "native_final_completions",
} as const satisfies Record<SessionNoticeRow["notice"], keyof NotificationPrefs>;

export function nativeAttentionRequests(
  rows: ReadonlyArray<SessionNoticeRow>,
  observations: Record<string, SessionObservation>,
  prefs: NotificationPrefs,
): NativeAttentionRequest[] {
  if (!prefs.enabled || (!prefs.banner && !prefs.sound && !prefs.bounce)) return [];
  return rows.flatMap((row) => {
    if (!prefs[NATIVE_PREF_BY_NOTICE[row.notice]]) return [];
    const observation = observations[sessionListItemKey(row.item)];
    const occurrence = attentionOccurrence(row, observation);
    if (!occurrence) return [];
    const reason = row.notice === "unread_completion" ? "completed" : row.notice;
    return [{ key: `${row.item.repo_path}:${row.item.task_slug}:${row.item.id}:${reason}:${occurrence}`, repoPath: row.item.repo_path, slug: row.item.task_slug, reason }];
  });
}

function attentionOccurrence(row: SessionNoticeRow, observation: SessionObservation | undefined): string | null {
  if (row.notice === "unread_completion") {
    if (row.item.execution_id && !observation?.execution?.final_completion) return null;
    const completedAt = observation?.checkpoint.phase_completed_at ?? row.item.semantic?.phase_completed_at;
    return completedAt == null ? null : String(completedAt);
  }
  return liveNoticeSuppression(row.item, row.notice, observation)?.occurrence ?? null;
}

export function useNativeSessionAttention(
  rows: ReadonlyArray<SessionNoticeRow>,
  observations: Record<string, SessionObservation>,
  prefs: NotificationPrefs | undefined,
  loaded: boolean,
): void {
  const delivered = useRef(new Set<string>());
  useEffect(() => {
    if (!loaded || !prefs) return;
    for (const request of nativeAttentionRequests(rows, observations, prefs)) {
      if (delivered.current.has(request.key)) continue;
      delivered.current.add(request.key);
      ipc.notifySessionAttention(request.repoPath, request.slug, request.reason).catch(() => {
        delivered.current.delete(request.key);
      });
    }
  }, [rows, observations, prefs, loaded]);
}
