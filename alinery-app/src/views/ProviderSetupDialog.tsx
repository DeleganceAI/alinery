import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRolesMap } from "../chat/modelRoles";
import { settleOpenUrl } from "../chat/openUrl";
import { isInteractivePromptLoginError, shouldOfferProviderSetup } from "../chat/providers";
import { loginReply, setModelReply } from "../chat/send";
import type { ProvidersDialogTab } from "../chat/slash";
import { applyRpcLine, type ChatTranscriptState, dismissPendingUi, emptyTranscript, isPresentationUi, type PendingUi } from "../chatTranscript";
import * as ipc from "../ipc";
import {
  cancelExtensionUi,
  extensionUiConfirm,
  extensionUiValue,
  getAvailableModelsCommand,
  getLoginProvidersCommand,
  getStateCommand,
  loginCommand,
  setModelCommand,
} from "../ompRpc";
import { ChatEntryRow } from "./ChatEntryRow";
import { ChatExtensionPrompt } from "./ChatExtensionPrompt";
import { ChatModelDialog } from "./ChatModelDialog";

export type ProviderSetupMode =
  /** Opened by the user: show the dialog regardless of what the providers turn out to be. */
  | "manual"
  /** Opened on repo open: stay invisible unless this install actually needs setting up. */
  | "auto";

/**
 * The accounts dialog, backed by the daemon's reserved setup session rather than a real one.
 *
 * This is the whole point of that session: account setup used to be reachable only from inside a
 * working chat, which is precisely what you do not have when setup is missing. The dialog itself
 * is unchanged -- it only ever needed a session id to write to.
 *
 * Browser requests share the same handling as SessionView; login prompts must render inside
 * this modal so they remain reachable. Terminal `/login` still needs a real pty session.
 */
export type ProviderSetupClose =
  /** The providers came back and this install is already set up -- nothing was ever shown. */
  | "not-needed"
  /** The dialog was shown and the user closed it. */
  | "dismissed";

