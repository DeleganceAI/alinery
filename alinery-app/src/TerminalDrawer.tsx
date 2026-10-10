import { CornerDownRight, LoaderCircle, Plus, SquareX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { SessionTerminal } from "./SessionTerminal";
import type { RepoScope, View } from "./types";

export const DRAWER_MIN_WIDTH = 260;
export const DRAWER_MAX_SCREEN_FRACTION = 0.6;
export const DRAWER_DEFAULT_WIDTH = 360;

const DRAWER_PANEL_ID = "terminal-drawer-panel";
const closeLabel = (ordinal: number) => `Close terminal ${ordinal} — terminate shell and child processes`;

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
      title={dest ? `cd here: ${dest}` : "Resolving path…"}
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
  creating,
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
  creating: boolean;
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
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const tabIds = tabs.map((tab) => tab.id).join("\n");
  // Set when the user closes a tab; the close may finish later (kill is awaited), so focus
  // is restored once that tab is actually gone.
  const closingId = useRef<string | null>(null);

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
    const closing = closingId.current;
    if (!closing || tabIds.split("\n").includes(closing)) return;
    closingId.current = null;
    const focused = document.activeElement;
    if (!focused || focused === document.body || tabListRef.current?.contains(focused)) activeTabRef.current?.focus();
  }, [tabIds]);

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
            <div ref={tabListRef} role="tablist" aria-label="Terminals" className="terminal-drawer-tabs">
              {tabs.map((tab) => {
                const selected = tab.id === activeId;
                return (
                  <div
                    key={tab.id}
                    id={`terminal-drawer-tab-${tab.id}`}
                    ref={selected ? activeTabRef : undefined}
                    role="tab"
                    aria-selected={selected}
                    aria-controls={selected ? DRAWER_PANEL_ID : undefined}
                    aria-label={`Terminal ${tab.ordinal}`}
                    title={`Terminal ${tab.ordinal}`}
                    tabIndex={selected ? 0 : -1}
                    className={selected ? "terminal-drawer-tab is-active" : "terminal-drawer-tab"}
                    onClick={() => onSelect(tab.id)}
                    onKeyDown={(e) => {
                      // The board shortcuts listen on window; none of these keys may reach them.
                      const onTab = e.target === e.currentTarget;
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        // From the nested X, leave the default alone so the button activates natively.
                        if (onTab) {
                          e.preventDefault();
                          onSelect(tab.id);
                        }
                        return;
                      }
                      if (!onTab) return;
                      const i = tabs.findIndex((t) => t.id === tab.id);
                      const target = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
                      if (target === undefined) return;
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(tabs[target].id);
                      (e.currentTarget.parentElement?.children[target] as HTMLElement | undefined)?.focus();
                    }}
                  >
                    <span aria-hidden="true">{tab.ordinal}</span>
                    <button
                      type="button"
                      className="terminal-drawer-tab-x"
                      aria-label={closeLabel(tab.ordinal)}
                      title={closeLabel(tab.ordinal)}
                      onClick={(e) => {
                        e.stopPropagation();
                        closingId.current = tab.id;
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
              <button
                type="button"
                className="iconbtn"
                aria-label={creating ? "Starting terminal" : "New terminal"}
                title={creating ? "Starting terminal…" : "New terminal"}
                disabled={creating}
                aria-busy={creating}
                onClick={onNew}
              >
                {creating ? (
                  <LoaderCircle className="terminal-drawer-spin" size={16} strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
                )}
              </button>
              <span className="sr-only" role="status">
                {creating ? "Starting terminal" : ""}
              </span>
              <button type="button" className="iconbtn terminal-drawer-killall" aria-label="Kill all terminals" title="Kill all terminals" onClick={onKillAll}>
                <SquareX size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
              <CdHereButton sessionId={activeId} target={cdTarget} />
            </div>
          </div>
        )}
        {active && (
          <div className="termhost" role="tabpanel" id={DRAWER_PANEL_ID} aria-labelledby={`terminal-drawer-tab-${active.id}`}>
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
              keepViewport
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
