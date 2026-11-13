import { ChevronsDownUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listWorktreeFilesForRepo } from "./sync/git";

type Dir = { dirs: Map<string, Dir>; files: string[] };

/** Builds the folder tree from git's flat path list; folders sort before files, both by name. */
export function buildRepoTree(paths: string[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push(path);
  }
  return root;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function FileRow({ path, label, selected, onOpen }: { path: string; label: string; selected: boolean; onOpen: (path: string, keep: boolean) => void }) {
  return (
    <button type="button" className={`repo-tree-file${selected ? " selected" : ""}`} title={path} onClick={(event) => onOpen(path, event.detail >= 2)}>
      {label}
    </button>
  );
}

function DirRows({ dir, selected, onOpen }: { dir: Dir; selected: string; onOpen: (path: string, keep: boolean) => void }) {
  return (
    <>
      {[...dir.dirs.keys()].sort().map((name) => (
        <DirRow key={name} name={name} dir={dir.dirs.get(name) as Dir} selected={selected} onOpen={onOpen} />
      ))}
      {dir.files.map((path) => (
        <FileRow key={path} path={path} label={baseName(path)} selected={path === selected} onOpen={onOpen} />
      ))}
    </>
  );
}

function DirRow({ name, dir, selected, onOpen }: { name: string; dir: Dir; selected: string; onOpen: (path: string, keep: boolean) => void }) {
  // ponytail: children render only while open, so a large repo costs one row per visible folder.
  const [open, setOpen] = useState(false);
  return (
    <details className="repo-tree-dir" open={open} onToggle={(ev) => setOpen(ev.currentTarget.open)}>
      <summary>{name}/</summary>
      {open && (
        <div className="repo-tree-children">
          <DirRows dir={dir} selected={selected} onOpen={onOpen} />
        </div>
      )}
    </details>
  );
}

/** The Files panel's Repository section: the task's worktree as a folder tree, with a name filter. Loads on mount. */
export function RepoFileTree({ repoPath, taskSlug, selected, onOpen }: { repoPath: string; taskSlug: string; selected: string; onOpen: (path: string, keep: boolean) => void }) {
  const [listing, setListing] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [reload, setReload] = useState(0);
  // ponytail: each folder keeps its own open state, so collapsing all is a remount of the rows.
  const [collapsed, setCollapsed] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` is the Refresh button's trigger
  useEffect(() => {
    let alive = true;
    setError("");
    listWorktreeFilesForRepo(repoPath, taskSlug)
      .then((next) => alive && setListing(next))
      .catch((e) => alive && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [repoPath, taskSlug, reload]);

  const tree = useMemo(() => buildRepoTree(listing?.paths ?? []), [listing]);
  const needle = filter.trim().toLowerCase();
  const matches = needle ? (listing?.paths ?? []).filter((path) => path.toLowerCase().includes(needle)).slice(0, 500) : [];

  return (
    <section className="repo-tree" aria-label="Repository files">
      <div className="repo-tree-head">
        <span className="repo-tree-title">Repository</span>
        <div className="btn-group repo-tree-search">
          <input
            className="field-input repo-tree-filter"
            type="search"
            placeholder="Filter files…"
            aria-label="Filter repository files"
            value={filter}
            onChange={(ev) => setFilter(ev.target.value)}
          />
          <button type="button" className="btn ghost small" onClick={() => setReload((n) => n + 1)}>
            Refresh
          </button>
          <button type="button" className="btn ghost small" aria-label="Collapse all folders" title="Collapse all folders" onClick={() => setCollapsed((n) => n + 1)}>
            <ChevronsDownUp size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && <div className="danger-text">Couldn't list the worktree: {error}</div>}
      {!error && !listing && <div className="dim">Loading…</div>}
      {listing?.truncated && <div className="dim">Showing the first {listing.paths.length} files.</div>}
      {listing && listing.paths.length === 0 && <div className="dim">No files.</div>}
      {needle ? (
        <div className="repo-tree-children">
          {matches.map((path) => (
            <FileRow key={path} path={path} label={path} selected={path === selected} onOpen={onOpen} />
          ))}
          {matches.length === 0 && <div className="dim">No matching files.</div>}
        </div>
      ) : (
        listing && <DirRows key={collapsed} dir={tree} selected={selected} onOpen={onOpen} />
      )}
    </section>
  );
}
