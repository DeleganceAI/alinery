import { Search, Star, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { costBand } from "../chat/costBand";
import { BUILTIN_MODEL_ROLES, type ModelRolesMap } from "../chat/modelRoles";
import { type AdvancedProviderRow, HOSTED_PROVIDER, hostedPrice, type LoginProvider, mergeGrokModels, mergeHostedModels, partitionProviders } from "../chat/providers";
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
  /** Settings has a Grok key, so the xAI chat models are selectable. */
  grok?: boolean;
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
  onLogout?: (providerId: string) => void;
  /** Custom endpoint ids. They have models and are not an Accounts sign-in row. */
  configuredIds?: string[];
  footer?: ReactNode;
  onAssignRole: (role: string, model: string | null) => void;
  onSignIn?: () => void;
  onSubscribe?: () => void;
  onBuyCredits?: () => void;
  onClose: () => void;
};

function advancedHint(row: AdvancedProviderRow): string {
  if (row.reason === "env") return row.readyViaEnv ? "Ready" : "Not configured";
  return "Sign-in did not finish";
}

const DIALOG_TABS: { id: ProvidersDialogTab; label: string }[] = [
  { id: "accounts", label: "Accounts" },
  { id: "models", label: "Models" },
];

/** Case-insensitive match on the display name or the provider id, which is what people type ("anth", "codex"). */
function providerMatches(row: { id: string; name: string }, q: string): boolean {
  return row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q);
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

function formatCreditUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function AlineryAccountRow({
  hosted,
  onSignIn,
  onSubscribe,
  onBuyCredits,
}: {
  hosted: HostedCatalogView;
  onSignIn?: () => void;
  onSubscribe?: () => void;
  onBuyCredits?: () => void;
}) {
  if (hosted.ready) {
    const meta = hosted.balanceCents != null ? formatCreditUsd(hosted.balanceCents) : "Ready";
    return (
      <li>
        <button type="button" className="chat-model-item" disabled>
          <span>Alinery</span>
          <span className="chat-provider-status">{meta}</span>
        </button>
      </li>
    );
  }
  if (hosted.upsell === "subscribe") {
    return (
      <li>
        <button type="button" className="chat-model-item" onClick={onSubscribe}>
          <span>Alinery</span>
          <span className="chat-provider-status">Subscribe</span>
        </button>
      </li>
    );
  }
  if (hosted.upsell === "buy-credits") {
    return (
      <li>
        <button type="button" className="chat-model-item" onClick={onBuyCredits}>
          <span>Alinery</span>
          <span className="chat-provider-status">Buy credits</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <button type="button" className="chat-model-item" onClick={onSignIn}>
        <span>Alinery</span>
        <span className="chat-provider-status">Sign in</span>
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
  grok = false,
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
  onLogout,
  configuredIds = [],
  footer,
  onAssignRole,
  onSignIn,
  onSubscribe,
  onBuyCredits,
  onClose,
}: ChatProvidersDialogProps) {
  const [query, setQuery] = useState(preselect ?? "");
  const [providerQuery, setProviderQuery] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const advancedRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const searchValue = tab === "accounts" ? providerQuery : query;
  const setSearchValue = tab === "accounts" ? setProviderQuery : setQuery;

  useEffect(() => {
    setQuery(preselect ?? "");
  }, [preselect]);

  // Search shortcuts stay inside this modal, including when focus has moved to a row or tab.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && searchValue !== "") {
        e.preventDefault();
        e.stopPropagation();
        setSearchValue("");
      } else if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [searchValue, setSearchValue]);

  // Advanced opens from the footer, below a list that may be long: bring its rows into view.
  useEffect(() => {
    if (advancedOpen) advancedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [advancedOpen]);

  const listed = useMemo(() => mergeGrokModels(mergeHostedModels(models, hosted), grok), [models, hosted, grok]);
  const { chatLogin, advanced } = useMemo(
    () => partitionProviders({ loginProviders, models: listed, livePromotedIds, configuredIds }),
    [loginProviders, listed, livePromotedIds, configuredIds],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? listed.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : listed;
    // Starred first, order otherwise preserved -- same contract as `deriveModelRows`, which this
    // list replaces for every model-picking surface.
    const starred = new Set(favorites ?? []);
    if (starred.size === 0) return matched;
    return [...matched.filter((m) => starred.has(`${m.provider}/${m.id}`)), ...matched.filter((m) => !starred.has(`${m.provider}/${m.id}`))];
  }, [listed, query, favorites]);
  const roleModels = useMemo(() => listed.filter((model) => model.provider !== HOSTED_PROVIDER || hosted?.ready), [listed, hosted?.ready]);
  // A `provider/id` nobody lists is still a valid ask (preview models, private deployments).
  const customRef = (() => {
    const q = query.trim();
    const slash = q.indexOf("/");
    if (slash <= 0 || slash === q.length - 1 || listed.some((m) => `${m.provider}/${m.id}` === q)) return null;
    return { provider: q.slice(0, slash), id: q.slice(slash + 1) };
  })();
  const selected = customRef ?? filtered.find((model) => `${model.provider}/${model.id}` === query.trim()) ?? filtered[0];
  const title = setup ? "Set up your providers" : tab === "accounts" ? "Providers" : "Models";

  const providerNeedle = providerQuery.trim().toLowerCase();
  const shownHosted = hosted && (!providerNeedle || providerMatches({ id: HOSTED_PROVIDER, name: "Alinery" }, providerNeedle)) ? hosted : null;
  const shownLogin = providerNeedle ? chatLogin.filter((p) => providerMatches(p, providerNeedle)) : chatLogin;
  // A search reaches Advanced rows too, so an env-only provider is findable without knowing where it lives.
  const shownAdvanced = providerNeedle ? advanced.filter((row) => providerMatches(row, providerNeedle)) : advancedOpen ? advanced : [];
  const noProviderMatch = providerNeedle !== "" && !shownHosted && shownLogin.length === 0 && shownAdvanced.length === 0;

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = DIALOG_TABS.length - 1;
    const target = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onTabChange(DIALOG_TABS[target].id);
    (e.currentTarget.parentElement?.children[target] as HTMLElement | undefined)?.focus();
  };

  const applyOrUpsell = (provider: string, modelId: string) => {
    if (provider === HOSTED_PROVIDER && !hosted?.ready) {
      if (hosted?.upsell === "sign-in") onSignIn?.();
      else onTabChange("accounts");
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
        <div className="chat-providers-bar">
          <div className="chat-hatch" role="tablist" aria-label="Providers dialog">
            {DIALOG_TABS.map((t, index) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${panelId}-${t.id}`}
                aria-controls={panelId}
                aria-selected={tab === t.id}
                tabIndex={tab === t.id ? 0 : -1}
                className={tab === t.id ? "active" : ""}
                onClick={() => onTabChange(t.id)}
                onKeyDown={(e) => onTabKeyDown(e, index)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="chat-providers-search">
            <Search size={14} strokeWidth={1.5} aria-hidden="true" />
            <input
              ref={searchRef}
              className="field-input"
              data-autofocus=""
              aria-label={tab === "accounts" ? "Search providers" : "Search models"}
              placeholder={tab === "accounts" ? "Search providers" : "Search models"}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || tab !== "models") return;
                if (selected) applyOrUpsell(selected.provider, selected.id);
              }}
            />
          </div>
        </div>
        {error ? (
          <div className="chat-provider-error">
            <p role="alert">Provider setup couldn't be loaded.</p>
            <details>
              <summary>Technical details</summary>
              <pre>{error}</pre>
            </details>
          </div>
        ) : null}
        {tab === "accounts" ? children : null}

        <div id={panelId} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className="chat-providers-panel">
          {tab === "accounts" ? (
            <>
              <ul className="chat-model-list">
                {shownHosted ? <AlineryAccountRow hosted={shownHosted} onSignIn={onSignIn} onSubscribe={onSubscribe} onBuyCredits={onBuyCredits} /> : null}
                {catalogueStatus === "connecting" ? <li className="dim">Connecting…</li> : null}
                {catalogueStatus === "ready" && !providerNeedle && chatLogin.length === 0 && !hosted ? <li className="dim">No Chat-capable providers yet.</li> : null}
                {catalogueStatus !== "connecting" && noProviderMatch ? <li className="dim">No providers match “{providerQuery.trim()}”</li> : null}
                {shownLogin.map((p) => {
                  const busy = loginBusy === p.id;
                  const canSignOut = p.authenticated && p.stored === true && !!onLogout;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="chat-model-item"
                        disabled={!!loginBusy || (p.authenticated && !canSignOut)}
                        onClick={() => (canSignOut ? onLogout?.(p.id) : onLogin(p.id))}
                      >
                        <span>{p.name}</span>
                        <span className="chat-provider-status">{canSignOut ? "Sign out" : p.authenticated ? "Signed in" : busy ? "Signing in…" : "Sign in"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {shownAdvanced.length > 0 ? (
                <div ref={advancedRef} className="chat-providers-advanced">
                  <p className="dim">These already have models without a sign-in step.</p>
                  <ul className="chat-model-list">
                    {shownAdvanced.map((row) => (
                      <li key={row.id}>
                        <div className="chat-model-item">
                          <span>{row.name}</span>
                          <span className="chat-provider-status">{advancedHint(row)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {footer}
            </>
          ) : (
            <>
              <p className="dim">{current ? `Current model: ${current}` : "Choose a model."}</p>
              <ul className="chat-model-list">
                {catalogueStatus === "connecting" ? <li className="dim">Connecting…</li> : null}
                {catalogueStatus === "ready" && filtered.length === 0 && !customRef ? (
                  <li className="dim">{query.trim() ? `No models match “${query.trim()}”` : "No models match."}</li>
                ) : null}

                {customRef && (
                  <li className="chat-model-row">
                    <button type="button" className="chat-model-item" onClick={() => applyOrUpsell(customRef.provider, customRef.id)}>
                      <span>
                        Use {customRef.provider}/{customRef.id}
                      </span>
                      <span className="chat-work-meta">Custom model</span>
                    </button>
                  </li>
                )}
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

              <details className="chat-model-roles">
                <summary>Role defaults</summary>
                <p className="dim">Defaults for new agent sessions.</p>
                <div className="chat-role-list">
                  {BUILTIN_MODEL_ROLES.map((role) => {
                    const assigned = modelRoles[role] ?? "";
                    const missing = assigned !== "" && !roleModels.some((model) => `${model.provider}/${model.id}` === assigned);
                    return (
                      <label key={role} className="chat-role-row">
                        <code>{role}</code>
                        <select className="field-input" aria-label={`Model for ${role}`} value={assigned} onChange={(event) => onAssignRole(role, event.target.value || null)}>
                          <option value="">Not assigned</option>
                          {missing && (
                            <option value={assigned} disabled>
                              {assigned} (unavailable)
                            </option>
                          )}
                          {roleModels.map((model) => {
                            const label = `${model.provider}/${model.id}`;
                            return (
                              <option key={label} value={label}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                    );
                  })}
                </div>
              </details>
            </>
          )}
        </div>
      </div>
      <div className="mfoot">
        {tab === "models" ? (
          <button type="button" className="btn small" disabled={!selected} onClick={() => selected && applyOrUpsell(selected.provider, selected.id)}>
            Apply
          </button>
        ) : advanced.length > 0 && !providerNeedle ? (
          <button type="button" className="btn ghost small" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((o) => !o)}>
            {advancedOpen ? "Hide Advanced" : "Advanced"}
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
