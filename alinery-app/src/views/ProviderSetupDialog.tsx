import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRolesMap } from "../chat/modelRoles";
import { settleOpenUrl } from "../chat/openUrl";
import { isInteractivePromptLoginError, needsProviderSetup, shouldOfferProviderSetup } from "../chat/providers";
import { loginReply, requireWritten, setModelReply } from "../chat/send";
import type { ProvidersDialogTab } from "../chat/slash";
import { applyRpcLine, type ChatModelOption, type ChatTranscriptState, dismissPendingUi, emptyTranscript, isPresentationUi, type PendingUi } from "../chatTranscript";
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
import type { HostedCatalogView } from "../types";
import { ChatEntryRow, SignInInstructions } from "./ChatEntryRow";
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

const DAEMON_BACKOFF_MS = [250, 500, 1000, 2000] as const;

/** Last successful `get_available_models` rows for this JS realm. An app restart drops it. */
let lastCatalogue: ChatModelOption[] | undefined;

/** Test isolation. The cache is otherwise the JS realm, so an app restart drops it. */
export function resetProviderSetupCatalogue(): void {
  lastCatalogue = undefined;
}

function sameCatalogue(cached: ChatModelOption[] | undefined, next: ChatModelOption[]): boolean {
  if (!cached || cached.length !== next.length) return false;
  return cached.every((row, index) => row.provider === next[index]?.provider && row.id === next[index]?.id);
}

/** A successful catalogue reply, matching the `get_available_models` branch in `applyRpcLine`. */
function successfulModelsReply(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const data = rec.data;
  return rec.type === "response" && rec.command === "get_available_models" && rec.success !== false && data !== null && typeof data === "object" && !Array.isArray(data);
}

