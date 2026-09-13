import { Star, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { costBand } from "../chat/costBand";
import { BUILTIN_MODEL_ROLES, type ModelRolesMap } from "../chat/modelRoles";
import { type AdvancedProviderRow, HOSTED_PROVIDER, hostedPrice, type LoginProvider, mergeHostedModels, partitionProviders } from "../chat/providers";
import type { ProvidersDialogTab } from "../chat/slash";
import type { ChatModelOption } from "../chatTranscript";
import { Dialog } from "../shared";
import type { HostedCatalogView } from "../types";

export type ChatProvidersDialogProps = {
  tab: ProvidersDialogTab;
  setup?: boolean;
  models: ChatModelOption[];
  current?: string;
  preselect?: string;
  loginProviders: LoginProvider[];
  livePromotedIds?: string[];
  modelRoles: ModelRolesMap;
  hosted?: HostedCatalogView | null;
  error?: string | null;
  loginBusy?: string | null;
  children?: ReactNode;
  defaultAdvancedOpen?: boolean;
  /** Starred models, newest store wins. Empty when the host has not loaded them yet. */
  favorites?: string[];
  /** Default ready so in-session ChatModelDialog is unchanged. */
  catalogueStatus?: "connecting" | "ready" | "failed";
  /** Omitted by hosts that do not persist favourites; the star is then not rendered at all. */
  onToggleFavorite?: (model: string, favorite: boolean) => void;
  onTabChange: (tab: ProvidersDialogTab) => void;
  onApplyModel: (provider: string, modelId: string) => void;
  onLogin: (providerId: string) => void;
  onHatchTerminalLogin: (providerId?: string) => void;
  onAssignRole: (role: string, model: string | null) => void;
  onSignIn?: () => void;
  onGetCredits?: () => void;
  onClose: () => void;
};

function advancedHint(row: AdvancedProviderRow): string {
  if (row.reason === "env") return row.readyViaEnv ? "ready via env" : "set env or Terminal";
  if (row.reason === "live-promote") return "needs Terminal";
  return "Terminal /login";
}

function CostBand({ price }: { price: number }) {
  return (
    <span className="chat-work-meta chat-cost-band" aria-label={`cost ${price} of 5`}>
      <span className={price > 0 ? "on" : undefined} aria-hidden="true" />
      <span className={price > 1 ? "on" : undefined} aria-hidden="true" />
      <span className={price > 2 ? "on" : undefined} aria-hidden="true" />
      <span className={price > 3 ? "on" : undefined} aria-hidden="true" />
      <span className={price > 4 ? "on" : undefined} aria-hidden="true" />
    </span>
  );
}

function AlineryAccountRow({ hosted, onSignIn, onGetCredits }: { hosted: HostedCatalogView; onSignIn?: () => void; onGetCredits?: () => void }) {
  if (hosted.ready) {
    return (
      <li>
        <button type="button" className="chat-model-item" disabled>
          <span>Alinery</span>
          <span className="chat-work-meta">ready</span>
        </button>
      </li>
    );
  }
  if (hosted.upsell === "get-credits") {
    return (
      <li>
        <button type="button" className="chat-model-item" onClick={onGetCredits}>
          <span>Alinery</span>
          <span className="chat-work-meta">Get credits</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="chat-model-item" onClick={onSignIn}>
        <span>Alinery</span>
        <span className="chat-work-meta">Sign in</span>
      </button>
    </li>
  );
}

export function ChatModelDialog({
  tab,
  setup = false,
  models,
  current,
  preselect,
  loginProviders,
  livePromotedIds = [],
  modelRoles,
  hosted,
  error,
  loginBusy,
  children,
  defaultAdvancedOpen = false,
  favorites,
  catalogueStatus = "ready",
  onToggleFavorite,
  onTabChange,
  onApplyModel,
  onLogin,
  onHatchTerminalLogin,
  onAssignRole,
  onSignIn,
  onGetCredits,
  onClose,
}: ChatProvidersDialogProps) {
  const [query, setQuery] = useState(preselect ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);
  const [rolePick, setRolePick] = useState<string | null>(null);

  useEffect(() => {
    setQuery(preselect ?? "");
  }, [preselect]);

  const listed = useMemo(() => mergeHostedModels(models, hosted), [models, hosted]);
  const { chatLogin, advanced } = useMemo(() => partitionProviders({ loginProviders, models: listed, livePromotedIds }), [loginProviders, listed, livePromotedIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? listed.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : listed;
    // Starred first, order otherwise preserved -- same contract as `deriveModelRows`, which this
    // list replaces for every model-picking surface.
    const starred = new Set(favorites ?? []);
    if (starred.size === 0) return matched;
    return [...matched.filter((m) => starred.has(`${m.provider}/${m.id}`)), ...matched.filter((m) => !starred.has(`${m.provider}/${m.id}`))];
  }, [listed, query, favorites]);
  const selected = filtered.find((m) => `${m.provider}/${m.id}` === query.trim()) ?? filtered[0];
  const title = setup ? "Set up your providers" : tab === "accounts" ? "Providers" : "Models";

  const applyOrUpsell = (provider: string, modelId: string) => {
    if (provider === HOSTED_PROVIDER && !hosted?.ready) {
      if (hosted?.upsell === "get-credits") onGetCredits?.();
      else if (hosted?.upsell === "sign-in") onSignIn?.();
      return;
    }
    onApplyModel(provider, modelId);
  };

  return (
    <Dialog onClose={onClose} ariaLabel={title} className="chat-model-dialog">
      <div className="mh">
        <span className="mt">{title}</span>
        <button type="button" className="x" aria-label="Cancel" title="Cancel" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div className="mb">
        <div className="chat-hatch chat-providers-tabs" role="tablist" aria-label="Providers dialog">
          <button type="button" role="tab" aria-selected={tab === "accounts"} className={tab === "accounts" ? "active" : ""} onClick={() => onTabChange("accounts")}>
            Accounts
          </button>
          <button type="button" role="tab" aria-selected={tab === "models"} className={tab === "models" ? "active" : ""} onClick={() => onTabChange("models")}>
            Models
          </button>
        </div>

        {tab === "accounts" ? (
          <>
            <p className="dim">Sign in with browser OAuth or paste-code. Chat never collects API keys.</p>
            {error ? <p className="chat-face-danger">{error}</p> : null}
            {children}
            <ul className="chat-model-list">
              {hosted ? <AlineryAccountRow hosted={hosted} onSignIn={onSignIn} onGetCredits={onGetCredits} /> : null}
              {catalogueStatus === "connecting" ? <li className="dim">Connecting…</li> : null}
              {catalogueStatus === "ready" && chatLogin.length === 0 && !hosted ? <li className="dim">No Chat-capable providers yet.</li> : null}
              {chatLogin.map((p) => {
                const busy = loginBusy === p.id;
                return (
                  <li key={p.id}>
                    <button type="button" className="chat-model-item" disabled={!!loginBusy || p.authenticated} onClick={() => onLogin(p.id)}>
                      <span>{p.name}</span>
                      <span className="chat-work-meta">{p.authenticated ? "signed in" : busy ? "signing in…" : "sign in"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {advanced.length > 0 ? (
              <div className="chat-providers-advanced">
                <button type="button" className="btn ghost small" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((o) => !o)}>
                  {advancedOpen ? "Hide Advanced" : "Advanced"}
                </button>
                {advancedOpen ? (
                  <>
                    <p className="dim">These need Terminal /login or an environment variable on the Alinery process. Chat will not collect keys.</p>
                    <ul className="chat-model-list">
                      {advanced.map((row) => (
                        <li key={row.id}>
                          <button type="button" className="chat-model-item" onClick={() => onHatchTerminalLogin(row.id)}>
                            <span>{row.name}</span>
                            <span className="chat-work-meta">{advancedHint(row)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <p className="dim">{current ? `Current session ${current}. Apply switches this chat only.` : "Choose a model for this session."}</p>
            <input
              className="field-input"
              data-autofocus=""
              aria-label="Filter models"
              placeholder="provider/id"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && selected) applyOrUpsell(selected.provider, selected.id);
              }}
            />
            {error ? <p className="chat-face-danger">{error}</p> : null}
            <ul className="chat-model-list">
              {catalogueStatus === "connecting" ? <li className="dim">Connecting…</li> : null}
              {catalogueStatus === "ready" && filtered.length === 0 ? <li className="dim">No models match.</li> : null}

              {filtered.map((m) => {
                const label = `${m.provider}/${m.id}`;
                const active = selected ? `${selected.provider}/${selected.id}` === label : false;
                const isCurrent = current === label;
                const starred = (favorites ?? []).includes(label);
                const band = costBand(hostedPrice(hosted, m.provider, m.id));
                return (
                  <li key={label} className="chat-model-row">
                    <button type="button" className={`chat-model-item${active ? " active" : ""}`} onClick={() => applyOrUpsell(m.provider, m.id)}>
                      <span>{label}</span>
                      <span className="chat-model-item-side">
                        {band !== null ? <CostBand price={band} /> : null}
                        {isCurrent ? <span className="chat-work-meta">current</span> : null}
                      </span>
                    </button>
                    {onToggleFavorite ? (
                      <button
                        type="button"
                        className="btn ghost small chat-model-star"
                        aria-pressed={starred}
                        aria-label={starred ? `Unstar ${label}` : `Star ${label}`}
                        title={starred ? "Remove from favourites" : "Add to favourites"}
                        onClick={() => onToggleFavorite(label, !starred)}
                      >
                        <Star size={14} strokeWidth={1.5} fill={starred ? "currentColor" : "none"} aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <div className="chat-model-roles">
              <p className="dim">Role assignments apply to new OMP processes (titles, @smol, advisor, …). This chat’s model is the session control above.</p>
              <table className="chat-role-table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Model</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {BUILTIN_MODEL_ROLES.map((role) => {
                    const assigned = modelRoles[role];
                    const picking = rolePick === role;
                    return (
                      <tr key={role}>
                        <td>
                          <code>{role}</code>
                        </td>
                        <td>{assigned || <span className="dim">unset</span>}</td>
                        <td>
                          {picking ? (
                            <select
                              aria-label={`Assign ${role}`}
                              className="field-input"
                              defaultValue=""
                              onChange={(e) => {
                                const v = e.target.value;
                                setRolePick(null);
                                if (v === "") onAssignRole(role, null);
                                else onAssignRole(role, v);
                              }}
                            >
                              <option value="">Clear</option>
                              {listed
                                .filter((m) => m.provider !== HOSTED_PROVIDER || hosted?.ready)
                                .map((m) => {
                                  const label = `${m.provider}/${m.id}`;
                                  return (
                                    <option key={label} value={label}>
                                      {label}
                                    </option>
                                  );
                                })}
                            </select>
                          ) : (
                            <button type="button" className="btn ghost small" onClick={() => setRolePick(role)}>
                              {assigned ? "Change" : "Assign"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <div className="mfoot">
        {tab === "models" ? (
          <button type="button" className="btn small" disabled={!selected} onClick={() => selected && applyOrUpsell(selected.provider, selected.id)}>
            Apply
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="btn ghost small" onClick={onClose}>
          {setup ? "Done" : "Cancel"}
        </button>
      </div>
    </Dialog>
  );
}
