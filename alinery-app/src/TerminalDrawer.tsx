import { CornerDownRight, Plus, SquareX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { SessionTerminal } from "./SessionTerminal";
import type { RepoScope, View } from "./types";

export const DRAWER_MIN_WIDTH = 260;
export const DRAWER_MAX_SCREEN_FRACTION = 0.6;
export const DRAWER_DEFAULT_WIDTH = 360;

export type DrawerTab = {
  id: string;
  ordinal: number;
  cwd: string;
};

export function clampDrawerWidth(w: number): number {
  return Math.max(DRAWER_MIN_WIDTH, Math.min(Math.floor(window.innerWidth * DRAWER_MAX_SCREEN_FRACTION), w));
}

/** Single-quote a path for zsh/bash so spaces/specials survive stdin write. */
export function shellSingleQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Build a shell `cd` line. Bare `~` stays unquoted so the shell expands it. */
export function shellCdCommand(path: string): string {
  const p = path.trim();
  if (!p) return "cd\n";
  if (p === "~") return "cd ~\n";
  return `cd ${shellSingleQuote(p)}\n`;
}

async function worktreeForSlug(slug: string): Promise<string | null> {
  if (!slug.trim()) return null;
  try {
    const tasks = await ipc.listTasks();
    const task = tasks.find((t) => t.slug === slug);
    const wt = task?.worktree?.trim();
    return wt || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the "cd here" target from app navigation context.
 * Priority: session/task/create-draft worktree → active repo root → home
 * (home when all-repos scope or no active repo / unresolved).
 */
export async function resolveDrawerCdTarget(opts: { view: View; scope: RepoScope; activeRepo: string | undefined; home: string }): Promise<string> {
  const { view, scope, activeRepo, home } = opts;
  const homeFallback = home.trim() || "~";

  if (view.kind === "session") {
    if (view.cwd.trim()) return view.cwd.trim();
    const fromTask = await worktreeForSlug(view.taskSlug);
    if (fromTask) return fromTask;
  }

  if (view.kind === "task") {
    const fromTask = await worktreeForSlug(view.slug);
    if (fromTask) return fromTask;
  }

  if (view.kind === "reviewHandoff") {
    const fromTask = await worktreeForSlug(view.source.source_slug);
    if (fromTask) return fromTask;
  }

  // Create-task draft already carries its intended worktree path when known.
  if (view.kind === "create" && view.draft?.worktree?.trim()) {
    return view.draft.worktree.trim();
  }

  if (scope === "all" || !activeRepo?.trim()) {
    return homeFallback;
  }
  return activeRepo.trim();
}

function CdHereButton({ sessionId, target }: { sessionId: string | null; target: string }) {
  const [busy, setBusy] = useState(false);
  const dest = target.trim();
  const ready = Boolean(sessionId && dest && !busy);
  return (
    <button
      type="button"
      className="iconbtn"
      disabled={!ready}
      title={dest || "Resolving path…"}
      aria-label={dest ? `cd here: ${dest}` : "cd here (resolving path)"}
      onClick={() => {
        if (!sessionId || !dest) return;
        setBusy(true);
        void Promise.resolve(ipc.writeSession(sessionId, shellCdCommand(dest)))
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      <CornerDownRight size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

export function TerminalDrawer({
  open,
  width,
  onWidthChange,
  tabs,
  activeId,
  terminalFontSize,
  onSelect,
  onClose,
  onNew,
  onKillAll,
  onTabExited,
  view,
  scope,
  activeRepo,
}: {
  open: boolean;
  width: number;
  onWidthChange: (w: number) => void;
  tabs: DrawerTab[];
  activeId: string | null;
  terminalFontSize: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onKillAll: () => void;
  onTabExited: (id: string) => void;
  view: View;
  scope: RepoScope;
  activeRepo: string | undefined;
}) {
  const [home, setHome] = useState("");
  const [cdTarget, setCdTarget] = useState("");
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const tabIds = tabs.map((tab) => tab.id).join("\n");

  useEffect(() => {
    let alive = true;
    ipc
      .homeDir()
      .then((h) => {
        if (!alive) return;
        const cleaned = h.replace(/\/+$/, "") || h;
        setHome(cleaned);
      })
      .catch(() => {
        if (alive) setHome("");
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    resolveDrawerCdTarget({ view, scope, activeRepo, home }).then((t) => {
      if (alive) setCdTarget(t);
    });
    return () => {
      alive = false;
    };
  }, [view, scope, activeRepo, home]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  useEffect(() => {
    const ids = tabIds.split("\n").filter(Boolean);
    if (ids.length === 0) return;
    const reported = new Set<string>();
    let alive = true;
    const tick = () => {
      for (const id of ids) {
        if (reported.has(id)) continue;
        ipc
          .sessionStatus(id, "")
          .then((obs) => {
            if (!alive || reported.has(id)) return;
            const state = obs.lifecycle.state;
            if (state !== "live" && state !== "never_started") {
              reported.add(id);
              onTabExited(id);
            }
          })
          .catch(() => {});
      }
    };
    tick();
    const timer = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tabIds, onTabExited]);

  if (!open && tabs.length === 0) return null;

  return (
    <>
      <div className={open ? "terminal-drawer is-open" : "terminal-drawer is-hidden"} aria-hidden={!open}>
        {open && tabs.length > 0 && (
          <div className="terminal-drawer-chrome">
            <div role="tablist" aria-label="Terminals" className="terminal-drawer-tabs">
              {tabs.map((tab) => {
                const selected = tab.id === activeId;
                return (
                  <div
                    key={tab.id}
                    ref={selected ? activeTabRef : undefined}
                    role="tab"
                    aria-selected={selected}
                    aria-label={`Terminal ${tab.ordinal}`}
                    title={`Terminal ${tab.ordinal}`}
                    tabIndex={selected ? 0 : -1}
                    className={selected ? "terminal-drawer-tab is-active" : "terminal-drawer-tab"}
                    onClick={() => onSelect(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(tab.id);
                      }
                    }}
                  >
                    <span aria-hidden="true">{tab.ordinal}</span>
                    <button
                      type="button"
                      className="terminal-drawer-tab-x"
                      aria-label={`Close terminal ${tab.ordinal}`}
                      title={`Close terminal ${tab.ordinal}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(tab.id);
                      }}
                    >
                      <X size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="terminal-drawer-actions">
              <button type="button" className="iconbtn" aria-label="New terminal" title="New terminal" onClick={onNew}>
                <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <button type="button" className="iconbtn terminal-drawer-killall" aria-label="Kill all terminals" title="Kill all terminals" onClick={onKillAll}>
                <SquareX size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <CdHereButton sessionId={activeId} target={cdTarget} />
            </div>
          </div>
        )}
        {active && (
          <div className="termhost">
            <SessionTerminal
              key={active.id}
              sessionId={active.id}
              cwd={active.cwd}
              taskSlug=""
              phase=""
              harness="no-harness"
              model=""
              intent="spawn"
              terminalFontSize={terminalFontSize}
            />
          </div>
        )}
      </div>
      {open && (
        <div
          className="terminal-drawer-resizer"
          onPointerDown={(ev) => {
            const startX = ev.clientX;
            const startWidth = width;
            const move = (moveEv: PointerEvent) => {
              onWidthChange(clampDrawerWidth(startWidth + moveEv.clientX - startX));
            };
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      )}
    </>
  );
}
