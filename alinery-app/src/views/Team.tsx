import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { sharedTasks } from "../sharedTask";
import { toast } from "../toast";
import type { AppearancePrefs, DesktopTeams, TeamShare, TeamShareDetail } from "../types";
import { SharedTaskList, SharedTaskView } from "./SharedTask";

function repoLabel(repo: string): string {
  const trimmed = repo.replace(/\/$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || repo;
}

const EMPTY_DETAIL: TeamShareDetail = { tasks: [], artifacts: [], comments: [] };

/** Shared daemons for the teams this account belongs to. The page reads through the accounts API.
 *  Comments can arrive over the Supabase Realtime socket; a poll covers a socket that is not up yet. */
export function TeamView({ active, appearance, onAppearanceChange }: { active: boolean; appearance: AppearancePrefs; onAppearanceChange: (next: AppearancePrefs) => void }) {
  const [teams, setTeams] = useState<DesktopTeams | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [shares, setShares] = useState<TeamShare[]>([]);
  const [shareId, setShareId] = useState<string | null>(null);
  const [taskSlug, setTaskSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamShareDetail | null>(null);
  const [teamId, setTeamId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadShares = () => {
    ipc
      .accountTeamShares()
      .then((page) => setShares(page.shares ?? []))
      .catch((e) => setError(String(e)));
  };

  const loadDetail = (id: string) => {
    ipc
      .accountTeamShare(id)
      .then((next) => setDetail(next))
      .catch((e) => setError(String(e)));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once each time the tab becomes active
  useEffect(() => {
    if (!active) return;
    ipc
      .accountTeams()
      .then((next) => {
        setTeams(next);
        const first = next.pots.find((pot) => pot.teamId);
        if (first?.teamId) setTeamId((current) => current || first.teamId || "");
      })
      .catch(() => {});
    ipc
      .listChatRepos()
      .then(setRepos)
      .catch(() => setRepos([]));
    loadShares();
  }, [active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one subscription per open share
  useEffect(() => {
    if (!active || !shareId) return;
    loadDetail(shareId);
    const timer = window.setInterval(() => loadDetail(shareId), 15_000);
    let closed = false;
    const held: { channel: { unsubscribe: () => void } | null } = { channel: null };
    ipc
      .accountRealtime()
      .then(async (session) => {
        if (closed) return;
        const supabase = await import("@supabase/supabase-js");
        const client = supabase.createClient(session.url, session.key);
        client.realtime.setAuth(session.accessToken);
        const joined = client
          .channel(`share:${shareId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "artifact_comments", filter: `shared_daemon_id=eq.${shareId}` }, () => loadDetail(shareId))
          .on("postgres_changes", { event: "UPDATE", schema: "public", table: "shared_daemons", filter: `id=eq.${shareId}` }, () => loadShares())
          .subscribe();
        held.channel = joined;
        if (closed) joined.unsubscribe();
      })
      .catch(() => {});
    return () => {
      closed = true;
      window.clearInterval(timer);
      held.channel?.unsubscribe();
    };
  }, [active, shareId]);

  const share = shares.find((row) => row.id === shareId) ?? null;
  const tasks = useMemo(() => sharedTasks(detail ?? EMPTY_DETAIL), [detail]);
  const task = tasks.find((row) => row.slug === taskSlug) ?? null;

  const openShare = (id: string) => {
    if (id !== shareId) setDetail(null);
    setShareId(id);
    setTaskSlug(null);
  };

  const shareRepo = (repo: string) => {
    if (!teamId) return;
    setBusy(true);
    ipc
      .accountShareDaemon(repo, teamId)
      .then(() => {
        toast.info(`Sharing ${repoLabel(repo)}`);
        loadShares();
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  const unshare = async (repo: string) => {
    const ok = await confirmDanger("Stop sharing this daemon?", "The team loses this daemon's tasks, artifacts, and comments.", "Stop sharing");
    if (!ok) return;
    setBusy(true);
    ipc
      .accountUnshareDaemon(repo)
      .then(() => loadShares())
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  if (share && task && detail) {
    return (
      <SharedTaskView
        share={share}
        task={task}
        detail={detail}
        appearance={appearance}
        onAppearanceChange={onAppearanceChange}
        onBack={() => setTaskSlug(null)}
        onComment={(filename, body, anchor) =>
          ipc.accountTeamComment(share.id, task.slug, filename, body, anchor).then(() => {
            loadDetail(share.id);
          })
        }
      />
    );
  }

  if (share) {
    return <SharedTaskList share={share} tasks={tasks} loaded={detail !== null} onBack={() => setShareId(null)} onOpen={(next) => setTaskSlug(next.slug)} />;
  }

  const teamPots = teams?.pots.filter((pot) => pot.teamId) ?? [];
  const sharedWithYou = shares.filter((row) => !row.mine);

  return (
    <div className="team-page">
      <h2 className="view-title">Team</h2>
      {error ? <p className="dim">{error}</p> : null}
      <section>
        <h3>Your daemons</h3>
        {teamPots.length > 0 ? (
          <div className="field settings-select-field">
            <label htmlFor="share-with">Share with</label>
            <div className="field-select">
              <select id="share-with" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                {teamPots.map((pot) => (
                  <option key={pot.teamId} value={pot.teamId ?? ""}>
                    {pot.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
            </div>
          </div>
        ) : (
          <p className="dim">Join a team to share a daemon.</p>
        )}
        {repos.length === 0 ? <p className="dim">No daemon is connected in this window.</p> : null}
        {repos.length > 0 ? (
          <div className="list team-list">
            {repos.map((repo) => {
              const shared = shares.some((row) => row.mine && row.name === repoLabel(repo).slice(0, 60));
              return (
                <div key={repo} className="row">
                  <div className="rt">
                    <div className="rtt">{repoLabel(repo)}</div>
                    {shared ? <div className="rts">Shared</div> : null}
                  </div>
                  {shared ? (
                    <button type="button" className="btn ghost small" disabled={busy} onClick={() => void unshare(repo)}>
                      Stop sharing
                    </button>
                  ) : (
                    <button type="button" className="btn small" disabled={busy || !teamId} onClick={() => shareRepo(repo)}>
                      Share
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
      <section>
        <h3>Shared with you</h3>
        {sharedWithYou.length === 0 ? <p className="dim">No teammate has shared a daemon yet.</p> : null}
        {sharedWithYou.length > 0 ? (
          <div className="list team-list">
            {sharedWithYou.map((row) => (
              <div
                key={row.id}
                className="row"
                role="button"
                tabIndex={0}
                onClick={() => openShare(row.id)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  openShare(row.id);
                }}
              >
                <div className="rt">
                  <div className="rtt">{row.name}</div>
                  {row.last_sync_error ? <div className="rts">{row.last_sync_error}</div> : null}
                </div>
                <span className="pill">{row.online ? "Online" : "Offline"}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
