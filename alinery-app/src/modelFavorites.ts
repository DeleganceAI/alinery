/** Token-AND substring match for model picker filters. Empty or whitespace-only queries match all. */
export function modelMatches(model: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const normalizedModel = model.toLowerCase();
  return normalizedQuery.split(/\s+/).every((token) => normalizedModel.includes(token));
}

export type ProviderAlive = {
  providers: readonly { id: string }[];
  custom: readonly { id: string }[];
  models: readonly { provider: string; id: string }[];
};

/** Is a favorited `provider/model` still offered by a provider this machine knows? A removed endpoint or a renamed
 * provider id leaves its favorites behind in the store; a provider merely signed out still counts as present, so its
 * stars survive a sign-out and return with it. `null` catalog (it did not answer) keeps the favorite. */
export function favoriteAlive(favorite: string, catalog: ProviderAlive | null, hostedProvider = "alinery"): boolean {
  const slash = favorite.indexOf("/");
  // A favorite without a `provider/` prefix cannot be attributed to a provider; keep it.
  if (slash <= 0) return true;
  const provider = favorite.slice(0, slash);
  if (provider === hostedProvider) return true;
  if (!catalog) return true;
  return (
    catalog.custom.some((row) => row.id === provider) ||
    catalog.providers.some((row) => row.id === provider) ||
    catalog.models.some((model) => `${model.provider}/${model.id}` === favorite)
  );
}

export type ModelRow = {
  model: string;
  favorite: boolean;
};

export function deriveModelRows(discovered: readonly string[], favorites: readonly string[], query: string): ModelRow[] {
  const favoriteModels = new Set(favorites);
  const favoriteRows: ModelRow[] = [];
  const otherRows: ModelRow[] = [];

  for (const model of discovered) {
    if (!modelMatches(model, query)) continue;
    const favorite = favoriteModels.has(model);
    (favorite ? favoriteRows : otherRows).push({ model, favorite });
  }

  return favoriteRows.concat(otherRows);
}
