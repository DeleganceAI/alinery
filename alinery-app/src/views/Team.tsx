import { useEffect, useState } from "react";
import { confirmDanger } from "../confirm";
import * as ipc from "../ipc";
import { toast } from "../toast";
import type { DesktopTeams, TeamShare, TeamShareDetail } from "../types";

function repoLabel(repo: string): string {
  const trimmed = repo.replace(/\/$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || repo;
}

/** Shared daemons for the teams this account belongs to. The page reads through the accounts API.
 *  Comments can arrive over the Supabase Realtime socket; a poll covers a socket that is not up yet. */
export function TeamView({ active }: { active: boolean }) {
  const [teams, setTeams] = useState<DesktopTeams | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [shares, setShares] = useState<TeamShare[]>([]);
  const [shareId, setShareId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamShareDetail | null>(null);
  const [teamId, setTeamId] = useState("");
  const [comment, setComment] = useState("");
  const [filename, setFilename] = useState("");
  const [taskSlug, setTaskSlug] = useState("");
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

  const sendComment = () => {
    if (!shareId || !taskSlug || !filename || !comment.trim()) return;
    setBusy(true);
    ipc
      .accountTeamComment(shareId, taskSlug, filename, comment.trim())
      .then(() => {
        setComment("");
        loadDetail(shareId);
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  const teamPots = teams?.pots.filter((pot) => pot.teamId) ?? [];
  const artifacts = detail?.artifacts ?? [];
  const selectedArtifact = artifacts.find((row) => row.task_slug === taskSlug && row.filename === filename) ?? artifacts[0];

  return (
    <div className="team-view">
      <h2>Team</h2>
      {error ? <p className="dim">{error}</p> : null}
      <section>
        <h3>Your daemons</h3>
        {teamPots.length > 0 ? (
          <label>
            Share with{" "}
            <select className="field-input" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              {teamPots.map((pot) => (
                <option key={pot.teamId} value={pot.teamId ?? ""}>
                  {pot.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="dim">Join a team to share a daemon.</p>
        )}
        {repos.length === 0 ? <p className="dim">No daemon is connected in this window.</p> : null}
        <ul>
          {repos.map((repo) => (
            <li key={repo}>
              {repoLabel(repo)}{" "}
              <button type="button" className="btn small" disabled={busy || !teamId} onClick={() => shareRepo(repo)}>
                Share
              </button>{" "}
              <button type="button" className="btn ghost small" disabled={busy} onClick={() => void unshare(repo)}>
                Stop sharing
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Shared with you</h3>
        {shares.length === 0 ? <p className="dim">Nothing is shared yet.</p> : null}
        <ul>
          {shares.map((share) => (
            <li key={share.id}>
              <button type="button" className="btn ghost small" onClick={() => setShareId(share.id)}>
                {share.name}
              </button>{" "}
              <span className="dim">{share.online ? "online" : "offline"}</span>
              {share.last_sync_error ? <span className="dim"> {share.last_sync_error}</span> : null}
            </li>
          ))}
        </ul>
      </section>
      {shareId && detail ? (
        <section>
          <h3>{shares.find((share) => share.id === shareId)?.name ?? "Daemon"}</h3>
          <ul>
            {(detail.tasks ?? []).map((task) => (
              <li key={task.slug}>
                <button type="button" className="btn ghost small" onClick={() => setTaskSlug(task.slug ?? "")}>
                  {task.slug}
                </button>
              </li>
            ))}
          </ul>
          <ul>
            {artifacts.map((row) => (
              <li key={`${row.task_slug}/${row.filename}`}>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() => {
                    setTaskSlug(row.task_slug ?? "");
                    setFilename(row.filename ?? "");
                  }}
                >
                  {row.task_slug}/{row.filename}
                </button>
              </li>
            ))}
          </ul>
          {selectedArtifact?.body ? <pre>{selectedArtifact.body}</pre> : null}
          <h3>Comments</h3>
          <ul>
            {(detail.comments ?? [])
              .filter((row) => !filename || (row.task_slug === taskSlug && row.filename === filename))
              .map((row) => (
                <li key={row.id}>
                  <span className="dim">{row.filename}</span> {row.body}
                </li>
              ))}
          </ul>
          <textarea className="field-input" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Comment on the selected artifact" />
          <button type="button" className="btn small" disabled={busy || !filename || !comment.trim()} onClick={sendComment}>
            Comment
          </button>
        </section>
      ) : null}
    </div>
  );
}