export function ProviderSetupDialog({
  mode,
  initialTab = "accounts",
  preselect = "",
  unsignedOpensAccounts = false,
  onPick,
  onClose,
}: {
  mode: ProviderSetupMode;
  initialTab?: ProvidersDialogTab;
  /** `/model provider/id` typed in a chat: filters the Models tab to it. */
  preselect?: string;
  /**
   * Form pickers land on Accounts once login providers and hosted state have settled
   * and this install still needs setup. The setup session's probe model is not that
   * evidence. Settings omits this.
   */
  unsignedOpensAccounts?: boolean;
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
  // The device code a sign-in needs typed into the browser. It arrives only on the link's
  // `instructions`, and that row is dismissed as soon as the browser opens.
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [livePromotedIds, setLivePromotedIds] = useState<string[]>([]);
  const [tab, setTab] = useState<ProvidersDialogTab>(initialTab);
  const [catalogueStatus, setCatalogueStatus] = useState<"connecting" | "ready" | "failed">("connecting");
  const [modelsSettled, setModelsSettled] = useState(false);
  // Same store the old ModelInput picker used, so stars survive the swap rather than resetting.
  const [favorites, setFavorites] = useState<string[]>([]);
  const [hosted, setHosted] = useState<HostedCatalogView | null>(null);
  const [hostedLoaded, setHostedLoaded] = useState(false);
  const chatRef = useRef(emptyTranscript());
  const sessionIdRef = useRef("");
  const loginApplyRef = useRef<string | null>(null);
  const loginOpenUrlRef = useRef(false);
  const handledUiRef = useRef(new Set<string>());
  const unsignedSwitchedRef = useRef(false);
  const modelApplyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const apply = (line: string) => {
      if (cancelled) return;
      try {
        // `applyRpcLine` takes the parsed value, not the raw line: handed a string it silently
        // no-ops, so every provider row would vanish without an error anywhere.
        const value: unknown = JSON.parse(line);
        const next = applyRpcLine(chatRef.current, value);
        chatRef.current = next;
        setChat(next);
        // Publish only a live successful catalogue. A close that already set `cancelled`
        // returned above, so a racing reply cannot become the next open's cache.
        if (successfulModelsReply(value)) {
          const nextModels = next.sessionMeta.models ?? [];
          if (!sameCatalogue(lastCatalogue, nextModels)) {
            lastCatalogue = nextModels.map((row) => ({ provider: row.provider, id: row.id }));
          }
          setModelsSettled(true);
        }
        if (modelApplyRef.current) {
          const reply = setModelReply(value);
          if (reply) {
            modelApplyRef.current = false;
            setModelError(reply.ok ? null : (reply.error ?? "Could not set model."));
          }
        }
        const reply = loginReply(value);
        if (reply) setLoginNotice(null);
        if (loginApplyRef.current) {
          if (reply) {
            const providerId = loginApplyRef.current;
            loginApplyRef.current = null;
            loginOpenUrlRef.current = false;
            setLoginBusy(null);
            if (reply.ok) {
              setModelError(null);
              void ipc
                .rpcWriteSession(sessionIdRef.current, getLoginProvidersCommand())
                .then(requireWritten)
                .catch((error: unknown) => setModelError(String(error)));
              void ipc
                .rpcWriteSession(sessionIdRef.current, getAvailableModelsCommand())
                .then(requireWritten)
                .catch((error: unknown) => setModelError(String(error)));
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
    let backoffTimer: number | undefined;

    const reap = (id: string) => {
      void ipc.detachSession(id, attachId);
      if (sessionIdRef.current === id) sessionIdRef.current = "";
      if (attached === id) attached = null;
    };

    const attachAndQuery = async (id: string) => {
      sessionIdRef.current = id;
      // Attach even when the effect is already torn down. The daemon's setup-session reaper only
      // arms once it has seen a client, so a session nobody ever attached to is never reaped --
      // attaching and immediately detaching below is what lets it go.
      try {
        await ipc.rpcAttachSession({ id, attachId, streamToken: attachId, onLine: apply });
      } catch (error) {
        reap(id);
        throw error;
      }
      attached = id;
      if (cancelled) {
        reap(id);
        return;
      }
      // The daemon negotiates protocol v2 for this session on `ready`, so go straight to
      // asking what it can see.
      requireWritten(await ipc.rpcWriteSession(id, getStateCommand()));
      if (cancelled) return;
      requireWritten(await ipc.rpcWriteSession(id, getLoginProvidersCommand()));
      if (cancelled) return;
      requireWritten(await ipc.rpcWriteSession(id, getAvailableModelsCommand()));
    };

    const run = async () => {
      let attempt = 0;
      while (!cancelled) {
        try {
          const id = await ipc.ompSetupSession();
          await attachAndQuery(id);
          return;
        } catch (error) {
          if (cancelled) return;
          const leaked = attached || sessionIdRef.current;
          if (leaked) reap(leaked);
          const message = String(error);
          if (!message.includes("daemon not connected")) {
            setCatalogueStatus("failed");
            setModelError(message);
            return;
          }
          if (mode === "manual" && attempt >= DAEMON_BACKOFF_MS.length) {
            setCatalogueStatus("failed");
            setModelError(message);
            return;
          }
          const delay = DAEMON_BACKOFF_MS[Math.min(attempt, DAEMON_BACKOFF_MS.length - 1)] ?? 2000;
          attempt += 1;
          await new Promise<void>((resolve) => {
            backoffTimer = window.setTimeout(resolve, delay);
          });
        }
      }
    };
    void run();
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
    void ipc
      .hostedCatalog()
      .then((view) => {
        if (!cancelled) setHosted(view);
      })
      .catch(() => {
        if (!cancelled) setHosted(null);
      })
      .finally(() => {
        if (!cancelled) setHostedLoaded(true);
      });

    return () => {
      cancelled = true;
      if (backoffTimer != null) window.clearTimeout(backoffTimer);
      const id = attached || sessionIdRef.current;
      if (id) reap(id);
    };
  }, [mode]);

  const openBrowser = useCallback(async (request: PendingUi) => {
    setLoginNotice(request.instructions ?? null);
    try {
      await settleOpenUrl(sessionIdRef.current, request.id, request.launchUrl || request.url, setModelError);
      const next = dismissPendingUi(chatRef.current, request.id);
      chatRef.current = next;
      setChat(next);
    } catch (error) {
      handledUiRef.current.delete(request.id);
      setModelError(String(error));
    }
  }, []);

  useEffect(() => {
    for (const request of chat.pendingUi) {
      if (handledUiRef.current.has(request.id)) continue;
      if (isPresentationUi(request.method)) {
        handledUiRef.current.add(request.id);
        void ipc
          .rpcWriteSession(sessionIdRef.current, cancelExtensionUi(request.id))
          .then(requireWritten)
          .catch((error: unknown) => setModelError(String(error)));
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
      requireWritten(await ipc.rpcWriteSession(sessionIdRef.current, response));
      const next = dismissPendingUi(chatRef.current, requestId);
      chatRef.current = next;
      setChat(next);
    } catch (error) {
      handledUiRef.current.delete(requestId);
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
      requireWritten(await ipc.rpcWriteSession(sessionIdRef.current, setModelCommand(provider, modelId)));
    } catch (error) {
      modelApplyRef.current = false;
      setModelError(String(error));
    }
  }, []);

  const startLogin = useCallback(async (providerId: string) => {
    if (loginApplyRef.current) return;
    setModelError(null);
    setLoginNotice(null);
    setLoginBusy(providerId);
    loginApplyRef.current = providerId;
    loginOpenUrlRef.current = true;
    try {
      requireWritten(await ipc.rpcWriteSession(sessionIdRef.current, loginCommand(providerId)));
    } catch (error) {
      loginApplyRef.current = null;
      loginOpenUrlRef.current = false;
      setLoginBusy(null);
      setLoginNotice(null);
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
  const models = chat.sessionMeta.models ?? [];
  // Accounts is ready when login providers arrive. Models is not: a pending
  // `get_available_models` must stay "Connecting…", or paint this process's last catalogue.
  const accountsStatus = providers !== undefined ? "ready" : catalogueStatus;
  const shownModels = modelsSettled ? models : (lastCatalogue ?? []);
  const modelsStatus = modelsSettled || lastCatalogue ? "ready" : catalogueStatus === "failed" ? "failed" : "connecting";
  const decided = mode === "manual" || (hostedLoaded && providers !== undefined && providers.length > 0);
  const offer =
    mode === "manual" ||
    shouldOfferProviderSetup({
      connected: true,
      suppressed: false,
      busy: false,
      providers: providers ?? [],
      models,
      currentModel: chat.sessionMeta.model,
      hostedReady: hosted?.ready === true,
    });
  useEffect(() => {
    if (mode === "auto" && decided && !offer) onClose("not-needed");
  }, [mode, decided, offer, onClose]);
  useEffect(() => {
    if (!unsignedOpensAccounts || unsignedSwitchedRef.current) return;
    if (!hostedLoaded || providers === undefined) return;
    if (needsProviderSetup(providers, undefined, shownModels, hosted?.ready === true)) {
      unsignedSwitchedRef.current = true;
      setTab("accounts");
    }
  }, [unsignedOpensAccounts, hostedLoaded, providers, shownModels, hosted]);
  if (mode === "auto" && (!decided || !offer)) return null;
  if (mode === "manual" && !offer) return null;

  return (
    <ChatModelDialog
      tab={tab}
      setup={mode === "auto"}
      models={shownModels}
      current={onPick ? undefined : chat.sessionMeta.model}
      preselect={preselect}
      loginProviders={chat.sessionMeta.loginProviders ?? []}
      livePromotedIds={livePromotedIds}
      modelRoles={modelRoles}
      hosted={hosted}
      favorites={favorites}
      catalogueStatus={tab === "models" ? modelsStatus : accountsStatus}
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
      onSignIn={() => {
        void ipc
          .accountSignIn()
          .then(() => ipc.accountRefresh().catch(() => undefined))
          .then(() =>
            ipc
              .hostedCatalog()
              .then(setHosted)
              .catch(() => setHosted(null)),
          )
          .catch((error) => setModelError(String(error)));
      }}
      onSubscribe={() => {
        void ipc.accountOpenPlans().catch((error) => setModelError(String(error)));
      }}
      onBuyCredits={() => {
        void ipc.accountOpen().catch((error) => setModelError(String(error)));
      }}
      onClose={() => onClose("dismissed")}
    >
      {loginNotice ? <SignInInstructions text={loginNotice} /> : null}
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
