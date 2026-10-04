import { useCallback, useEffect, useRef } from "react";
import { settleOpenUrl } from "../chat/openUrl";
import { type ChatTranscriptState, dismissPendingUi, isPresentationUi } from "../chatTranscript";
import * as ipc from "../ipc";
import { cancelExtensionUi, extensionUiConfirm, extensionUiValue } from "../ompRpc";

/**
 * Answers the extension UI requests OMP raises inside a chat thread: Allow/Deny rows, and the
 * select/input/editor prompts the `ask` tool shows. An unanswered request holds the turn open for
 * good, so every request is answered exactly once; `handled` is what stops a double click sending
 * two responses while the row is still mounted.
 */
export function useChatUiReplies({
  repo,
  id,
  live,
  transcript,
  setTranscript,
  onError,
}: {
  repo: string | null;
  id: string | null;
  live: boolean;
  transcript: ChatTranscriptState;
  setTranscript: (update: (current: ChatTranscriptState) => ChatTranscriptState) => void;
  onError: (message: string) => void;
}) {
  const handled = useRef(new Set<string>());
  const pending = useRef(transcript.pendingUi);
  pending.current = transcript.pendingUi;

  useEffect(() => {
    handled.current.clear();
  }, [repo, id]);

  const write = useCallback((payload: object) => (repo && id ? ipc.chatRpcWrite(repo, id, payload) : Promise.reject(new Error("no thread selected"))), [repo, id]);

  // Presentation requests (status, title, notify) want no answer from a person, only a release.
  useEffect(() => {
    if (!live) return;
    for (const request of transcript.pendingUi) {
      if (handled.current.has(request.id) || !isPresentationUi(request.method)) continue;
      handled.current.add(request.id);
      void write(cancelExtensionUi(request.id)).catch(() => undefined);
    }
  }, [live, transcript.pendingUi, write]);

  const answer = useCallback(
    async (requestId: string, send: () => Promise<unknown>) => {
      if (handled.current.has(requestId)) return;
      handled.current.add(requestId);
      try {
        await send();
        setTranscript((current) => dismissPendingUi(current, requestId));
      } catch (cause) {
        handled.current.delete(requestId);
        onError(String(cause));
      }
    },
    [setTranscript, onError],
  );

  const approve = useCallback(
    (requestId: string, allow: boolean) => {
      const request = pending.current.find((candidate) => candidate.id === requestId);
      // Allowing an `open_url` means "did it open", so it settles through the browser, not a plain yes.
      const send =
        allow && request?.method === "open_url" && id
          ? () => settleOpenUrl(id, requestId, request.launchUrl || request.url, onError, write)
          : () => write(extensionUiConfirm(requestId, allow));
      return answer(requestId, send);
    },
    [answer, id, onError, write],
  );

  return {
    approve,
    reply: (requestId: string, value: string) => answer(requestId, () => write(extensionUiValue(requestId, value))),
    cancel: (requestId: string) => answer(requestId, () => write(cancelExtensionUi(requestId))),
    prompt: transcript.pendingUi.find((request) => request.method === "select" || request.method === "input" || request.method === "editor"),
  };
}