export function ProviderSetupDialog({
  mode,
  initialTab = "accounts",
  onPick,
  onClose,
}: {
  mode: ProviderSetupMode;
  initialTab?: ProvidersDialogTab;
  /**
   * Pick a model instead of applying one. Form surfaces (create task, create session, the default
   * in Settings) want the `provider/model` string for a field, not a `set_model` written into a
   * live session -- there is no session to write it to.
   */
  onPick?: (model: string) => void;
  onClose: (reason: ProviderSetupClose) => void;
}) {
  const [chat, setChat] = useState<ChatTranscriptState>(emptyTranscript);
  const [modelRoles, setModelRoles] = useState<ModelRolesMap>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState<string | null>(null);
  const [livePromotedIds, setLivePromotedIds] = useState<string[]>([]);
  const [tab, setTab] = useState<ProvidersDialogTab>(initialTab);
  // Same store the old ModelInput picker used, so stars survive the swap rather than resetting.
  const [favorites, setFavorites] = useState<string[]>([]);
  const sessionIdRef = useRef("");
  const loginApplyRef = useRef<string | null>(null);
  const loginOpenUrlRef = useRef(false);
  const handledUiRef = useRef(new Set<string>());
  const modelApplyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (line: string) => {
      if (cancelled) return;
      try {
        // `applyRpcLine` takes the parsed value, not the raw line: handed a string it silently
        // no-ops, so every provider row would vanish without an error anywhere.
        const value: unknown = JSON.parse(line);
        setChat((current) => applyRpcLine(current, value));
        if (modelApplyRef.current) {
          const reply = setModelReply(value);
          if (reply) {
            modelApplyRef.current = false;
            setModelError(reply.ok ? null : (reply.error ?? "Could not set model."));
          }
        }
        if (loginApplyRef.current) {
          const reply = loginReply(value);
          if (reply) {
            const providerId = loginApplyRef.current;
            loginApplyRef.current = null;
            loginOpenUrlRef.current = false;
            setLoginBusy(null);
            if (reply.ok) {
              setModelError(null);
              void ipc.rpcWriteSession(sessionIdRef.current, getLoginProvidersCommand()).catch(() => undefined);
              void ipc.rpcWriteSession(sessionIdRef.current, getAvailableModelsCommand()).catch(() => undefined);
            } else if (isInteractivePromptLoginError(reply.error)) {
              setLivePromotedIds((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]));
              setModelError(reply.error ?? "This provider needs Terminal /login.");
            } else {
              setModelError(reply.error ?? "Login failed.");
            }
          }
        }
      } catch {
        /* ignore non-JSON */
      }
    };

    const attachId = Math.floor(Math.random() * 2 ** 31);
    let attached: string | null = null;
    ipc
      .ompSetupSession()
      .then(async (id) => {
        sessionIdRef.current = id;
        // Attach even when the effect is already torn down. The daemon's setup-session reaper only
        // arms once it has seen a client, so a session nobody ever attached to is never reaped --
        // attaching and immediately detaching below is what lets it go.
        await ipc.rpcAttachSession({ id, attachId, streamToken: attachId, onLine: apply });
        attached = id;
        // The cleanup ran while the attach was still in flight, so it had no id to release.
        if (cancelled) {
          void ipc.detachSession(id, attachId);
          return;
        }
        // The daemon negotiates protocol v2 for this session on `ready`, so go straight to
        // asking what it can see.
        await ipc.rpcWriteSession(id, getStateCommand());
        if (cancelled) return;
        await ipc.rpcWriteSession(id, getLoginProvidersCommand());
        if (cancelled) return;
        await ipc.rpcWriteSession(id, getAvailableModelsCommand());
      })
      .catch((error) => {
        if (!cancelled) setModelError(String(error));
      });
    void ipc
      .readModelFavorites("omp")
      .then((rows) => {
        if (!cancelled) setFavorites(rows);
      })
      .catch(() => undefined);
    void ipc
      .readOmpModelRoles()
      .then((roles) => {
        if (!cancelled) setModelRoles(roles);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (attached) void ipc.detachSession(attached, attachId);
    };
  }, []);

  const openBrowser = useCallback(async (request: PendingUi) => {
    try {
      await settleOpenUrl(sessionIdRef.current, request.id, request.launchUrl || request.url, setModelError);
      setChat((current) => dismissPendingUi(current, request.id));
    } catch (error) {
      setModelError(String(error));
    }
  }, []);

  useEffect(() => {
    for (const request of chat.pendingUi) {
      if (handledUiRef.current.has(request.id)) continue;
      if (isPresentationUi(request.method)) {
        handledUiRef.current.add(request.id);
        void ipc.rpcWriteSession(sessionIdRef.current, cancelExtensionUi(request.id)).catch(() => undefined);
      } else if (request.method === "open_url" && loginOpenUrlRef.current) {
        // Sign in authorizes only its first browser request; further links need approval.
        loginOpenUrlRef.current = false;
        handledUiRef.current.add(request.id);
        void openBrowser(request);
      }
    }
  }, [chat.pendingUi, openBrowser]);

  const replyUi = async (requestId: string, response: ReturnType<typeof extensionUiValue> | ReturnType<typeof extensionUiConfirm> | ReturnType<typeof cancelExtensionUi>) => {
    if (handledUiRef.current.has(requestId)) return;
    handledUiRef.current.add(requestId);
    try {
      await ipc.rpcWriteSession(sessionIdRef.current, response);
      setChat((current) => dismissPendingUi(current, requestId));
    } catch (error) {
      setModelError(String(error));
    }
  };

  const approveUi = (requestId: string, allow: boolean) => {
    if (handledUiRef.current.has(requestId)) return;
    const request = chat.pendingUi.find((pending) => pending.id === requestId);
    if (allow && request?.method === "open_url") {
      handledUiRef.current.add(requestId);
      void openBrowser(request);
    } else {
      void replyUi(requestId, extensionUiConfirm(requestId, allow));
    }
  };

  const applyModel = useCallback(async (provider: string, modelId: string) => {
    setModelError(null);
    modelApplyRef.current = true;
    try {
      await ipc.rpcWriteSession(sessionIdRef.current, setModelCommand(provider, modelId));
    } catch (error) {
      modelApplyRef.current = false;
      setModelError(String(error));
    }
  }, []);

  const startLogin = useCallback(async (providerId: string) => {
    if (loginApplyRef.current) return;
    setModelError(null);
    setLoginBusy(providerId);
    loginApplyRef.current = providerId;
    loginOpenUrlRef.current = true;
    try {
      await ipc.rpcWriteSession(sessionIdRef.current, loginCommand(providerId));
    } catch (error) {
      loginApplyRef.current = null;
      loginOpenUrlRef.current = false;
      setLoginBusy(null);
      setModelError(String(error));
    }
  }, []);

  const assignRole = useCallback(
    async (role: string, model: string | null) => {
      const next = { ...modelRoles };
      if (model) next[role] = model;
      else delete next[role];
      try {
        setModelRoles(await ipc.writeOmpModelRoles(next));
      } catch (error) {
        setModelError(String(error));
      }
    },
    [modelRoles],
  );

  // In auto mode the component is a check first and a dialog second: it stays invisible until the
  // providers come back, and dismisses itself when they say this install is already set up. That
  // keeps one attach and one predicate behind both entry points, so the repo-open offer and the
  // in-session offer cannot disagree about what "set up" means.
  const providers = chat.sessionMeta.loginProviders;
  const decided = mode === "manual" || (providers !== undefined && providers.length > 0);
  const offer =
    mode === "manual" ||
    shouldOfferProviderSetup({
      connected: true,
      suppressed: false,
      busy: false,
      providers: providers ?? [],
      models: chat.sessionMeta.models ?? [],
      currentModel: chat.sessionMeta.model,
    });
  useEffect(() => {
    if (mode === "auto" && decided && !offer) onClose("not-needed");
  }, [mode, decided, offer, onClose]);
  if (!decided || !offer) return null;

  return (
    <ChatModelDialog
      tab={tab}
      setup={mode === "auto"}
      models={chat.sessionMeta.models ?? []}
      current={chat.sessionMeta.model}
      preselect=""
      loginProviders={chat.sessionMeta.loginProviders ?? []}
      livePromotedIds={livePromotedIds}
      modelRoles={modelRoles}
      favorites={favorites}
      onToggleFavorite={(model, favorite) => {
        // Optimistic: the store is the authority, but a star that lags a click reads as broken.
        setFavorites((prev) => (favorite ? [...prev, model] : prev.filter((row) => row !== model)));
        void ipc
          .setModelFavorite("omp", model, favorite)
          .then(setFavorites)
          .catch((error) => setModelError(String(error)));
      }}
      error={modelError}
      loginBusy={loginBusy}
      onTabChange={setTab}
      onApplyModel={(provider, modelId) => {
        if (onPick) {
          onPick(`${provider}/${modelId}`);
          onClose("dismissed");
          return;
        }
        void applyModel(provider, modelId);
      }}
      onLogin={(providerId) => void startLogin(providerId)}
      // No pty here to drop into, so say where /login lives rather than silently doing nothing.
      onHatchTerminalLogin={() => setModelError("This provider needs Terminal /login. Open a session and switch it to Terminal.")}
      onAssignRole={(role, model) => void assignRole(role, model)}
      onClose={() => onClose("dismissed")}
    >
      {chat.entries
        .filter((entry) => entry.type === "approval" && !handledUiRef.current.has(entry.requestId))
        .map((entry) => (
          <ChatEntryRow key={entry.id} entry={entry} onApprove={approveUi} showDate={false} showTime={false} />
        ))}
      {chat.pendingUi
        .filter((request) => ["input", "editor", "select"].includes(request.method ?? "") && !handledUiRef.current.has(request.id))
        .map((request) => (
          <ChatExtensionPrompt
            key={request.id}
            request={request}
            onSubmit={(value) => void replyUi(request.id, extensionUiValue(request.id, value))}
            onCancel={() => void replyUi(request.id, cancelExtensionUi(request.id))}
          />
        ))}
    </ChatModelDialog>
  );
}
