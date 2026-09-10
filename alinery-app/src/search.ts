export type SearchKind = "action" | "task" | "session";

export type SearchDocument = {
  id: string;
  kind: SearchKind;
  title: string;
  detail: string;
  searchText: string;
  hint?: string;
};

export function searchDocuments<T extends SearchDocument>(query: string, documents: T[]): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return documents.filter((document) => document.kind === "action");

  const terms = normalized.split(/\s+/);
  return documents
    .map((document, index) => {
      const title = document.title.toLocaleLowerCase();
      const haystack = `${document.kind} ${title} ${document.detail} ${document.searchText}`.toLocaleLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return null;
      const score = title === normalized ? 0 : title.startsWith(normalized) ? 1 : title.includes(normalized) ? 2 : 3;
      return { document, index, score };
    })
    .filter((match): match is { document: T; index: number; score: number } => match !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ document }) => document);
}
