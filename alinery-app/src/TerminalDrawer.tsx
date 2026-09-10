import { useEffect, useRef, useState } from "react";
import * as ipc from "./ipc";
import { SessionTerminal } from "./SessionTerminal";
import { KillButton } from "./shared";
import type { RepoScope, View } from "./types";

export const DRAWER_MIN_WIDTH = 260;
export const DRAWER_MAX_SCREEN_FRACTION = 0.6;
export const DRAWER_DEFAULT_WIDTH = 360;

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

function CdHereButton({ sessionId, target }: { sessionId: string; target: string }) {
  const [busy, setBusy] = useState(false);
  const dest = target.trim();
  const ready = Boolean(sessionId && dest);
  return (
    <button
      type="button"
      className="btn small"
      disabled={busy || !ready}
      title={dest || "Resolving path…"}
      aria-label={dest ? `cd here: ${dest}` : "cd here (resolving path)"}
      onClick={(e) => {
        e.stopPropagation();
        if (!ready) return;
        setBusy(true);
        ipc
          .writeSession(sessionId, shellCdCommand(dest))
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      cd here
    </button>
  );
}

export function TerminalDrawer({
  open,
  width,
  onWidthChange,
  session,
  terminalFontSize,
  onKilled,
  onExited,
  view,
  scope,
  activeRepo,
}: {
  open: boolean;
  width: number;
  onWidthChange: (w: number) => void;
  session: { id: string; cwd: string } | null;
  terminalFontSize: number;
  onKilled: () => void;
  onExited: () => void;
  view: View;
  scope: RepoScope;
  activeRepo: string | undefined;
}) {
  const exitedRef = useRef(false);
  // Empty until homeDir resolves — avoids cd '~' (quoted tilde does not expand).
  const [home, setHome] = useState("");
  const [cdTarget, setCdTarget] = useState("");

  useEffect(() => {
    let alive = true;
    ipc
      .homeDir()
      .then((h) => {
        if (!alive) return;
        // path API often returns a trailing slash; normalize for display/cd.
        const cleaned = h.replace(/\/+$/, "") || h;
        setHome(cleaned);
      })
      .catch(() => {
        // Keep empty; resolve falls back to activeRepo when possible.
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

  // Reset the one-shot EOF guard when the session handle changes.
  useEffect(() => {
    exitedRef.current = false;
  }, [session?.id]);

  // Natural shell EOF → same path as Kill (design: close + clear; next open is fresh).
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const tick = () =>
      ipc
        .sessionStatus(session.id, "")
        .then((obs) => {
          if (!alive || exitedRef.current) return;
          const ls = obs.lifecycle;
          if (ls.state !== "live" && ls.state !== "never_started") {
            exitedRef.current = true;
            onExited();
          }
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session, onExited]);

  if (!session && !open) return null;

  return (
    <>
      <div className={open ? "terminal-drawer is-open" : "terminal-drawer is-hidden"} aria-hidden={!open}>
        {open && session && (
          <div className="terminal-drawer-chrome">
            <CdHereButton sessionId={session.id} target={cdTarget} />
            <KillButton id={session.id} slug="" onKilled={onKilled} danger={true} />
          </div>
        )}
        {session && (
          <div className="termhost">
            <SessionTerminal
              key={session.id}
              sessionId={session.id}
              cwd={session.cwd}
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
