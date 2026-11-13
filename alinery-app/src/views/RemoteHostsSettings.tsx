import { useState } from "react";
import { connectHost } from "../hostConnect";
import { RemoteCredentialsDialog } from "../RemoteCredentials";
import { providerLabel } from "../remoteRepo";
import { toast } from "../toast";
import { useRemoteHosts } from "../useRemoteHosts";

/** The SSH hosts remote repositories live on, with the choice of what each may use. */
export function RemoteHostsSettings() {
  const { hosts, refresh } = useRemoteHosts(true);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  // The phase of each connect started here, by host id.
  const [phases, setPhases] = useState<Record<string, string>>({});
  const connect = async (hostId: string, destination: string, label: string) => {
    const setPhase = (phase: string) => setPhases((current) => ({ ...current, [hostId]: phase }));
    try {
      await connectHost(hostId, destination, setPhase);
      toast.success(`Connected to ${label}`);
    } catch (e) {
      toast.error(`Could not connect to ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPhases(({ [hostId]: _, ...rest }) => rest);
      void refresh();
    }
  };
  if (hosts.length === 0) return null;
  return (
    <div className="remote-hosts">
      <h3 id="remote-hosts-title">Remote hosts</h3>
      <ul className="connections-list" aria-labelledby="remote-hosts-title">
        {hosts.map((host) => {
          const label = host.label || host.host_id;
          const connected = host.state === "connected";
          const phase = phases[host.host_id] ?? (host.state === "connecting" || host.state === "reconnecting" ? host.phase || "Connecting" : "");
          return (
            <li className="connection-row" key={host.host_id}>
              <div className="connection-name">
                <span>
                  <strong>{label}</strong>
                  <small>{host.destination}</small>
                  {host.erased_sign_ins.length > 0 ? (
                    <small>Sign-ins removed from this host: {host.erased_sign_ins.map(providerLabel).join(", ")}. Use an API key or sign in again on the host.</small>
                  ) : null}
                </span>
              </div>
              <span className="connection-kind">{connected ? "Connected" : phase ? `${phase}…` : "Not connected"}</span>
              <div className="connection-status">
                {connected ? null : (
                  <button type="button" className="btn primary small" disabled={Boolean(phase)} onClick={() => void connect(host.host_id, host.destination, label)}>
                    Connect
                  </button>
                )}
                <button
                  type="button"
                  className="btn small"
                  disabled={!connected}
                  title={connected ? undefined : "Connect to this host first"}
                  onClick={() => setEditing({ id: host.host_id, label })}
                >
                  Credentials
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {editing ? (
        <RemoteCredentialsDialog
          hostId={editing.id}
          hostLabel={editing.label}
          onClose={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
