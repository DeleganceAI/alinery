import { useEffect, useState } from "react";
import * as ipc from "./ipc";
import { parseRemoteRepo } from "./remoteRepo";

/**
 * Says which machine a sign-in lands on. With a remote repository open, accounts are signed in on
 * its host, not on this Mac, and that is easy to miss.
 */
export function SignInTarget() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const remote = parseRemoteRepo((await ipc.readAppConfig()).active_repo);
        if (!remote) return;
        const host = (await ipc.remoteHosts()).find((row) => row.host_id === remote.hostId);
        if (!cancelled) setLabel(host?.label || remote.hostId);
      } catch {
        // The accounts list works without the label.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  if (!label) return null;
  return (
    <p className="dsc sign-in-target">
      The open repository is on <strong>{label}</strong>, so provider accounts you sign in to here are stored on that host, not on this Mac.
    </p>
  );
}
