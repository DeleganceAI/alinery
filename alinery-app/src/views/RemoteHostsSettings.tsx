import { useState } from "react";
import { RemoteCredentialsDialog } from "../RemoteCredentials";
import { providerLabel } from "../remoteRepo";
import { useRemoteHosts } from "../useRemoteHosts";

/** The SSH hosts remote repositories live on, with the choice of what each may use. */
export function RemoteHostsSettings() {
  const { hosts, refresh } = useRemoteHosts(true);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  if (hosts.length === 0) return null;
  return (
    <div className="remote-hosts">
      <h3 id="remote-hosts-title">Remote hosts</h3>
      <ul className="connections-list" aria-labelledby="remote-hosts-title">
        {hosts.map((host) => {
          const label = host.label || host.host_id;
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
              <span className="connection-kind">{host.state === "connected" ? "Connected" : "Not connected"}</span>
              <div className="connection-status">
                <button
                  type="button"
                  className="btn small"
                  disabled={host.state !== "connected"}
                  title={host.state === "connected" ? undefined : "Connect to this host first, from the repository list"}
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
