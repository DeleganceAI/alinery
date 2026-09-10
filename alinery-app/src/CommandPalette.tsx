import { ListTodo, Search, SquareTerminal, Zap } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type SearchDocument, type SearchKind, searchDocuments } from "./search";
import { Dialog } from "./shared";

export type SearchItem = SearchDocument & { icon?: ReactNode; run: () => void };

const GROUPS: SearchKind[] = ["action", "task", "session"];
const LABELS: Record<SearchKind, string> = { action: "Actions", task: "Tasks", session: "Sessions" };
const ICONS: Record<SearchKind, ReactNode> = {
  action: <Zap size={16} strokeWidth={1.5} />,
  task: <ListTodo size={16} strokeWidth={1.5} />,
  session: <SquareTerminal size={16} strokeWidth={1.5} />,
};

export function GlobalSearch({ open, items, loading, error, onClose }: { open: boolean; items: SearchItem[]; loading: boolean; error: string; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
  }, [open]);

  const matches = searchDocuments(query, items);
  // ponytail: cap entity groups for a responsive local scan; add indexed pagination if measured repository sizes outgrow it.
  const results = GROUPS.flatMap((kind) => matches.filter((item) => item.kind === kind).slice(0, kind === "action" ? matches.length : 20));
  const selected = Math.min(index, Math.max(0, results.length - 1));
  const activeId = results.length > 0 ? `search-result-${selected}` : undefined;

  useEffect(() => {
    listRef.current?.querySelector(`#search-result-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  const run = (item: SearchItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const move = (delta: number) => {
    if (!results.length) return;
    setIndex((selected + delta + results.length) % results.length);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[selected]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const status = loading
    ? "Loading search results"
    : error
      ? `Some search results are unavailable. ${error}`
      : query
        ? `${results.length} search result${results.length === 1 ? "" : "s"}`
        : "Search actions, tasks, and sessions";

  return (
    <Dialog onClose={onClose} ariaLabel="Search" className="palette search-dialog">
      <div className="in">
        <span className="p" aria-hidden="true">
          <Search size={17} strokeWidth={1.5} />
        </span>
        <label className="sr-only" htmlFor="global-search-input">
          Search actions, tasks, and sessions
        </label>
        <input
          id="global-search-input"
          data-autofocus=""
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="global-search-results"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-describedby="global-search-help"
          placeholder="Search actions, tasks, and sessions…"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="sr-only" role="status">
        {status}
      </div>
      <div className="list2" role="listbox" id="global-search-results" aria-busy={loading || undefined} aria-label="Search results" ref={listRef}>
        {loading && query && results.length === 0 && <div className="pitem empty">Loading results…</div>}
        {!loading && query && results.length === 0 && <div className="pitem empty">No results for “{query}”</div>}
        {error && <div className="pitem empty search-error">Some results could not be loaded.</div>}
        {GROUPS.map((kind) => {
          const grouped = results.map((item, resultIndex) => ({ item, resultIndex })).filter(({ item }) => item.kind === kind);
          if (!grouped.length) return null;
          const headingId = `search-group-${kind}`;
          return (
            // biome-ignore lint/a11y/useSemanticElements: listbox option groups use ARIA group, not fieldset.
            <div key={kind} role="group" aria-labelledby={headingId}>
              <div className="pgroup" id={headingId}>
                {LABELS[kind]}
              </div>
              {grouped.map(({ item, resultIndex }) => (
                <div
                  key={item.id}
                  id={`search-result-${resultIndex}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={resultIndex === selected}
                  className={`pitem${resultIndex === selected ? " on" : ""}`}
                  onMouseEnter={() => setIndex(resultIndex)}
                  onClick={() => run(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") run(item);
                  }}
                >
                  <span className="pi" aria-hidden="true">
                    {item.icon ?? ICONS[kind]}
                  </span>
                  <span className="ptext">
                    <span className="ptitle">{item.title}</span>
                    {item.detail && <span className="pdetail">{item.detail}</span>}
                  </span>
                  {item.hint && <span className="pk">{item.hint}</span>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div className="search-help" id="global-search-help">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          Navigate
        </span>
        <span>
          <kbd>↵</kbd>
          Open
        </span>
        <span>
          <kbd>Esc</kbd>
          Close
        </span>
      </div>
    </Dialog>
  );
}
