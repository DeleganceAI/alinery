/** Token-AND substring match for model picker filters. Empty or whitespace-only queries match all. */
export function modelMatches(model: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  const normalizedModel = model.toLowerCase();
  return normalizedQuery.split(/\s+/).every((token) => normalizedModel.includes(token));
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
