import { Archive, Check, Search, X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import "./listToolbar.css";

export function ListToolbar({
  label,
  heading,
  query,
  onQueryChange,
  shown,
  total,
  filtered,
  onReset,
  children,
}: {
  label: string;
  heading?: ReactNode;
  query: string;
  onQueryChange: (value: string) => void;
  shown: number;
  total: number;
  filtered: boolean;
  onReset: () => void;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <search
      className="collection-toolbar"
      aria-label={`Filter ${label.toLowerCase()}`}
      onKeyDown={(event) => {
        // Filter navigation/confirmation stays local; global command shortcuts still reach App.
        const control = (event.target as HTMLElement).closest("select,button");
        if (control && ((!event.metaKey && !event.ctrlKey) || event.key === "Enter" || event.key === " ")) event.stopPropagation();
      }}
    >
      {heading && <div className="collection-heading">{heading}</div>}
      <div className="collection-search">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder={`Search ${label.toLowerCase()}…`}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              onQueryChange("");
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="collection-search-clear"
            aria-label={`Clear ${label.toLowerCase()} search`}
            title="Clear search"
            onClick={() => {
              onQueryChange("");
              input.current?.focus();
            }}
          >
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
      <div className="collection-filters">{children}</div>
      <div className="collection-results">
        {filtered && (
          <button type="button" className="btn ghost small" onClick={onReset}>
            Clear filters
          </button>
        )}
        <span className="collection-count" role="status" aria-live="polite" aria-atomic="true">
          {filtered ? `${shown} of ${total}` : total} {total === 1 ? label.toLowerCase().replace(/s$/, "") : label.toLowerCase()}
        </span>
      </div>
    </search>
  );
}

export function ArchiveFilter({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const Icon = checked ? Check : Archive;
  return (
    <button
      type="button"
      className="btn ghost small collection-archive-toggle"
      aria-pressed={checked}
      title={checked ? "Hide archived items" : "Show active and archived items"}
      onClick={() => onChange(!checked)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
      Include archived
    </button>
  );
}
