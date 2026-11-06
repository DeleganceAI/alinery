import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelRolesMap } from "../chat/modelRoles";
import { useProviderAccess } from "../chat/providerAccess";
import { needsProviderSetup, shouldOfferProviderSetup } from "../chat/providers";
import type { ProvidersDialogTab } from "../chat/slash";
import * as ipc from "../ipc";
import { SignInTarget } from "../SignInTarget";
import * as agent from "../sync/agent";
import type { HostedCatalogView } from "../types";
import { ChatModelDialog } from "./ChatModelDialog";
import { CustomEndpointForm, ProviderAccessPanel } from "./ProviderAccessPanel";

export type ProviderSetupMode =
  /** Opened by the user: show the dialog regardless of what the providers turn out to be. */
  | "manual"
  /** Opened on repo open: stay invisible unless this install actually needs setting up. */
  | "auto";

/**
 * Accounts and model picker. Vinculum has no OMP process, so the list is the hosted catalog
 * plus Grok when a key is saved. It does not open a setup session.
 */
export type ProviderSetupClose =
  /** The providers came back and this install is already set up -- nothing was ever shown. */
  | "not-needed"
  /** The dialog was shown and the user closed it. */
  | "dismissed";

export function ProviderSetupDialog({
  mode,
  initialTab = "accounts",
  preselect = "",
  unsignedOpensAccounts = false,
  current,
  onPick,
  onClose,
}: {
  mode: ProviderSetupMode;
  initialTab?: ProvidersDialogTab;
  /** `/model provider/id` typed in a chat: filters the Models tab to it. */
  preselect?: string;
  /** The model the open session will use next. Form pickers have no session, so they omit this. */
  current?: string;
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
  const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
  const [modelRoles, setModelRoles] = useState<ModelRolesMap>({});
  const [modelError, setModelError] = useState<string | null>(null);
  const [tab, setTab] = useState<ProvidersDialogTab>(initialTab);
  const access = useProviderAccess(true);
  // Same store the old ModelInput picker used, so stars survive the swap rather than resetting.
  const [favorites, setFavorites] = useState<string[]>([]);
  const [hosted, setHosted] = useState<HostedCatalogView | null>(null);
  const [hostedLoaded, setHostedLoaded] = useState(false);
  const [grokReady, setGrokReady] = useState(false);
  const unsignedSwitchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void ipc
      .readModelFavorites("omp")
      .then((rows) => {
        if (!cancelled) setFavorites(rows);
      })
      .catch(() => undefined);
    void agent
      .readModelRoles()
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
    void ipc.grokKeyReady().then(
      (ready) => {
        if (!cancelled) setGrokReady(ready);
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const applyModel = useCallback((provider: string, modelId: string) => {
    setModelError(null);
    setCurrentModel(`${provider}/${modelId}`);
  }, []);

  const startLogin = useCallback(
    (providerId: string) => {
      const row = access.loginProviders.find((provider) => provider.id === providerId);
      if (row?.apiKey && row.oauth) {
        access.choose(row);
        return;
      }
      void access.start(providerId, row?.oauth && !row.apiKey ? "oauth" : "api_key");
    },
    [access],
  );

  const assignRole = useCallback(
    async (role: string, model: string | null) => {
      const next = { ...modelRoles };
      if (model) next[role] = model;
      else delete next[role];
      try {
        setModelRoles(await agent.writeModelRoles(next));
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
  const providers = access.loginProviders;
  const models = access.models;
  const accountsStatus = access.settled ? "ready" : "connecting";
  const shownModels = models;
  const modelsStatus = hostedLoaded && access.settled ? "ready" : "connecting";
  const decided = mode === "manual" || (hostedLoaded && access.settled);
  const offer =
    mode === "manual" ||
    shouldOfferProviderSetup({
      connected: true,
      suppressed: false,
      busy: false,
      providers: providers ?? [],
      models,
      currentModel,
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
      current={current || (onPick ? undefined : currentModel)}
      preselect={preselect}
      loginProviders={providers}
      livePromotedIds={[]}
      modelRoles={modelRoles}
      hosted={hosted}
      grok={grokReady}
      favorites={favorites}
      configuredIds={access.custom.map((row) => row.id)}
      catalogueStatus={tab === "models" ? modelsStatus : accountsStatus}
      onToggleFavorite={(model, favorite) => {
        // Optimistic: the store is the authority, but a star that lags a click reads as broken.
        setFavorites((prev) => (favorite ? [...prev, model] : prev.filter((row) => row !== model)));
        void ipc
          .setModelFavorite("omp", model, favorite)
          .then(setFavorites)
          .catch((error) => setModelError(String(error)));
      }}
      error={modelError || access.error}
      loginBusy={access.busy}
      onTabChange={setTab}
      onApplyModel={(provider, modelId) => {
        if (onPick) {
          onPick(`${provider}/${modelId}`);
          onClose("dismissed");
          return;
        }
        void applyModel(provider, modelId);
      }}
      onLogin={(providerId) => startLogin(providerId)}
      onLogout={(providerId) => void access.logout(providerId)}
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
      onClose={() => {
        void access.cancel();
        onClose("dismissed");
      }}
      footer={<CustomEndpointForm access={access} />}
    >
      <SignInTarget />
      <ProviderAccessPanel access={access} />
    </ChatModelDialog>
  );
}
